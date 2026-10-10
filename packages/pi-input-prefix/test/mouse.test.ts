import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import extension from "../src/index.js";

function editor(
  rows = 40,
  previousFactory?: (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor,
): CustomEditor {
  let create: ((ctx: ExtensionContext) => void) | undefined;
  extension({
    on: (_event: string, handler: (_event: unknown, ctx: ExtensionContext) => void) => {
      create = (ctx) => handler({}, ctx);
    },
  } as ExtensionAPI);
  let instance: CustomEditor | undefined;
  const identity = (s: string) => s;
  const theme = {
    borderColor: identity,
    selectList: {
      selectedText: identity,
      selectedPrefix: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  } as EditorTheme;
  create?.({
    mode: "tui",
    ui: {
      getEditorComponent: () => previousFactory,
      setEditorComponent(factory: (tui: TUI, theme: EditorTheme, kb: KeybindingsManager) => CustomEditor) {
        instance = factory({ terminal: { rows }, requestRender() {} } as TUI, theme, {
          matches: () => false,
        } as unknown as KeybindingsManager);
      },
    },
  } as unknown as ExtensionContext);
  assert.ok(instance);
  return instance;
}

function click(instance: CustomEditor, width: number, x: number, y = 1, type: TuiMouseEvent["type"] = "click") {
  return instance.handleMouse({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: instance.render(width).length,
    shift: false,
    alt: false,
    ctrl: false,
  });
}

test("composes inherited view hooks without replacing native identity or editing state", () => {
  class InheritedEditor extends CustomEditor {
    #calls: string[] = [];
    #lastMouseX = -1;

    get calls(): string[] {
      return this.#calls;
    }

    get lastMouseX(): number {
      return this.#lastMouseX;
    }

    setPaddingX(padding: number): void {
      this.#calls.push(`padding:${padding}`);
      super.setPaddingX(padding);
    }

    protected renderTopBorder(width: number, hiddenLineCount: number): string {
      this.#calls.push(`top:${hiddenLineCount}`);
      const border = super.renderTopBorder(width, hiddenLineCount);
      return `${border.slice(0, 2)}owner${border.slice(7)}`;
    }

    render(width: number): string[] {
      this.#calls.push("render");
      return super.render(width);
    }

    handleMouse(event: TuiMouseEvent) {
      this.#lastMouseX = event.x;
      return super.handleMouse(event);
    }
  }
  const originalRender = InheritedEditor.prototype.render;
  let native: InheritedEditor | undefined;
  const instance = editor(40, (tui, theme, keybindings) => {
    keybindings.matches = (data, action) => data === "\x03" && action === "app.clear";
    native = new InheritedEditor(tui, theme, keybindings);
    native.handleInput(`\x1b[200~${"private ".repeat(200)}\x1b[201~`);
    return native;
  });
  assert.equal(instance, native);
  assert.equal(InheritedEditor.prototype.render, originalRender, "only instance view methods are decorated");
  assert.equal(instance.getExpandedText(), "private ".repeat(200));
  instance.setPaddingX(0);
  assert.equal(instance.getPaddingX(), 4);
  instance.setPaddingX(8);
  assert.equal(instance.getPaddingX(), 8);
  assert.deepEqual(native?.calls.slice(0, 3), ["padding:4", "padding:4", "padding:8"]);
  instance.setPaddingX(4);
  instance.setText("!git");
  click(instance, 30, 4);
  assert.equal(native?.lastMouseX, 5);
  assert.ok(native?.calls.includes("render"));
  assert.ok(native?.calls.includes("top:0"));
  assert.ok(stripVTControlCharacters(instance.render(30)[0] ?? "").includes("owner"));
  assert.deepEqual(instance.getCursor(), { line: 0, col: 1 });

  // The native app shortcut map is still used by the unchanged input handler.
  let handled = 0;
  instance.onExtensionShortcut = (data) => {
    if (data !== "custom shortcut") return false;
    handled++;
    return true;
  };
  instance.handleInput("custom shortcut");
  assert.equal(handled, 1);
  assert.equal(instance.getText(), "!git");
  instance.onAction("app.clear", () => handled++);
  instance.handleInput("\x03");
  assert.equal(handled, 2, "native input still uses its original keybindings and action map");
  assert.equal(instance.getText(), "!git");
  assert.equal(
    editor(40, () => instance),
    instance,
    "singleton factories are decorated only once",
  );
  click(instance, 30, 4);
  assert.equal(native?.lastMouseX, 5);
  assert.deepEqual(instance.getCursor(), { line: 0, col: 1 });
});

test("an editor without the native border hook keeps shell content and its mouse geometry", () => {
  let receivedX = -1;
  const original = {
    getText: () => "!git",
    setText() {},
    handleInput() {},
    invalidate() {},
    render: () => ["─".repeat(30), `    !git${" ".repeat(22)}`, "─".repeat(30)],
    handleMouse: (event: TuiMouseEvent) => {
      receivedX = event.x;
      return { handled: true };
    },
  };
  const instance = editor(40, () => original as unknown as CustomEditor);
  assert.equal(instance, original);
  assert.equal(stripVTControlCharacters(instance.render(30)[1] ?? "")[4], "!");
  assert.deepEqual(click(instance, 30, 4), { handled: true });
  assert.equal(receivedX, 4, "without scroll information, do not detach or remap a bang");
});

test("older editor runtimes without mouse handling remain usable", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Editor.prototype, "handleMouse");
  assert.ok(descriptor);
  try {
    Object.defineProperty(Editor.prototype, "handleMouse", { ...descriptor, value: undefined });
    const instance = editor();
    instance.setText("!git");
    assert.equal(click(instance, 30, 4), undefined);
    instance.handleInput("x");
    assert.equal(instance.getText(), "!gitx");
  } finally {
    Object.defineProperty(Editor.prototype, "handleMouse", descriptor);
  }
});

