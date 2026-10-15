import { describe, expect, it } from "vitest";
import { WakeTokens } from "../src/wake-tokens.js";

describe("factory-local wake authentication", () => {
  it("recognizes old deliveries without keeping issued-ID history", () => {
    const tokens = new WakeTokens();
    const first = tokens.create();
    for (let index = 0; index < 10_000; index += 1) expect(tokens.owns(tokens.create())).toBe(true);
    expect(tokens.owns(first)).toBe(true);
  });

  it("does not authenticate another factory or lookalike extension text", () => {
    const tokens = new WakeTokens();
    const token = tokens.create();
    expect(new WakeTokens().owns(token)).toBe(false);
    for (const text of ["", "foreign-wake", token.slice(0, -1), `${token}0`, `${token.slice(0, -1)}x`]) {
      expect(tokens.owns(text)).toBe(false);
    }
    const changed = `${token[0] === "a" ? "b" : "a"}${token.slice(1)}`;
    expect(tokens.owns(changed)).toBe(false);
  });
});
