import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import history, { HistoryPopupComponent } from "../packages/pi-input-history/src/index.js";
import prefix from "../packages/pi-input-prefix/src/index.js";
import { resolvePromptMarker } from "../packages/pi-input-prefix/src/render.js";

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
type SessionList = Awaited<ReturnType<typeof SessionManager.list>>;

function host(order: Array<typeof history>, recordSubmissions = false) {
  const identity = (text: string) => text;
  const theme: EditorTheme = {
    borderColor: identity,
    selectList: {
      selectedText: identity,
      selectedPrefix: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  };
  const tui = { terminal: { rows: 40 }, requestRender() {} } as TUI;
  const keybindings = { matches: () => false } as unknown as KeybindingsManager;
  const submitted: string[] = [];
  const defaultEditor = new CustomEditor(tui, theme, keybindings);
  defaultEditor.onSubmit = (text) => {
    submitted.push(text);
    if (recordSubmissions) visible.addToHistory?.(text);
  };
  const changed = vi.fn();
  defaultEditor.onChange = changed;
  const clear = vi.fn();
  defaultEditor.onAction("app.clear", clear);
  let visible: EditorComponent = defaultEditor;
  let factory: EditorFactory;
  let mounts = 0;
  const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void>>();
  let shortcut: ((ctx: ExtensionContext) => Promise<void>) | undefined;
  let popup: HistoryPopupComponent | undefined;
  const pi = {
    on(event: string, handler: (event: never, ctx: ExtensionContext) => void) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerShortcut(_key: string, registered: { handler: (ctx: ExtensionContext) => Promise<void> }) {
      shortcut = registered.handler;
    },
  } as unknown as ExtensionAPI;
  for (const extension of order) extension(pi);

  const sessionDir = mkdtempSync(join(tmpdir(), "history-prefix-"));
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: sessionDir,
    sessionManager: { getSessionDir: () => sessionDir, getBranch: () => [] },
    ui: {
      getEditorComponent: () => factory,
      setEditorText: (text: string) => visible.setText(text),
      custom: (create: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
        new Promise((resolve) => {
          const component = create(
            tui,
            { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as never,
            keybindings,
            resolve,
          );
          assert.ok(component instanceof HistoryPopupComponent);
          popup = component;
        }),
      // Mirror Pi's synchronous mounting and copying, not a factory-only stub.
      setEditorComponent(next: EditorFactory) {
        factory = next;
        const text = visible.getText();
        visible = next?.(tui, theme, keybindings) ?? defaultEditor;
        visible.onSubmit = defaultEditor.onSubmit;
        visible.onChange = defaultEditor.onChange;
        visible.setText(text);
        visible.borderColor = defaultEditor.borderColor;
        visible.setPaddingX?.(defaultEditor.getPaddingX());
        visible.setAutocompleteMaxVisible?.(defaultEditor.getAutocompleteMaxVisible());
        if (visible instanceof CustomEditor) {
          for (const [action, handler] of defaultEditor.actionHandlers) visible.actionHandlers.set(action, handler);
          visible.focused = true;
        }
        mounts++;
      },
    },
  } as unknown as ExtensionContext;

  return {
    start: () => {
      for (const handler of handlers.get("session_start") ?? []) handler({} as never, ctx);
    },
    cleanup: () => {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({} as never, ctx);
      rmSync(sessionDir, { recursive: true, force: true });
    },
    sessionDir,
    submitted,
    changed,
    clear,
    search: () => {
      assert.ok(shortcut);
      return shortcut(ctx);
    },
    get popup() {
      return popup;
    },
    get visible() {
      return visible;
    },
    get mounts() {
      return mounts;
    },
  };
}

for (const [name, order] of [
  ["history → prefix", [history, prefix]],
  ["prefix → history", [prefix, history]],
] as const) {
  test(`${name}: one fresh native submission survives 100 deferred old entries without remounting`, async () => {
    let resolve!: (sessions: SessionList) => void;
    const scan = new Promise<SessionList>((done) => {
      resolve = done;
    });
    vi.spyOn(SessionManager, "list").mockReturnValue(scan);
    const fixture = host([...order], true);
    try {
      const path = join(fixture.sessionDir, "previous.jsonl");
      writeFileSync(
        path,
        Array.from({ length: 100 }, (_, index) =>
          JSON.stringify({ type: "message", message: { role: "user", content: `old prompt ${index}` } }),
        ).join("\n"),
      );
      fixture.start();
      const live = fixture.visible;
      assert.ok(live instanceof CustomEditor);
      const submit = live.onSubmit;
      const change = live.onChange;
      const seed = vi.spyOn(live, "addToHistory");
      live.handleInput("fresh submission");
      live.handleInput("\r");
      assert.deepEqual(fixture.submitted, ["fresh submission"]);
      assert.deepEqual(seed.mock.calls, [["fresh submission"]]);
      const paste = "private draft paste ".repeat(100);
      live.handleInput(`\x1b[200~${paste}`); // Scan finishes mid-bracketed paste.
      const search = fixture.search();
      resolve([{ path, modified: new Date("2026-01-01") }] as SessionList);
      await vi.waitFor(() => assert.ok(fixture.popup));
      assert.ok(fixture.popup?.render(100).some((line) => line.includes("old prompt 99")));
      assert.ok(
        fixture.popup?.render(100).some((line) => line.includes("1/100")),
        "Ctrl+R retains the full cache",
      );
      fixture.popup?.handleInput("\x1b");
      await search;
      assert.equal(fixture.mounts, 2);
      assert.equal(fixture.visible, live);
      assert.equal(live.onSubmit, submit);
      assert.equal(live.onChange, change);
      assert.equal(live.actionHandlers.get("app.clear"), fixture.clear);
      live.handleInput("\x1b[201~");
      assert.equal(live.getExpandedText(), paste);
      live.setText("");
      live.handleInput("\x1b[A");
      assert.equal(live.getText(), "fresh submission");
      live.handleInput("\x1b[A");
      assert.equal(live.getText(), "fresh submission", "all 100 old entries were skipped");
      assert.deepEqual(seed.mock.calls, [["fresh submission"]], "used native history must not be seeded");
      assert.ok(fixture.changed.mock.calls.length > 0);
    } finally {
      fixture.cleanup();
    }
  });

  for (const splitPaste of [false, true]) {
    test(`${name}: deferred history seeds the visible editor without remounting ${splitPaste ? "an in-flight" : "a stored"} large paste`, async () => {
      let resolve!: (sessions: SessionList) => void;
      const scan = new Promise<SessionList>((done) => {
        resolve = done;
      });
      const list = vi.spyOn(SessionManager, "list").mockReturnValue(scan);
      const fixture = host([...order]);
      try {
        const path = join(fixture.sessionDir, "previous.jsonl");
        writeFileSync(
          path,
          ["older prompt", "newer prompt"]
            .map((text) => JSON.stringify({ type: "message", message: { role: "user", content: text } }))
            .join("\n"),
        );
        fixture.start();
        assert.equal(list.mock.calls.length, 1);
        assert.equal(fixture.mounts, 2);
        const live = fixture.visible;
        assert.ok(live instanceof CustomEditor, "the native editor keeps its full API");
        assert.equal(live.getPaddingX(), 4, "host default padding cannot erase the prefix floor");
        const seed = vi.spyOn(live, "addToHistory");
        const paste = "private paste content ".repeat(100);
        live.handleInput("draft ");
        live.handleInput(`\x1b[200~${paste}${splitPaste ? "" : "\x1b[201~"}`);
        const pendingText = live.getText();
        if (!splitPaste) {
          assert.match(pendingText, /\[paste #1/);
          assert.equal(live.getExpandedText(), `draft ${paste}`);
        }

        resolve([{ path, modified: new Date("2026-01-01") }] as SessionList);
        await vi.waitFor(() => assert.equal(seed.mock.calls.length, 2));
        assert.deepEqual(
          seed.mock.calls.map(([text]) => text),
          ["older prompt", "newer prompt"],
        );
        assert.equal(fixture.mounts, 2, "I/O must not reinstall a factory or remount the draft");
        assert.equal(fixture.visible, live, "history and prefix retain the same native receiver");
        assert.equal(live.getText(), pendingText);
        if (splitPaste) live.handleInput("\x1b[201~");
        assert.equal(live.getExpandedText(), `draft ${paste}`);
        assert.ok(stripVTControlCharacters(live.render(80)[0] ?? "").startsWith("╭"));
        assert.equal(
          stripVTControlCharacters(live.render(80)[1] ?? "")[2],
          resolvePromptMarker(process.env.PI_INPUT_PREFIX),
        );
        live.handleInput("\r");
        assert.deepEqual(fixture.submitted, [`draft ${paste}`.trim()], "submission expands native private pastes");

        // Actual arrow navigation on the visible editor, not the scan's cache.
        live.handleInput("\x1b[A");
        assert.equal(live.getText(), "newer prompt");
        live.handleInput("\x1b[A");
        assert.equal(live.getText(), "older prompt");
        live.handleInput("\x1b[B");
        assert.equal(live.getText(), "newer prompt");
        live.handleInput("\x1b[B");
        assert.equal(live.getText(), "");
      } finally {
        fixture.cleanup();
      }
    });
  }
}
