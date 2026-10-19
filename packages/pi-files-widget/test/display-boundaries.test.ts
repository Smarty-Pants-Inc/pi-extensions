// Keep reason: repository names, paths and pasted text cross the terminal trust boundary.
import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type BrowserController, createFileBrowser } from "../browser.js";
import { loadFileContent } from "../file-viewer.js";
import * as git from "../git.js";
import extension from "../index.js";
import * as utils from "../utils.js";
import { createViewer } from "../viewer.js";

const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove only trusted application SGR.
  return text.replace(/\x1b\[[0-9;]*m/gu, "");
}
function safe(text: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Assert the display trust boundary after application SGR.
  assert.doesNotMatch(plain(text), /[\x00-\x1f\x7f-\x9f\p{Cf}\p{Cs}\u2028\u2029]/u);
}
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(check(), true);
}

for (const [name, attack] of [
  ["OSC52", "\x1b]52;c;cHduZWQ=\x07"],
  ["CSI", "\x1b[2J"],
  ["C1 CSI", "\u009b2J"],
] as const) {
  test(`real browser → viewer → comment notifications sanitize ${name} paths without changing data`, async () => {
    const temporary = mkdtempSync(join(tmpdir(), "display-paths-"));
    const root = join(temporary, `root${attack}end`);
    mkdirSync(root);
    const filename = `document${attack}end.txt`;
    const source = `source${attack}end`;
    writeFileSync(join(root, filename), source);
    const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    const notices: string[] = [];
    const messages: string[] = [];
    let browser: BrowserController | undefined;
    let idle = true;
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      extension({
        registerCommand: (name: string, command: never) => commands.set(name, command),
        on() {},
        sendUserMessage: (message: string) => messages.push(message),
      } as never);
      const ctx = {
        cwd: root,
        mode: "tui",
        hasUI: true,
        isIdle: () => idle,
        ui: {
          notify: (message: string) => notices.push(message),
          custom: (factory: (...args: unknown[]) => BrowserController) =>
            new Promise<void>((done) => {
              browser = factory({ requestRender() {} }, theme, {}, done);
            }),
        },
      };
      const running = commands.get("readfiles")?.handler("", ctx as never);
      await until(() => plain(browser?.render(500).join("") ?? "").includes("documentend.txt"));
      assert.ok(browser);
      const rows = browser.render(500);
      for (const row of rows) safe(row);
      assert.ok(rows[0].includes(theme.bold(join(temporary, "rootend"))));
      assert.ok(plain(rows[2]).includes("documentend.txt"));
      browser.handleInput("\r");
      const viewerRows = browser.render(500);
      for (const row of viewerRows) safe(row);
      assert.ok(viewerRows[0].includes(theme.bold("documentend.txt")));
      for (const isIdle of [true, false]) {
        idle = isIdle;
        browser.handleInput("v");
        browser.handleInput("c");
        browser.handleInput("explain");
        browser.handleInput("\x04");
        const notice = notices.at(-1) ?? "";
        safe(notice);
        assert.equal(notice, `Comment ${idle ? "sent to" : "queued for"} agent for documentend.txt (line 1)`);
        assert.ok(messages.at(-1)?.includes(filename), "message uses the original relative path");
        assert.ok(messages.at(-1)?.includes(source), "message uses the original selected source");
      }
      browser.handleInput("q"); // Return from viewer.
      browser.handleInput("q"); // Complete custom interaction and clear polling.
      await running;
    } finally {
      browser?.dispose();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test("all browser name styles, root, branch and search/empty status labels sanitize before styling", () => {
  const root = mkdtempSync(join(tmpdir(), "display-styles-"));
  const attack = "\x1b]52;c;data\x07\u009b2J\u206a\u200d\u2028\ud800\t";
  const names = ["plain", "changed", "ignored", "dir", "changed-dir"].map((name) => `${name}${attack}end`);
  const spies = [
    spyOn(git, "isGitRepo").mockReturnValue(true),
    spyOn(git, "getGitFileList").mockReturnValue([
      names[0],
      names[1],
      names[2],
      `${names[3]}/child`,
      `${names[4]}/child`,
    ]),
    spyOn(git, "getGitStatus").mockReturnValue(
      new Map([
        [names[1], "M"],
        [names[2], "!!"],
        [`${names[4]}/child`, "M"],
      ]),
    ),
    spyOn(git, "getGitDiffStats").mockReturnValue(new Map()),
    spyOn(git, "getGitBranch").mockReturnValue(`branch${attack}end`),
  ];
  const browser = createFileBrowser(
    root,
    new Set(),
    theme as never,
    () => {},
    () => {},
    () => {},
  );
  try {
    const rows = browser.render(500);
    for (const row of rows) safe(row);
    for (const name of ["plain", "changed", "ignored", "dir", "changed-dir"]) {
      assert.ok(plain(rows.join("")).includes(`${name} \ufffd   end`), name);
    }
    assert.ok(rows[0].includes(theme.fg("accent", " (branch \ufffd   end)")));
    browser.handleInput("/");
    browser.handleInput("absent\u206a\u009b2J\u2028\ud800");
    for (const row of browser.render(500)) safe(row);
    assert.ok(plain(browser.render(500).join("")).includes("absent \ufffd"));
  } finally {
    browser.dispose();
    for (const spy of spies) spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("inaccessible-path notification and viewer load errors never expose raw paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "display-errors-"));
  const attack = "\x1b]52;c;data\x07\x1b[2J\u009b2J\u206f\u2029";
  const path = join(root, `missing${attack}end`);
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const notices: string[] = [];
  try {
    extension({ registerCommand: (name: string, command: never) => commands.set(name, command), on() {} } as never);
    await commands.get("readfiles")?.handler(path, {
      cwd: root,
      mode: "tui",
      hasUI: true,
      ui: { notify: (message: string) => notices.push(message) },
    } as never);
    for (const notice of notices) safe(notice);
    assert.ok(notices.at(-1)?.includes("missing end"));
    const viewer = createViewer({ getRoot: () => root, projectCwd: root }, theme as never, () => {});
    viewer.setFile({ name: `missing${attack}end`, path, isDirectory: false });
    for (const width of [120, 40, 1]) {
      const rows = viewer.render(width);
      for (const row of rows) safe(row);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captured renderer output is sanitized before diff wrapping or line splitting, including errors", () => {
  const root = mkdtempSync(join(tmpdir(), "display-loaders-"));
  const path = join(root, "source.md");
  writeFileSync(path, "source");
  const output = "+a\t\x1b]52;c;hidden\nsecret\x07b\u009b2J\u206a\ud800\u2028c";
  let tool = "";
  let fail = false;
  const spies = [
    spyOn(git, "isGitRepo").mockReturnValue(true),
    spyOn(utils, "hasCommand").mockImplementation((command) => command === tool),
    spyOn(childProcess, "execFileSync").mockImplementation((() => {
      if (fail) throw new Error(output);
      return output;
    }) as never),
  ];
  try {
    for (const renderer of ["", "delta", "glow", "bat"]) {
      tool = renderer;
      const diff = renderer === "" || renderer === "delta";
      const loaded = loadFileContent(path, root, diff, diff, 8, renderer !== "bat");
      for (const row of loaded.lines) safe(row);
      assert.ok(!loaded.lines.join("").includes("secret"), renderer);
      assert.ok(loaded.lines.join("").includes("\ufffd"), renderer);
      if (diff) assert.ok(loaded.lines.every((row) => visibleWidth(row) <= 8));
    }
    fail = true;
    const error = loadFileContent(path, root, true, true, 80);
    assert.ok(error.lines[0].startsWith("Diff error:"));
    for (const row of error.lines) safe(row);
  } finally {
    for (const spy of spies) spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("viewer search title and multiline comment editor sanitize display copies only", () => {
  const root = mkdtempSync(join(tmpdir(), "display-editors-"));
  const path = join(root, "source.txt");
  writeFileSync(path, "source");
  const attack = "text\u009b2J\u206f\u200d\u2028\ud800";
  const sent: string[] = [];
  const viewer = createViewer({ getRoot: () => root, projectCwd: root }, theme as never, (_payload, comment) =>
    sent.push(comment),
  );
  try {
    viewer.setFile({ name: "source.txt", path, isDirectory: false });
    viewer.handleInput("/");
    viewer.handleInput(attack);
    for (const row of viewer.render(80)) safe(row);
    viewer.handleInput("\x1b");
    viewer.handleInput("v");
    viewer.handleInput("c");
    viewer.handleInput(attack);
    for (const row of viewer.render(80)) safe(row);
    viewer.handleInput("\x04");
    assert.deepEqual(sent, [attack], "the comment submitted to the agent is not rewritten for display");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
