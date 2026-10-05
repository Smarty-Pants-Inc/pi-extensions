import assert from "node:assert/strict";
import { test } from "vitest";
import goal from "../src/goal.js";
import type { ActiveGoal } from "../src/persistence.js";
import { GoalRuntime } from "../src/runtime.js";
import { createMockContext, createMockPi } from "./support.js";

// No filesystem fixtures: these tests exercise only input queue ownership.
test("expanded real follow-up wakes once with the current Goal ID and no extra prompt", async () => {
  const mock = createMockPi({ activeTools: ["read", "goal_complete", "goal_blocked", "goal_wait"] });
  const saved: ActiveGoal = {
    id: "recorded-wait",
    text: "finish review",
    status: "paused",
    startedAt: 1,
    updatedAt: 2,
    iteration: 3,
    tokensUsed: 7,
    timeUsedSeconds: 9,
    baselineTokens: 0,
    automaticModelTurns: 4,
    toolFreeRepeatCount: 2,
    wait: { reason: "awaiting result" },
  };
  let pending = false;
  const { ctx } = createMockContext({
    hasPendingMessages: () => pending,
    sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-state", data: { goal: saved } }] },
  });
  goal(mock.pi, { settingsPath: "/nonexistent-pi-goal-regression-settings.json" });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await mock.events.get("input")?.[0]?.({ source: "rpc", text: "/notice green", streamingBehavior: "followUp" }, ctx);
  pending = true; // Native enqueue follows input hooks and precedes the next input.
  await mock.events.get("input")?.[0]?.(
    { source: "extension", text: "Recorded outcome: green", streamingBehavior: "followUp" },
    ctx,
  );
  const delivered = { message: { role: "user", content: "Recorded outcome: green" } };
  await mock.events.get("message_start")?.[0]?.(delivered, ctx);
  const lastGoal = () => {
    const entry = mock.entries.at(-1);
    assert.ok(entry);
    return (entry.data as { goal: ActiveGoal }).goal;
  };
  const resumed = lastGoal();
  assert.equal(resumed.status, "active");
  assert.notEqual(resumed.id, saved.id);
  assert.equal(resumed.wait, undefined);
  assert.equal(resumed.tokensUsed, saved.tokensUsed);
  assert.equal(resumed.timeUsedSeconds, saved.timeUsedSeconds);
  const id = resumed.id;
  resumed.automaticModelTurns = 2;
  await mock.events.get("message_start")?.[0]?.(delivered, ctx);
  assert.equal(lastGoal().id, id);
  assert.equal(lastGoal().automaticModelTurns, 2, "extension delivery cannot grant another safety epoch");
  assert.equal(mock.sentUserMessages.length, 0);
});
test("expanded real follow-up keeps its authority ahead of a later exact-text extension follow-up", () => {
  const runtime = new GoalRuntime(createMockPi().pi);
  runtime.noteQueuedNonGoalInput("/notice green", "followUp", true);
  runtime.noteQueuedNonGoalInput("Recorded outcome: green", "followUp", false);
  assert.equal(runtime.consumeQueuedNonGoalInput("Recorded outcome: green")?.resetSafetyEpoch, true);
  assert.equal(runtime.consumeQueuedNonGoalInput("Recorded outcome: green")?.resetSafetyEpoch, false);
  assert.equal(runtime.consumeQueuedNonGoalInput("Recorded outcome: green"), undefined);
});

test("same-text steer retains native priority ahead of a queued follow-up", () => {
  const runtime = new GoalRuntime(createMockPi().pi);
  runtime.noteQueuedNonGoalInput("same text", "followUp", true);
  runtime.noteQueuedNonGoalInput("same text", "steer", false);
  assert.equal(runtime.consumeQueuedNonGoalInput("same text")?.behavior, "steer");
  assert.equal(runtime.consumeQueuedNonGoalInput("same text")?.resetSafetyEpoch, true);
});

test("owned prompt boundaries cannot consume a transformed unrelated follow-up", () => {
  const runtime = new GoalRuntime(createMockPi().pi);
  runtime.noteQueuedNonGoalInput("/notice green", "followUp", true);
  runtime.noteQueuedNonGoalInput("Recorded outcome: green", "followUp", false);
  assert.equal(runtime.consumeQueuedNonGoalInput("Recorded outcome: green", false), undefined);
  assert.equal(runtime.consumeQueuedNonGoalInput("Recorded outcome: green")?.resetSafetyEpoch, true);
});
