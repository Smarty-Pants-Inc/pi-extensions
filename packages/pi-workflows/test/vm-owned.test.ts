import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("owned Node execution frames (disposable process, external deadline)", () => {
  it("uses Node on PATH from an actual Bun host without a helper TypeScript loader", async () => {
    const { stdout, stderr } = await execute("bun", [fixture("vm-owned.ts"), "controls"], { timeout: 12000 });
    expect(stderr).toBe("");
    expect(stdout).toContain("PASS controls");
  }, 15000);
  it.each([
    "sync",
    "async",
    "parallel",
    "dag",
    "gate",
    "retry",
    "round",
    "key",
    "inFlight",
    "cancel",
    "longAwait",
    "controls",
    "inspect",
    "compiled",
    "missingNode",
    "ignoreTerm",
    "abortSpin",
    "bounds",
    "scriptErrors",
    "errorCoercion",
    "ignoredRejection",
    "realm",
    "nestedDrain",
    "nestedDescendants",
    "unawaitedControls",
    "localPromiseThenRootNative",
    "localPromiseControls",
    "localPromiseBudget",
    "localPromiseCancel",
    "ignoredLocalPromise",
    "retainedContextCapacity",
    "awaitedDescendants",
    "forgottenDescendants",
    "descendantControls",
    "descendantBudget",
    "postRootLocalPromise",
    "rootLateCall",
    "deadScope",
    "foreignScope",
    "scopeRecycling",
    "nestedAbort",
    "parentLagHealthy",
    "parentLagStall",
  ])(
    "bounds %s without blocking the Pi parent or leaking its child",
    async (mode) => {
      const { stdout, stderr } = await execute(
        "node",
        ["--unhandled-rejections=strict", "--import", fixture("node-typescript.mjs"), fixture("vm-owned.ts"), mode],
        { timeout: 12000 },
      );
      expect(stderr).toBe("");
      expect(stdout).toContain(`PASS ${mode}`);
    },
    15000,
  );
});
