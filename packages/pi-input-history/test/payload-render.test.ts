import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { extractText, fuzzyMatch, HistoryPopupComponent, subsequence } from "../src/index.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
} as never;

test("multipart text is collected in order, with raw whitespace and no invented separators", () => {
  assert.equal(
    extractText([
      { type: "text", text: "  first\n" },
      { type: "image", mimeType: "image/png", data: "image" },
      { type: "text", text: "\nsecond  " },
    ]),
    "  first\n\nsecond  ",
  );
});

test("subsequence matching does not compose an emoji from separate UTF-16 halves", () => {
  assert.equal(subsequence("😃😀", "😀"), true);
  assert.equal(subsequence("😃\ude00", "😀"), false);
  assert.equal(fuzzyMatch("😃😀", "😀"), true);
});

test("selected row highlights complete emoji/combining/ZWJ graphemes and accepts raw payload", () => {
  const raw = "  😃😀 e\u0301 👩‍💻\n trailing  ";
  let accepted: string | null | undefined;
  const popup = new HistoryPopupComponent(
    { terminal: { rows: 24 }, requestRender() {} } as never,
    theme,
    [{ text: raw }],
    (value) => {
      accepted = value;
    },
  );
  for (const query of ["😀", "e", "👩"]) {
    // Fresh popup for each query so the input is not appended.
    const view = new HistoryPopupComponent(
      { terminal: { rows: 24 }, requestRender() {} } as never,
      theme,
      [{ text: raw }],
      () => {},
    );
    view.handleInput(query);
    for (const width of [20, 40, 76, 100]) {
      const resized = view.render(width);
      assert.ok(resized.every((line) => line.isWellFormed()));
      assert.ok(resized.every((line) => visibleWidth(line) <= width));
    }
    const lines = view.render(100);
    const grapheme = query === "e" ? "e\u0301" : query === "👩" ? "👩‍💻" : "😀";
    assert.ok(lines.join("\n").includes(`\x1b[4m${grapheme}\x1b[24m`));
    if (query === "😀") assert.ok(!lines.join("\n").includes("\x1b[4m😃"));
  }
  popup.handleInput("\r");
  assert.equal(accepted, raw);
});

test("filtering and highlight use the same contextual lowercase mapping", () => {
  const popup = new HistoryPopupComponent(
    { terminal: { rows: 24 }, requestRender() {} } as never,
    theme,
    [{ text: "ΟΣ" }],
    () => {},
  );
  popup.handleInput("ς");
  assert.ok(popup.render(100).join("\n").includes("\x1b[4mΣ\x1b[24m"));
});

for (const initialRows of [8, 12, 24]) {
  test(`preview bottom sentinel remains reachable through scroll and resize (${initialRows} rows)`, () => {
    const terminal = { rows: initialRows };
    const popup = new HistoryPopupComponent(
      { terminal, requestRender() {} } as never,
      theme,
      [{ text: `${"preview line\n".repeat(100)}BOTTOM_SENTINEL😀` }],
      () => {},
    );
    const right = () =>
      popup
        .render(100)
        .slice(1, -1)
        .map((line) => stripVTControlCharacters(line).split("│")[2] ?? "")
        .join("\n");
    assert.doesNotMatch(right(), /BOTTOM_SENTINEL/);
    for (const rows of [initialRows, 30, 8, 20]) {
      terminal.rows = rows;
      popup.render(100);
      for (let step = 0; step < 200; step++) {
        popup.handleInput("\x04");
        popup.render(100);
      }
      assert.match(right(), /BOTTOM_SENTINEL😀/);
      assert.match(right(), /scroll back/);
      assert.ok(popup.render(100).every((line) => line.isWellFormed() && visibleWidth(line) <= 100));
    }
  });
}
