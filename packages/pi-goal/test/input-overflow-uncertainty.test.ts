import assert from "node:assert/strict";
import { test } from "vitest";
import { GoalRuntime } from "../src/runtime.js";
import { createMockPi } from "./support.js";

for (const behavior of ["steer", "followUp"] as const) {
  test(`overflow uncertainty outlives retained ${behavior} observations and settlement`, () => {
    const runtime = new GoalRuntime(createMockPi().pi);
    for (let index = 0; index < 45; index++) {
      runtime.noteQueuedNonGoalInput(`observation ${index}`, behavior, true);
      assert.ok(runtime.pendingNonGoalInputs.length <= 20, "observation storage stays bounded");
    }
    assert.equal(runtime.nonGoalInputOverflow, true);
    while (runtime.pendingNonGoalInputs.length > 0) {
      assert.equal(runtime.consumeQueuedNonGoalInput("native expanded delivery")?.resetSafetyEpoch, false);
    }
    assert.equal(runtime.ambiguousNonGoalInput, true, "array exhaustion is not acknowledgement");
    runtime.clearSettledSafetyTracking();
    assert.equal(runtime.nonGoalInputOverflow, true);
    assert.equal(runtime.ambiguousNonGoalInput, true, "run settlement is not acknowledgement");
    runtime.noteQueuedNonGoalInput("later real attempt", behavior, true);
    assert.equal(runtime.consumeQueuedNonGoalInput("evicted extension delivery")?.resetSafetyEpoch, false);
    runtime.noteIdleNonGoalInput("unrelated accepted idle", true);
    assert.equal(runtime.consumeIdleNonGoalInput("unrelated accepted idle")?.resetSafetyEpoch, false);
    runtime.clearPendingGoalPrompts();
    assert.equal(runtime.nonGoalInputOverflow, true, "session clearing cannot exclude late sibling hooks");
    assert.equal(runtime.ambiguousNonGoalInput, true);
    runtime.noteQueuedNonGoalInput("after session change", behavior, true);
    assert.equal(runtime.consumeQueuedNonGoalInput("late evicted delivery")?.resetSafetyEpoch, false);
  });
}

test("retiring a full but non-overflowed array does not permanently revoke isolated real authority", () => {
  const runtime = new GoalRuntime(createMockPi().pi);
  for (let index = 0; index < 20; index++) runtime.noteQueuedNonGoalInput(`extension ${index}`, "followUp");
  for (let index = 0; index < 20; index++) runtime.consumeQueuedNonGoalInput(`extension ${index}`);
  runtime.clearSettledSafetyTracking();
  assert.equal(runtime.nonGoalInputOverflow, false);
  assert.equal(runtime.ambiguousNonGoalInput, false);
  runtime.noteQueuedNonGoalInput("isolated real accepted input", "steer", true);
  assert.equal(runtime.consumeQueuedNonGoalInput("isolated real accepted input")?.resetSafetyEpoch, true);
  const fresh = new GoalRuntime(createMockPi().pi);
  assert.equal(fresh.nonGoalInputOverflow, false, "a fresh runtime has no old observations");
});
