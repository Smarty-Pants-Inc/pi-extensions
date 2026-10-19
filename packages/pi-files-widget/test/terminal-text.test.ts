// Keep reason: untrusted file bytes cross the terminal/clipboard trust boundary (SEC-01).
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommentPayload, createViewer } from "../viewer.js";

const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

for (const [name, body, expected] of [
  ["OSC52 BEL", "before\x1b]52;c;cHduZWQ=\x07after", "beforeafter"],
  ["OSC52 ST", "before\x1b]52;c;cHduZWQ=\x1b\\after", "beforeafter"],
  ["C1 OSC52", "before\u009d52;c;cHduZWQ=\u009cafter", "beforeafter"],
  ["CSI and bidi", "before\x1b[31m\u202eafter\u202c\x1b[0m", "beforeafter"],
  ["benign Unicode and expanded tabs", "café\t漢字 👩🏽‍💻 e\u0301", "café   漢字 👩🏽‍💻 e\u0301"],
  ["format controls and separators", "a\u206a\u206f\u200db\u2028c\u2029d", "ab c d"],
] as const) {
  test(`file viewer neutralises ${name} before selection styling, without changing comment source`, () => {
    const root = mkdtempSync(join(tmpdir(), "viewer-terminal-"));
    const previousPath = process.env.PATH;
    process.env.PATH = ""; // Exercise the real raw-file fallback, without optional renderers.
    try {
      const path = join(root, "file.txt");
      writeFileSync(path, `${body}\nsecond line`);
      const comments: CommentPayload[] = [];
      const viewer = createViewer({ getRoot: () => root, projectCwd: root }, theme as never, (payload) => {
        comments.push(payload);
      });
      viewer.setFile({ name: "file.txt", path, isDirectory: false });
      const rows = viewer.render(120);
      assert.equal(rows[2], `   1 │ ${expected}`);
      assert.equal(rows[3], "   2 │ second line");
      assert.ok(rows[0].includes(theme.bold("file.txt"))); // App styling is not sanitised.
      assert.equal(rows[1], theme.fg("borderAccent", "─".repeat(120)));

      viewer.handleInput("v"); // This path bypasses loadFileContent and displays the raw snapshot.
      assert.equal(viewer.render(120)[2], theme.bg("selectedBg", `   1 │ ${expected}`));
      viewer.handleInput("c");
      viewer.handleInput("explain");
      viewer.handleInput("\x04");
      assert.equal(comments[0]?.selectedText, body, "sanitising display must not rewrite source data");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
