// Keep reason: Unicode and terminal layout are a display trust boundary, not source normalization.
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { sanitizeTerminalText } from "../src/index.js";

test("expands every tab to the three spaces measured by pi-tui before layout", () => {
  for (const text of ["\t", "a\tb\t", "漢字\t👨‍👩‍👧‍👦\t", "a\n\tb"]) {
    const display = sanitizeTerminalText(text);
    assert.equal(display, text.replace(/\t/g, "   "));
    assert.equal(visibleWidth(display), visibleWidth(text));
    assert.ok(!display.includes("\t"));
  }
});

test("removes every Unicode Cf code point when it is not a contextual emoji joiner", () => {
  for (let code = 0; code <= 0x10ffff; code++) {
    const char = String.fromCodePoint(code);
    if (/\p{Cf}/u.test(char)) {
      assert.equal(sanitizeTerminalText(`a${char}b`), "ab", `U+${code.toString(16)}`);
    }
  }
});

test("normalizes Unicode line and paragraph separators to LF", () => {
  assert.equal(sanitizeTerminalText("a\u2028b\u2029c\n"), "a\nb\nc\n");
});

test("keeps family emoji, modifiers and variation selectors, but removes stray ZWJ", () => {
  for (const emoji of ["👨‍👩‍👧‍👦", "👩🏽‍💻", "❤️‍🔥", "🏳️‍🌈", "漢\ufe00字\u{e0100}"]) {
    assert.equal(sanitizeTerminalText(emoji), emoji);
  }
  for (const [input, expected] of [
    ["a\u200db", "ab"],
    ["👩\u200da", "👩a"],
    ["a\u200d💻", "a💻"],
    ["\u200d👩\u200d", "👩"],
    ["👩\u200d\u200d💻", "👩💻"],
    ["👩\u206a\u200d💻", "👩💻"],
    ["👩\u200d\ufe0f💻", "👩\ufe0f💻"],
  ]) {
    assert.equal(sanitizeTerminalText(input), expected);
  }
});

test("replaces only unpaired UTF-16 surrogates with the replacement character", () => {
  for (const [input, expected] of [
    ["\ud800", "\ufffd"],
    ["\udfff", "\ufffd"],
    ["a\ud800b\udfff", "a\ufffdb\ufffd"],
    ["\ud800\ud800\udfff\udfff", "\ufffd\ud800\udfff\ufffd"],
    ["👩🏽‍💻\ud800👨‍👩‍👧‍👦", "👩🏽‍💻\ufffd👨‍👩‍👧‍👦"],
  ]) {
    assert.equal(sanitizeTerminalText(input), expected);
    assert.equal(sanitizeTerminalText(expected), expected);
  }
});

test("handles megabyte adversarial control, surrogate and emoji-context inputs in linear passes", () => {
  // A generous CI ceiling catches pathological rescanning; a separate benchmark
  // records the tighter interactive (~100 ms) budget without scheduler-sensitive assertions.
  for (const unit of ["\x1b]", "\x1b[123;", "\u206a\ud800\t\u200d", "\ufe0f\u200d", "👩🏽‍💻"]) {
    const input = unit.repeat(Math.ceil(1_048_576 / unit.length)).slice(0, 1_048_576);
    const start = performance.now();
    const display = sanitizeTerminalText(input);
    assert.ok(performance.now() - start < 2_000, "1 Mi code units must not trigger quadratic scans");
    assert.ok(!display.includes("\t"));
    assert.equal(sanitizeTerminalText(display), display);
  }
});
