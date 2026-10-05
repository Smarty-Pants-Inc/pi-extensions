import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import goal from "../src/goal.js";
import type { ActiveGoal } from "../src/persistence.js";
import { createMockContext, createMockPi } from "./support.js";

afterEach(() => vi.useRealTimers());
function fixture(deliver?: (text: string) => unknown, resumeAt = Date.now() - 1) {
  const saved: ActiveGoal = {
    id: "original-wait-id",
    text: "finish after review",
    status: "paused",
    startedAt: 1,
    updatedAt: 2,
    iteration: 3,
    tokensUsed: 7,
    timeUsedSeconds: 9,
    baselineTokens: 0,
    automaticModelTurns: 4,
    toolFreeRepeatCount: 0,
    wait: { reason: "awaiting result", resumeAt },
  };
  const mock = createMockPi({ activeTools: ["read", "goal_complete", "goal_blocked", "goal_wait"] });
  if (deliver) mock.rawPi.sendUserMessage = deliver;
  let aborts = 0;
  const { ctx } = createMockContext({
    abort: () => {
      aborts++;
    },
    sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-state", data: { goal: saved } }] },
  });
  goal(mock.pi, { settingsPath: "/nonexistent-pi-goal-regression-settings.json" });
  const emit = async (name: string, event: unknown) => mock.events.get(name)?.[0]?.(event, ctx);
  const last = () => {
    const entry = mock.entries.at(-1);
    assert.ok(entry);
    return (entry.data as { goal: ActiveGoal }).goal;
  };
  const unchanged = () => {
    const actual = last();
    assert.equal(actual.id, saved.id, "wait must retain its original ID before native acceptance");
    assert.deepEqual(actual.wait, saved.wait);
    assert.equal(actual.tokensUsed, saved.tokensUsed);
    assert.equal(actual.timeUsedSeconds, saved.timeUsedSeconds);
    assert.equal(actual.iteration, saved.iteration);
    assert.equal(actual.automaticModelTurns, saved.automaticModelTurns);
    assert.equal(actual.status, "paused");
  };
  return { mock, ctx, saved, emit, last, unchanged, abortCount: () => aborts };
}

for (const failure of ["void", "throw", "reject", "false"] as const) {
  test(`overdue wait survives native ${failure} delivery without consuming identity or accounting`, async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const f = fixture(() => {
      attempts++;
      if (failure === "throw") throw new Error("preflight rejected");
      if (failure === "reject") return Promise.reject(new Error("preflight rejected"));
      return failure === "false" ? false : undefined;
    });
    await f.emit("session_start", {});
    await vi.advanceTimersByTimeAsync(0);
    f.unchanged();
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(attempts, 1, "no timer retry loop");
    f.unchanged();
    await f.emit("session_shutdown", {});
  });
}

test("rejected real input keeps the original future deadline armed", async () => {
  vi.useFakeTimers();
  const f = fixture(undefined, Date.now() + 10_000);
  await f.emit("session_start", {});
  await f.emit("input", { source: "rpc", text: "review ready" });
  f.unchanged();
  await vi.advanceTimersByTimeAsync(9_999);
  assert.equal(f.mock.sentUserMessages.length, 0);
  await vi.advanceTimersByTimeAsync(1);
  f.unchanged();
  assert.equal(f.mock.sentUserMessages.length, 1, "the unchanged deadline still attempts its automatic wake");
  await f.emit("session_shutdown", {});
});

test("extension input cannot inherit rejected direct input wake authority", async () => {
  vi.useFakeTimers();
  const f = fixture(undefined, Date.now() + 10_000);
  await f.emit("session_start", {});
  await f.emit("input", { source: "rpc", text: "review ready" });
  await f.emit("input", { source: "extension", text: "extension update" });
  await f.emit("before_agent_start", { prompt: "extension update", systemPrompt: "base" });
  f.unchanged();
  await f.emit("session_shutdown", {});
});

