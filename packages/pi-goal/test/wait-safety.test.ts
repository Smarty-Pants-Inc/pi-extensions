import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import goal from "../src/goal.js";
import type { ActiveGoal } from "../src/persistence.js";
import { createMockContext, createMockPi } from "./support.js";

// No cleanup hook: the runner owns the temporary directory's lifetime.
const directory = mkdtempSync(join(tmpdir(), "pi-goal-wait-safety-"));
const settingsPath = join(directory, "settings.json");
writeFileSync(
  settingsPath,
  JSON.stringify({
    toolVisibility: "always",
    rpc: { enabled: true },
    continuationLimits: { automaticTurns: 2, noProgressTurns: null },
  }),
);
afterEach(() => vi.useRealTimers());

function fixture(saved?: ActiveGoal) {
  const mock = createMockPi({ activeTools: ["read", "goal_complete", "goal_blocked", "goal_wait"] });
  goal(mock.pi, { settingsPath });
  const context = createMockContext({
    sessionManager: {
      getBranch: () => (saved ? [{ type: "custom", customType: "goal-state", data: { goal: saved } }] : []),
    },
  });
  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  return { mock, ...context };
}
type Fixture = ReturnType<typeof fixture>;
function last(f: Fixture): ActiveGoal {
  const entry = f.mock.entries.filter((item) => item.customType === "goal-state").at(-1);
  assert.ok(entry);
  return (entry.data as { goal: ActiveGoal }).goal;
}
async function begin(f: Fixture) {
  const prompt = f.mock.sentUserMessages.at(-1)?.text;
  assert.ok(prompt);
  await f.mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, f.ctx);
  await f.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: prompt } }, f.ctx);
}
async function wait(f: Fixture) {
  const tool = f.mock.tools.find((item) => item.name === "goal_wait");
  assert.ok(tool);
  await (tool.execute as (...args: unknown[]) => Promise<unknown>)(
    "wait",
    {
      goal_id: last(f).id,
      reason: "await review",
      resume_after_ms: 10_000,
    },
    undefined,
    undefined,
    f.ctx,
  );
  await f.mock.events.get("turn_end")?.[0]?.({ message: { role: "assistant", stopReason: "toolUse" } }, f.ctx);
  await f.mock.events.get("agent_end")?.[0]?.({ messages: [] }, f.ctx);
}

test("deadline waits charge automatic responses and stop at the finite boundary across reload", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.mock.commands.get("goal")?.handler("review objective", f.ctx);
  await begin(f);
  await wait(f); // Initial explicit user activation is manual.
  assert.equal(last(f).automaticModelTurns, 0);
  await vi.advanceTimersByTimeAsync(10_000);
  await begin(f);
  await wait(f);
  const saved = structuredClone(last(f));
  f.mock.events.get("session_shutdown")?.[0]?.({}, f.ctx);
  const restored = fixture(saved);
  await vi.advanceTimersByTimeAsync(10_000);
  await begin(restored);
  await wait(restored);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(restored.mock.sentUserMessages.length, 1, "no third automatic response after reload");
  assert.equal(last(restored).automaticModelTurns, 2, "responses entering waits are charged");
  assert.equal(last(restored).status, "paused");
  assert.equal(last(restored).safetyPauseCause, "continuation_limit");
  assert.equal(last(restored).wait, undefined);
});

for (const source of ["interactive", "resume"] as const) {
  test(`${source} grants a fresh manual epoch for a waiting goal`, async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.mock.commands.get("goal")?.handler("review objective", f.ctx);
    await begin(f);
    await wait(f);
    const saved = { ...structuredClone(last(f)), automaticModelTurns: 2 };
    f.mock.events.get("session_shutdown")?.[0]?.({}, f.ctx);
    const restored = fixture(saved);
    if (source === "resume") {
      await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);
      await begin(restored);
    } else {
      await restored.mock.events.get("input")?.[0]?.({ source, text: "review ready" }, restored.ctx);
    }
    assert.equal(last(restored).status, "active");
    assert.equal(last(restored).automaticModelTurns, 0);
    await wait(restored);
    assert.equal(last(restored).automaticModelTurns, 0, "real input remains manual");
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(last(restored).status, "active", "new epoch can wake automatically");
    restored.mock.events.get("session_shutdown")?.[0]?.({}, restored.ctx);
  });
}

test("restored wait at the finite boundary sends no provider prompt", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.mock.commands.get("goal")?.handler("review objective", f.ctx);
  await begin(f);
  await wait(f);
  const saved = { ...structuredClone(last(f)), automaticModelTurns: 2 };
  f.mock.events.get("session_shutdown")?.[0]?.({}, f.ctx);
  const restored = fixture(saved);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  assert.equal(last(restored).safetyPauseCause, "continuation_limit");
});

test("managed wait terminal receipt durably cancels wake before owner notification", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let terminalWait: ActiveGoal["wait"];
  let terminalCount = 0;
  const errors: unknown[] = [];
  f.mock.eventBus.on("pi-goal:event:owned", (data) => {
    const event = data as { type: string; status?: string };
    if (event.type === "error") errors.push(data);
    if (event.type === "state" && event.status === "paused") {
      terminalCount++;
      terminalWait = structuredClone(last(f).wait);
    }
  });
  f.mock.eventBus.emit("pi-goal:start", { runId: "owned", objective: "managed review" });
  await vi.advanceTimersByTimeAsync(0);
  await begin(f);
  await wait(f);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(terminalCount, 1);
  f.mock.eventBus.emit("pi-goal:cancel", { runId: "owned" });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(errors.length, 1, "terminal run no longer accepts cancellation");
  const saved = structuredClone(last(f));
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(f.mock.sentUserMessages.length, 1, "terminal owner cannot leave an unowned wake");
  f.mock.events.get("session_shutdown")?.[0]?.({}, f.ctx);
  const restored = fixture(saved);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(restored.mock.sentUserMessages.length, 0, "reload cannot re-arm a terminated managed wait");
  assert.equal(terminalWait, undefined, "wait is durably gone before terminal receipt");
  assert.equal(saved.wait, undefined);
});
