import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { test, vi } from "vitest";
import { WorktreeRecoveryError, withWorktreeMutationLock } from "../src/git.js";

for (const cancelled of [false, true]) {
  for (const scenario of ["result", "void", "error", "recovery", "throw undefined"] as const) {
    test(`mutation lock retains ${scenario} and release failure (cancelled: ${cancelled})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "pi-worktree-release-outcome-"));
      const controller = new AbortController();
      const value = { path: "/fixture/worktree", branch: "feature" };
      const reason =
        scenario === "recovery"
          ? new WorktreeRecoveryError("quarantine retained at /fixture/quarantine; move outcome unknown")
          : scenario === "throw undefined"
            ? undefined
            : new Error("fixture callback failed");
      const resolved = scenario === "result" || scenario === "void";
      let completed = false;
      const release = vi.fn(async () => {
        assert.equal(completed, true, "release must run after the callback settles");
        if (cancelled) controller.abort();
        throw new Error("fixture release failed");
      });
      vi.spyOn(lockfile, "lock").mockResolvedValue(release);
      try {
        await assert.rejects(
          withWorktreeMutationLock(
            root,
            async () => {
              completed = true;
              if (!resolved) throw reason;
              return scenario === "result" ? value : undefined;
            },
            controller.signal,
          ),
          (error: unknown) => {
            assert.ok(error instanceof WorktreeRecoveryError);
            assert.equal(error.mutationOutcome?.status, resolved ? "fulfilled" : "rejected");
            if (error.mutationOutcome?.status === "fulfilled") {
              assert.equal(error.mutationOutcome.value, scenario === "result" ? value : undefined);
            } else if (error.mutationOutcome?.status === "rejected") {
              assert.equal(error.mutationOutcome.reason, reason);
              assert.ok(error.message.includes(reason instanceof Error ? reason.message : String(reason)));
            }
            assert.ok(error.releaseError instanceof Error);
            assert.match(error.releaseError.message, /fixture release failed/);
            assert.match(error.message, /Cannot release worktree mutation lock.*fixture release failed/);
            assert.match(error.message, /before retrying/);
            return true;
          },
        );
        assert.equal(release.mock.calls.length, 1);
        // A failed filesystem release must still retire the in-process queue slot.
        vi.mocked(lockfile.lock).mockResolvedValue(async () => {});
        assert.equal(await withWorktreeMutationLock(root, async () => "successor"), "successor");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("successful lock release preserves callback result and error identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-release-success-"));
  const release = vi.fn(async () => {});
  vi.spyOn(lockfile, "lock").mockResolvedValue(release);
  const value = { path: "/fixture/worktree" };
  const reason = new WorktreeRecoveryError("retained callback outcome");
  try {
    assert.equal(await withWorktreeMutationLock(root, async () => value), value);
    await assert.rejects(
      withWorktreeMutationLock(root, async () => {
        throw reason;
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(release.mock.calls.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
