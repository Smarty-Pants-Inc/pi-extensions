// Keep reason: persisted prompts and pasted filters cross a terminal trust boundary; recall is data safety.
import assert from "node:assert/strict";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { HistoryPopupComponent } from "../src/index.js";

const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
};
function assertSafe(row: string, width: number): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Ignore only application SGR.
  const plain = row.replace(/\x1b\[[0-9;]*m/gu, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Check untrusted output after application styling.
  assert.doesNotMatch(plain, /[\x00-\x1f\x7f-\x9f\p{Cs}\u206a-\u206f\u2028\u2029]/u);
  assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} > ${width}`);
}

for (const [name, text] of [
  ["tabs", "a\tb\t".repeat(80)],
  ["unpaired high surrogates", `a${"\ud800".repeat(300)}z`],
  ["unpaired low surrogates", `a${"\udfff".repeat(300)}z`],
  ["mixed surrogates", "\ud800a\udfff👨‍👩‍👧‍👦".repeat(80)],
  [
    "format controls and separators",
    "a\u206a\u206b\u206c\u206d\u206e\u206f\u00ad\u200b\u200d\u2028b\u2029c".repeat(40),
  ],
] as const) {
  test(`history list and preview stay within width for ${name}, while recall stays identical`, () => {
    const original = `${text}\nsecond\tline`;
    let recalled: string | null = null;
    const entries = [{ text: original }, { text: original }]; // Both selected and unselected summary paths.
    const popup = new HistoryPopupComponent(
      { requestRender() {} } as unknown as TUI,
      theme as never,
      entries,
      (value) => {
        recalled = value;
      },
    );
    for (const width of [40, 60, 76, 80, 120]) {
      for (const row of popup.render(width)) assertSafe(row, width);
      popup.handleInput("\x04");
      for (const row of popup.render(width)) assertSafe(row, width);
      popup.handleInput("\x15");
    }
    popup.handleInput("\r");
    assert.equal(recalled, original);
    assert.equal(entries[0].text, original);
    assert.equal(JSON.stringify(recalled), JSON.stringify(original), "even unpaired UTF-16 units survive recall");
  });
}

test("a valid family emoji survives in both history panes", () => {
  const family = "👨‍👩‍👧‍👦";
  const popup = new HistoryPopupComponent(
    { requestRender() {} } as unknown as TUI,
    theme as never,
    [{ text: family }],
    () => {},
  );
  const row = popup.render(120)[1];
  assert.equal(row.split(family).length - 1, 2);
  assertSafe(row, 120);
});

test("pasted history filter is sanitized before native Input layout and cursor styling", () => {
  const popup = new HistoryPopupComponent(
    { requestRender() {} } as unknown as TUI,
    theme as never,
    [{ text: "safe" }],
    () => {},
  );
  popup.handleInput("\x1b[200~safe\x1b]52;c;data\x07\u009b2J\u206f\u200d\u2028\ud800\x1b[201~");
  for (const width of [40, 76, 120]) {
    for (const row of popup.render(width)) assertSafe(row, width);
  }
});
