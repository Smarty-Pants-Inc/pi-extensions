import { describe, expect, test } from "vitest";
import {
  type OwnedConversationOpenRequest,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  parseOwnedConversationOpenRequest,
  parseProtocolPing,
  parseRpcReply,
  parseWorkflowUiOpenRequest,
  parseWorkflowUiQueryRequest,
  parseWorkflowUiSnapshot,
  RPC_CHANNELS,
  replyChannel,
  requiredCapabilitiesMatch,
  routingPolicyFingerprint,
  WORKFLOW_UI_CHANNELS,
  WORKFLOW_UI_VERSION,
  type WorkflowUiOpenRequest,
  type WorkflowUiQueryRequest,
  type WorkflowUiRunSummary,
  type WorkflowUiSnapshot,
} from "../src/index.js";

const owner = { extension: "pi-workflows", runId: "run-1", nodeId: "node-1", attemptId: "attempt-1" } as const;
const query: WorkflowUiQueryRequest = { requestId: "request-1" };
const open: WorkflowUiOpenRequest = { ...query, surfaceId: "surface-1", runId: "run-1" };
const conversation: OwnedConversationOpenRequest = { ...query, agentId: "agent-1", owner };

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    surfaceId: "surface-1",
    runId: "run-1",
    name: "Review",
    status: "running",
    callCount: 5,
    runningCalls: 1,
    completedCalls: 2,
    failedCalls: 1,
    elapsedMs: 1.5,
    restored: false,
    ...overrides,
  };
}

function snapshot(runs: unknown = [summary()]): Record<string, unknown> {
  return { version: 1, surfaceId: "surface-1", runs };
}

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

const parsers = [
  { parse: parseWorkflowUiSnapshot, valid: snapshot() },
  { parse: parseWorkflowUiQueryRequest, valid: query },
  { parse: parseWorkflowUiOpenRequest, valid: open },
  { parse: parseOwnedConversationOpenRequest, valid: conversation },
];

test("exports separate optional UI channels using the existing reply idiom", () => {
  expect(WORKFLOW_UI_VERSION).toBe(1);
  expect(WORKFLOW_UI_CHANNELS).toEqual({
    query: "pi-workflows:ui:query",
    changed: "pi-workflows:ui:changed",
    open: "pi-workflows:ui:open",
    openConversation: "subagents:ui:open-owned",
  });
  for (const channel of Object.values(WORKFLOW_UI_CHANNELS)) {
    expect(replyChannel(channel, query.requestId)).toBe(`${channel}:reply:request-1`);
  }
  const data: WorkflowUiSnapshot = parseWorkflowUiSnapshot(snapshot());
  expect(parseRpcReply<WorkflowUiSnapshot>({ success: true, data })).toEqual({ success: true, data });
  expect(parseRpcReply({ success: false, error: "Inactive surface" })).toEqual({
    success: false,
    error: "Inactive surface",
  });
});

test("accepts exact request shapes and detaches the immutable attempt owner", () => {
  expect(parseWorkflowUiQueryRequest(query)).toEqual(query);
  expect(parseWorkflowUiOpenRequest(open)).toEqual(open);
  const raw = structuredClone(conversation);
  const parsed = parseOwnedConversationOpenRequest(raw);
  expect(parsed).toEqual(conversation);
  expect(parsed).not.toBe(raw);
  expect(parsed.owner).not.toBe(raw.owner);
  raw.owner.attemptId = "replacement";
  expect(parsed.owner.attemptId).toBe("attempt-1");
});

test("preserves original display text and identifiers without sanitizing or trimming", () => {
  const raw = snapshot([
    summary({ name: " \u001b[31mReview\n ", currentPhase: " <script>phase</script> ", runId: " run " }),
  ]);
  expect(parseWorkflowUiSnapshot(raw).runs[0]).toMatchObject({
    name: " \u001b[31mReview\n ",
    currentPhase: " <script>phase</script> ",
    runId: " run ",
  });
  expect(parseWorkflowUiQueryRequest({ requestId: " request " }).requestId).toBe(" request ");
  expect(
    parseOwnedConversationOpenRequest({ ...conversation, owner: { ...owner, attemptId: " attempt " } }).owner.attemptId,
  ).toBe(" attempt ");
});

