import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type ExtensionCommandContext,
  InteractiveMode,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import extension from "../index.js";
import { ownedCustom } from "../src/owned-custom.js";

initTheme("dark", false);

// Pi 1.0.4's actual closure captures the draft, restores it synchronously in done,
// and mounts asynchronously. Native navigateTree does not reset this custom UI.
function editorHost() {
  const editor = {
    text: "",
    getText() {
      return this.text;
    },
    setText(text: string) {
      this.text = text;
    },
    render: () => [],
    invalidate() {},
  };
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  let focus: Component = editor;
  let restores = 0;
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    editor,
    defaultEditor: editor,
    editorContainer,
    activeSelector: undefined,
    ui: {
      setFocus: (component: Component) => {
        focus = component;
        if (component === editor) restores++;
      },
      requestRender() {},
    },
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
  }) as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  return {
    editor,
    editorContainer,
    custom: ((factory, options) =>
      host.showExtensionCustom(factory, options)) as ExtensionCommandContext["ui"]["custom"],
    get focus() {
      return focus;
    },
    get restores() {
      return restores;
    },
  };
}

function commandHost() {
  const host = editorHost();
  const handlers = new Map<string, () => void>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const execs: AbortSignal[] = [];
  const notices: string[] = [];
  const sessionManager = SessionManager.inMemory("/tmp");
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "```sh\nprintf hello\n```" }],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  });
  extension({
    on: (name: string, handler: () => void) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: { handler: typeof command }) => {
      command = definition.handler;
    },
    exec: async (_command: string, _args: string[], options: { signal: AbortSignal }) => {
      execs.push(options.signal);
      return { code: 0, stdout: "hello", stderr: "" };
    },
  } as never);
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    sessionManager,
    ui: {
      custom: host.custom,
      confirm: async () => true,
      getEditorText: () => host.editor.text,
      setEditorText: (text: string) => host.editor.setText(text),
      notify: (text: string) => notices.push(text),
    },
  } as unknown as ExtensionCommandContext;
  return {
    ...host,
    host,
    ctx,
    command,
    execs,
    notices,
    emit: (event: string) => {
      const handler = handlers.get(event);
      assert.ok(handler, event);
      handler();
    },
  };
}

const boundaries = [
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_tree",
  "session_start",
  "session_shutdown",
];

async function mounted(host: ReturnType<typeof editorHost>) {
  for (let i = 0; i < 8 && host.editorContainer.children[0] === host.editor; i++) await Promise.resolve();
  const component = host.editorContainer.children[0];
  assert.ok(component && component !== host.editor, "custom component mounted");
  return component;
}

for (const boundary of boundaries) {
  for (const args of ["last", "last run 1"]) {
    test(`${boundary} synchronously closes ${args} before a same-manager fresh draft; retained input is inert`, async () => {
      const fixture = commandHost();
      const manager = fixture.ctx.sessionManager;
      const pending = fixture.command(args, fixture.ctx);
      const old = await mounted(fixture.host);
      const retainedInput = old.handleInput;
      fixture.emit(boundary);
      // Assert before any await: retiring a dialog must restore the captured empty
      // draft now, not overwrite the tree target's user message in a continuation.
      assert.deepEqual(fixture.host.editorContainer.children, [fixture.host.editor]);
      assert.equal(fixture.host.focus, fixture.host.editor);
      assert.equal(fixture.host.restores, 1);
      fixture.host.editor.setText("tree target user message");
      await pending; // Includes shutdown with no keyboard reply.
      assert.equal(fixture.ctx.sessionManager, manager);
      const replacement = { render: () => [], invalidate() {} };
      let closeReplacement!: () => void;
      const next = fixture.host.custom<void>((_tui, _theme, _keys, done) => {
        closeReplacement = () => done();
        return replacement;
      });
      await Promise.resolve();
      retainedInput?.("\r");
      old.handleInput?.("\u001b");
      old.handleInput?.("\t");
      old.invalidate();
      assert.deepEqual(old.render(100), []);
      await Promise.resolve();
      assert.deepEqual(fixture.host.editorContainer.children, [replacement]);
      assert.equal(fixture.host.focus, replacement);
      assert.equal(fixture.host.restores, 1);
      assert.equal(fixture.host.editor.text, "tree target user message");
      assert.deepEqual(fixture.notices, []);
      assert.equal(fixture.execs.length, args.includes("run") ? 1 : 0);
      closeReplacement();
      await next;
    }, 1000);
  }
}

for (const preMount of [false, true]) {
  test(`owned custom guards captured done and disposes exactly once (${preMount ? "before" : "after"} mount)`, async () => {
    const host = editorHost();
    const controller = new AbortController();
    const owner = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
    let retainedDone!: (result: string) => void;
    let disposals = 0;
    let inputs = 0;
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => {
      added++;
      add(...args);
    };
    controller.signal.removeEventListener = (...args) => {
      removed++;
      remove(...args);
    };
    let retainedRawDone!: (value: unknown) => void;
    const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
      host.custom((tui, theme, keys, rawDone) => {
        retainedRawDone = rawDone;
        return factory(tui, theme, keys, rawDone);
      }, options);
    const ctx = { mode: "tui", hasUI: true, ui: { custom } } as ExtensionCommandContext;
    const pending = ownedCustom<string>(ctx, owner, (_tui, _theme, _keys, done) => {
      retainedDone = done;
      return {
        render: () => [],
        invalidate() {},
        handleInput: () => inputs++,
        dispose: () => disposals++,
      };
    });
    const old = preMount ? undefined : await mounted(host);
    controller.abort();
    assert.equal(host.restores, 1);
    host.editor.setText("replacement draft");
    assert.equal(await pending, undefined);
    let close!: () => void;
    const replacement = { render: () => [], invalidate() {} };
    const next = host.custom<void>((_tui, _theme, _keys, done) => {
      close = () => done();
      return replacement;
    });
    await Promise.resolve();
    retainedDone("stale completion");
    retainedRawDone("already closed SDK callback");
    old?.handleInput?.("\r");
    assert.equal(inputs, 0);
    assert.equal(disposals, 1);
    assert.equal(added, 1);
    assert.equal(removed, added);
    assert.deepEqual(host.editorContainer.children, [replacement]);
    assert.equal(host.editor.text, "replacement draft");
    assert.equal(host.restores, 1);
    close();
    await next;
  }, 1000);
}

test("normal picker appends to the TUI draft and run pane closes normally", async () => {
  const fixture = commandHost();
  fixture.host.editor.setText("existing draft");
  const inserting = fixture.command("last", fixture.ctx);
  (await mounted(fixture.host)).handleInput?.("\t");
  await inserting;
  assert.equal(fixture.host.editor.text, "existing draft\nprintf hello");
  assert.deepEqual(fixture.notices, ["Inserted snippet into editor."]);
  const running = fixture.command("last run 1", fixture.ctx);
  const pane = await mounted(fixture.host);
  assert.match(pane.render(100).join("\n"), /hello/);
  pane.handleInput?.("\r");
  await running;
  assert.equal(fixture.host.editor.text, "existing draft\nprintf hello");
  assert.equal(fixture.host.restores, 2);
});
