import assert from "node:assert/strict";
import { test } from "vitest";
import goal from "../src/goal.js";
import type { ActiveGoal } from "../src/persistence.js";
import { createMockContext, createMockPi } from "./support.js";

for (const boundary of ["pending-real", "custom"] as const) {
  test(`${boundary} cannot acknowledge retained real-input wake authority`, async () => {
    const saved: ActiveGoal = {
      id: "original-wait",
      text: "finish review",
      status: "paused",
      startedAt: 1,
      updatedAt: 2,
      iteration: 3,
      tokensUsed: 7,
      timeUsedSeconds: 9,
      baselineTokens: 0,
      automaticModelTurns: 4,
      toolFreeRepeatCount: 1,
      wait: { reason: "original condition" },
    };
    const mock = createMockPi();
    let pending = false;
    const { ctx } = createMockContext({
      hasPendingMessages: () => pending,
      sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-state", data: { goal: saved } }] },
    });
    goal(mock.pi, { settingsPath: "/nonexistent-pi-goal-regression-settings.json" });
    const emit = async (name: string, event: unknown) => mock.events.get(name)?.[0]?.(event, ctx);
    await emit("session_start", {});
    mock.entries.push({ customType: "goal-state", data: { goal: saved } });
    const before = structuredClone(mock.entries.at(-1)?.data);
    await emit("input", { source: "rpc", text: "/notice blue", streamingBehavior: "followUp" });
    pending = true;
    if (boundary === "pending-real") {
      // A later handler consumes this second attempt; no native delivery follows.
      await emit("input", { source: "rpc", text: "/notice green", streamingBehavior: "steer" });
    } else {
      // Native custom queue messages bypass input hooks entirely.
      await emit("message_start", { message: { role: "custom", content: "extension notice" } });
    }
    await emit("input", { source: "extension", text: "Recorded outcome: blue", streamingBehavior: "followUp" });
    await emit("message_start", { message: { role: "user", content: "Recorded outcome: blue" } });
    await emit("message_start", { message: { role: "user", content: "extension notice" } });
    assert.deepEqual(mock.entries.at(-1)?.data, before, "ambiguous deliveries keep the exact original recorded wait");
    assert.equal(mock.sentUserMessages.length, 0);
  });
}
