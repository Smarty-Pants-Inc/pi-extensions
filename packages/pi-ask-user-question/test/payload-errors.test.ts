import assert from "node:assert/strict";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { askUserQuestionTool } from "../src/ask-user-question.js";
import { type DialogOutcome, QuestionDialog } from "../src/dialog.js";
import { MAX_FREE_TEXT_LENGTH, normalizeQuestions } from "../src/normalize.js";
import { fakeTheme, fakeTui, keybindings, makeQuestions } from "./support.js";

const params = {
  questions: [
    { question: "One?", options: [{ label: "A" }, { label: "B" }] },
    { question: "Two?", options: [{ label: "C" }, { label: "D" }] },
  ],
};
const raw = "  first line\n\n  👩‍💻 😀  last line  ";
const other = "[action:other] Other (free text)";

for (const text of [raw, "x".repeat(MAX_FREE_TEXT_LENGTH), "😀".repeat(MAX_FREE_TEXT_LENGTH / 2)]) {
  test(`RPC Other preserves raw text (${text.length} units)`, async () => {
    const result = await askUserQuestionTool.execute(
      "raw",
      { questions: [params.questions[0]] } as never,
      undefined,
      undefined,
      {
        mode: "rpc",
        hasUI: true,
        ui: { select: async () => other, input: async () => text },
      } as never,
    );
    assert.equal(result.details.cancelled, false);
    assert.equal(result.details.answers[0]?.freeText, text);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  });
  test(`TUI Other preserves raw text before native submit trimming (${text.length} units)`, () => {
    let outcome: DialogOutcome | undefined;
    const dialog = new QuestionDialog(fakeTui(), fakeTheme(), keybindings() as never, makeQuestions(), (value) => {
      outcome = value;
    });
    dialog.handleInput("\u001b[B");
    dialog.handleInput("\u001b[B");
    dialog.handleInput("\r");
    dialog.handleInput(`\x1b[200~${text}\x1b[201~`);
    dialog.handleInput("\r");
    assert.equal(outcome?.kind, "answered");
    if (outcome?.kind === "answered") assert.equal(outcome.answers[0]?.freeText, text);
  });
}

test("RPC keeps tabs and CRLF exactly as returned by its client", async () => {
  const text = "  line\twith tabs\r\n👩‍💻  ";
  const result = await askUserQuestionTool.execute(
    "rpc-spacing",
    { questions: [params.questions[0]] } as never,
    undefined,
    undefined,
    {
      mode: "rpc",
      hasUI: true,
      ui: { select: async () => other, input: async () => text },
    } as never,
  );
  assert.equal(result.details.answers[0]?.freeText, text);
});

test("RPC rejects an overlong Other response explicitly and retries without truncating", async () => {
  const notify = vi.fn();
  const input = vi
    .fn()
    .mockResolvedValueOnce("x".repeat(MAX_FREE_TEXT_LENGTH + 1))
    .mockResolvedValueOnce(raw);
  const result = await askUserQuestionTool.execute(
    "length",
    { questions: [params.questions[0]] } as never,
    undefined,
    undefined,
    {
      mode: "rpc",
      hasUI: true,
      ui: { select: async () => other, input, notify },
    } as never,
  );
  assert.equal(input.mock.calls.length, 2);
  assert.match(notify.mock.calls[0]?.[0], /4000.*shorten/);
  assert.equal(result.details.answers[0]?.freeText, raw);
});

