import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import history from "../src/index.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "history-safety-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

function boot(sessionManager: Pick<SessionManager, "getSessionDir" | "getCwd">, composing = false) {
  const tui = { requestRender() {} } as unknown as TUI;
  const theme = { borderColor: (text: string) => text } as Parameters<EditorFactory>[1];
  const keybindings = { matches: () => false } as unknown as Parameters<EditorFactory>[2];
  let active: EditorComponent = new CustomEditor(tui, theme, keybindings);
  let inheritedCalls = 0;
  let factory: EditorFactory | undefined = composing
    ? () => {
        inheritedCalls++;
        // The prior editor factory remains the owner of its instance/behavior.
        return new CustomEditor(tui, theme, keybindings);
      }
    : undefined;
  const mounted: EditorComponent[] = [];
  const replacements: EditorComponent[] = [];
  const ctx = {
    cwd: sessionManager.getCwd(),
    mode: "tui",
    hasUI: true,
    sessionManager,
    ui: {
      getEditorComponent: () => factory,
      setEditorComponent: (next: EditorFactory) => {
        factory = next;
        const text = active.getText(); // Pi's native replacement copies only getText().
        active = next(tui, theme, keybindings);
        active.setText(text);
        replacements.push(active);
        mounted.push(active);
      },
    },
  } as unknown as ExtensionContext;
  const events = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  history({
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => events.set(name, handler),
    registerShortcut() {},
  } as never);
  return {
    start: (context = ctx) => events.get("session_start")?.({} as never, context),
    getActive: () => active,
    createEditor: () => {
      assert.ok(factory);
      const editor = factory(tui, theme, keybindings);
      mounted.push(editor);
      return editor;
    },
    getInheritedCalls: () => inheritedCalls,
    mounted,
    replacements,
  };
}

function sessionFile(dir: string, cwd: string, text: string, version = 3) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${text}.jsonl`);
  // Deliberately no final newline. v1 entries also need in-memory migration.
  const bytes = [
    { type: "session", version, id: "session", timestamp: "2026-01-01T00:00:00Z", cwd },
    {
      type: "message",
      ...(version >= 2 ? { id: "message", parentId: null } : {}),
      timestamp: "2026-01-01T00:01:00Z",
      message: { role: "user", content: text, timestamp: 1 },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  writeFileSync(path, bytes);
  return { path, bytes: Buffer.from(bytes) };
}

for (const composing of [false, true]) {
  test(`a deferred scan populates real editors without dropping a large paste (composition=${composing})`, async () => {
    const session = SessionManager.create(directory, join(directory, "sessions"));
    const recorded = sessionFile(session.getSessionDir(), directory, "remembered");
    let resolve!: (sessions: Awaited<ReturnType<typeof SessionManager.list>>) => void;
    const scan = new Promise<Awaited<ReturnType<typeof SessionManager.list>>>((done) => {
      resolve = done;
    });
    vi.spyOn(SessionManager, "list").mockReturnValue(scan);
    const fixture = boot(session, composing);
    fixture.start();
    assert.equal(fixture.replacements.length, 1); // Installed before any asynchronous scan result.
    const editor = fixture.getActive();
    assert.ok(editor instanceof CustomEditor);
    const sibling = fixture.createEditor();
    const populate = vi.spyOn(editor, "addToHistory");
    const populateSibling = vi.spyOn(sibling, "addToHistory");
    const paste = "large paste line\n".repeat(100);
    editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
    assert.notEqual(editor.getText(), paste);
    assert.equal(editor.getExpandedText(), paste);

    resolve([{ path: recorded.path, modified: new Date() }] as Awaited<ReturnType<typeof SessionManager.list>>);
    await vi.waitFor(() => assert.equal(populate.mock.calls.length, 1));
    assert.deepEqual(populate.mock.calls, [["remembered"]]);
    assert.deepEqual(populateSibling.mock.calls, [["remembered"]]);
    assert.equal(fixture.replacements.length, 1);
    assert.equal(fixture.getActive(), editor);
    assert.equal(editor.getExpandedText(), paste);
    if (composing) assert.equal(fixture.getInheritedCalls(), 2);

    const later = fixture.createEditor();
    later.handleInput("\x1b[A");
    assert.equal(later.getText(), "remembered"); // Factory also seeds instances created after the scan.
  });
}

test("historical legacy and missing-newline sessions are inspected without changing their bytes", async () => {
  const session = SessionManager.create(directory, join(directory, "sessions"));
  const legacy = sessionFile(session.getSessionDir(), directory, "legacy prompt", 1);
  const current = sessionFile(session.getSessionDir(), directory, "current prompt");
  const open = vi.spyOn(SessionManager, "open");
  const fixture = boot(session);
  fixture.start();
  const populate = vi.spyOn(fixture.getActive(), "addToHistory");
  await vi.waitFor(() => assert.equal(populate.mock.calls.length, 2));
  assert.deepEqual(new Set(populate.mock.calls.map(([text]) => text)), new Set(["legacy prompt", "current prompt"]));
  assert.equal(open.mock.calls.length, 0);
  assert.deepEqual(readFileSync(legacy.path), legacy.bytes);
  assert.deepEqual(readFileSync(current.path), current.bytes);
});

for (const custom of [false, true]) {
  test(`history selects only the active session store (custom=${custom})`, async () => {
    const defaultSession = SessionManager.create(directory);
    const customSession = SessionManager.create(directory, join(directory, "custom-sessions"));
    sessionFile(defaultSession.getSessionDir(), directory, "default prompt");
    sessionFile(customSession.getSessionDir(), directory, "custom prompt");
    sessionFile(customSession.getSessionDir(), join(directory, "other-cwd"), "other project prompt");
    const session = custom ? customSession : defaultSession;
    const list = vi.spyOn(SessionManager, "list");
    const fixture = boot(session);
    fixture.start();
    const populate = vi.spyOn(fixture.getActive(), "addToHistory");
    await vi.waitFor(() => assert.equal(populate.mock.calls.length, 1));
    assert.deepEqual(populate.mock.calls, [[custom ? "custom prompt" : "default prompt"]]);
    assert.deepEqual(list.mock.calls, [[directory, session.getSessionDir()]]);
  });
}

for (const mode of ["print", "rpc"]) {
  test(`${mode} sessions never scan history or install an editor even with a UI bridge`, () => {
    const list = vi.spyOn(SessionManager, "list");
    const fixture = boot(SessionManager.create(directory));
    fixture.start({ mode, hasUI: true } as ExtensionContext);
    assert.equal(list.mock.calls.length, 0);
    assert.equal(fixture.replacements.length, 0);
  });
}
