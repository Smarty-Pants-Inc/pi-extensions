import assert from "node:assert/strict";
import { test } from "vitest";
import { sanitizeDisplayText } from "../src/index.js";

function escaped(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

test("escapes every C0, DEL and C1 code, preserving only declared multiline LF/tab", () => {
  const codes = [...Array.from({ length: 32 }, (_, code) => code), ...Array.from({ length: 33 }, (_, i) => 127 + i)];
  for (const code of codes) {
    const input = `a${String.fromCharCode(code)}b`;
    assert.equal(sanitizeDisplayText(input), `a${escaped(code)}b`);
    assert.equal(sanitizeDisplayText(input, { multiline: false }), `a${escaped(code)}b`);
    assert.equal(
      sanitizeDisplayText(input, { multiline: true }),
      `a${code === 9 || code === 10 ? String.fromCharCode(code) : escaped(code)}b`,
    );
  }
});

test("escapes bidi controls and Unicode line separators without changing RTL letters", () => {
  const codes = [
    0x061c,
    0x200e,
    0x200f,
    ...Array.from({ length: 7 }, (_, i) => 0x2028 + i),
    ...Array.from({ length: 10 }, (_, i) => 0x2066 + i),
  ];
  for (const code of codes) {
    for (const multiline of [false, true]) {
      assert.equal(sanitizeDisplayText(String.fromCharCode(code), { multiline }), escaped(code));
    }
  }
  assert.equal(sanitizeDisplayText("עברית العربية"), "עברית العربية");
});

test("all terminal sequence introducers and terminators are inert, including incomplete/joined sequences", () => {
  const sequences = [
    "\x1b[31mred\x1b[0m",
    "\x1b]8;;https://invalid.test\x07link\x1b]8;;\x1b\\",
    "\x1b]52;c;payload\x1b\\",
    "\x1bPpayload\x1b\\",
    "\x1bXpayload\x1b\\",
    "\x1b^payload\x1b\\",
    "\x1b_payload\x1b\\",
    "\x9b31mred\x9b0m",
    "\x9d52;c;payload\x9c",
    "\x90payload\x9c",
    "\x1b",
    "\x1b[",
    "\x1b]unterminated",
    ["\x1b", "]52;c;", "payload", "\x1b", "\\"].join(""),
  ];
  for (const input of sequences) {
    const expected = [...input]
      .map((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159) ? escaped(code) : char;
      })
      .join("");
    assert.equal(sanitizeDisplayText(input), expected);
    assert.equal(sanitizeDisplayText(sanitizeDisplayText(input)), expected);
  }
  assert.notEqual(sanitizeDisplayText("file\x1b[31m"), sanitizeDisplayText("file\x1b[32m"));
});

test("preserves Unicode graphemes, ZWJ, ZWNJ, variation selectors and ordinary punctuation", () => {
  const text = "日本語 café e\u0301 👩🏽‍💻 👨‍👩‍👧‍👦 🏳️‍🌈 क्ष می‌روم \\u001b [a]; ./file";
  assert.equal(sanitizeDisplayText(text), text);
  assert.equal(sanitizeDisplayText(text, { multiline: true }), text);
});

test("sanitization is stable on mixed controls and multiline output", () => {
  const text = "name\n\t\r\x1b[2J\x9dtitle\x07\u202e👩‍💻";
  for (const multiline of [false, true]) {
    const safe = sanitizeDisplayText(text, { multiline });
    assert.equal(sanitizeDisplayText(safe, { multiline }), safe);
    assert.ok(safe.includes("👩‍💻"));
  }
});
