import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { test, vi } from "vitest";
import { registerWorktreeCommand } from "../src/command.js";
import { listWorktrees, resolveCommit } from "../src/git.js";
import type { WorktreeSettingsRuntime } from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

for (const [scenario, cancelled] of [
  ["create", true],
  ["attach", true],
  ["inventory-failure", true],
  ["branch-failure", true],
  ["branch-only", true],
  ["lock-release-failure", true],
  ["lock-release-failure", false],
] as const) {
  test(`Add reconciles ${scenario} after Git finishes (cancelled: ${cancelled})`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-add-cancel-")));
    const main = join(root, "repo");
    const linked = join(root, "linked");
    const controller = new AbortController();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: main, encoding: "utf8", env }).trim();
    const recoveryCalls: string[][] = [];
    let mutationFinished = false;
    let confirms = 0;
    try {
      execFileSync("git", ["init", "--quiet", "--initial-branch=main", main], { env });
      git("commit", "--allow-empty", "-m", "fixture");
      const oid = git("rev-parse", "HEAD");
      if (scenario === "attach") git("branch", "feature");
      if (scenario === "lock-release-failure") {
        const acquire = lockfile.lock;
        vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
          const release = await acquire(file, options);
          return async () => {
            assert.equal(recoveryCalls.length, 2, "release must fail only after both verification reads finish");
            await release();
            if (cancelled) controller.abort();
            throw new Error("fixture release failed");
          };
        });
      }
      const exec: ExtensionAPI["exec"] = async (command, args, options): Promise<ExecResult> => {
        if (mutationFinished) {
          recoveryCalls.push(args);
          assert.equal(options?.signal, undefined, "recovery must not inherit the aborted signal");
          assert.ok(options?.timeout, "recovery reads must remain bounded");
          if (scenario === "inventory-failure" && args[0] === "worktree") throw new Error("inventory unavailable");
          if (scenario === "branch-failure" && args[0] === "rev-parse") throw new Error("branch unavailable");
        }
        const adding = args[0] === "worktree" && args[1] === "add";
        const value = spawnSync(command, adding && scenario === "branch-only" ? ["branch", "feature", oid] : args, {
          cwd: options?.cwd,
          encoding: "utf8",
          env,
        });
        if (value.error) throw value.error;
        if (adding) {
          assert.equal(value.status, 0, value.stderr);
          assert.ok(options?.signal);
          mutationFinished = true;
          if (scenario !== "lock-release-failure") controller.abort();
          assert.equal(options.signal.aborted, scenario !== "lock-release-failure");
        }
        return {
          stdout: value.stdout,
          stderr: adding && scenario === "branch-only" ? "checkout failed after creating branch" : value.stderr,
          code: adding && scenario === "branch-only" ? 1 : (value.status ?? 1),
          killed: Boolean(value.signal),
        };
      };
      const mock = createMockPi();
      Object.assign(mock.rawPi, { exec });
      const state = { effectiveRoot: root, source: "default" as const, canSave: true };
      const settings: WorktreeSettingsRuntime = {
        get: () => state,
        getPath: () => join(root, "settings.json"),
        reload: async () => state,
        save: async () => state,
      };
      registerWorktreeCommand(mock.pi, settings, () => ({
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
      }));
      const inputs = scenario === "attach" ? ["feature", linked] : ["feature", "", linked];
      const context = createMockContext({
        cwd: main,
        mode: "rpc",
        hasUI: true,
        select: async () => "Add worktree",
        input: async () => inputs.shift(),
        confirm: async () => {
          confirms++;
          return true;
        },
      });
      await mock.commands.get("worktree")?.handler("", context.ctx);
      assert.equal(mutationFinished, true);
      assert.ok(recoveryCalls.some((args) => args[0] === "worktree" && args[1] === "list"));
      assert.ok(recoveryCalls.some((args) => args[0] === "rev-parse" && args.includes("refs/heads/feature^{commit}")));
      assert.equal(confirms, 1, "a retired or recovery flow must not offer workspace switching");
      let notice: string;
      if (cancelled) {
        assert.deepEqual(context.notifications, [], "a retired context must not be notified");
        assert.equal(stderr.mock.calls.length, 1);
        notice = String(stderr.mock.calls[0]?.[0]);
      } else {
        assert.equal(stderr.mock.calls.length, 0);
        assert.equal(context.notifications.length, 1);
        assert.equal(context.notifications[0]?.level, "error");
        notice = context.notifications[0]?.message ?? "";
      }
      assert.ok(notice.includes(linked));
      assert.match(notice, /feature/);
      if (scenario === "inventory-failure" || scenario === "branch-failure") {
        assert.match(notice, /verification failed/);
        assert.match(notice, /unavailable/);
        assert.match(notice, /before retrying/);
      } else if (scenario === "branch-only") {
        assert.match(notice, /checkout failed/);
        assert.match(notice, /not registered/);
        assert.ok(notice.includes(oid), "notice must account for the retained branch independently of the path");
      } else {
        assert.match(notice, /verified.*retained/i);
        assert.ok(notice.includes(oid));
      }
      if (scenario === "lock-release-failure") {
        assert.match(notice, /Git add completed/i);
        assert.match(notice, /Cannot release worktree mutation lock.*fixture release failed/);
        assert.match(notice, /before retrying/);
      }
      // Inspect real Git independently of the failure-injecting host.
      const cleanPi = {
        exec: async (_command: string, args: string[]) => ({
          stdout: git(...args),
          stderr: "",
          code: 0,
          killed: false,
        }),
      };
      assert.equal(await resolveCommit(cleanPi, main, "refs/heads/feature"), oid);
      const registered = (await listWorktrees(cleanPi, main)).find((record) => record.path === linked);
      assert.equal(Boolean(registered), scenario !== "branch-only");
      assert.equal(existsSync(linked), scenario !== "branch-only");
    } finally {
      controller.abort();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
}
