import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserController } from "../browser.js";
import { loadFileContent } from "../file-viewer.js";
import * as git from "../git.js";
import extension from "../index.js";
import * as utils from "../utils.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function harness() {
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const events = new Map<string, (event: never, ctx: never) => unknown>();
  const notices: Array<{ text: string; type: string }> = [];
  let customCalls = 0;
  extension({
    registerCommand: (name: string, command: never) => commands.set(name, command),
    on: (name: string, handler: never) => events.set(name, handler),
  } as never);
  const ctx = {
    cwd: tmpdir(),
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (text: string, type: string) => notices.push({ text, type }),
      custom: async () => {
        customCalls++;
      },
    },
  };
  const command = commands.get("readfiles");
  const start = events.get("session_start");
  assert.ok(command);
  assert.ok(start);
  return {
    ctx,
    notices,
    get customCalls() {
      return customCalls;
    },
    open: () => command.handler("", ctx as never),
    start: () => start({} as never, ctx as never),
  };
}

for (const missing of [["bat"], ["delta"], ["glow"], ["bat", "delta", "glow"]]) {
  test(`missing ${missing.join("/")} warns once at startup and never blocks repeated /readfiles`, async () => {
    const deps = spyOn(utils, "hasCommand").mockImplementation((name) => !missing.includes(name));
    const h = harness();
    try {
      await h.start();
      assert.equal(h.notices.length, 1);
      assert.equal(h.notices[0].type, "warning");
      assert.match(h.notices[0].text, /optional|fallback|plain.text/i);
      for (const name of missing) assert.ok(h.notices[0].text.includes(name));
      await h.open();
      await h.open();
      await h.start();
      assert.equal(h.customCalls, 2);
      assert.equal(h.notices.length, 1, "startup and repeated commands share a single warning");
    } finally {
      deps.mockRestore();
    }
  });
}

test("/readfiles without startup still opens the real browser and renders numbered plain Markdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "optional-tools-browser-"));
  writeFileSync(join(root, "readme.md"), "# Plain source\nSecond source line");
  const deps = spyOn(utils, "hasCommand").mockReturnValue(false);
  const h = harness();
  h.ctx.cwd = root;
  let component: BrowserController | undefined;
  let done: (() => void) | undefined;
  let opened = false;
  h.ctx.ui.custom = async (factory?: unknown) => {
    assert.equal(typeof factory, "function");
    component = (factory as (...args: unknown[]) => BrowserController)({ requestRender() {} }, theme, {}, () => {});
    opened = true;
    // q in the browser owns interval cleanup as well as browser disposal.
    done = () => {
      component?.handleInput("q");
      component?.handleInput("q");
    };
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (component.render(100).some((line) => line.includes("readme.md"))) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(component.render(100).some((line) => line.includes("readme.md")));
      component.handleInput("\r");
      const rows = component.render(100);
      assert.match(rows[0], /\[RAW\]/);
      assert.ok(rows.includes("   1 │ # Plain source"));
      assert.ok(rows.includes("   2 │ Second source line"));
    } finally {
      done();
    }
  };
  try {
    await h.open();
    assert.equal(opened, true, "missing tools must not prevent ctx.ui.custom");
    await h.open();
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].type, "warning");
  } finally {
    done?.();
    component?.dispose();
    deps.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed tools do not warn or block /readfiles", async () => {
  const deps = spyOn(utils, "hasCommand").mockReturnValue(true);
  const h = harness();
  try {
    await h.start();
    await h.open();
    assert.equal(h.customCalls, 1);
    assert.deepEqual(h.notices, []);
  } finally {
    deps.mockRestore();
  }
});

for (const [mode, hasUI] of [
  ["rpc", false],
  ["rpc", true],
  ["print", false],
  ["tui", false],
] as const) {
  test(`${mode} with hasUI=${hasUI} never probes optional tools or opens terminal UI`, async () => {
    const deps = spyOn(utils, "hasCommand").mockReturnValue(false);
    const h = harness();
    h.ctx.mode = mode;
    h.ctx.hasUI = hasUI;
    try {
      await h.start();
      await h.open();
      assert.equal(deps.mock.calls.length, 0);
      assert.equal(h.customCalls, 0);
      assert.equal(h.notices.length, hasUI ? 1 : 0);
      if (hasUI) assert.match(h.notices[0].text, /requires TUI/);
    } finally {
      deps.mockRestore();
    }
  });
}

test("renderer retains raw diff fallback and installed bat/delta/glow rendering", () => {
  const root = mkdtempSync(join(tmpdir(), "optional-tools-renderer-"));
  const path = join(root, "source.md");
  writeFileSync(path, "# Plain source");
  let installed = false;
  const deps = spyOn(utils, "hasCommand").mockImplementation(() => installed);
  const repo = spyOn(git, "isGitRepo").mockReturnValue(true);
  const rawDiff = "diff --git a/source.md b/source.md\n@@ -1 +1 @@\n-old\n+new\n";
  const exec = spyOn(childProcess, "execFileSync").mockImplementation(((command: string) => {
    if (command === "git") return rawDiff;
    if (command === "delta") return "delta formatted diff";
    if (command === "glow") return "glow rendered Markdown";
    if (command === "bat") return "bat highlighted source";
    throw new Error(`Unexpected command: ${command}`);
  }) as never);
  try {
    assert.deepEqual(loadFileContent(path, root, true, true, 100), {
      lines: rawDiff.split("\n"),
      renderedMarkdown: false,
    });
    assert.deepEqual(
      exec.mock.calls.map(([command]) => command),
      ["git"],
    );
    installed = true;
    assert.deepEqual(loadFileContent(path, root, true, true, 100).lines, ["delta formatted diff"]);
    assert.deepEqual(loadFileContent(path, root, false, false, 100), {
      lines: ["glow rendered Markdown"],
      renderedMarkdown: true,
    });
    assert.deepEqual(loadFileContent(path, root, false, false, 100, false), {
      lines: ["bat highlighted source"],
      renderedMarkdown: false,
    });
    assert.deepEqual(
      exec.mock.calls.map(([command]) => command),
      ["git", "git", "delta", "glow", "bat"],
    );
  } finally {
    exec.mockRestore();
    repo.mockRestore();
    deps.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
