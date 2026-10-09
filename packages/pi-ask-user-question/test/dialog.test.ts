import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type DialogOutcome, QuestionDialog } from "../src/dialog.js";
import { normalizeQuestions } from "../src/normalize.js";
import { fakeTheme, fakeTui, keybindings, makeQuestions } from "./support.js";

test("dialog renders a visible border, sanitizes text, and fits narrow widths", () => {
  const normalized = normalizeQuestions({
    questions: [
      {
        question: "Unsafe\u001b]2;title\u0007 question\nwith a long line",
        options: [{ label: "One\u001b[31m" }, { label: "Two" }],
      },
    ],
  });
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  const dialog = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    normalized.questions,
    () => undefined,
  );
  const lines = dialog.render(30);
  assert.ok(lines.length >= 4);
  assert.ok(stripVTControlCharacters(lines[0] ?? "").includes("─"));
  assert.ok(stripVTControlCharacters(lines.at(-1) ?? "").includes("─"));
  assert.ok(lines.every((line) => stripVTControlCharacters(line).length <= 30));
  assert.doesNotMatch(lines.join("\n"), /title/);
  assert.equal(lines.join("\n").includes(String.fromCharCode(27)), false);
});

test("single selection, Other editor, multi-select, Back, Escape, and dispose are idempotent", () => {
  const first = makeQuestions();
  let outcome: DialogOutcome | undefined;
  const dialog = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    first,
    (value) => (outcome = value),
  );
  dialog.focused = true;
  dialog.handleInput("\r");
  assert.equal(outcome?.kind, "answered");

  let customOutcome: DialogOutcome | undefined;
  const custom = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    first,
    (value) => (customOutcome = value),
  );
  custom.focused = true;
  custom.handleInput("\u001b[B");
  custom.handleInput("\u001b[B");
  custom.handleInput("\r");
  custom.handleInput("custom response");
  custom.handleInput("\r");
  assert.equal(customOutcome?.kind, "answered");
  if (customOutcome?.kind === "answered") assert.equal(customOutcome.answers[0]?.freeText, "custom response");

  let editorCancelled: DialogOutcome | undefined;
  const editorCancel = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    first,
    (value) => (editorCancelled = value),
  );
  editorCancel.handleInput("\u001b[B");
  editorCancel.handleInput("\u001b[B");
  editorCancel.handleInput("\r");
  editorCancel.handleInput("\u001b");
  assert.equal(editorCancelled, undefined);
  editorCancel.handleInput("\u001b");
  assert.equal(editorCancelled?.kind, "cancelled");

  let multiOutcome: DialogOutcome | undefined;
  const multi = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    makeQuestions({ multiSelect: true }),
    (value) => (multiOutcome = value),
  );
  multi.focused = true;
  multi.handleInput(" ");
  multi.handleInput("\u001b[B");
  multi.handleInput(" ");
  multi.handleInput("\u001b[B");
  multi.handleInput("\u001b[B");
  multi.handleInput("\r");
  assert.equal(multiOutcome?.kind, "answered");
  if (multiOutcome?.kind === "answered") assert.equal(Array.isArray(multiOutcome.answers[0]?.selected), true);

  let multiOtherOutcome: DialogOutcome | undefined;
  const multiOther = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    makeQuestions({ multiSelect: true }),
    (value) => (multiOtherOutcome = value),
  );
  multiOther.handleInput("\u001b[B");
  multiOther.handleInput("\u001b[B");
  multiOther.handleInput("\r");
  multiOther.handleInput("free-form choice");
  multiOther.handleInput("\r");
  multiOther.handleInput("\u001b[B");
  multiOther.handleInput("\u001b[B");
  multiOther.handleInput("\r");
  assert.equal(multiOtherOutcome?.kind, "answered");
  if (multiOtherOutcome?.kind === "answered") {
    assert.equal(multiOtherOutcome.answers[0]?.freeText, "free-form choice");
  }

  let batchOutcome: DialogOutcome | undefined;
  const batch = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    [...makeQuestions(), ...makeQuestions({ id: "second", header: "Second" })],
    (value) => (batchOutcome = value),
  );
  batch.handleInput("\r");
  batch.handleInput("\u001b[B");
  batch.handleInput("\r");
  assert.equal(batchOutcome?.kind, "answered");

  let revisedOutcome: DialogOutcome | undefined;
  const revisable = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    [...makeQuestions(), ...makeQuestions({ id: "revised", header: "Revised" })],
    (value) => (revisedOutcome = value),
  );
  revisable.handleInput("\r");
  revisable.handleInput("\u001b[B");
  revisable.handleInput("\u001b[B");
  revisable.handleInput("\u001b[B");
  revisable.handleInput("\r");
  revisable.handleInput("\u001b[B");
  revisable.handleInput("\r");
  revisable.handleInput("\r");
  assert.equal(revisedOutcome?.kind, "answered");

  let cancelled = 0;
  const disposable = new QuestionDialog(fakeTui(), fakeTheme(), keybindings() as never, first, () => (cancelled += 1));
  disposable.dispose();
  disposable.dispose();
  disposable.handleInput("\u001b");
  assert.equal(cancelled, 1);
});

