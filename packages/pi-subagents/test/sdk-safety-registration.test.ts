import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A green package total must not silently omit the pinned host's safety paths.
describe("deterministic SDK safety suite registration", () => {
  it.each([
    "agent-runner-tool-policy-sdk.test.ts",
    "e2e/tool-veto-reachability.e2e.test.ts",
    "navigation-host.test.ts",
    "navigation-sdk.test.ts",
  ])("admits Pi 1.x in %s", (file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).toContain('!VERSION.startsWith("0.99.") && !VERSION.startsWith("1.")');
  });
});
