import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/contracts.js";
import { Matcher, safeEventText, validateWatch } from "../src/matcher.js";

describe("Matcher", () => {
  it("matches literal fragments per stream/line, once per distinct pattern", () => {
    const matches: string[] = [];
    const matcher = new Matcher({ patterns: [" ready ", "ready", "(a+)+$"] }, (pattern) => matches.push(pattern));
    matcher.feed("stdout", "rea");
    matcher.feed("stderr", "dy\n");
    matcher.feed("stdout", "dy\nready\n ready \n(a+)+$\n");
    expect(matches).toEqual(["ready", " ready ", "(a+)+$"]);
    matcher.feed("stdout", "(a+)+$\n");
    expect(matches).toHaveLength(3);
  });

  it("respects stream filters and bounded repeated cooldown", () => {
    let time = 0;
    const lines: string[] = [];
    const matcher = new Matcher(
      { patterns: ["yes"], stream: "stderr", repeat: true, cooldownMs: 1000 },
      (_, line) => lines.push(line),
      () => time,
    );
    matcher.feed("stdout", "yes\n");
    matcher.feed("stderr", "yes\nyes\n");
    time = 999;
    matcher.feed("stderr", "yes\n");
    time = 1000;
    matcher.feed("stderr", "yes\n");
    expect(lines).toEqual(["yes", "yes"]);
  });

  it("requires new occurrences rather than replaying a partial line after cooldown", () => {
    let time = 0;
    const lines: string[] = [];
    const matcher = new Matcher(
      { patterns: ["ready"], repeat: true, cooldownMs: 1000 },
      (_, line) => lines.push(line),
      () => time,
    );
    matcher.feed("stdout", "ready");
    time = 100;
    matcher.feed("stdout", " ready"); // Consume this occurrence during cooldown.
    time = 1000;
    matcher.feed("stdout", " unrelated");
    matcher.feed("stdout", "\n");
    expect(lines).toEqual(["ready"]);
    matcher.feed("stderr", "ready");
    time = 2000;
    matcher.feed("stdout", "rea");
    matcher.feed("stdout", "dy");
    expect(lines).toEqual(["ready", "ready", "ready"]);
    time = 3000;
    matcher.feed("stdout", " ready");
    expect(lines).toEqual(["ready", "ready", "ready", "ready ready"]);
  });

  it("bounds incomplete lines and resumes after newline", () => {
    const lines: string[] = [];
    const matcher = new Matcher({ patterns: ["hit"], repeat: true, cooldownMs: 1000 }, (_, line) => lines.push(line));
    matcher.feed("stdout", "x".repeat(LIMITS.lineBytes * 4));
    matcher.feed("stdout", "hit");
    expect(lines).toHaveLength(0);
    matcher.feed("stdout", "\nhit");
    expect(lines).toEqual(["hit"]);
  });

  it("validates literals and cooldown and does not retain input arrays", () => {
    for (const patterns of [[], [""], ["x".repeat(257)], [` ${"x".repeat(255)} `], Array(9).fill("x")]) {
      expect(() => validateWatch({ patterns })).toThrow();
    }
    for (const cooldownMs of [0, 999, 3_600_001, Infinity, 1000.5]) {
      expect(() => validateWatch({ patterns: ["x"], cooldownMs })).toThrow();
    }
    const patterns = ["x"];
    const watch = validateWatch({ patterns });
    patterns[0] = "changed";
    expect(watch.patterns).toEqual(["x"]);
  });

  it("preserves literal whitespace and deduplicates only exact patterns", () => {
    const matches: string[] = [];
    const matcher = new Matcher({ patterns: [" ERROR ", "ERROR", " ERROR ", " "] }, (pattern) => matches.push(pattern));
    expect(matcher.options.patterns).toEqual([" ERROR ", "ERROR", " "]);
    matcher.feed("stdout", "ERROR\n");
    expect(matches).toEqual(["ERROR"]);
    matcher.feed("stdout", " ERROR \n");
    expect(matches).toEqual(["ERROR", " ERROR ", " "]);
  });

  // Adversarial sequence forms from aliou/pi-processes display-text fixtures;
  // plain-text expectations here intentionally retain neither SGR nor payloads.
  it.each([
    ["DCS with BEL data", "\x1bPq\x07payload\x1b\\kept", "kept"],
    ["DCS with C1 ST", "\x1bPdata\x9ckept", "kept"],
    ["OSC with C1 ST", "\x1b]0;title\x9ckept", "kept"],
    ["C1 OSC with carriage return", "old\x9d0;ti\rtle\x07new", "oldnew"],
    ["C1 DCS", "\x90data\x9ckept", "kept"],
    ["C1 CSI", "\x9b2Jboom", "boom"],
    ["unterminated OSC", "ok \x1b]0;no terminator", "ok "],
    ["unterminated CSI", "ok \x1b[38;5", "ok "],
    ["unterminated ESC", "ok \x1b", "ok "],
    ["private mode m", "\x1b[?1000mtext", "text"],
  ])("drops %s from event text", (_name, input, expected) => {
    expect(safeEventText(input)).toBe(expected);
  });

  it("sanitizes fragmented terminal strings before a match excerpt", () => {
    const lines: string[] = [];
    const matcher = new Matcher({ patterns: ["ready"] }, (_, line) => lines.push(line));
    matcher.feed("stdout", "\x1bPq\x07hidden\n");
    matcher.feed("stdout", "still-hidden");
    matcher.feed("stdout", "\x1b");
    matcher.feed("stdout", "\\\x9dtitle");
    matcher.feed("stdout", "\x9cready\n");
    expect(lines).toEqual(["ready"]);
  });

  it("strips terminal escapes and controls, bounding valid UTF-8 text", () => {
    expect(safeEventText("\x1b[31mred\x1b[0m\x1b]0;title\x07\x00\r")).toBe("red");
    const text = safeEventText("😀".repeat(10000));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIMITS.notificationBytes);
    expect(text).not.toContain("�");
  });
});
