import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/contracts.js";
import { LogBuffer } from "../src/log-buffer.js";

describe("LogBuffer", () => {
  it("decodes fragmented UTF-8 independently for each stream", () => {
    const log = new LogBuffer();
    const emoji = Buffer.from("😀");
    expect(log.append("stdout", emoji.subarray(0, 2))).toBe("");
    log.append("stderr", Buffer.from("error\n"));
    expect(log.append("stdout", emoji.subarray(2))).toBe("😀");
    expect(log.snapshot(200, "stdout").text).toBe("😀");
    expect(log.snapshot().text).toBe("error\n😀");
    expect(log.snapshot().droppedBytes).toBe(0);
  });

  it("shares one byte cap, including oversized no-newline Unicode chunks", () => {
    const log = new LogBuffer();
    log.append("stderr", Buffer.from("x".repeat(1000)));
    log.append("stdout", Buffer.from("€".repeat(LIMITS.logBytes)));
    const snapshot = log.snapshot();
    expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(LIMITS.logBytes);
    expect(snapshot.text).not.toContain("�");
    expect(snapshot.droppedBytes).toBe(1000 + LIMITS.logBytes * 3 - Buffer.byteLength(snapshot.text));
    expect(log.snapshot(200, "stderr").text).toBe("");
  });

  it("tails lines, preserves trailing newline, and validates bounds", () => {
    const log = new LogBuffer();
    log.append("stdout", Buffer.from("one\ntwo\nthree\n"));
    expect(log.snapshot(2).text).toBe("two\nthree\n");
    log.append("stderr", Buffer.from("four"));
    expect(log.snapshot(2).text).toBe("three\nfour");
    expect(() => log.snapshot(1001)).toThrow();
    expect(() => log.snapshot(0)).toThrow();
    expect(() => log.snapshot(1.5)).toThrow();
  });

  it("flushes incomplete UTF-8 at end", () => {
    const log = new LogBuffer();
    log.append("stdout", Buffer.from([0xe2]));
    expect(log.end("stdout")).toBe("�");
    expect(log.snapshot().text).toBe("�");
  });
});