describe("strict own plain records", () => {
  test("rejects missing and unknown fields at every request and snapshot boundary", () => {
    for (const { parse, valid } of parsers) {
      for (const key of Object.keys(valid)) expect(() => parse(without(valid, key))).toThrow();
      for (const extra of [{ callback: () => {} }, { approved: true }, { action: "stop" }, { ["__proto__"]: {} }]) {
        expect(() => parse({ ...valid, ...extra })).toThrow();
      }
    }
    for (const key of Object.keys(summary())) {
      expect(() => parseWorkflowUiSnapshot(snapshot([without(summary(), key)]))).toThrow();
    }
    expect(() => parseWorkflowUiSnapshot(snapshot([summary({ unexpected: true })]))).toThrow();
    expect(() => parseOwnedConversationOpenRequest({ ...conversation, owner: { ...owner, extra: 1 } })).toThrow();
  });

  test("rejects null, arrays, functions, inherited fields, symbols, and getters", () => {
    for (const { parse, valid } of parsers) {
      for (const raw of [null, [], 1, "string", () => {}, Object.create(valid), new Date()]) {
        expect(() => parse(raw)).toThrow();
      }
      expect(() => parse({ ...valid, [Symbol("hidden")]: true })).toThrow();
      let accessed = false;
      const raw = { ...valid };
      Object.defineProperty(raw, "requestId", {
        get() {
          accessed = true;
          return "request";
        },
      });
      expect(() => parse(raw)).toThrow();
      expect(accessed).toBe(false);
      expect(parse(Object.assign(Object.create(null), valid))).toEqual(valid);
    }
    for (const raw of [null, [], Object.create(summary())]) {
      expect(() => parseWorkflowUiSnapshot(snapshot([raw]))).toThrow();
    }
    expect(() => parseOwnedConversationOpenRequest({ ...conversation, owner: Object.create(owner) })).toThrow();
  });
});

test("requires exact workflow ownership and a bounded nonempty attempt", () => {
  for (const replacement of [
    { ...owner, extension: "foreign" },
    { ...owner, extension: " pi-workflows " },
    without(owner, "attemptId"),
    ...[undefined, null, "", " ", "a".repeat(257)].map((attemptId) => ({ ...owner, attemptId })),
    ...["runId", "nodeId"].flatMap((key) => [without(owner, key), { ...owner, [key]: "a".repeat(257) }]),
  ]) {
    expect(() => parseOwnedConversationOpenRequest({ ...conversation, owner: replacement })).toThrow();
  }
});

test("bounds every string and rejects empty, non-string, and raw overlong values", () => {
  for (const { parse, valid } of parsers.slice(1)) {
    for (const key of Object.keys(valid).filter((key) => key !== "owner")) {
      const max = key === "requestId" || key === "agentId" ? 128 : 256;
      expect(parse({ ...valid, [key]: "a".repeat(max) })).toMatchObject({ [key]: "a".repeat(max) });
      for (const value of ["", " \n ", null, 1, () => {}, "a".repeat(max + 1), ` ${"a".repeat(max)} `]) {
        expect(() => parse({ ...valid, [key]: value })).toThrow();
      }
    }
  }
  for (const [key, max] of [
    ["surfaceId", 256],
    ["runId", 256],
    ["name", 512],
    ["currentPhase", 512],
  ] as const) {
    for (const value of ["", " ", null, 1, "a".repeat(max + 1)]) {
      expect(() => parseWorkflowUiSnapshot(snapshot([summary({ [key]: value })]))).toThrow();
    }
    const raw = snapshot([summary({ [key]: "a".repeat(max) })]);
    if (key === "surfaceId") raw.surfaceId = "a".repeat(max);
    expect(parseWorkflowUiSnapshot(raw).runs[0]).toHaveProperty(key, "a".repeat(max));
  }
  for (const surfaceId of [undefined, "", " ", "a".repeat(257)]) {
    expect(() => parseWorkflowUiSnapshot({ ...snapshot([]), surfaceId })).toThrow();
  }
});

test("validates explicit versions, status, and restored rather than inferring state", () => {
  const statuses: WorkflowUiRunSummary["status"][] = [
    "pending",
    "running",
    "pausing",
    "paused",
    "stopping",
    "completed",
    "failed",
    "stopped",
    "interrupted",
  ];
  for (const status of statuses) {
    expect(parseWorkflowUiSnapshot(snapshot([summary({ status, restored: true })])).runs[0]).toMatchObject({
      status,
      restored: true,
    });
  }
  for (const version of [undefined, 0, 2, "1", NaN]) {
    expect(() => parseWorkflowUiSnapshot({ ...snapshot(), version })).toThrow();
    expect(() => parseWorkflowUiSnapshot(snapshot([summary({ version })]))).toThrow();
  }
  for (const status of ["unknown", "queued", "", null, 1]) {
    expect(() => parseWorkflowUiSnapshot(snapshot([summary({ status })]))).toThrow();
  }
  for (const restored of [undefined, 0, "false", null]) {
    expect(() => parseWorkflowUiSnapshot(snapshot([summary({ restored })]))).toThrow();
  }
});

test("requires finite nonnegative counts and tokens with consistent totals", () => {
  for (const key of ["callCount", "runningCalls", "completedCalls", "failedCalls", "tokenCount"]) {
    for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, "1", null]) {
      expect(() => parseWorkflowUiSnapshot(snapshot([summary({ [key]: value })]))).toThrow();
    }
  }
  for (const elapsedMs of [-1, NaN, Infinity, -Infinity, "1", null]) {
    expect(() => parseWorkflowUiSnapshot(snapshot([summary({ elapsedMs })]))).toThrow();
  }
  const zero = summary({
    callCount: 0,
    runningCalls: 0,
    completedCalls: 0,
    failedCalls: 0,
    elapsedMs: 0,
    tokenCount: 0,
  });
  expect(parseWorkflowUiSnapshot(snapshot([zero])).runs[0]).toMatchObject(zero);
  expect(() => parseWorkflowUiSnapshot(snapshot([summary({ callCount: 3 })]))).toThrow(/totals/);
  expect(() =>
    parseWorkflowUiSnapshot(
      snapshot([
        summary({
          callCount: Number.MAX_SAFE_INTEGER,
          runningCalls: Number.MAX_SAFE_INTEGER,
          completedCalls: 1,
          failedCalls: 0,
        }),
      ]),
    ),
  ).toThrow(/totals/);
  expect(parseWorkflowUiSnapshot(snapshot([summary({ callCount: 4, tokenCount: 10 })])).runs[0]).toMatchObject({
    callCount: 4,
    tokenCount: 10,
  });
});

