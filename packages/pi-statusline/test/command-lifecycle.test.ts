import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionEditorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { ownedCustom } from "../src/command-owner.js";
import statusline from "../src/statusline.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark", false);

test.each(
  (["tree", "shutdown"] as const).flatMap((boundary) =>
    (["appearance", "layout", "editor"] as const).map((dialog) => [boundary, dialog] as const),
  ),
)("%s retires pending statusline %s without writes or late runtime changes", async (boundary, dialog) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-statusline-command-owner-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const path = join(directory, "pi-statusline.json");
  const document = '{"palettePreset":"classic","segments":["model"]}\n';
  writeFileSync(path, document);
  const mock = createMockPi();
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    model: { id: "model", provider: "test" },
    select: async (title: string, choices: string[]) => {
      if (title.includes("Advanced")) return choices[0];
      return dialog === "appearance" ? choices[0] : choices[2];
    },
    custom: async (factory: unknown) => {
      harness = createCustomSelectorHarness(factory);
      opened();
      return harness.resultPromise;
    },
  });
  const emit = async (event: string) => {
    for (const handler of mock.events.get(event) ?? []) await handler({}, context.ctx);
  };
  type Footer = { render(width: number): string[]; dispose(): void };
  let footer: Footer | undefined;
  const createFooter = () => {
    footer = (context.footer as (...args: unknown[]) => Footer)(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => undefined },
    );
  };
  const render = () => footer?.render(200);
  try {
    statusline(mock.pi);
    await emit("session_start");
    createFooter();
    const before = render();
    const pending = mock.commands.get("statusline")?.handler(dialog === "editor" ? "settings" : "", context.ctx);
    await ready;
    if (boundary === "tree") {
      await emit("session_before_tree");
      await emit("session_tree"); // Same sessionManager identity, new command owner.
      footer?.dispose();
      createFooter();
    } else {
      await emit("session_shutdown");
    }
    await pending; // No dialog response is needed to settle.
    const notifications = context.notifications.length;
    const afterBoundary = render();
    assert.deepEqual(afterBoundary, before);
    if (dialog === "editor") {
      assert.ok(harness?.component instanceof ExtensionEditorComponent);
      const editor = harness.component.children.find((child) => child instanceof Editor);
      assert.ok(editor instanceof Editor);
      editor.onSubmit?.('{"palettePreset":"forest","segments":[]}');
    } else {
      harness?.handleInput("tui.select.down");
      harness?.handleInput("tui.select.confirm"); // A late yes must not save/preview.
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(readFileSync(path, "utf8"), document);
    assert.deepEqual(render(), afterBoundary);
    assert.equal(context.notifications.length, notifications);
  } finally {
    await emit("session_shutdown");
    footer?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("raw custom cancellation closes synchronously once and disposes once despite late completion", async () => {
  const controller = new AbortController();
  let closed = 0;
  let disposed = 0;
  let complete!: (value: string) => void;
  let component: { dispose(): void } | undefined;
  const context = createMockContext({
    custom: async (factory: unknown) =>
      new Promise((resolve) => {
        component = (factory as (...args: unknown[]) => { dispose(): void })({}, {}, {}, (value: unknown) => {
          closed++;
          resolve(value);
        });
      }),
  });
  const pending = ownedCustom(context.ctx, { signal: controller.signal, isCurrent: () => true })(
    (_tui, _theme, _keys, done) => {
      complete = done;
      return {
        render: () => [],
        invalidate() {},
        dispose: () => {
          disposed++;
        },
      };
    },
  );
  controller.abort();
  assert.equal(closed, 1); // Before abort returns, not in a later promise continuation.
  assert.equal(disposed, 1);
  complete("late save");
  component?.dispose();
  assert.equal(closed, 1);
  assert.equal(disposed, 1);
  assert.equal(await pending, undefined);
});
