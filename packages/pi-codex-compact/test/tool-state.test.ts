import assert from "node:assert/strict";
import { type Tool, Type } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { comparableTools, ToolStateTracker } from "../src/tool-state.js";

function tools(description = "Read a file"): Tool[] {
  return [{ name: "read", description, parameters: Type.Object({ path: Type.String() }) }];
}

function payload(recorded: Tool[]) {
  return { tools: recorded.map((tool) => ({ type: "function", ...tool })) };
}

function dispatch(tracker: ToolStateTracker, owner: object, recorded: Tool[], registry: Tool[]) {
  tracker.prepare(owner, "session", recorded, registry);
  tracker.observe(owner, "session", recorded, registry, payload(recorded));
}

test("transformed descriptions require prepared request evidence, not blanket description omission", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const registry = tools();
  const recorded = tools("Read a file; callable through codemode");
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  tracker.observe(owner, "session", recorded, registry, payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  dispatch(tracker, owner, recorded, registry);
  assert.equal(tracker.matches(owner, "session", recorded, registry), true);
  assert.equal(tracker.matches(owner, "session", tools("A new effective description"), registry), false);
  assert.equal(tracker.matches(owner, "session", recorded, tools("A newly registered description")), false);
});

test("snapshots detect in-place schema and description mutations", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  const registry = tools();
  dispatch(tracker, owner, recorded, registry);
  registry[0].description = "Changed";
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  tracker.observe(owner, "session", recorded, registry, payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, registry), false, "cached callbacks cannot bless the edit");
  registry[0].description = "Read a file";
  registry[0].parameters = Type.Object({ changed: Type.Boolean() });
  tracker.observe(owner, "session", recorded, registry, payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
});

test("cached observations cannot replace preparation; a new prepared request can admit new descriptions", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  dispatch(tracker, owner, recorded, tools());
  const changed = tools("Changed registry description");
  tracker.observe(owner, "session", recorded, changed, payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, changed), false);
  const next = tools("Changed effective description");
  tracker.prepare(owner, "session", next, changed);
  tracker.observe(owner, "session", next, changed, payload(recorded));
  assert.equal(tracker.matches(owner, "session", next, changed), false, "stale payload cannot prove new preparation");
  tracker.observe(owner, "session", next, changed, payload(next));
  assert.equal(tracker.matches(owner, "session", next, changed), true);
});

test("membership and schema mismatches cannot establish request evidence", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  dispatch(tracker, owner, recorded, tools());
  dispatch(tracker, owner, recorded, []);
  assert.equal(tracker.matches(owner, "session", recorded, tools()), false);
  dispatch(tracker, owner, recorded, [{ ...tools()[0], parameters: Type.Object({ other: Type.Number() }) }]);
  assert.equal(tracker.matches(owner, "session", recorded, tools()), false);
});

for (const wire of [
  undefined,
  null,
  {},
  { tools: [] },
  { tools: null },
  { tools: [null] },
  payload(tools("Wrong")),
  {
    tools: [...payload(tools()).tools, ...payload(tools()).tools],
  },
]) {
  test(`invalid or hidden wire declarations fail closed: ${JSON.stringify(wire)}`, () => {
    const tracker = new ToolStateTracker();
    const owner = {};
    dispatch(tracker, owner, tools(), tools());
    tracker.observe(owner, "session", tools(), tools(), wire);
    assert.equal(tracker.matches(owner, "session", tools(), tools()), false, "must not fall back to raw equality");
  });
}

test("observations are fenced by owner, session identity, and lifecycle reset", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  dispatch(tracker, owner, recorded, tools());
  assert.equal(tracker.matches({}, "session", recorded, tools()), false);
  assert.equal(tracker.matches(owner, "replacement", recorded, tools()), false);
  tracker.reset(owner);
  tracker.observe(owner, "session", recorded, tools(), payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, tools()), false);
  assert.equal(tracker.matches(owner, "session", tools(), tools()), true);
});

test("wire schema/sampling normalization is frozen and checked again at remote serialization", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  const wire = payload(recorded);
  wire.tools[0].parameters = Type.Object({ path: Type.Union([Type.String(), Type.Null()]) });
  tracker.prepare(owner, "session", recorded, tools());
  tracker.observe(owner, "session", recorded, tools(), wire);
  const validate = tracker.payloadValidator(owner, "session");
  assert.ok(validate);
  assert.equal(validate(structuredClone(wire)), true);
  assert.equal(validate(payload(recorded)), false);
  assert.equal(validate({ tools: [] }), false);
  assert.equal(tracker.payloadValidator(owner, "replacement"), undefined);
  wire.tools[0].description = "Later mutation";
  assert.equal(validate(wire), false);
  dispatch(tracker, owner, tools("New dispatch"), tools());
  assert.equal(validate(payload(tools("New dispatch"))), false, "an in-flight validator retains its original snapshot");
});

test("comparison uses equivalent JSON schemas and only public shared fields", () => {
  const tracker = new ToolStateTracker();
  const tool = { ...tools()[0], constrainedSampling: true };
  assert.equal(tracker.matches({}, "session", comparableTools([tool]), tools()), true);
});