test("RPC overflow notification failure returns ui_error with completed question 1", async () => {
  const notify = vi.fn((_message: string) => {
    throw new Error("notification unavailable");
  });
  const input = vi.fn().mockResolvedValue("x".repeat(MAX_FREE_TEXT_LENGTH + 1));
  let calls = 0;
  const result = await askUserQuestionTool.execute("notify-throw", params as never, undefined, undefined, {
    mode: "rpc",
    hasUI: true,
    ui: {
      select: async () => (calls++ === 0 ? "[option:1] A" : other),
      input,
      notify,
    },
  } as never);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.reason, "ui_error");
  assert.equal(result.details.answers.length, 1);
  assert.equal(result.details.answers[0]?.id, "question-1");
  assert.equal(input.mock.calls.length, 1);
  assert.match(notify.mock.calls[0]?.[0] ?? "", /4000.*shorten/);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

for (const remapped of [false, true]) {
  test(`public SDK Other editor respects ${remapped ? "remapped" : "default"} newline and submit bindings`, () => {
    const previous = getKeybindings();
    const bindings = new KeybindingsManager(
      TUI_KEYBINDINGS,
      remapped ? { "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" } : {},
    );
    setKeybindings(bindings);
    try {
      let outcome: DialogOutcome | undefined;
      const dialog = new QuestionDialog(fakeTui(), fakeTheme(), bindings, makeQuestions(), (value) => {
        outcome = value;
      });
      dialog.handleInput("\u001b[B");
      dialog.handleInput("\u001b[B");
      dialog.handleInput("\r");
      dialog.handleInput("  👩‍💻 first  ");
      dialog.handleInput(remapped ? "\r" : "\x1b[13;2u");
      assert.equal(outcome, undefined);
      dialog.handleInput("  last  ");
      dialog.handleInput(remapped ? "\x1b[13;2u" : "\r");
      assert.equal(outcome?.kind, "answered");
      if (outcome?.kind === "answered") assert.equal(outcome.answers[0]?.freeText, "  👩‍💻 first  \n  last  ");
    } finally {
      setKeybindings(previous);
    }
  });
}

test("public SDK backslash-Enter submit workaround keeps native intentional transformation", () => {
  const previous = getKeybindings();
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.input.submit": "shift+enter",
    "tui.input.newLine": "enter",
  });
  setKeybindings(bindings);
  try {
    let nativeAnswer: string | undefined;
    const native = new Editor(fakeTui(), { borderColor: (text) => text, selectList: getSelectListTheme() });
    native.onSubmit = (text) => {
      nativeAnswer = text;
    };
    native.handleInput("  answer\\");
    native.handleInput("\r");
    assert.equal(nativeAnswer, "answer");

    let outcome: DialogOutcome | undefined;
    const dialog = new QuestionDialog(fakeTui(), fakeTheme(), bindings, makeQuestions(), (value) => {
      outcome = value;
    });
    dialog.handleInput("\u001b[B");
    dialog.handleInput("\u001b[B");
    dialog.handleInput("\r");
    dialog.handleInput("  answer\\");
    dialog.handleInput("\r");
    assert.equal(outcome?.kind, "answered");
    if (outcome?.kind === "answered") assert.equal(outcome.answers[0]?.freeText, nativeAnswer);
  } finally {
    setKeybindings(previous);
  }
});

test("TUI rejects overlong Other input with a visible error and keeps the draft", () => {
  let outcome: DialogOutcome | undefined;
  const dialog = new QuestionDialog(fakeTui(), fakeTheme(), keybindings() as never, makeQuestions(), (value) => {
    outcome = value;
  });
  dialog.handleInput("\u001b[B");
  dialog.handleInput("\u001b[B");
  dialog.handleInput("\r");
  const overlong = "x".repeat(MAX_FREE_TEXT_LENGTH + 1);
  dialog.handleInput(`\x1b[200~${overlong}\x1b[201~`);
  dialog.handleInput("\r");
  assert.equal(outcome, undefined);
  // Repeated submission remains invalid rather than accepting a clipped answer.
  dialog.handleInput("\r");
  assert.equal(outcome, undefined);
  assert.match(dialog.render(100).join("\n"), /4000|shorten|exceeds/);
  dialog.handleInput("\x7f"); // Shorten the preserved raw draft by one unit.
  dialog.handleInput("\r");
  assert.equal(outcome?.kind, "answered");
  if (outcome?.kind === "answered") assert.equal(outcome.answers[0]?.freeText, "x".repeat(MAX_FREE_TEXT_LENGTH));
});

for (const prompt of ["select", "multi", "input"] as const) {
  for (const signalKind of ["undefined", "live", "aborted"] as const) {
    for (const sync of [false, true]) {
      test(`question 2 ${prompt} ${sync ? "throws" : "rejects"}, signal=${signalKind}: structured error retains question 1`, async () => {
        const controller = new AbortController();
        let calls = 0;
        const fail = (): Promise<string | undefined> => {
          if (signalKind === "aborted") controller.abort();
          if (sync) throw new Error("UI unavailable");
          return Promise.reject(new Error("UI unavailable"));
        };
        const result = await askUserQuestionTool.execute(
          "reject",
          {
            questions: params.questions.map((question, index) => ({
              ...question,
              multiSelect: prompt === "multi" && index === 1,
            })),
          } as never,
          signalKind === "undefined" ? undefined : controller.signal,
          undefined,
          {
            mode: "rpc",
            hasUI: true,
            ui: {
              select: () =>
                calls++ === 0 ? Promise.resolve("[option:1] A") : prompt === "input" ? Promise.resolve(other) : fail(),
              input: fail,
            },
          } as never,
        );
        assert.equal(result.details.cancelled, true);
        assert.equal(result.details.reason, signalKind === "aborted" ? "aborted" : "ui_error");
        assert.equal(result.details.answers.length, 1);
        assert.equal(result.details.answers[0]?.id, "question-1");
        assert.deepEqual(JSON.parse(result.content[0].text), result.details);
      });
    }
  }
}

