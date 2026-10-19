import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus, { formatTabTitle } from "../tab-status.js";

/**
 * Drive the extension under manually advanced timers.
 *
 * The inactivity timer is the subject of these tests, so the clock has to be
 * under test control: advancing a fake clock past 180s is the whole point, and
 * a real sleep would make the suite unusable. The spies are installed before
 * the extension is constructed because it captures `globalThis.clearTimeout`
 * when its factory runs.
 */
function createHarness() {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    timers.set(++nextTimerId, { due: now + delay, callback });
    return nextTimerId;
  }) as unknown as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: number) => {
    timers.delete(timer);
  }) as unknown as typeof clearTimeout);

  const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
  const titles: string[] = [];
  const ctx = {
    mode: "tui",
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
    advance: (ms: number) => {
      now += ms;
      for (const [timerId, { due, callback }] of timers) {
        if (due > now) continue;
        timers.delete(timerId);
        callback();
      }
    },
    restore: () => {
      schedule.mockRestore();
      cancel.mockRestore();
    },
  };
}

/** A long call that stays silent: no `tool_execution_update` arrives while it runs. */
const silentToolStart = (toolCallId: string) => ({
  toolCallId,
  toolName: "bash",
  args: { command: "sleep 400" },
});
const toolEnd = (toolCallId: string, isError = false) => ({
  toolCallId,
  toolName: "bash",
  result: { content: [] },
  isError,
});

test("a silent tool that outlives the inactivity threshold keeps the running title", async () => {
  const { ctx, titles, emit, advance, restore } = createHarness();
  try {
    await emit("agent_start");
    await emit("tool_execution_start", silentToolStart("t1"));
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));

    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"), "in-flight work is not inactivity");

    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"), "still in flight after two thresholds");

    await emit("tool_execution_end", toolEnd("t1"));
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));

    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"), "idle only after the tool returns");
  } finally {
    await emit("session_shutdown");
    restore();
  }
});

test("genuine inactivity with no in-flight tool still times out", async () => {
  const { ctx, titles, emit, advance, restore } = createHarness();
  try {
    await emit("agent_start");
    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"));
  } finally {
    await emit("session_shutdown");
    restore();
  }
});

test("a finished tool clears its in-flight state and normal settlement resumes", async () => {
  const { ctx, titles, emit, advance, restore } = createHarness();
  try {
    await emit("agent_start");
    await emit("tool_execution_start", silentToolStart("t1"));
    advance(180_000);
    await emit("tool_execution_end", toolEnd("t1"));
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    await emit("agent_settled");
    advance(25);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "doneNoCommit"));
  } finally {
    await emit("session_shutdown");
    restore();
  }
});

test("an errored tool does not leak in-flight state", async () => {
  const { ctx, titles, emit, advance, restore } = createHarness();
  try {
    await emit("agent_start");
    await emit("tool_execution_start", silentToolStart("t1"));
    await emit("tool_execution_end", toolEnd("t1", true));
    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"));
  } finally {
    await emit("session_shutdown");
    restore();
  }
});

test("an aborted run does not leave in-flight state behind for the next run", async () => {
  const { ctx, titles, emit, advance, restore } = createHarness();
  try {
    await emit("agent_start");
    await emit("tool_execution_start", silentToolStart("t1"));
    // Session replacement resets run state; a stale tool id must not survive it.
    await emit("session_start");
    await emit("agent_start");
    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"));
  } finally {
    await emit("session_shutdown");
    restore();
  }
});

test("a tool left in flight by a failed run is not carried into the retry", async () => {
  const { ctx, titles, emit, advance, restore } = createHarness();
  try {
    await emit("agent_start");
    await emit("tool_execution_start", silentToolStart("t1"));
    // A run that fails while a tool is executing reports the end of the run
    // without ever reporting the end of that tool. Its id can never be cleared
    // by a later end event, so the retry must not inherit it.
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
    await emit("agent_start");
    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"), "the retry has no in-flight tool");
  } finally {
    await emit("session_shutdown");
    restore();
  }
});

test("a tool that ends normally after a retry still holds the running title", async () => {
  const { ctx, titles, emit, advance, restore } = createHarness();
  try {
    await emit("agent_start");
    await emit("tool_execution_start", silentToolStart("stale"));
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
    await emit("agent_start");
    await emit("tool_execution_start", silentToolStart("retry-tool"));
    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"), "the live tool is still in flight");
    await emit("tool_execution_end", toolEnd("retry-tool"));
    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"));
  } finally {
    await emit("session_shutdown");
    restore();
  }
});

test("sequential long tools each hold the running title while they execute", async () => {
  const { ctx, titles, emit, advance, restore } = createHarness();
  try {
    await emit("agent_start");

    await emit("tool_execution_start", silentToolStart("t1"));
    advance(170_000);
    await emit("tool_execution_end", toolEnd("t1"));

    await emit("tool_execution_start", silentToolStart("t2"));
    advance(170_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"), "the second tool resets the idle window");

    await emit("tool_execution_end", toolEnd("t2"));
    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"));
  } finally {
    await emit("session_shutdown");
    restore();
  }
});

test("parallel tools keep the running title until the last one ends", async () => {
  const { ctx, titles, emit, advance, restore } = createHarness();
  try {
    await emit("agent_start");
    await emit("tool_execution_start", silentToolStart("a"));
    await emit("tool_execution_start", silentToolStart("b"));

    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));

    await emit("tool_execution_end", toolEnd("a"));
    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"), "one tool is still in flight");

    await emit("tool_execution_end", toolEnd("b"));
    advance(180_000);
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"));
  } finally {
    await emit("session_shutdown");
    restore();
  }
});