test("later deadline retries the same recorded wait and supersedes the earlier unacknowledged prompt", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.emit("session_start", {});
  await vi.advanceTimersByTimeAsync(0);
  const stale = f.mock.sentUserMessages.at(-1)?.text;
  assert.ok(stale);
  f.unchanged();
  await f.emit("session_compact_failed", {});
  await vi.advanceTimersByTimeAsync(0);
  f.unchanged();
  assert.equal(f.mock.sentUserMessages.length, 2);
  assert.deepEqual(await f.emit("input", { source: "extension", text: stale }), { action: "handled" });
  const prompt = f.mock.sentUserMessages.at(-1)?.text;
  assert.ok(prompt);
  await f.emit("before_agent_start", { prompt, systemPrompt: "base" });
  assert.equal(f.last().status, "active");
  assert.equal(f.last().wait, undefined);
  assert.equal(f.last().automaticModelTurns, f.saved.automaticModelTurns);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(f.mock.sentUserMessages.length, 2, "accepted wake cancels all automatic retry work");
  await f.emit("session_shutdown", {});
});

test("a delivery rejection arriving after native acceptance cannot roll back the accepted wake", async () => {
  vi.useFakeTimers();
  let accept!: (text: string) => Promise<unknown>;
  const f = fixture(async (text) => {
    await accept(text);
    throw new Error("late delivery result rejected");
  });
  accept = (prompt) => f.emit("before_agent_start", { prompt, systemPrompt: "base" });
  await f.emit("session_start", {});
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(f.last().status, "active");
  assert.notEqual(f.last().id, f.saved.id);
  assert.equal(f.last().wait, undefined);
  assert.equal(f.last().automaticModelTurns, f.saved.automaticModelTurns);
  await f.emit("session_shutdown", {});
});

test("a superseded rejected prompt at queued message_start is aborted without a second activation", async () => {
  vi.useFakeTimers();
  let prompt = "";
  const f = fixture((text) => {
    prompt = text;
    return false;
  });
  await f.emit("session_start", {});
  await vi.advanceTimersByTimeAsync(0);
  f.unchanged();
  await f.emit("input", { source: "rpc", text: "review ready" });
  await f.emit("before_agent_start", { prompt: "review ready", systemPrompt: "base" });
  const id = f.last().id;
  await f.emit("message_start", { message: { role: "user", content: prompt } });
  assert.equal(f.abortCount(), 1, "native queued stale delivery cannot reach provider work");
  assert.equal(f.last().id, id);
  assert.equal(f.last().automaticModelTurns, 0);
  await f.emit("session_shutdown", {});
});

test("void return followed by a late native boundary commits exactly once", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.emit("session_start", {});
  await vi.advanceTimersByTimeAsync(0);
  f.unchanged();
  const prompt = f.mock.sentUserMessages.at(-1)?.text;
  assert.ok(prompt);
  await f.emit("before_agent_start", { prompt, systemPrompt: "base" });
  const resumed = f.last();
  assert.notEqual(resumed.id, f.saved.id);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.wait, undefined);
  assert.equal(resumed.automaticModelTurns, f.saved.automaticModelTurns);
  await f.emit("message_start", { message: { role: "user", content: prompt } });
  assert.equal(f.last().id, resumed.id);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(f.mock.sentUserMessages.length, 1);
  await f.emit("session_shutdown", {});
});

test("rejected real input preserves wait and a later real wake supersedes a late deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.emit("session_start", {});
  await vi.advanceTimersByTimeAsync(0);
  const stalePrompt = f.mock.sentUserMessages.at(-1)?.text;
  assert.ok(stalePrompt);
  await f.emit("input", { source: "rpc", text: "review ready" });
  f.unchanged(); // No native boundary: model/auth preflight rejected.
  await f.emit("input", { source: "rpc", text: "review ready now" });
  f.unchanged();
  await f.emit("before_agent_start", { prompt: "review ready now", systemPrompt: "base" });
  const resumed = f.last();
  assert.equal(resumed.status, "active");
  assert.equal(resumed.wait, undefined);
  assert.equal(resumed.automaticModelTurns, 0);
  assert.equal(resumed.tokensUsed, f.saved.tokensUsed);
  assert.deepEqual(await f.emit("input", { source: "extension", text: stalePrompt }), { action: "handled" });
  assert.equal(f.last().id, resumed.id);
  assert.equal(f.mock.sentUserMessages.length, 1, "real wake sends no extra prompt");
  await f.emit("session_shutdown", {});
});