test("labels are sanitized display copies, not answer payloads", async () => {
  const label = "  👩‍💻\nA  ";
  let offered: string[] = [];
  const result = await askUserQuestionTool.execute(
    "label",
    { questions: [{ question: "Pick?", options: [{ label }, { label: "B" }] }] } as never,
    undefined,
    undefined,
    {
      mode: "rpc",
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          offered = options;
          return options[0];
        },
      },
    } as never,
  );
  assert.equal(offered[0], "[option:1] 👩‍💻 A");
  assert.deepEqual(result.details.answers[0]?.selected, { label, value: label, index: 0 });
  assert.equal(
    normalizeQuestions({ questions: [{ question: "Pick?", options: [{ label: "x".repeat(201) }, { label: "B" }] }] })
      .ok,
    false,
  );
});

test("TUI successful host done still completes the tool without waiting for the host promise", async () => {
  const done = vi.fn();
  const result = await askUserQuestionTool.execute("done-success", params as never, undefined, undefined, {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: (factory: (...args: unknown[]) => QuestionDialog) => {
        const dialog = factory(fakeTui(), fakeTheme(), keybindings(), done);
        dialog.handleInput("\r");
        dialog.handleInput("\r");
        dialog.dispose();
        return new Promise<DialogOutcome>(() => {});
      },
    },
  } as never);
  assert.equal(result.details.cancelled, false);
  assert.equal(result.details.answers.length, 2);
  assert.equal(done.mock.calls.length, 1);
  assert.deepEqual(done.mock.calls[0]?.[0], { kind: "answered", answers: result.details.answers });
}, 1000);

for (const signalKind of ["undefined", "live"] as const) {
  test(`TUI host done throwing after the last answer settles ui_error, signal=${signalKind}`, async () => {
    const controller = new AbortController();
    let dialog: QuestionDialog | undefined;
    const done = vi.fn(() => {
      throw new Error("host completion failure");
    });
    const result = await askUserQuestionTool.execute(
      "done-throw",
      params as never,
      signalKind === "live" ? controller.signal : undefined,
      undefined,
      {
        mode: "tui",
        hasUI: true,
        ui: {
          custom: (factory: (...args: unknown[]) => QuestionDialog) => {
            dialog = factory(fakeTui(), fakeTheme(), keybindings(), done);
            dialog.handleInput("\r");
            dialog.handleInput("\r");
            // The host never resolves its promise if done fails. Tool settlement
            // must not depend on host completion or a later rejection/abort.
            return new Promise<DialogOutcome>(() => {});
          },
        },
      } as never,
    );
    assert.equal(result.details.cancelled, true);
    assert.equal(result.details.reason, "ui_error");
    assert.deepEqual(
      result.details.answers.map((answer) => answer.id),
      ["question-1", "question-2"],
    );
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
    dialog?.dispose();
    dialog?.cancel("ui_error");
    controller.abort();
    assert.equal(done.mock.calls.length, 1);
  }, 1000);

  test(`TUI UI rejection on question 2 retains partial answers, signal=${signalKind}`, async () => {
    const controller = new AbortController();
    const result = await askUserQuestionTool.execute(
      "dialog-reject",
      params as never,
      signalKind === "live" ? controller.signal : undefined,
      undefined,
      {
        mode: "tui",
        hasUI: true,
        ui: {
          custom: (factory: (...args: unknown[]) => QuestionDialog) => {
            const dialog = factory(fakeTui(), fakeTheme(), keybindings(), () => {});
            dialog.handleInput("\r");
            return Promise.reject(new Error("overlay failure"));
          },
        },
      } as never,
    );
    assert.equal(result.details.reason, "ui_error");
    assert.equal(result.details.answers.length, 1);
  });
}
