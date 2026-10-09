import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus, { formatTabTitle } from "../tab-status.js";

function harness(mode = "tui") {
  const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
  const titles: string[] = [];
  const ctx = {
    mode,
    hasUI: true,
    cwd: "/tmp/demo",
    isIdle: () => true,
    ui: { setTitle: (title: string) => titles.push(title) },
  };
  tabStatus({
    on: (name: string, handler: (event: never, ctx: never) => Promise<void>) => handlers.set(name, handler),
  } as never);
  return {
    ctx,
    titles,
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx as never),
  };
}

for (const [before, actual, failed, committed, toolName] of [
  ["git commit -m done", "git status", false, false, "bash"],
  ["git status", "git commit -m done", false, true, "bash"],
  ["git status", "git commit -m done", true, false, "bash"],
  ["git commit -m done", "git commit -m done", false, false, "read"],
] as const) {
  test(`classifies executed ${toolName} command ${actual}, not candidate ${before}, failed=${failed}`, async () => {
    const { ctx, titles, emit } = harness();
    try {
      await emit("agent_start");
      await emit("tool_call", { toolName: "bash", toolCallId: "rewritten", input: { command: before } });
      await emit("tool_result", {
        toolName,
        toolCallId: "rewritten",
        input: { command: actual },
        isError: failed,
      });
      await emit("agent_end", { messages: [] });
      await emit("agent_settled");
      assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, committed ? "doneCommitted" : "doneNoCommit"));
    } finally {
      await emit("session_shutdown");
    }
  });
}

for (const activity of ["message_update", "tool_execution_update", "message_end"]) {
  test(`${activity} keeps a long stream active, then idle blocks and activity recovers`, async () => {
    let now = 0;
    let id = 0;
    const timers = new Map<number, { due: number; callback: () => void }>();
    const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
      timers.set(++id, { due: now + delay, callback });
      return id;
    }) as unknown as typeof setTimeout);
    const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: number) => {
      timers.delete(timer);
    }) as unknown as typeof clearTimeout);
    const advance = (ms: number) => {
      now += ms;
      for (const [timer, { due, callback }] of timers) {
        if (due > now) continue;
        timers.delete(timer);
        callback();
      }
    };
    const { ctx, titles, emit } = harness();
    try {
      await emit("agent_start");
      for (let index = 0; index < 5; index++) {
        advance(60_000);
        await emit(activity);
        assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
      }
      advance(180_000);
      assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"));
      await emit(activity);
      assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
    } finally {
      await emit("session_shutdown");
      schedule.mockRestore();
      cancel.mockRestore();
    }
  });
}

for (const committed of [false, true]) {
  test(`a native rename retains the owned done title, committed=${committed}`, async () => {
    const { ctx, titles, emit } = harness();
    try {
      await emit("agent_start");
      if (committed) {
        await emit("tool_result", {
          toolName: "bash",
          toolCallId: "commit",
          input: { command: "git commit -m done" },
          isError: false,
        });
      }
      await emit("agent_end", { messages: [] });
      await emit("agent_settled");
      ctx.ui.setTitle("pi - renamed session");
      await emit("session_info_changed", { name: "renamed session" });
      assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, committed ? "doneCommitted" : "doneNoCommit"));
    } finally {
      await emit("session_shutdown");
    }
  });
}

test("RPC contexts with a working title API still do not own the terminal title", async () => {
  const { titles, emit } = harness("rpc");
  await emit("session_start");
  await emit("agent_start");
  await emit("session_info_changed", { name: "renamed" });
  await emit("agent_settled");
  await emit("session_shutdown");
  assert.deepEqual(titles, []);
});
