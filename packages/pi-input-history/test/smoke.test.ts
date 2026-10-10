import assert from "node:assert/strict";
import { test } from "vitest";
import history from "../src/index.js";

test("registers Ctrl+Alt+R history search without overriding Pi's Ctrl+R session rename", () => {
  const events = new Set<string>();
  const shortcuts: string[] = [];
  const pi = {
    on(event: string) {
      events.add(event);
    },
    registerShortcut(key: string) {
      shortcuts.push(key);
    },
  };

  history(pi as never);

  assert.deepEqual([...events], ["session_start", "session_tree", "session_shutdown"]);
  assert.deepEqual(shortcuts, ["ctrl+alt+r"]);
});
