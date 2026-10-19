import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import { JOURNAL_ENTRY_TYPE, type JournalEvent } from "../src/journal.js";
import type { ManagedSpawnClient, WorkflowEventBus } from "../src/rpc-client.js";
import * as runtime from "../src/runtime.js";

const META = 'export const meta = {name:"managed usage",description:"test"};';
const TWO_CALLS = 'await agent("first",{thread:"shared"}); await agent("second",{thread:"shared"});';
const DELTAS = [
  { input: 10, output: 15, total: 30 },
  { input: 20, output: 23, total: 50 },
];

type Delivery = "waiter" | "buffered" | "snapshot";
interface Spawn {
  id: string;
  runId: string;
  nodeId: string;
  attemptId: string;
}
const engines: WorkflowEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
});

function harness(delivery: Delivery = "waiter", payloads: Record<string, unknown>[] = []) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const bus: WorkflowEventBus = {
    on(name, handler) {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(handler);
      listeners.set(name, handlers);
      return () => handlers.delete(handler);
    },
    emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) handler(payload);
    },
  };
  const entries: JournalEvent[] = [];
  const spawns: Spawn[] = [];
  const emit = (spawn: Spawn, payload: Record<string, unknown>, event = "subagents:completed") => {
    bus.emit(event, {
      id: spawn.id,
      result: "answer",
      compactionCount: 0,
      completedAt: Date.now(),
      owner: { extension: "pi-workflows", runId: spawn.runId, nodeId: spawn.nodeId, attemptId: spawn.attemptId },
      ...payload,
    });
  };
  const client: ManagedSpawnClient = {
    async spawn(_task, runId, nodeId, attemptId) {
      // One session/agent reused for sequential managed thread calls.
      const spawn = { id: "shared-managed-agent", runId, nodeId, attemptId: attemptId ?? "" };
      spawns.push(spawn);
      const payload = payloads[spawns.length - 1] ?? {};
      if (delivery === "buffered") emit(spawn, payload);
      return delivery === "snapshot"
        ? {
            id: spawn.id,
            terminal: {
              status: "completed",
              result: "answer",
              tokenCount: payload.tokenCount as number,
              compactionCount: 0,
              completedAt: Date.now(),
            },
          }
        : { id: spawn.id, state: "running" };
    },
    async stop() {},
    async stopOwned() {},
    async quiesceOwned() {
      return { settled: true, pending: [] };
    },
    async checkProtocol() {
      return {
        routingPolicyFingerprint: "usage-test",
        routingPolicy: {
          defaultTier: "medium",
          profiles: { medium: { model: "inherit", thinking: "medium" } },
          blockedProfiles: [],
          blockedDefaultTier: false,
        },
      };
    },
  };
  const sessionEntries = () =>
    entries.map((data) => ({ type: "custom" as const, customType: JOURNAL_ENTRY_TYPE, data }));
  const engine = new WorkflowEngine(bus, client, { append: (event) => entries.push(event) }, sessionEntries);
  engines.push(engine);
  const waitForSpawn = async (runId: string, count: number) => {
    await expect.poll(() => spawns.length, { timeout: 5_000 }).toBe(count);
    await expect.poll(() => engine.getState(runId)?.agentWaiters.size, { timeout: 5_000 }).toBe(1);
    return spawns[count - 1];
  };
  return { engine, entries, spawns, emit, waitForSpawn, sessionEntries };
}

function resultFacts(entries: JournalEvent[]) {
  return entries.filter((event) => event.kind === "call_result");
}

function assertCounts(h: ReturnType<typeof harness>, runId: string, counts: number[]) {
  const facts = resultFacts(h.entries);
  expect(facts).toHaveLength(counts.length); // One enriched fact per call, not an extra lifecycle result.
  expect(facts.map((fact) => fact.result.tokenCount)).toEqual(counts);
  expect(Object.values(h.engine.getRun(runId)?.callResults ?? {}).map((fact) => fact.tokenCount)).toEqual(counts);
  expect(h.engine.getInspection(runId)?.calls.map((call) => call.tokenCount)).toEqual(counts);
}

const ownedPayloads = () => [
  { tokens: { input: 10, output: 15, total: 30 }, managedTokens: DELTAS[0] },
  // The ordinary lifecycle tokens still describe the session lifetime. Even a
  // legacy top-level tokenCount must not override the additive managed delta.
  { tokenCount: 80, tokens: { input: 30, output: 38, total: 80 }, managedTokens: DELTAS[1] },
];

