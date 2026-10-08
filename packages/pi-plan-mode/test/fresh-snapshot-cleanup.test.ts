import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { test, vi } from "vitest";
import { startFreshImplementationSession } from "../src/fresh-implementation.js";
import { createMockContext } from "./support.js";

const failure = vi.hoisted(() => ({ partialFile: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      fs.writeFileSync(...args);
      failure.partialFile = String(args[0]);
      throw new Error("disk failure after partial snapshot write");
    },
  };
});

test("partial parent snapshot writes are removed without replacing or mutating the live session", async () => {
  const branch = [{ type: "custom", customType: "plan-mode-state", data: { enabled: true, awaitingAction: false } }];
  let replacementCalls = 0;
  const context = createMockContext({
    model: { provider: "test", id: "test-model" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
    sessionManager: {
      getSessionFile: () => undefined,
      getBranch: () => branch,
      getCwd: () => "/tmp",
    },
    newSession: async () => {
      replacementCalls += 1;
      return { cancelled: false };
    },
  });
  const before = structuredClone(branch);
  const result = await startFreshImplementationSession(context.ctx, {
    plan: "# Approved plan",
    source: "plan_mode_complete",
    retention: "keep",
    stateEntryType: "plan-mode-state",
    isCurrent: () => true,
  });
  assert.equal(result.kind, "rejected");
  assert.equal(replacementCalls, 0);
  assert.deepEqual(branch, before);
  assert.ok(failure.partialFile);
  assert.equal(existsSync(dirname(failure.partialFile)), false);
});
