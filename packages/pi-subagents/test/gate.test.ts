/**
 * gate.test.ts — `gate:`, the acceptance signal the agent cannot author.
 *
 * Everything here protects one property: a gate verdict must reflect what the
 * command actually did. The failure modes that break it are a gate that could
 * not run being reported as a pass, and a cache hit reporting a stale pass for
 * a workspace that has since changed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGateCache,
  formatGateVerdict,
  runGate,
  workspaceFingerprint,
} from "../src/gate.js";

beforeEach(() => {
  clearGateCache();
});

const exec = (result: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}) => vi.fn(async () => result);

describe("runGate", () => {
  it("passes on exit 0", async () => {
    const verdict = await runGate({
      command: "true",
      cwd: "/tmp",
      exec: exec({ exitCode: 0 }),
    });
    expect(verdict.passed).toBe(true);
  });

  it("fails on a non-zero exit", async () => {
    const verdict = await runGate({
      command: "false",
      cwd: "/tmp",
      exec: exec({ exitCode: 1 }),
    });
    expect(verdict.passed).toBe(false);
  });

  it("runs the command in the agent's workspace", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({ command: "bun run check", cwd: "/work/tree", exec: run });
    expect(run.mock.calls[0][2]).toMatchObject({ cwd: "/work/tree" });
  });

  it("runs the command through a shell, so a project's own gate works verbatim", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({
      command: "bun run check && echo ok",
      cwd: "/tmp",
      exec: run,
    });
    expect(run.mock.calls[0][0]).toBe("sh");
    expect(run.mock.calls[0][1]).toEqual(["-c", "bun run check && echo ok"]);
  });

  it("treats an empty command as nothing to check", async () => {
    const run = exec({ exitCode: 1 });
    const verdict = await runGate({ command: "   ", cwd: "/tmp", exec: run });
    expect(verdict.passed).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("merges stdout and stderr, since either may carry the reason", async () => {
    const verdict = await runGate({
      command: "check",
      cwd: "/tmp",
      exec: exec({ exitCode: 1, stdout: "out-line", stderr: "err-line" }),
    });
    expect(verdict.output).toContain("out-line");
    expect(verdict.output).toContain("err-line");
  });

  // A failing command prints its reason last, so the tail is the useful end.
  it("keeps the end of a long output, not the start", async () => {
    const verdict = await runGate({
      command: "check",
      cwd: "/tmp",
      exec: exec({ exitCode: 1, stdout: `${"x".repeat(10_000)}THE-REASON` }),
    });
    expect(verdict.output).toContain("THE-REASON");
    expect(verdict.output).toContain("truncated");
    expect(verdict.output.length).toBeLessThan(5_000);
  });

  // Reporting an infrastructure failure as a pass turns every broken gate into
  // a silent green, which is worse than having no gate.
  it("fails when the command cannot run at all", async () => {
    const verdict = await runGate({
      command: "check",
      cwd: "/tmp",
      exec: vi.fn(async () => {
        throw new Error("spawn ENOENT");
      }),
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.output).toContain("spawn ENOENT");
  });
});

describe("memoization", () => {
  it("reuses a verdict for the same command and workspace state", async () => {
    const run = exec({ exitCode: 0 });
    const args = {
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    };
    const first = await runGate(args);
    const second = await runGate(args);

    expect(run).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.passed).toBe(true);
  });

  it("re-runs when the workspace changed", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    });
    await runGate({
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "def",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("re-runs for a different command on the same workspace", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    });
    await runGate({
      command: "test",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  // Without a fingerprint the workspace state is unknown, and a cache hit on
  // unknown state is exactly how a stale pass gets reported.
  it("never caches when the workspace cannot be fingerprinted", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({ command: "check", cwd: "/tmp", exec: run });
    await runGate({ command: "check", cwd: "/tmp", exec: run });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("caches a failure too, so a fan-out does not re-run a known-bad gate", async () => {
    const run = exec({ exitCode: 1 });
    const args = {
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    };
    await runGate(args);
    const second = await runGate(args);
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.passed).toBe(false);
    expect(second.cached).toBe(true);
  });
});

describe("workspaceFingerprint", () => {
  it.each(["gitignore", "exclude", "global"] as const)("reruns a gate when an input ignored through %s changes", async source => {
    const root = mkdtempSync(join(tmpdir(), "gate-ignored-"));
    const cwd = join(root, "repo");
    mkdirSync(cwd);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
    const run = vi.fn(async (file: string, args: string[]) => {
      try {
        return { stdout: execFileSync(file, args, { cwd, encoding: "utf8", env }), exitCode: 0 };
      } catch {
        return { stdout: "", exitCode: 1 };
      }
    });
    try {
      git("init", "--quiet");
      git("config", "status.showUntrackedFiles", "no");
      if (source === "gitignore") writeFileSync(join(cwd, ".gitignore"), "inputs/\n");
      else if (source === "exclude") writeFileSync(join(cwd, ".git", "info", "exclude"), "inputs/\n");
      else {
        const ignoreFile = join(root, "global-ignore");
        writeFileSync(ignoreFile, "inputs/\n");
        git("config", "core.excludesFile", ignoreFile);
      }
      writeFileSync(join(cwd, "check.js"), "process.exit(require('node:fs').readFileSync('inputs/config', 'utf8') === 'good' ? 0 : 1)\n");
      git("add", ".");
      const tree = git("write-tree");
      const commit = execFileSync("git", ["commit-tree", tree, "-m", "fixture"], {
        cwd, encoding: "utf8", env: { ...env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
      }).trim();
      git("update-ref", "HEAD", commit);
      mkdirSync(join(cwd, "inputs"));
      const input = join(cwd, "inputs", "config");
      writeFileSync(input, "good");
      // The old fingerprint cannot see this input at all, even with all untracked files enabled.
      expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
      const command = `${JSON.stringify(process.execPath)} check.js`;
      const firstFingerprint = await workspaceFingerprint(cwd, run);
      const first = await runGate({ command, cwd, exec: run, fingerprint: firstFingerprint });
      expect(first).toMatchObject({ passed: true, cached: false });
      writeFileSync(input, "bad");
      const second = await runGate({ command, cwd, exec: run, fingerprint: await workspaceFingerprint(cwd, run) });
      expect(second).toMatchObject({ passed: false, cached: false });
      expect(firstFingerprint).toBeUndefined();
      expect(run.mock.calls.filter(([file]) => file === "sh")).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never reuses a passing gate after an untracked check.js is overwritten", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gate-untracked-"));
    const run = vi.fn(async (file: string, args: string[]) => {
      try {
        return { stdout: execFileSync(file, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }), exitCode: 0 };
      } catch {
        return { stdout: "", exitCode: 1 };
      }
    });
    try {
      execFileSync("git", ["init", "--quiet"], { cwd });
      execFileSync("git", ["config", "status.showUntrackedFiles", "no"], { cwd });
      // Make HEAD without committing files or relying on user Git identity.
      const tree = execFileSync("git", ["mktree"], { cwd, input: "", encoding: "utf8" }).trim();
      const commit = execFileSync("git", ["commit-tree", tree, "-m", "fixture"], {
        cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
      }).trim();
      execFileSync("git", ["update-ref", "HEAD", commit], { cwd });
      const command = `${JSON.stringify(process.execPath)} check.js`;
      writeFileSync(join(cwd, "check.js"), "process.exit(0)\n");
      const first = await runGate({ command, cwd, exec: run, fingerprint: await workspaceFingerprint(cwd, run) });
      expect(first).toMatchObject({ passed: true, cached: false });
      writeFileSync(join(cwd, "check.js"), "process.exit(1)\n");
      const second = await runGate({ command, cwd, exec: run, fingerprint: await workspaceFingerprint(cwd, run) });
      expect(second).toMatchObject({ passed: false, cached: false });
      expect(run.mock.calls.filter(([file]) => file === "sh")).toHaveLength(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["binary", "textconv"] as const)("does not reuse a passing gate after a tracked %s input changes", async kind => {
    const cwd = mkdtempSync(join(tmpdir(), `gate-${kind}-`));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
    const run = vi.fn(async (file: string, args: string[]) => {
      try {
        return { stdout: execFileSync(file, args, { cwd, encoding: "utf8", env }), exitCode: 0 };
      } catch {
        return { stdout: "", exitCode: 1 };
      }
    });
    try {
      git("init", "--quiet");
      writeFileSync(join(cwd, ".gitattributes"), kind === "binary" ? "data.bin -diff\n" : "check.js diff=squash\n");
      writeFileSync(join(cwd, "check.js"), kind === "binary"
        ? "process.exit(require('node:fs').readFileSync('data.bin')[1] === 1 ? 0 : 1)\n"
        : "process.exit(2)\n");
      if (kind === "binary") writeFileSync(join(cwd, "data.bin"), Buffer.from([0, 0]));
      else git("config", "diff.squash.textconv", "true");
      git("add", ".");
      const tree = git("write-tree");
      const commit = execFileSync("git", ["commit-tree", tree, "-m", "fixture"], {
        cwd, encoding: "utf8", env: { ...env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
      }).trim();
      git("update-ref", "HEAD", commit);
      const input = join(cwd, kind === "binary" ? "data.bin" : "check.js");
      writeFileSync(input, kind === "binary" ? Buffer.from([0, 1]) : "process.exit(0)\n");
      const command = `${JSON.stringify(process.execPath)} check.js`;
      const firstFingerprint = await workspaceFingerprint(cwd, run);
      const first = await runGate({ command, cwd, exec: run, fingerprint: firstFingerprint });
      expect(first).toMatchObject({ passed: true, cached: false });
      writeFileSync(input, kind === "binary" ? Buffer.from([0, 2]) : "process.exit(1)\n");
      const secondFingerprint = await workspaceFingerprint(cwd, run);
      const second = await runGate({ command, cwd, exec: run, fingerprint: secondFingerprint });
      expect(second).toMatchObject({ passed: false, cached: false });
      expect(secondFingerprint).not.toBe(firstFingerprint);
      expect(run.mock.calls.filter(([file]) => file === "sh")).toHaveLength(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not invoke external diff helpers", async () => {
    const run = gitExec({
      "rev-parse": { stdout: "sha1", exitCode: 0 },
      status: { stdout: "", exitCode: 0 },
      diff: { stdout: "", exitCode: 0 },
    });
    await workspaceFingerprint("/tmp", run);
    expect(run).toHaveBeenCalledWith("git", ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "HEAD"], { cwd: "/tmp" });
  });

  const gitExec = (
    responses: Record<string, { stdout?: string; exitCode?: number | null }>,
  ) =>
    vi.fn(
      async (_file: string, args: string[]) =>
        responses[args[0]] ?? { exitCode: 1 },
    );

  it("combines HEAD, status, and the diff", async () => {
    const run = gitExec({
      "rev-parse": { stdout: "sha1", exitCode: 0 },
      status: { stdout: " M a.ts", exitCode: 0 },
      diff: { stdout: "@@ -1 +1 @@", exitCode: 0 },
    });
    expect(await workspaceFingerprint("/tmp", run)).toBeTypeOf("string");
  });

  // `--porcelain` says a file changed, not to what — two different edits to one
  // file would otherwise share a fingerprint and the second would get the
  // first's verdict.
  it("distinguishes two different edits to the same file", async () => {
    const withDiff = (diff: string) =>
      workspaceFingerprint(
        "/tmp",
        gitExec({
          "rev-parse": { stdout: "sha1", exitCode: 0 },
          status: { stdout: " M a.ts", exitCode: 0 },
          diff: { stdout: diff, exitCode: 0 },
        }),
      );
    expect(await withDiff("first change")).not.toBe(
      await withDiff("second change"),
    );
  });

  it("is stable for an identical workspace", async () => {
    const responses = {
      "rev-parse": { stdout: "sha1", exitCode: 0 },
      status: { stdout: "", exitCode: 0 },
      diff: { stdout: "", exitCode: 0 },
    };
    expect(await workspaceFingerprint("/tmp", gitExec(responses))).toBe(
      await workspaceFingerprint("/tmp", gitExec(responses)),
    );
  });

  it.each(["?? untracked.txt", "!! ignored.txt", "!! ignored-directory/"])("disables caching for %s without reading a diff", async status => {
    const run = gitExec({
      "rev-parse": { stdout: "sha1", exitCode: 0 },
      status: { stdout: `${status}\n`, exitCode: 0 },
      diff: { stdout: "", exitCode: 0 },
    });
    expect(await workspaceFingerprint("/tmp", run)).toBeUndefined();
    expect(run).toHaveBeenCalledWith("git", ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"], { cwd: "/tmp" });
    expect(run.mock.calls.some(([, args]) => args[0] === "diff")).toBe(false);
  });

  it("returns undefined outside a git repository, disabling the cache", async () => {
    expect(
      await workspaceFingerprint(
        "/tmp",
        gitExec({ "rev-parse": { exitCode: 128 } }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when git throws", async () => {
    const run = vi.fn(async () => {
      throw new Error("git missing");
    });
    expect(await workspaceFingerprint("/tmp", run)).toBeUndefined();
  });
});

describe("formatGateVerdict", () => {
  it("states the command and the outcome", () => {
    const text = formatGateVerdict("bun run check", {
      passed: false,
      output: "",
      cached: false,
    });
    expect(text).toContain("bun run check");
    expect(text).toContain("FAILED");
  });

  it("includes the output when there is any", () => {
    const text = formatGateVerdict("check", {
      passed: false,
      output: "2 tests failed",
      cached: false,
    });
    expect(text).toContain("2 tests failed");
  });

  // A cached verdict is still a real verdict, but the reader deserves to know
  // the command did not just run.
  it("says when a verdict was reused", () => {
    const text = formatGateVerdict("check", {
      passed: true,
      output: "",
      cached: true,
    });
    expect(text).toMatch(/cached/i);
  });

  it("does not claim a cache on a fresh run", () => {
    const text = formatGateVerdict("check", {
      passed: true,
      output: "",
      cached: false,
    });
    expect(text).not.toMatch(/cached/i);
  });
});
