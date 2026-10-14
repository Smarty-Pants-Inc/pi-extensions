import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DialogOutcome, QuestionDialog } from "./dialog.js";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_FREE_TEXT_LENGTH,
  MAX_HEADER_LENGTH,
  MAX_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  MAX_QUESTIONS,
  MAX_VALUE_LENGTH,
  normalizeQuestions,
  type Question,
  type QuestionAnswer,
  type QuestionSelection,
  sanitizeDisplayText,
} from "./normalize.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const OptionSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: MAX_LABEL_LENGTH, description: "Short user-facing option label." }),
    description: Type.Optional(
      Type.String({ maxLength: MAX_DESCRIPTION_LENGTH, description: "Optional explanation of the tradeoff." }),
    ),
    value: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_VALUE_LENGTH, description: "Optional machine-readable value." }),
    ),
  },
  { additionalProperties: false },
);

const QuestionSchema = Type.Object(
  {
    id: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH, description: "Stable identifier for this answer." }),
    ),
    header: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_HEADER_LENGTH,
        description: "Short heading shown above the question.",
      }),
    ),
    question: Type.String({
      minLength: 1,
      maxLength: MAX_QUESTION_LENGTH,
      description: "The question to show the user.",
    }),
    options: Type.Array(OptionSchema, { minItems: 2, maxItems: MAX_OPTIONS, description: "Two to four choices." }),
    multiSelect: Type.Optional(
      Type.Boolean({ description: "Allow multiple choices; the user explicitly chooses Done." }),
    ),
    allowOther: Type.Optional(Type.Boolean({ description: "Offer a free-text Other answer; defaults to true." })),
  },
  { additionalProperties: false },
);

export const ASK_USER_QUESTION_PARAMETERS = Type.Object(
  {
    questions: Type.Array(QuestionSchema, {
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      description: "One to four questions. Ask only related decisions in one batch.",
    }),
  },
  { additionalProperties: false },
);

export type CancellationReason = "cancelled" | "aborted" | "disposed" | "invalid_input" | "ui_unavailable" | "ui_error";

export interface AskUserQuestionDetails {
  version: 1;
  cancelled: boolean;
  questions: Question[];
  answers: QuestionAnswer[];
  reason?: CancellationReason;
  message?: string;
}

export interface AskUserQuestionResult {
  content: [{ type: "text"; text: string }];
  details: AskUserQuestionDetails;
}

const askUserQuestionTool = defineTool({
  name: ASK_USER_QUESTION_TOOL_NAME,
  label: "Ask user question",
  description:
    "Ask the user one to four focused decision questions with bounded choices. Use this when an important preference, tradeoff, or missing requirement cannot be discovered from the available context. Wait for the structured answer before continuing.",
  promptSnippet: "Ask the user focused decision questions and wait for structured answers",
  promptGuidelines: [
    "Use ask_user_question for decisions that materially affect the work, not for routine progress updates or questions answerable from the repository.",
    "Ask one to four related questions, provide two to four mutually exclusive options, and put the recommended option first when there is a clear default.",
    "Use multiSelect only when choices can be combined. Keep question and option text concise; use allowOther when a free-form answer is genuinely useful.",
    "The tool is sequential: wait for its result before making another user-facing decision request, and use the returned answer objects rather than inferring a choice.",
  ],
  parameters: ASK_USER_QUESTION_PARAMETERS,
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AskUserQuestionResult> {
    const normalized = normalizeQuestions(params);
    if (!normalized.ok) {
      return cancellation([], "invalid_input", normalized.error);
    }
    if (signal?.aborted) return cancellation(normalized.questions, "aborted", "The question request was aborted.");

    const outcome = await askQuestions(normalized.questions, ctx, signal);
    if (outcome.kind === "answered") return answered(normalized.questions, outcome.answers);
    return cancellation(normalized.questions, outcome.reason, cancelMessage(outcome.reason), outcome.answers);
  },
});

export default function askUserQuestion(pi: ExtensionAPI): void {
  pi.registerTool(askUserQuestionTool);
}

export { askUserQuestionTool };