test("delegates to the inherited handler with the editor receiver and preserves its result", () => {
  const result = { handled: true, capture: true, focus: true, render: false };
  let receiver: Editor | undefined;
  let received: TuiMouseEvent | undefined;
  const spy = vi.spyOn(Editor.prototype, "handleMouse").mockImplementation(function (this: Editor, event) {
    receiver = this;
    received = event;
    return result;
  });
  try {
    const instance = editor();
    instance.setText("!git");
    assert.equal(click(instance, 30, 4), result);
    assert.equal(receiver, instance);
    assert.equal(received?.x, 5);
    assert.equal(spy.mock.calls.length, 1);
  } finally {
    spy.mockRestore();
  }
});

test("normal prefix and slash clicks retain native buffer positions", () => {
  const instance = editor();
  for (const text of ["hello", "/help", ""]) {
    instance.setText(text);
    click(instance, 30, 4);
    assert.deepEqual(instance.getCursor(), { line: 0, col: 0 });
    click(instance, 30, 2);
    assert.equal(instance.getCursor().col, 0);
  }
});

test("shell clicks target the displayed command, with bang still editable from its prompt", () => {
  const instance = editor();
  instance.setText("!git status");
  assert.equal(stripVTControlCharacters(instance.render(30)[1] ?? "")[4], "g");
  assert.deepEqual(click(instance, 30, 4), { handled: true, focus: true });
  assert.equal(instance.getCursor().col, 1);
  click(instance, 30, 6);
  assert.equal(instance.getCursor().col, 3);
  click(instance, 30, 2);
  assert.equal(instance.getCursor().col, 0);
  instance.setText("!!ls");
  click(instance, 30, 4);
  assert.equal(instance.getCursor().col, 1);
  instance.setText("!界x");
  click(instance, 30, 5);
  assert.equal(instance.getCursor().col, 1);
});

test("only a detached row is translated, not wrapped or subsequent logical rows", () => {
  const instance = editor();
  instance.setText("!abcdefghijk\nsecond");
  click(instance, 14, 4, 2);
  assert.deepEqual(instance.getCursor(), { line: 0, col: 6 });
  click(instance, 14, 4, 3);
  assert.deepEqual(instance.getCursor(), { line: 1, col: 0 });
  click(instance, 14, 4, 1);
  assert.equal(instance.getCursor().col, 1);
});

test("a scrolled-off leading bang does not detach a later logical bang or remap its click", () => {
  const instance = editor(10);
  instance.setText("!echo\n!printf foo\n3\n4\n5\n6");
  const firstVisible = stripVTControlCharacters(instance.render(30)[1] ?? "");
  assert.equal(firstVisible[2], "!", "shell mode still owns the prompt glyph");
  assert.equal(firstVisible[4], "!", "the second logical bang stays in the editable content");
  assert.deepEqual(click(instance, 30, 4), { handled: true, focus: true });
  assert.deepEqual(instance.getCursor(), { line: 1, col: 0 });
  // Returning to the semantic first row restores the detached prompt mapping.
  instance.setText("!echo");
  assert.equal(stripVTControlCharacters(instance.render(30)[1] ?? "")[4], "e");
  click(instance, 30, 4);
  assert.deepEqual(instance.getCursor(), { line: 0, col: 1 });
});

test("shell autocomplete rows retain their own mouse selection geometry", async () => {
  vi.useFakeTimers();
  const instance = editor();
  instance.setAutocompleteProvider({
    triggerCharacters: ["!"],
    getSuggestions: () => ({
      prefix: "!",
      items: [
        { value: "!git", label: "git" },
        { value: "!ls", label: "ls" },
      ],
    }),
    applyCompletion: (_lines, _line, _col, item) => ({
      lines: [item.value],
      cursorLine: 0,
      cursorCol: item.value.length,
    }),
  });
  instance.handleInput("!");
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(instance.isShowingAutocomplete(), true);
  assert.deepEqual(click(instance, 30, 4, 4), { handled: true, focus: true });
  assert.equal(instance.getText(), "!ls");
  assert.equal(instance.getCursor().col, 3);
});

test("narrow widths without a detached bang keep native hit-testing; drag stays unhandled", () => {
  const instance = editor();
  for (const width of [1, 2, 3, 5, 7, 8]) {
    instance.setText("!git");
    // Move to start so the first row stays visible even at one-column width.
    click(instance, width, 0);
    const padding = Math.min(4, Math.max(0, Math.floor((width - 1) / 2)));
    click(instance, width, padding);
    assert.equal(instance.getCursor().col, 0, `width ${width}`);
  }
  instance.setText("!git status");
  for (const type of ["press", "drag", "release", "wheel"] as const) {
    assert.equal(click(instance, 30, 4, 1, type), undefined);
    assert.equal(instance.getCursor().col, 11);
  }
});