test("accepts 0 and 256 runs but rejects 257, sparse arrays, mismatches, and duplicate IDs", () => {
  expect(parseWorkflowUiSnapshot(snapshot([])).runs).toEqual([]);
  const runs = Array.from({ length: 256 }, (_, i) => summary({ runId: `run-${i}` }));
  expect(parseWorkflowUiSnapshot(snapshot(runs)).runs).toHaveLength(256);
  expect(() => parseWorkflowUiSnapshot(snapshot([...runs, summary({ runId: "run-256" })]))).toThrow();
  expect(() => parseWorkflowUiSnapshot(snapshot(new Array(1)))).toThrow();
  expect(() => parseWorkflowUiSnapshot(snapshot(Object.assign([summary()], { callback: () => {} })))).toThrow();
  let invoked = false;
  const getterRuns = [summary()];
  Object.defineProperty(getterRuns, "0", {
    get() {
      invoked = true;
      return summary();
    },
  });
  expect(() => parseWorkflowUiSnapshot(snapshot(getterRuns))).toThrow();
  const iterableRuns = [summary()];
  Object.defineProperty(iterableRuns, Symbol.iterator, {
    value() {
      invoked = true;
      return [summary()][Symbol.iterator]();
    },
  });
  expect(() => parseWorkflowUiSnapshot(snapshot(iterableRuns))).toThrow();
  expect(invoked).toBe(false);
  for (const raw of [undefined, null, {}, "runs"]) {
    expect(() => parseWorkflowUiSnapshot({ ...snapshot(), runs: raw })).toThrow();
  }
  expect(() => parseWorkflowUiSnapshot(snapshot([summary({ surfaceId: "other" })]))).toThrow(/surfaceId/);
  expect(() => parseWorkflowUiSnapshot(snapshot([summary(), summary()]))).toThrow(/duplicate/);
});

test("returns detached plain records and arrays without mutating the source", () => {
  const run = Object.freeze(summary({ currentPhase: "phase", tokenCount: 10 }));
  const runs = Object.freeze([run]);
  const raw = Object.freeze(snapshot(runs));
  const parsed = parseWorkflowUiSnapshot(raw);
  expect(parsed).toEqual(raw);
  expect(parsed).not.toBe(raw);
  expect(parsed.runs).not.toBe(runs);
  expect(parsed.runs[0]).not.toBe(run);
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(parsed.runs[0])).toBe(Object.prototype);
  parsed.runs[0].name = "changed";
  parsed.runs.push({ ...parsed.runs[0], runId: "another" });
  expect(run.name).toBe("Review");
  expect(runs).toHaveLength(1);
  const minimal = parseWorkflowUiSnapshot(snapshot()).runs[0];
  expect(minimal).not.toHaveProperty("currentPhase");
  expect(minimal).not.toHaveProperty("tokenCount");
});

test("leaves required protocol v4 channels, capabilities, and ping envelopes untouched", () => {
  expect(PROTOCOL_VERSION).toBe(4);
  expect(RPC_CHANNELS).toEqual({
    context: "subagents:rpc:context",
    ping: "subagents:rpc:ping",
    spawn: "subagents:rpc:spawn",
    spawnManaged: "subagents:rpc:spawn-managed",
    stop: "subagents:rpc:stop",
    stopOwned: "subagents:rpc:stop-owned",
    quiesceOwned: "subagents:rpc:quiesce-owned",
    reconcileManaged: "subagents:rpc:reconcile-managed",
  });
  expect(PROTOCOL_CAPABILITIES).toEqual({
    managedSpawn: true,
    lifecycleOwner: true,
    ownedStop: true,
    childContext: true,
    ownedQuiescence: true,
    agentTiers: true,
    managedPolicy: true,
  });
  expect(requiredCapabilitiesMatch(PROTOCOL_CAPABILITIES)).toBe(true);
  const policy = { defaultTier: null, profiles: {}, blockedProfiles: [], blockedDefaultTier: false };
  const ping = {
    version: 4,
    capabilities: { ...PROTOCOL_CAPABILITIES },
    routingPolicy: { policy, fingerprint: routingPolicyFingerprint(policy) },
  };
  expect(parseProtocolPing(ping)).toEqual(ping);
  expect(parseProtocolPing(ping)).not.toHaveProperty("maxConcurrent");
  expect(() => parseProtocolPing({ ...ping, workflowUi: true })).toThrow();
});
