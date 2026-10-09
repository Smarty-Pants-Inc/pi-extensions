import { test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus from "../tab-status.js";

test("registers the tab status lifecycle hooks", () => {
  const events: string[] = [];
  tabStatus({ on: (event: string) => events.push(event) } as never);
  assert.deepEqual(events, [
    "session_start",
    "before_agent_start",
    "agent_start",
    "turn_start",
    "tool_call",
    "tool_result",
    "message_update",
    "tool_execution_update",
    "message_end",
    "session_info_changed",
    "agent_end",
    "agent_settled",
    "session_shutdown",
  ]);
});
