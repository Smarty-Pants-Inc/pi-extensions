import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { captureSessionOrigin } from "../src/session-origin.js";

for (const boundary of [
  "sibling",
  "ancestor",
  "empty",
  "session",
  "invalid leaf",
  "null leaf",
  "unreadable",
] as const) {
  test(`live origin retires monotonically on ${boundary}`, () => {
    const manager = SessionManager.inMemory();
    const root = manager.appendMessage({ role: "user", content: "shared task", timestamp: 1 });
    const origin = manager.appendCustomEntry("origin metadata");
    const isCurrent = captureSessionOrigin({ sessionManager: manager });
    assert.equal(isCurrent(), true);
    const getBranch = manager.getBranch.bind(manager);
    const getLeafId = manager.getLeafId.bind(manager);
    if (boundary === "session") manager.newSession();
    else if (boundary === "invalid leaf") manager.getLeafId = () => "not-the-branch-leaf";
    else if (boundary === "null leaf") manager.getLeafId = () => null;
    else if (boundary === "unreadable")
      manager.getBranch = () => {
        throw new Error("retired context");
      };
    else if (boundary === "empty") manager.resetLeaf();
    else {
      manager.branch(root);
      if (boundary === "sibling") manager.appendCustomEntry("sibling metadata");
    }
    assert.equal(isCurrent(), false);
    manager.getBranch = getBranch;
    manager.getLeafId = getLeafId;
    if (boundary !== "session") manager.branch(origin);
    assert.equal(isCurrent(), false, "returning to the opening leaf cannot resurrect an observed divergence");
  });
}

test("ordinary message and metadata appends retain a complete opening prefix", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "opening", timestamp: 1 });
  manager.appendCustomEntry("metadata");
  const isCurrent = captureSessionOrigin({ sessionManager: manager });
  manager.appendMessage({ role: "user", content: "normal append", timestamp: 2 });
  assert.equal(isCurrent(), true);
  manager.appendCustomEntry("more metadata");
  assert.equal(isCurrent(), true);
});
