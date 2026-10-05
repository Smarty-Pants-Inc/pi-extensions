import assert from "node:assert/strict";
import { test } from "vitest";
import { GoalRuntime } from "../src/runtime.js";
import { createMockPi } from "./support.js";

for (const resetSafetyEpoch of [false, true]) {
  test(`speculative agent start retains unacknowledged follow-up: reset=${resetSafetyEpoch}`, () => {
    const runtime = new GoalRuntime(createMockPi().pi);
    runtime.noteQueuedNonGoalInput("still inside input hook", "followUp", resetSafetyEpoch);
    const observation = runtime.pendingNonGoalInputs[0];
    assert.equal(runtime.consumeQueuedNonGoalFollowUpForAgentStart(), true);
    assert.equal(runtime.pendingNonGoalInputs.length, 1);
    assert.equal(runtime.pendingNonGoalInputs[0], observation);
    assert.equal(runtime.consumeQueuedNonGoalInput("still inside input hook"), observation);
    assert.equal(runtime.consumeQueuedNonGoalFollowUpForAgentStart(), false);
  });
}
