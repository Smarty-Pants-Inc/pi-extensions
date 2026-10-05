import assert from "node:assert/strict";
import { test } from "vitest";
import { GoalRuntime } from "../src/runtime.js";
import { createMockPi } from "./support.js";

test("idle boundary cannot use expansion fallback to confirm a different attempt", () => {
  const runtime = new GoalRuntime(createMockPi().pi);
  runtime.noteIdleNonGoalInput("/notice green", true);
  assert.equal(runtime.consumeIdleNonGoalInput("Recorded outcome: green"), undefined);
  assert.equal(runtime.consumeIdleNonGoalInput("/notice green")?.resetSafetyEpoch, false);
});

test("equal-text overlapping idle attempts cannot identify native acceptance", () => {
  const runtime = new GoalRuntime(createMockPi().pi);
  runtime.noteIdleNonGoalInput("review ready", true);
  runtime.noteIdleNonGoalInput("review ready", true);
  assert.equal(runtime.consumeIdleNonGoalInput("review ready"), undefined);
});

for (const extensionFirst of [true, false]) {
  test(`idle extension observation revokes overlapping real authority: extensionFirst=${extensionFirst}`, () => {
    const runtime = new GoalRuntime(createMockPi().pi);
    if (extensionFirst) runtime.noteIdleNonGoalInput("extension observation");
    runtime.noteIdleNonGoalInput("handled real observation", true);
    if (!extensionFirst) runtime.noteIdleNonGoalInput("extension observation");
    assert.equal(runtime.consumeIdleNonGoalInput("extension observation")?.resetSafetyEpoch, false);
    assert.equal(runtime.consumeIdleNonGoalInput("handled real observation")?.resetSafetyEpoch, false);
  });
}

for (const behavior of ["idle", "followUp"] as const) {
  test(`accepted ${behavior} observation cannot reset a different goal generation`, () => {
    const runtime = new GoalRuntime(createMockPi().pi);
    runtime.activeGoal = {
      id: "observed-goal",
      text: "review",
      status: "paused",
      startedAt: 1,
      updatedAt: 2,
      iteration: 3,
      tokensUsed: 7,
      timeUsedSeconds: 9,
      baselineTokens: 0,
      wait: { reason: "original condition" },
    };
    if (behavior === "idle") runtime.noteIdleNonGoalInput("review ready", true);
    else runtime.noteQueuedNonGoalInput("review ready", behavior, true);
    runtime.activeGoal = { ...runtime.activeGoal, id: "replacement-goal" };
    const accepted =
      behavior === "idle"
        ? runtime.consumeIdleNonGoalInput("review ready")
        : runtime.consumeQueuedNonGoalInput("review ready");
    assert.equal(accepted?.resetSafetyEpoch, false);
  });
}

for (const behavior of ["idle", "followUp"] as const) {
  test(`settlement does not discard outstanding ${behavior} extension hooks`, () => {
    const runtime = new GoalRuntime(createMockPi().pi);
    if (behavior === "idle") runtime.noteIdleNonGoalInput("older extension");
    else runtime.noteQueuedNonGoalInput("older extension", behavior);
    runtime.clearSettledSafetyTracking();
    if (behavior === "idle") {
      runtime.noteIdleNonGoalInput("handled real", true);
      assert.equal(runtime.consumeIdleNonGoalInput("older extension")?.resetSafetyEpoch, false);
      assert.equal(runtime.consumeIdleNonGoalInput("handled real")?.resetSafetyEpoch, false);
    } else {
      runtime.noteQueuedNonGoalInput("handled real", behavior, !runtime.ambiguousNonGoalInput);
      assert.equal(runtime.consumeQueuedNonGoalInput("older extension")?.resetSafetyEpoch, false);
      assert.equal(runtime.consumeQueuedNonGoalInput("handled real")?.resetSafetyEpoch, false);
    }
  });
}

for (const idleFirst of [true, false]) {
  test(`mixed idle and queued observations fail closed: idleFirst=${idleFirst}`, () => {
    const runtime = new GoalRuntime(createMockPi().pi);
    if (idleFirst) runtime.noteIdleNonGoalInput("idle extension");
    runtime.noteQueuedNonGoalInput("queued real", "followUp", true);
    if (!idleFirst) runtime.noteIdleNonGoalInput("idle extension");
    assert.equal(runtime.consumeIdleNonGoalInput("idle extension")?.resetSafetyEpoch, false);
    assert.equal(runtime.consumeQueuedNonGoalInput("queued real")?.resetSafetyEpoch, false);
  });
}
