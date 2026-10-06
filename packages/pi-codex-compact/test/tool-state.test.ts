import assert from "node:assert/strict";
import { type Tool, Type } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { comparableTools, ToolStateTracker } from "../src/tool-state.js";

function tools(description = "Read a file"): Tool[] {
  return [{ name: "read", description, parameters: Type.Object({ path: Type.String() }) }];
}

test("transformed descriptions require request evidence, not blanket description omission", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const registry = tools();
  const recorded = tools("Read a file; callable through codemode");
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  tracker.observe(owner, "session", recorded, registry);
  assert.equal(tracker.matches(owner, "session", recorded, registry), true);
  assert.equal(tracker.matches(owner, "session", tools("A new effective description"), registry), false);
  assert.equal(tracker.matches(owner, "session", recorded, tools("A newly registered description")), false);
});

test("snapshots detect in-place schema and description mutations", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  const registry = tools();
  tracker.observe(owner, "session", recorded, registry);
  registry[0].description = "Changed";
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  registry[0].description = "Read a file";
  registry[0].parameters = Type.Object({ changed: Type.Boolean() });
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
});

test("membership and schema mismatches cannot establish request evidence", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  tracker.observe(owner, "session", recorded, tools());
  tracker.observe(owner, "session", recorded, []);
  assert.equal(tracker.matches(owner, "session", recorded, tools()), false);
  tracker.observe(owner, "session", recorded, [{ ...tools()[0], parameters: Type.Object({ other: Type.Number() }) }]);
  assert.equal(tracker.matches(owner, "session", recorded, tools()), false);
});

test("observations are fenced by owner, session identity, and lifecycle reset", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  tracker.observe(owner, "session", recorded, tools());
  assert.equal(tracker.matches({}, "session", recorded, tools()), false);
  assert.equal(tracker.matches(owner, "replacement", recorded, tools()), false);
  tracker.reset(owner);
  assert.equal(tracker.matches(owner, "session", recorded, tools()), false);
  assert.equal(tracker.matches(owner, "session", tools(), tools()), true);
});

test("comparison uses equivalent JSON schemas and only public shared fields", () => {
  const tracker = new ToolStateTracker();
  const tool = { ...tools()[0], constrainedSampling: true };
  assert.equal(tracker.matches({}, "session", comparableTools([tool]), tools()), true);
});
