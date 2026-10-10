import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { test, vi } from "vitest";
import { registerWorktreeCommand } from "../src/command.js";
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

// One regression matrix covers all four mutations and both UI-owner states.
// Extra move rows also preserve retained and unknown recovery outcomes.
const cases = (["add", "remove", "prune", "quarantine-retained", "move-retained", "move-unknown"] as const).flatMap(
  (scenario) =>
    [false, true].map((cancelled) => ({
      mutation: scenario === "quarantine-retained" || scenario.startsWith("move-") ? "move/quarantine" : scenario,
      scenario,
      cancelled,
    })),
);

test.each(cases)(
  "$mutation outcome and lock release failure are reported ($scenario; cancelled: $cancelled)",
  async ({ scenario, cancelled }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-release-command-")));
    const main = join(root, "repo");
    const linked = join(root, "linked");
    const controller = new AbortController();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const git = (cwd: string, args: string[], allowFailure = false): ExecResult => {
      const child = spawnSync("git", args, { cwd, encoding: "utf8", env });
      if (child.error) throw child.error;
      if (!allowFailure) assert.equal(child.status, 0, child.stderr);
      return { stdout: child.stdout, stderr: child.stderr, code: child.status ?? 1, killed: false };
    };
    let quarantine: string | undefined;
    let releases = 0;
    let moves = 0;
    let injected = false;
    let notificationsAtRelease = 0;
    let confirms = 0;
    try {
      git(root, ["init", "--quiet", "--initial-branch=main", main]);
      writeFileSync(join(main, "tracked.txt"), "recovery data\n");
      git(main, ["add", "tracked.txt"]);
      git(main, ["commit", "-m", "fixture"]);
      const oid = git(main, ["rev-parse", "HEAD"]).stdout.trim();
      if (scenario !== "add") git(main, ["worktree", "add", "-b", "feature", linked]);
      const administrative =
        scenario === "add"
          ? join(main, ".git", "worktrees", "linked")
          : git(linked, ["rev-parse", "--path-format=absolute", "--git-dir"]).stdout.trim();
      if (scenario === "prune") rmSync(linked, { recursive: true, force: true });

      const acquire = lockfile.lock;
      vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
        const release = await acquire(file, options);
        return async () => {
          releases++;
          // Fail cleanup only after verifying the mutation's terminal effects.
          if (scenario === "add") {
            assert.ok(git(main, ["worktree", "list", "--porcelain"]).stdout.includes(linked));
            assert.equal(git(main, ["rev-parse", "refs/heads/feature"]).stdout.trim(), oid);
          } else if (scenario === "remove" || scenario === "prune" || scenario === "quarantine-retained") {
            assert.equal(existsSync(administrative), false);
            assert.equal(existsSync(linked), false);
          } else {
            assert.equal(injected, true);
            assert.equal(moves, scenario === "move-retained" ? 2 : 1);
          }
          notificationsAtRelease = context.notifications.length;
          await release();
          if (cancelled) controller.abort();
          throw new Error("\u001b[31mfixture release failed\u001b[0m");
        };
      });
      const exec: ExtensionAPI["exec"] = async (_command, args, options) => {
        if (scenario === "move-retained" && args[1] === "move" && moves === 1) {
          moves++;
          mkdirSync(linked);
          writeFileSync(join(linked, "late.txt"), "original path replacement\n");
          return { stdout: "", stderr: "fixture restore failed", code: 1, killed: false };
        }
        const value = git(options?.cwd ?? main, args, true);
        if (args[0] === "worktree" && args[1] === "move") {
          moves++;
          quarantine = args[3];
          assert.ok(quarantine);
          if (scenario === "move-retained") {
            writeFileSync(join(quarantine, "late.txt"), "retained quarantine data\n");
            injected = true;
          } else if (scenario === "move-unknown") {
            renameSync(quarantine, join(root, "moved-away"));
            injected = true;
          }
        }
        if (
          scenario === "quarantine-retained" &&
          quarantine &&
          !injected &&
          args[0] === "worktree" &&
          args[1] === "list" &&
          !existsSync(administrative)
        ) {
          writeFileSync(join(`${quarantine}.pi-worktree-tombstone`, "late.txt"), "retained quarantine data\n");
          injected = true;
        }
        return value;
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
      const action =
        scenario === "add" ? "Add worktree" : scenario === "prune" ? "Prune stale metadata" : "Remove worktree";
      const inputs = ["feature", "", linked];
      const context = createMockContext({
        cwd: main,
        mode: "rpc",
        hasUI: true,
        select: async (_title: string, items: string[]) => (items.includes(action) ? action : items[0]),
        input: async () => inputs.shift(),
        confirm: async () => {
          confirms++;
          return true;
        },
      });
      await mock.commands.get("worktree")?.handler("", context.ctx);
      assert.equal(releases, 1, "the callback must settle before its one release attempt");
      assert.equal(confirms, 1, "no follow-up dialog may hide the recovery outcome");
      const notices = context.notifications.filter((notice) => notice.level === "error");
      let diagnostic: string;
      if (cancelled) {
        assert.equal(notices.length, 0, "a retired context must not be notified");
        assert.equal(context.notifications.length, notificationsAtRelease, "no UI notification after cancellation");
        assert.equal(stderr.mock.calls.length, 1);
        diagnostic = String(stderr.mock.calls[0]?.[0]);
      } else {
        assert.equal(stderr.mock.calls.length, 0);
        assert.equal(notices.length, 1);
        diagnostic = notices[0]?.message ?? "";
      }
      assert.equal(diagnostic.includes("\u001b"), false);
      assert.match(diagnostic, /Cannot release worktree mutation lock.*fixture release failed/);
      assert.match(diagnostic, /before retrying/);
      assert.equal(git(main, ["show-ref", "--verify", "refs/heads/feature"]).code, 0);
      if (scenario === "add") {
        assert.match(diagnostic, /Git add completed; verified and retained worktree/);
        assert.ok(diagnostic.includes(linked));
        assert.ok(diagnostic.includes("feature"));
        assert.ok(diagnostic.includes(oid));
        assert.equal(git(main, ["rev-parse", "refs/heads/feature"]).stdout.trim(), oid);
        assert.ok(git(main, ["worktree", "list", "--porcelain"]).stdout.includes(linked));
        assert.equal(readFileSync(join(linked, "tracked.txt"), "utf8"), "recovery data\n");
      } else if (scenario === "remove") {
        assert.match(diagnostic, /Removed worktree.*branch was preserved/);
        assert.ok(diagnostic.includes(linked));
        assert.equal(existsSync(linked), false);
        assert.equal(existsSync(administrative), false);
        assert.equal(existsSync(`${quarantine}.pi-worktree-tombstone`), false);
      } else if (scenario === "prune") {
        assert.match(diagnostic, /Pruned stale worktree metadata.*Removed linked/);
        assert.equal(existsSync(administrative), false);
      } else {
        assert.equal(injected, true);
        assert.equal(moves, scenario === "move-retained" ? 2 : 1, "only a known uncommitted move may try restoration");
        assert.ok(quarantine);
        if (scenario === "quarantine-retained") {
          assert.match(diagnostic, /Worktree metadata was removed, but quarantine was retained at/);
          assert.equal(existsSync(administrative), false);
          const retained = /quarantine was retained at (\S+):/.exec(diagnostic)?.[1];
          assert.ok(retained, diagnostic);
          assert.equal(readFileSync(join(retained, "tracked.txt"), "utf8"), "recovery data\n");
          assert.equal(readFileSync(join(retained, "late.txt"), "utf8"), "retained quarantine data\n");
        } else if (scenario === "move-retained") {
          assert.match(diagnostic, /worktree changed while entering quarantine.*quarantine retained at/);
          assert.match(diagnostic, /fixture restore failed/);
          assert.ok(diagnostic.includes(quarantine));
          assert.equal(readFileSync(join(linked, "late.txt"), "utf8"), "original path replacement\n");
          assert.equal(readFileSync(join(quarantine, "tracked.txt"), "utf8"), "recovery data\n");
        } else {
          assert.match(diagnostic, /Git worktree move outcome is unknown/);
          assert.ok(diagnostic.includes(linked));
          assert.ok(diagnostic.includes(quarantine));
          assert.equal(readFileSync(join(root, "moved-away", "tracked.txt"), "utf8"), "recovery data\n");
        }
      }
      if (scenario === "remove" || scenario === "prune") {
        assert.equal(git(main, ["worktree", "list", "--porcelain"]).stdout.includes(linked), false);
      }
    } finally {
      controller.abort();
      rmSync(root, { recursive: true, force: true });
    }
  },
  10_000,
);
