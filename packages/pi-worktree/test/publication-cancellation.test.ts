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
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createWorktreeSettingsRuntime } from "../src/settings.js";
import worktree from "../src/worktree.js";
import { createMockContext, createMockPi } from "./support.js";

function git(cwd: string, args: string[]): ExecResult {
  const child = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  return { stdout: child.stdout, stderr: child.stderr, code: child.status, killed: false };
}

test("retirement during fallback metadata prune retains unknown-outcome recovery diagnostics", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-prune-outcome-")));
  const main = join(root, "repo");
  const linked = join(root, "linked");
  mkdirSync(main);
  mkdirSync(linked);
  writeFileSync(join(linked, "tracked.txt"), "recovery data\n");
  const mock = createMockPi();
  const reported = Promise.withResolvers<string>();
  const stderr = vi.spyOn(console, "error").mockImplementation((message: unknown) => reported.resolve(String(message)));
  const oid = "0123456789abcdef0123456789abcdef01234567";
  let quarantine: string | undefined;
  let removed = false;
  let moves = 0;
  const context = createMockContext({
    cwd: main,
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, items: string[]) =>
      items.includes("Remove worktree") ? "Remove worktree" : items[0],
    confirm: async () => true,
  });
  const notify = vi.spyOn(context.ctx.ui, "notify");
  const exec: ExtensionAPI["exec"] = async (_command, args) => {
    const result = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
    if (args[0] === "worktree" && args[1] === "list") {
      return result(
        `worktree ${main}\0HEAD ${oid}\0branch refs/heads/main\0\0${
          removed
            ? ""
            : `worktree ${quarantine ?? linked}\0HEAD ${oid}\0branch refs/heads/feature\0${quarantine ? "prunable missing gitdir\0" : ""}\0`
        }`,
      );
    }
    if (args[0] === "worktree" && args[1] === "move") {
      moves++;
      const [source, destination] = [args[2], args[3]];
      assert.ok(source && destination);
      renameSync(source, destination);
      quarantine = destination;
    }
    if (args[0] === "worktree" && args[1] === "prune") {
      if (args.includes("--dry-run")) return result("Removing worktrees/test: missing gitdir\n");
      removed = true;
      await emit(mock, "session_shutdown", context.ctx);
      // Git has committed, but its cancelled exec return cannot establish outcome.
      return result();
    }
    if (args[0] === "rev-parse") return result(`${args.includes("--git-dir") ? join(root, "administrative") : main}\n`);
    return result();
  };
  Object.assign(mock.rawPi, { exec });
  worktree(mock.pi, { settings: createWorktreeSettingsRuntime({ path: join(root, "settings.json") }) });
  try {
    const pending = mock.commands.get("worktree")?.handler("", context.ctx);
    const diagnostic = await reported.promise;
    await pending;
    assert.equal(stderr.mock.calls.length, 1);
    assert.equal(notify.mock.calls.length, 0);
    assert.equal(moves, 1);
    assert.equal(removed, true);
    assert.ok(quarantine);
    const retained = `${quarantine}.pi-worktree-tombstone`;
    assert.match(diagnostic, /metadata outcome is unknown, but quarantine was retained at/);
    assert.ok(diagnostic.includes(retained));
    assert.equal(readFileSync(join(retained, "tracked.txt"), "utf8"), "recovery data\n");
    assert.equal(existsSync(linked), false);
    assert.equal(existsSync(quarantine), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-publication-")));
  const main = join(root, "repo");
  git(root, ["init", "--initial-branch=main", main]);
  git(main, ["config", "user.name", "Pi Worktree Test"]);
  git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
  writeFileSync(join(main, "tracked.txt"), "recovery data\n");
  git(main, ["add", "tracked.txt"]);
  git(main, ["commit", "-m", "initial"]);
  return { root, main };
}

async function emit(mock: ReturnType<typeof createMockPi>, event: string, ctx: unknown) {
  for (const handler of mock.events.get(event) ?? []) await handler({}, ctx);
}

test("same-session tree retirement during settings publication syncs the next Add root without stale UI", async () => {
  const { root, main } = repository();
  const path = join(root, "pi-worktree.json");
  const nextRoot = join(root, "new-root");
  const entered = Promise.withResolvers<void>();
  const publish = Promise.withResolvers<void>();
  const runtime = createWorktreeSettingsRuntime({
    path,
    operations: {
      rename: async (source, destination) => {
        entered.resolve();
        await publish.promise;
        await rename(source, destination);
      },
    },
  });
  writeFileSync(path, JSON.stringify({ worktreeRoot: join(root, "old-root") }));
  const mock = createMockPi();
  Object.assign(mock.rawPi, {
    exec: async (_command: string, args: string[], options: { cwd: string }) => git(options.cwd, args),
  });
  worktree(mock.pi, { settings: runtime });
  const retired = createMockContext({
    cwd: main,
    mode: "rpc",
    hasUI: true,
    select: async () => "Configure worktree root",
    input: async () => nextRoot,
  });
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const notify = vi.spyOn(retired.ctx.ui, "notify");
  try {
    const pending = mock.commands.get("worktree")?.handler("", retired.ctx);
    await entered.promise;
    await emit(mock, "session_tree", retired.ctx);
    publish.resolve();
    await runtime.flush?.();
    await pending;
    assert.equal(runtime.get().effectiveRoot, nextRoot);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).worktreeRoot, nextRoot);
    assert.equal(notify.mock.calls.length, 0);
    assert.equal(stderr.mock.calls.length, 0);

    let suggested = "";
    git(main, ["branch", "feature"]);
    const current = createMockContext({
      cwd: main,
      mode: "rpc",
      hasUI: true,
      select: async () => "Add worktree",
      input: async (title: string, placeholder: string) => {
        if (title.startsWith("Branch")) return "feature";
        suggested = placeholder;
        return undefined;
      },
    });
    await mock.commands.get("worktree")?.handler("", current.ctx);
    assert.equal(suggested, join(nextRoot, "repo", "feature"));
    assert.deepEqual(current.notifications, []);
  } finally {
    publish.resolve();
    await runtime.flush?.();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test.each(["cancel", "verification fails"])(
  "retirement after administrative metadata deletion reports retained quarantine: %s",
  async (scenario) => {
    const { root, main } = repository();
    const linked = join(root, "linked");
    git(main, ["worktree", "add", "-b", "feature", linked]);
    const administrative = git(linked, ["rev-parse", "--path-format=absolute", "--git-dir"]).stdout.trim();
    const mock = createMockPi();
    const reported = Promise.withResolvers<string>();
    const stderr = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      reported.resolve(String(message));
    });
    let quarantine: string | undefined;
    let retired = false;
    const moves: string[][] = [];
    const context = createMockContext({
      cwd: main,
      mode: "rpc",
      hasUI: true,
      select: async (_title: string, items: string[]) =>
        items.includes("Remove worktree") ? "Remove worktree" : items[0],
      confirm: async () => true,
    });
    const notify = vi.spyOn(context.ctx.ui, "notify");
    const exec: ExtensionAPI["exec"] = async (_command, args, options) => {
      if (args[0] === "worktree" && args[1] === "move") {
        moves.push(args);
        quarantine = args[3];
      }
      if (quarantine && !retired && args[0] === "worktree" && args[1] === "list" && !existsSync(administrative)) {
        retired = true;
        await emit(mock, "session_tree", context.ctx);
        // Committed deletion is verified without the now-retired UI signal.
        assert.equal(options?.signal, undefined);
        if (scenario === "verification fails") throw new Error("\u001b[31mfixture verification unavailable\u001b[0m");
      }
      return git(options?.cwd ?? main, args);
    };
    Object.assign(mock.rawPi, { exec });
    worktree(mock.pi, { settings: createWorktreeSettingsRuntime({ path: join(root, "settings.json") }) });
    try {
      const pending = mock.commands.get("worktree")?.handler("", context.ctx);
      const diagnostic = await reported.promise;
      await pending;
      assert.equal(retired, true);
      assert.equal(stderr.mock.calls.length, 1);
      assert.equal(notify.mock.calls.length, 0);
      assert.deepEqual(context.notifications, []);
      assert.equal(diagnostic.includes("\u001b"), false);
      assert.match(diagnostic, /Worktree metadata was removed, but quarantine was retained at/);
      if (scenario === "verification fails")
        assert.match(diagnostic, /verification failed.*fixture verification unavailable/);
      assert.ok(quarantine);
      const retained = `${quarantine}.pi-worktree-tombstone`;
      assert.ok(diagnostic.includes(retained));
      assert.equal(readFileSync(join(retained, "tracked.txt"), "utf8"), "recovery data\n");
      assert.equal(existsSync(linked), false);
      assert.equal(existsSync(administrative), false);
      assert.equal(existsSync(quarantine), false);
      assert.equal(moves.length, 1); // Never pretend registration can be rolled back after commit.
      assert.equal(git(main, ["worktree", "list", "--porcelain"]).stdout.includes(linked), false);
      assert.equal(git(main, ["show-ref", "--verify", "refs/heads/feature"]).code, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);