for (const [width, rows] of [
  [80, 24],
  [40, 12],
  [20, 8],
]) {
  test(`long dialog follows every control and editor cursor in ${width}x${rows}`, () => {
    const questions = makeQuestions({
      question: "A long question with enough context to wrap. ".repeat(30),
      options: Array.from({ length: 4 }, (_, index) => ({
        label: `Option ${index + 1}`,
        value: String(index),
        description: "Detailed explanation of the option. ".repeat(10),
      })),
      multiSelect: true,
    });
    let outcome: DialogOutcome | undefined;
    const dialog = new QuestionDialog(
      { terminal: { rows }, requestRender() {} } as never,
      fakeTheme(),
      keybindings() as never,
      [...questions, ...makeQuestions({ ...questions[0], id: "second" })],
      (value) => {
        outcome = value;
      },
    );
    dialog.focused = true;
    const check = (label: string) => {
      const lines = dialog.render(width);
      assert.ok(lines.length <= Math.min(Math.floor(rows * 0.85), rows - 2));
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      assert.match(lines[0] ?? "", /─/);
      assert.match(lines.at(-1) ?? "", /─/);
      assert.ok(lines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")));
      assert.ok(
        lines.some((line) => line.includes(`❯ ${label}`)),
        lines.join("\n"),
      );
    };
    for (let index = 0; index < 4; index++) {
      check(`[ ] Option ${index + 1}`);
      dialog.handleInput(" ");
      dialog.handleInput("\u001b[B");
    }
    check("Other");
    dialog.handleInput("\r");
    dialog.handleInput("Free text response wrapped across many lines. ".repeat(30));
    const editing = dialog.render(width);
    assert.ok(editing.length <= Math.floor(rows * 0.85));
    assert.ok(
      editing.some((line) => line.includes(CURSOR_MARKER)),
      "cursor must stay in viewport",
    );
    assert.ok(editing.every((line) => visibleWidth(line) === width));
    dialog.handleInput("\u001b");
    check("Other");
    dialog.handleInput("\u001b[B");
    check("Done");
    dialog.handleInput("\r");
    assert.equal(outcome, undefined);
    for (let index = 0; index < 6; index++) dialog.handleInput("\u001b[B");
    check("Back");
    dialog.handleInput("\r");
    check("[ ] Option 1");
    for (let index = 0; index < 5; index++) dialog.handleInput("\u001b[B");
    dialog.handleInput("\r");
    for (let index = 0; index < 5; index++) dialog.handleInput("\u001b[B");
    dialog.handleInput("\r");
    assert.equal(outcome?.kind, "answered");
  });
}

test("short dialog has no default Text blank padding or wrapped side borders", () => {
  const dialog = new QuestionDialog(fakeTui(), fakeTheme(), keybindings() as never, makeQuestions(), () => {});
  const lines = dialog.render(80);
  assert.equal(lines.length, 10);
  assert.ok(lines.every((line) => visibleWidth(line) === 80));
  assert.ok(lines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")));
});

for (const [width, rows] of [
  [40, 12],
  [20, 8],
]) {
  test(`question paging reads the entire prompt without submitting an offscreen answer in ${width}x${rows}`, () => {
    let outcome: DialogOutcome | undefined;
    const dialog = new QuestionDialog(
      { terminal: { rows }, requestRender() {} } as never,
      fakeTheme(),
      keybindings() as never,
      makeQuestions({ question: `QUESTION-BEGIN ${"Context words. ".repeat(50)}QUESTION-END` }),
      (value) => {
        outcome = value;
      },
    );
    const render = () => {
      const lines = dialog.render(width);
      assert.ok(lines.length <= Math.min(Math.floor(rows * 0.85), rows - 2));
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      return lines.join("\n");
    };
    assert.match(render(), /❯ Fast/);
    assert.doesNotMatch(render(), /QUESTION-BEGIN/);
    for (let page = 0; page < 100; page++) {
      dialog.handleInput("\u001b[5~");
      render();
    }
    assert.match(render(), /QUESTION-BEGIN/);
    assert.match(render(), /QUESTION-BEGIN/, "re-render must not jump back to the answer");
    const seen: string[] = [];
    for (let page = 0; page < 100; page++) {
      seen.push(render());
      dialog.handleInput("\u001b[6~");
    }
    assert.match(seen.join("\n"), /QUESTION-END/);
    assert.match(seen.join("\n"), /Safe/);
    assert.equal(outcome, undefined);
    // Consent is never inferred while reading content away from the selection.
    dialog.handleInput("\r");
    assert.equal(outcome, undefined);
    assert.match(render(), /❯ Fast/);
    dialog.handleInput("\r");
    assert.equal(outcome?.kind, "answered");
    if (outcome?.kind === "answered") {
      const selected = outcome.answers[0]?.selected;
      assert.ok(selected && !Array.isArray(selected));
      assert.equal(selected.index, 0);
    }
  });
}

test("paging does not toggle an offscreen multi-select option", () => {
  const dialog = new QuestionDialog(
    { terminal: { rows: 12 }, requestRender() {} } as never,
    fakeTheme(),
    keybindings() as never,
    makeQuestions({ question: "A long question. ".repeat(50), multiSelect: true }),
    () => {},
  );
  dialog.render(40);
  dialog.handleInput("\u001b[5~");
  dialog.render(40);
  dialog.handleInput(" ");
  assert.match(dialog.render(40).join("\n"), /❯ \[ \] Fast/);
  dialog.handleInput(" ");
  assert.match(dialog.render(40).join("\n"), /❯ \[x\] Fast/);
});