describe("engine managed per-attempt usage", () => {
  it.each(["waiter", "buffered"] as const)("accounts 30 + 50, not lifetime 30 + 80 (%s)", async (delivery) => {
    const payloads = ownedPayloads();
    const h = harness(delivery, payloads);
    const started = await h.engine.start(`${META} ${TWO_CALLS} return budget.spent();`, { background: true });
    if (delivery === "waiter") {
      for (let i = 0; i < payloads.length; i++) h.emit(await h.waitForSpawn(started.runId, i + 1), payloads[i]);
    }
    expect((await h.engine.waitFor(started.runId)).status).toBe("completed");
    const execution = await h.engine.getState(started.runId)?.execution;
    expect(execution?.result).toBe(80);
    expect(execution?.tokenUsage).toEqual({ input: 30, output: 38, total: 80, cacheWrite: 12, cacheRead: 0, cost: 0 });
    assertCounts(h, started.runId, [30, 50]);
    expect(h.spawns[0].id).toBe(h.spawns[1].id);

    // A terminal replay/duplicate (including an old attempt on this session)
    // cannot add another charge or overwrite either call's persisted count.
    for (let i = 0; i < h.spawns.length; i++) h.emit(h.spawns[i], payloads[i]);
    assertCounts(h, started.runId, [30, 50]);
    h.engine.restore(h.sessionEntries());
    assertCounts(h, started.runId, [30, 50]);
    expect(h.engine.getInspection(started.runId)?.calls.reduce((sum, call) => sum + (call.tokenCount ?? 0), 0)).toBe(
      80,
    );
  });

  it("leaves 20 of budget 100 after two calls and admits a third call", async () => {
    const h = harness("buffered", [
      ...ownedPayloads(),
      { tokens: { total: 81 }, managedTokens: { input: 0, output: 1, total: 1 } },
    ]);
    const started = await h.engine.start(
      `${META} ${TWO_CALLS} const remaining = budget.remaining(); await agent("third",{thread:"shared"}); return {remaining,spent:budget.spent()};`,
      { tokenBudget: 100 },
    );
    expect(started.status).toBe("completed");
    expect(h.spawns).toHaveLength(3);
    expect(h.engine.getRun(started.runId)?.finalResult).toEqual({ remaining: 20, spent: 81 });
    assertCounts(h, started.runId, [30, 50, 1]);
  });

  it.each(["waiter", "buffered", "snapshot"] as const)(
    "passes explicit zero usage, not lifetime tokens, to runtime (%s)",
    async (delivery) => {
      const usages: runtime.AgentUsage[] = [];
      const runWorkflow = runtime.runWorkflow;
      vi.spyOn(runtime, "runWorkflow").mockImplementation((script, options) => {
        const runner = options.agent;
        if (!runner) throw new Error("missing runner");
        return runWorkflow(script, {
          ...options,
          agent: {
            ...runner,
            run: (prompt, runOptions) =>
              runner.run(prompt, {
                ...runOptions,
                onUsage: (usage) => {
                  usages.push(usage);
                  runOptions?.onUsage?.(usage);
                },
              }),
          },
        });
      });
      const payload = { tokenCount: 0, tokens: { total: 80 }, managedTokens: { input: 0, output: 0, total: 0 } };
      const h = harness(delivery, [payload]);
      const started = await h.engine.start(`${META} return await agent("zero");`, { background: true });
      if (delivery === "waiter") h.emit(await h.waitForSpawn(started.runId, 1), payload);
      await h.engine.waitFor(started.runId);
      expect(usages).toEqual([{ input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 }]);
      assertCounts(h, started.runId, [0]);
    },
  );

  it.each(["waiter", "buffered"] as const)(
    "keeps legacy tokens-only lifetime accounting for old peers (%s)",
    async (delivery) => {
      const payloads = [{ tokens: { total: 30 } }, { tokens: { total: 80 } }];
      const h = harness(delivery, payloads);
      const started = await h.engine.start(`${META} ${TWO_CALLS} return budget.spent();`, { background: true });
      if (delivery === "waiter") {
        for (let i = 0; i < payloads.length; i++) h.emit(await h.waitForSpawn(started.runId, i + 1), payloads[i]);
      }
      await h.engine.waitFor(started.runId);
      expect((await h.engine.getState(started.runId)?.execution)?.result).toBe(110);
      assertCounts(h, started.runId, [30, 80]);
    },
  );

  it("uses already-scoped immediate terminal snapshot counts and restores 80", async () => {
    const h = harness("snapshot", [{ tokenCount: 30 }, { tokenCount: 50 }]);
    const started = await h.engine.start(`${META} ${TWO_CALLS} return budget.spent();`);
    expect(started.status).toBe("completed");
    expect(h.engine.getRun(started.runId)?.finalResult).toBe(80);
    assertCounts(h, started.runId, [30, 50]);
    h.engine.restore(h.sessionEntries());
    assertCounts(h, started.runId, [30, 50]);
  });

  it("restores and resumes a cached prefix without losing its final counts", async () => {
    const h = harness("buffered", ownedPayloads());
    const prefix = `${META} await agent("first"); await agent("second");`;
    const started = await h.engine.start(`${prefix} throw new Error("after prefix");`);
    expect(started.status).toBe("failed");
    assertCounts(h, started.runId, [30, 50]);
    h.engine.restore(h.sessionEntries());
    const resumed = await h.engine.resume(started.runId, h.sessionEntries(), {}, `${prefix} return "replayed";`);
    expect(resumed?.status).toBe("completed");
    expect(h.spawns).toHaveLength(2);
    assertCounts(h, started.runId, [30, 50]);
    h.engine.restore(h.sessionEntries());
    assertCounts(h, started.runId, [30, 50]);
  });

  it("rejects malformed early terminals instead of buffering lifetime fallback", async () => {
    const h = harness("buffered", [
      {
        managedTokens: { input: -1, output: 0, total: 50 },
        tokens: { total: 80 },
        tier: "invalid-terminal-tier",
        outputFile: "invalid-output",
        compactionCount: 99,
      },
    ]);
    const started = await h.engine.start(`${META} return await agent("early invalid");`, { background: true });
    const spawn = await h.waitForSpawn(started.runId, 1);
    expect(h.engine.getState(started.runId)?.bufferedTerminals.size).toBe(0);
    expect(h.engine.getRun(started.runId)?.callResults).toEqual({});
    expect(h.engine.getRun(started.runId)?.callTiers["0"]).toEqual({});
    expect(h.engine.getInspection(started.runId)?.calls[0]).toMatchObject({
      status: "running",
      compactionCount: undefined,
      tokenCount: undefined,
      outputFile: undefined,
    });
    expect(resultFacts(h.entries)).toEqual([]);
    h.emit(spawn, { managedTokens: DELTAS[1], tokens: { total: 80 } });
    await h.engine.waitFor(started.runId);
    assertCounts(h, started.runId, [50]);
  });

  it("accounts owned failed terminal usage with the same delta preference", async () => {
    const h = harness();
    const started = await h.engine.start(`${META} await agent("failed"); return budget.spent();`, {
      background: true,
      agentRetries: 0,
    });
    const spawn = await h.waitForSpawn(started.runId, 1);
    h.emit(spawn, { error: "failed child", tokens: { total: 80 }, managedTokens: DELTAS[1] }, "subagents:failed");
    await h.engine.waitFor(started.runId);
    expect(h.engine.getRun(started.runId)?.finalResult).toBe(50);
    expect(resultFacts(h.entries)).toMatchObject([{ result: { status: "failed", tokenCount: 50 } }]);
    assertCounts(h, started.runId, [50]);
  });

  it("rejects malformed present managed usage and foreign owners before any call mutation", async () => {
    const h = harness();
    const started = await h.engine.start(`${META} return await agent("validated");`, { background: true });
    const spawn = await h.waitForSpawn(started.runId, 1);
    const inspection = h.engine.getInspection(started.runId);
    const entryCount = h.entries.length;
    const invalid = [
      undefined,
      null,
      [],
      "usage",
      {},
      { input: 0, output: 1 },
      { input: "1", output: 1, total: 2 },
      { input: -1, output: 1, total: 1 },
      { input: 0, output: -1, total: 1 },
      { input: 0, output: 0, total: -1 },
      { input: 0, output: 0, total: Number.NaN },
      { input: 0, output: 0, total: Number.POSITIVE_INFINITY },
      { input: 0, output: 0, total: Number.MAX_SAFE_INTEGER + 1 },
      { input: Number.MAX_SAFE_INTEGER + 1, output: 0, total: 0 },
      { input: 0, output: Number.MAX_SAFE_INTEGER + 1, total: 0 },
      { input: 0.5, output: 1, total: 2 },
      { input: 0, output: 0.5, total: 2 },
      { input: 0, output: 0, total: 0.5 },
      { input: 5, output: 5, total: 9 },
    ];
    for (const managedTokens of invalid) {
      for (const event of ["subagents:completed", "subagents:failed"]) {
        h.emit(spawn, { managedTokens, tokens: { total: 80 }, tier: "foreign-tier" }, event);
        expect(h.engine.getInspection(started.runId)).toEqual(inspection);
        expect(h.entries).toHaveLength(entryCount);
        expect(h.engine.getState(started.runId)?.agentWaiters.size).toBe(1);
        expect(h.engine.getRun(started.runId)?.callResults).toEqual({});
      }
    }
    const owner = { extension: "pi-workflows", runId: spawn.runId, nodeId: spawn.nodeId, attemptId: spawn.attemptId };
    for (const foreign of [
      { ...owner, extension: "another-extension" },
      { ...owner, runId: "another-run" },
      { ...owner, nodeId: "call-foreign" },
      { ...owner, attemptId: "attempt-99" },
    ]) {
      h.emit(spawn, { owner: foreign, managedTokens: DELTAS[0], tokens: { total: 80 }, tier: "foreign-tier" });
      expect(h.engine.getInspection(started.runId)).toEqual(inspection);
      expect(h.entries).toHaveLength(entryCount);
      expect(h.engine.getRun(started.runId)?.callResults).toEqual({});
    }
    h.emit(spawn, { managedTokens: DELTAS[0], tokens: { total: 80 } });
    await h.engine.waitFor(started.runId);
    assertCounts(h, started.runId, [30]);
  });
});
