// Keep reason: terminal escape parsing is a data-safety boundary shared by both viewers.
import assert from "node:assert/strict";
import { test } from "vitest";
import { sanitizeTerminalText } from "../src/index.js";

for (const [name, sequence] of [
  ["OSC52 with BEL", "\x1b]52;c;cHduZWQ=\x07"],
  ["OSC52 with ST", "\x1b]52;c;cHduZWQ=\x1b\\"],
  ["C1 OSC52", "\u009d52;c;cHduZWQ=\u009c"],
  ["OSC hyperlink", "\x1b]8;;https://example.invalid\x1b\\"],
  ["CSI SGR", "\x1b[31;1m"],
  ["CSI erase", "\x1b[2J"],
  ["CSI private parameters", "\x1b[?25l"],
  ["CSI intermediate bytes", "\x1b[1 q"],
  ["C1 CSI", "\u009b31m"],
  ["DCS", "\x1bPpayload\x1b\\"],
  ["SOS", "\x1bXpayload\x1b\\"],
  ["PM", "\x1b^payload\x1b\\"],
  ["APC", "\x1b_payload\x1b\\"],
  ["C1 DCS", "\u0090payload\u009c"],
  ["C1 SOS", "\u0098payload\u009c"],
  ["C1 PM", "\u009epayload\u009c"],
  ["C1 APC", "\u009fpayload\u009c"],
  ["multiline OSC", "\x1b]52;c;first\nsecond\x07"],
  ["charset selection", "\x1b(B"],
  ["terminal reset", "\x1bc"],
  ["keypad mode", "\x1b="],
] as const) {
  test(`strips ${name} without losing surrounding printable text`, () => {
    assert.equal(sanitizeTerminalText(`before${sequence}after`), "beforeafter");
  });
}

for (const [name, sequence] of [
  ["OSC", "\x1b]52;c;unfinished"],
  ["C1 OSC", "\u009d52;c;unfinished"],
  ["DCS", "\x1bPunfinished"],
  ["CSI", "\x1b[31;"],
  ["C1 CSI", "\u009b31;"],
  ["ESC", "\x1b"],
] as const) {
  test(`drops unterminated ${name} at end of content`, () => {
    assert.equal(sanitizeTerminalText(`before${sequence}`), "before");
  });
}

test("strips every C0/C1 control and DEL except expanded tab and LF", () => {
  for (let code = 0; code <= 0x9f; code++) {
    if (code >= 0x20 && code < 0x7f) continue;
    const char = String.fromCharCode(code);
    assert.equal(sanitizeTerminalText(char), code === 9 ? "   " : code === 10 ? char : "", `U+${code.toString(16)}`);
  }
  assert.equal(sanitizeTerminalText("one\r\ntwo\rthree"), "one\ntwothree");
});

test("strips Unicode bidi controls", () => {
  const codes = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c];
  for (const code of codes) {
    assert.equal(sanitizeTerminalText(`before${String.fromCharCode(code)}after`), "beforeafter");
  }
});

test("preserves benign printable text, Unicode, emoji and LF byte-for-byte", () => {
  for (const text of ["", "  plain [31m ]52;c;text ~ ", "café 漢字\nمرحبا שלום", "👩🏽‍💻 👨‍👩‍👧‍👦 e\u0301\nend\n"]) {
    assert.equal(sanitizeTerminalText(text), text);
  }
});

test("never emits forbidden controls even from malformed or nested escapes", () => {
  for (const text of [
    "before\x1b[3\x001mafter",
    "before\x1b]52;c;nested\x1b]52;c;data\x07after",
    "before\x1bP\x1b]52;c;data\x07\x1b\\after",
    "before\x1b[\u202e31mafter",
    "\x00\u202e\x1b[31mtext\x1b[0m\u2069\u009c",
  ]) {
    const result = sanitizeTerminalText(text);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Verify the sanitizer's terminal trust boundary.
    assert.doesNotMatch(result, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/u);
    assert.equal(sanitizeTerminalText(result), result);
  }
});