async function askQuestions(
  questions: Question[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<DialogOutcome | { kind: "cancelled"; reason: CancellationReason; answers: QuestionAnswer[] }> {
  // RPC has UI request methods but cannot mount a local component. Print mode,
  // and contexts without UI, are deliberately cancellation-only.
  if (!ctx.hasUI) return { kind: "cancelled", reason: "ui_unavailable", answers: [] };
  if (ctx.mode === "tui") return askWithDialog(questions, ctx, signal);
  if (ctx.mode === "rpc") return askWithRpcFallback(questions, ctx, signal);
  return { kind: "cancelled", reason: "ui_unavailable", answers: [] };
}

async function askWithDialog(
  questions: Question[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<DialogOutcome> {
  return new Promise<DialogOutcome>((resolve) => {
    let settled = false;
    let dialog: QuestionDialog | undefined;
    const finish = (outcome: DialogOutcome): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => {
      dialog?.cancel("aborted");
      if (!dialog) finish({ kind: "cancelled", reason: "aborted", answers: [] });
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    void Promise.resolve()
      .then(() =>
        ctx.ui.custom<DialogOutcome>(
          (tui, theme, keybindings, done) => {
            dialog = new QuestionDialog(tui, theme, keybindings, questions, (outcome) => {
              if (settled) return;
              try {
                done(outcome);
              } catch {
                // The dialog has already settled; cancelling it again cannot
                // finish the tool if the host completion callback fails.
                finish({ kind: "cancelled", reason: "ui_error", answers: outcome.answers });
                return;
              }
              finish(outcome);
            });
            if (signal?.aborted) dialog.cancel("aborted");
            return dialog;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "90%",
              minWidth: 36,
              maxHeight: "85%",
              margin: 1,
            },
          },
        ),
      )
      .then((outcome) => {
        if (outcome) finish(outcome);
        else if (dialog) dialog.cancel("disposed");
        else finish({ kind: "cancelled", reason: "disposed", answers: [] });
      })
      .catch((_error: unknown) => {
        const reason = signal?.aborted ? "aborted" : "ui_error";
        if (dialog) dialog.cancel(reason);
        else finish({ kind: "cancelled", reason, answers: [] });
      });
  });
}

async function askWithRpcFallback(
  questions: Question[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<
  | { kind: "answered"; answers: QuestionAnswer[] }
  | { kind: "cancelled"; reason: CancellationReason; answers: QuestionAnswer[] }
> {
  const answers: (QuestionAnswer | undefined)[] = new Array<QuestionAnswer | undefined>(questions.length).fill(
    undefined,
  );
  let index = 0;
  while (index < questions.length) {
    const question = questions[index];
    if (!question) return { kind: "cancelled", reason: "ui_error", answers: complete(answers) };
    const choice = question.multiSelect
      ? await selectMulti(question, index, questions.length, ctx, signal)
      : await selectSingle(question, index, questions.length, index > 0, ctx, signal);
    if (choice.kind === "cancelled") return { ...choice, answers: complete(answers) };
    if (choice.kind === "back") {
      if (index > 0) {
        answers[index] = undefined;
        index -= 1;
        answers[index] = undefined;
      }
      continue;
    }
    if (choice.kind === "other") {
      let freeText: string;
      while (true) {
        const response = await withAbort(
          () => ctx.ui.input(questionTitle(question, index, questions.length), "", { signal }),
          signal,
        );
        if (response.kind === "cancelled") return { ...response, answers: complete(answers) };
        if (response.value === undefined) return { kind: "cancelled", reason: "cancelled", answers: complete(answers) };
        if (response.value.length > MAX_FREE_TEXT_LENGTH) {
          try {
            ctx.ui.notify(
              `Response exceeds ${MAX_FREE_TEXT_LENGTH} UTF-16 code units; shorten it and try again.`,
              "warning",
            );
          } catch {
            return { kind: "cancelled", reason: "ui_error", answers: complete(answers) };
          }
          continue;
        }
        freeText = response.value;
        break;
      }
      if (!freeText.trim()) continue;
      answers[index] = answerFor(question, choice.selections, freeText);
    } else {
      answers[index] = answerFor(question, choice.selections);
    }
    index += 1;
  }
  return { kind: "answered", answers: complete(answers) };
}

type FallbackChoice =
  | { kind: "selected"; selections: QuestionSelection[] }
  | { kind: "other"; selections: QuestionSelection[] }
  | { kind: "back" }
  | { kind: "cancelled"; reason: CancellationReason };

async function selectSingle(
  question: Question,
  index: number,
  total: number,
  canGoBack: boolean,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<FallbackChoice> {
  const actions = rpcActions(question, canGoBack);
  const selected = await withAbort(
    () => ctx.ui.select(questionTitle(question, index, total), [...actions.keys()], { signal }),
    signal,
  );
  if (selected.kind === "cancelled") return selected;
  if (selected.value === undefined) return { kind: "cancelled", reason: "cancelled" };
  const action = actions.get(selected.value);
  if (action?.kind === "other") return { kind: "other", selections: [] };
  if (action?.kind === "back") return { kind: "back" };
  return action?.kind === "option"
    ? { kind: "selected", selections: [rpcSelection(question, action.index)] }
    : { kind: "cancelled", reason: "ui_error" };
}

async function selectMulti(
  question: Question,
  index: number,
  total: number,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<FallbackChoice> {
  const selected = new Set<number>();
  while (true) {
    const actions = rpcActions(question, index > 0, selected);
    const choice = await withAbort(
      () =>
        ctx.ui.select(questionTitle(question, index, total), [...actions.keys()], {
          signal,
        }),
      signal,
    );
    if (choice.kind === "cancelled") return choice;
    if (choice.value === undefined) return { kind: "cancelled", reason: "cancelled" };
    const action = actions.get(choice.value);
    if (action?.kind === "done" || action?.kind === "other") {
      return {
        kind: action.kind === "done" ? "selected" : "other",
        selections: question.options.flatMap((_option, optionIndex) =>
          selected.has(optionIndex) ? [rpcSelection(question, optionIndex)] : [],
        ),
      };
    }
    if (action?.kind === "back") return { kind: "back" };
    if (action?.kind === "option") {
      if (selected.has(action.index)) selected.delete(action.index);
      else selected.add(action.index);
      continue;
    }
    return { kind: "cancelled", reason: "ui_error" };
  }
}

type RpcAction = { kind: "option"; index: number } | { kind: "other" | "done" | "back" };

// Select returns display strings, not opaque values. Prefix every action with a
// unique identity and resolve only entries actually offered in this request.
function rpcActions(question: Question, canGoBack: boolean, selected?: ReadonlySet<number>): Map<string, RpcAction> {
  const actions = new Map<string, RpcAction>();
  for (const [index, option] of question.options.entries()) {
    const checked = selected ? `${selected.has(index) ? "[x]" : "[ ]"} ` : "";
    actions.set(
      `[option:${index + 1}] ${checked}${sanitizeDisplayText(option.label, MAX_LABEL_LENGTH)}${option.description ? ` — ${sanitizeDisplayText(option.description, MAX_DESCRIPTION_LENGTH)}` : ""}`,
      { kind: "option", index },
    );
  }
  if (question.allowOther) actions.set("[action:other] Other (free text)", { kind: "other" });
  if (selected) actions.set("[action:done] Done", { kind: "done" });
  if (canGoBack) actions.set("[action:back] Back (revise previous answer)", { kind: "back" });
  return actions;
}

function rpcSelection(question: Question, index: number): QuestionSelection {
  const option = question.options[index];
  if (!option) throw new Error("RPC selection index is outside the offered options");
  return { label: option.label, value: option.value, index };
}

function answerFor(question: Question, selections: QuestionSelection[], freeText?: string): QuestionAnswer {
  const answer: QuestionAnswer = {
    id: question.id,
    header: question.header,
    question: question.question,
    wasCustom: freeText !== undefined,
  };
  if (question.multiSelect) answer.selected = selections;
  else if (selections[0]) answer.selected = selections[0];
  if (freeText !== undefined) answer.freeText = freeText;
  return answer;
}

function complete(answers: (QuestionAnswer | undefined)[]): QuestionAnswer[] {
  return answers.filter((answer): answer is QuestionAnswer => answer !== undefined);
}

function questionTitle(question: Question, index: number, total: number): string {
  return `${progress(index, total)}${sanitizeDisplayText(question.header, MAX_HEADER_LENGTH)}: ${sanitizeDisplayText(question.question, MAX_QUESTION_LENGTH)}`;
}

function progress(index: number, total: number): string {
  return total > 1 ? `[${index + 1}/${total}] ` : "";
}

function cancellation(
  questions: Question[],
  reason: CancellationReason,
  message: string,
  answers: QuestionAnswer[] = [],
): AskUserQuestionResult {
  return result({ version: 1, cancelled: true, questions, answers, reason, message });
}

function answered(questions: Question[], answers: QuestionAnswer[]): AskUserQuestionResult {
  return result({ version: 1, cancelled: false, questions, answers });
}

function result(details: AskUserQuestionDetails): AskUserQuestionResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function cancelMessage(reason: CancellationReason): string {
  switch (reason) {
    case "aborted":
      return "The question request was aborted.";
    case "disposed":
      return "The question dialog was disposed.";
    case "ui_unavailable":
      return "Interactive UI is not available in this context.";
    case "ui_error":
      return "The question UI could not collect a complete answer.";
    case "invalid_input":
      return "The supplied question payload was invalid.";
    case "cancelled":
      return "The user cancelled the question dialog.";
  }
}

type UiOutcome<T> = { kind: "value"; value: T } | { kind: "cancelled"; reason: "aborted" | "ui_error" };

async function withAbort<T>(request: () => Promise<T>, signal: AbortSignal | undefined): Promise<UiOutcome<T>> {
  if (signal?.aborted) return { kind: "cancelled", reason: "aborted" };
  return new Promise<UiOutcome<T>>((resolve) => {
    let settled = false;
    const finish = (outcome: UiOutcome<T>): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: "cancelled", reason: "aborted" });
    const onError = (): void => finish({ kind: "cancelled", reason: signal?.aborted ? "aborted" : "ui_error" });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // Always observe late rejection, including after cancellation. Sync throws
      // and promise rejection have the same structured outcome in every mode.
      void request().then(
        (value) => finish(signal?.aborted ? { kind: "cancelled", reason: "aborted" } : { kind: "value", value }),
        onError,
      );
    } catch {
      onError();
    }
    if (signal?.aborted) onAbort();
  });
}
