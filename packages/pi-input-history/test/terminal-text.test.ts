// Keep reason: saved prompts cross the terminal display trust boundary (SEC-02).
import assert from "node:assert/strict";
import type { TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { HistoryPopupComponent } from "../src/index.js";

const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
};

for (const [name, text, expected] of [
  ["bidi controls", "safe\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f\u061ctext", "safetext"],
  ["terminal escapes", "safe\x1b]52;c;cHduZWQ=\x07\x1b[31mtext\x1b[0m", "safetext"],
  ["benign Unicode", "café 漢字 👩🏽‍💻 e\u0301", "café 漢字 👩🏽‍💻 e\u0301"],
] as const) {
  test(`history popup sanitises ${name} in both preview panes before theme styling, preserving recall`, () => {
    let recalled: string | null = null;
    const entry = { text: `${text}\nsecond\tline` };
    const popup = new HistoryPopupComponent(
      { requestRender() {} } as unknown as TUI,
      theme as never,
      [entry],
      (result) => {
        recalled = result;
      },
    );
    for (const width of [120, 60]) {
      const rows = popup.render(width);
      const frame = rows.join("\n");
      // Ignore only SGR from the app theme; no other escape or bidi may survive.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove only application SGR for the safety assertion.
      const plain = frame.replace(/\x1b\[[0-9;]*m/gu, "");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Assert the terminal trust boundary on rendered output.
      assert.doesNotMatch(plain, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/u);
      assert.ok(plain.includes(expected)); // The one-line summary is also a preview.
      assert.ok(frame.includes("\x1b[36m"), "the popup retains app foreground colour");
      assert.ok(frame.includes("\x1b[44m"), "the selected row retains its app background colour");
      if (width === 120) {
        const preview = rows.map((row) => row.split("│")[2] ?? "").join("\n");
        assert.ok(preview.includes(theme.fg("text", expected)), "full-text pane renders sanitised content");
        assert.ok(preview.includes("second"));
        assert.ok(preview.includes("line"));
      }
    }
    popup.handleInput("\r");
    assert.equal(recalled, entry.text, "display sanitising must not change the prompt recalled into the editor");
  });
}
