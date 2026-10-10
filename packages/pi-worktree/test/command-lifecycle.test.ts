import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { withWorktreeMutationLock } from "../src/git.js";
import type { WorktreeSettingsRuntime } from "../src/settings.js";
import worktree from "../src/worktree.js";
import { createMockContext, createMockPi } from "./support.js";

const oid = "0123456789abcdef0123456789abcdef01234567";
const result = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
function settingsFixture() {
  let saves = 0;
  const state = { effectiveRoot: "/srv/worktrees", source: "default" as const, canSave: true };
  const settings: WorktreeSettingsRuntime = {
    get: () => state,
    getPath: () => "/agent/pi-worktree.json",
    reload: async () => state,
    save: async () => {
      saves++;
      return state;
    },
  };
  return { settings, saves: () => saves };
}

function setup(cwd: string, exec?: ExtensionAPI["exec"]) {
  const mock = createMockPi();
  const fixture = settingsFixture();
  Object.assign(mock.rawPi, {
    exec:
      exec ??
      (async (_command: string, args: string[]) => {
        if (args[0] === "worktree") return result(`worktree ${cwd}\0HEAD ${oid}\0branch refs/heads/main\0\0`);
        return result(`${cwd}\n`);
      }),
  });
  worktree(mock.pi, { settings: fixture.settings });
  return { ...mock, ...fixture };
}

async function emit(mock: ReturnType<typeof setup>, event: string, ctx: unknown) {
  for (const handler of mock.events.get(event) ?? []) await handler({}, ctx);
}

test("shutdown settles a pending native RPC config input and ignores a late response", async () => {
  const mock = setup("/repo");
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let respond!: (value: string) => void;
  const response = new Promise<string>((resolve) => {
    respond = resolve;
  });
  let dialogSignal: AbortSignal | undefined;
  const context = createMockContext({
    cwd: "/repo",
    mode: "rpc",
    hasUI: true,
    select: async () => "Configure worktree root",
    input: async (_title: string, _placeholder: string, options: { signal?: AbortSignal }) => {
      dialogSignal = options.signal;
      opened();
      return response; // No RPC response until after shutdown.
    },
  });
  const pending = mock.commands.get("worktree")?.handler("", context.ctx);
  await ready;
  assert.ok(dialogSignal);
  await emit(mock, "session_shutdown", context.ctx);
  await pending;
  assert.equal(dialogSignal.aborted, true);
  respond("/late/root");
  await response;
  await Promise.resolve();
  assert.equal(mock.saves(), 0);
  assert.deepEqual(context.notifications, []);
  assert.equal(stderr.mock.calls.length, 0);
});

test("lifecycle cancellation reaches pending Git preflight before any dialog or mutation", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let receivedSignal: AbortSignal | undefined;
  let calls = 0;
  const mock = setup("/repo", async (_command, _args, options) => {
    calls++;
    receivedSignal = options?.signal;
    assert.ok(receivedSignal);
    started();
    return new Promise<ExecResult>((_resolve, reject) => {
      receivedSignal?.addEventListener("abort", () => reject(new Error("cancelled Git")), { once: true });
    });
  });
  let dialogs = 0;
  const context = createMockContext({
    cwd: "/repo",
    mode: "rpc",
    hasUI: true,
    select: async () => {
      dialogs++;
      return undefined;
    },
  });
  const pending = mock.commands.get("worktree")?.handler("", context.ctx);
  await ready;
  await emit(mock, "session_shutdown", context.ctx);
  await pending;
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(calls, 1);
  assert.equal(dialogs, 0);
  assert.equal(stderr.mock.calls.length, 0);
  assert.deepEqual(context.notifications, []);
});

test("shutdown cancels Add waiting for the mutation lock without overtaking its holder", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-cancel-lock-"));
  let release!: () => void;
  let locked!: () => void;
  const lockReady = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = withWorktreeMutationLock(root, async () => {
    locked();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await lockReady;
  let mutations = 0;
  let confirmed!: () => void;
  const ready = new Promise<void>((resolve) => {
    confirmed = resolve;
  });
  const mock = setup(root, async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list")
      return result(`worktree ${root}\0HEAD ${oid}\0branch refs/heads/main\0\0`);
    if (args[0] === "worktree" && args[1] === "add") {
      mutations++;
      return result();
    }
    if (args[0] === "check-ref-format") return result("feature\n");
    if (args[0] === "show-ref") return result();
    if (args.includes("--verify")) return result(`${oid}\n`);
    return result(`${root}\n`);
  });
  const context = createMockContext({
    cwd: root,
    mode: "rpc",
    hasUI: true,
    select: async () => "Add worktree",
    input: async (title: string) => (title.startsWith("Branch") ? "feature" : join(root, "linked")),
    confirm: async () => {
      confirmed();
      return true;
    },
  });
  try {
    const pending = mock.commands.get("worktree")?.handler("", context.ctx);
    await ready;
    await Promise.resolve();
    await Promise.resolve();
    await emit(mock, "session_shutdown", context.ctx);
    await pending; // Still holding the lock: cancelled wait must settle independently.
    assert.equal(mutations, 0);
    let successorRan = false;
    const successor = withWorktreeMutationLock(root, async () => {
      successorRan = true;
    });
    await Promise.resolve();
    assert.equal(successorRan, false);
    release();
    await held;
    await successor;
    assert.equal(mutations, 0);
  } finally {
    release();
    await held;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cancelled queued mutation settles without executing or releasing its predecessor", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-owned-queue-"));
  let release!: () => void;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const holder = withWorktreeMutationLock(root, async () => {
    opened();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  const controller = new AbortController();
  let executions = 0;
  try {
    const cancelled = withWorktreeMutationLock(
      root,
      async () => {
        executions++;
      },
      controller.signal,
    );
    controller.abort();
    await assert.rejects(cancelled, /abort/i);
    assert.equal(executions, 0);
    const successor = withWorktreeMutationLock(root, async () => {
      executions++;
    });
    await Promise.resolve();
    assert.equal(executions, 0);
    release();
    await holder;
    await successor;
    assert.equal(executions, 1);
  } finally {
    release();
    await holder;
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["", "add\u001b[31m feature"])(
  "headless %j rejects on sanitized stderr even with a no-op notifier",
  async (args) => {
    let git = 0;
    let dialogs = 0;
    const mock = setup("/repo", async () => {
      git++;
      return result();
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = createMockContext({
      hasUI: false,
      mode: "print",
      select: async () => {
        dialogs++;
        return undefined;
      },
      input: async () => {
        dialogs++;
        return undefined;
      },
    });
    Object.assign(context.ctx.ui, { notify() {} });
    await mock.commands.get("worktree")?.handler(args, context.ctx);
    assert.equal(git, 0);
    assert.equal(dialogs, 0);
    assert.equal(error.mock.calls.length, 1);
    assert.match(String(error.mock.calls[0]?.[0]), args ? /does not accept arguments/ : /requires TUI or RPC/);
    assert.equal(String(error.mock.calls[0]?.[0]).includes("\u001b"), false);
  },
);
