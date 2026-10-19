import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import { JOURNAL_ENTRY_TYPE, type JournalEvent } from "../src/journal.js";
import { createManagedSpawnClient, type WorkflowEventBus } from "../src/rpc-client.js";
import * as runtime from "../src/runtime.js";

const SCRIPT = 'export const meta = {name:"owner-windows",description:"test"}; return await agent("work");';
const CHECKPOINT =
  'export const meta = {name:"owner-windows",description:"test"}; await checkpoint("old confirm"); return await agent("old work");';
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("controlled boundary not reached");
}
const engines: WorkflowEngine[] = [];
function harness() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const bus: WorkflowEventBus = {
    on(name, handler) {
      const set = handlers.get(name) ?? new Set();
      set.add(handler);
      handlers.set(name, set);
      return () => set.delete(handler);
    },
    emit(name, data) {
      for (const handler of handlers.get(name) ?? []) handler(data);
    },
  };
  const entries: JournalEvent[] = [];
  const spawns: Record<string, unknown>[] = [];
  const stops: Record<string, unknown>[] = [];
  const checks: Record<string, unknown>[] = [];
  const unowned = vi.fn();
  let terminal = false;
  let quiesce = async (_request: Record<string, unknown>) => ({ settled: true, pending: [] as string[] });
  for (const operation of ["spawn-managed", "stop-owned", "quiesce-owned", "reconcile-managed"]) {
    bus.on(`subagents:rpc:${operation}`, (raw) => {
      const request = raw as Record<string, unknown>;
      let answer: unknown;
      if (operation === "spawn-managed") {
        spawns.push(request);
        answer = {
          id: `child-${spawns.length}`,
          tier: "medium",
          state: terminal ? "completed" : "queued",
          ...(terminal
            ? {
                terminal: {
                  status: "completed",
                  result: "answer",
                  tokenCount: 2,
                  compactionCount: 0,
                  completedAt: Date.now(),
                },
              }
            : {}),
        };
      } else if (operation === "stop-owned") {
        stops.push(request);
      } else if (operation === "quiesce-owned") {
        checks.push(request);
        answer = quiesce(request);
      } else {
        const spawn = spawns.find((item) => item.spawnKey === request.spawnKey);
        answer = spawn ? { id: `child-${spawns.indexOf(spawn) + 1}`, state: "queued" } : undefined;
      }
      void Promise.resolve(answer).then((data) =>
        bus.emit(`subagents:rpc:${operation}:reply:${request.requestId}`, { success: true, data }),
      );
    });
  }
  bus.on("subagents:rpc:stop", unowned);
  const session = () =>
    entries.map((data) => ({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data: structuredClone(data) }));
  const journal = {
    append: vi.fn((event: JournalEvent) => {
      entries.push(event);
    }),
  };
  const engine = new WorkflowEngine(bus, createManagedSpawnClient(bus), journal, session, async () => ({
    routingPolicyFingerprint: "test",
    routingPolicy: {
      defaultTier: "medium",
      profiles: { medium: { model: "inherit", thinking: "medium" } },
      blockedProfiles: [],
      blockedDefaultTier: false,
    },
  }));
  engines.push(engine);
  return {
    engine,
    bus,
    entries,
    journal,
    session,
    spawns,
    stops,
    checks,
    unowned,
    terminal: () => {
      terminal = true;
    },
    quiesce: (fn: typeof quiesce) => {
      quiesce = fn;
    },
  };
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
});

// Wrap only the observation callback: use the actual runtime, native helper,
// engine dispatch and managed RPC, not a replacement workflow implementation.
function observe(window: "tier" | "usage", observer: () => void) {
  const original = runtime.runWorkflow;
  vi.spyOn(runtime, "runWorkflow").mockImplementation((script, options = {}) => {
    const agent = options.agent;
    return original(script, {
      ...options,
      agent: agent && {
        ...agent,
        run(prompt, args = {}) {
          return agent.run(prompt, {
            ...args,
            ...(window === "tier"
              ? {
                  onTierResolved: (tier: string) => {
                    args.onTierResolved?.(tier);
                    observer();
                  },
                }
              : {
                  onUsage: (usage: runtime.AgentUsage) => {
                    args.onUsage?.(usage);
                    observer();
                  },
                }),
          });
        },
      },
    });
  });
}

describe("continuous dispatch ownership across observer windows", () => {
  it.each(["inspection", "tier", "usage"] as const)(
    "pause waits for positive exact-owner quiescence at %s",
    async (window) => {
      const h = harness();
      if (window === "usage") h.terminal();
      const positive = gate<{ settled: boolean; pending: string[] }>();
      h.quiesce(() => positive.promise);
      let pause: Promise<unknown> | undefined;
      let finished = false;
      let observed = false;
      let snapshot: { spawns: number; waiters: number; cleanup: number } | undefined;
      const observer = () => {
        if (observed || h.spawns.length === 0) return;
        const runId = String(h.spawns[0].owner && (h.spawns[0].owner as { runId: string }).runId);
        const state = h.engine.getState(runId);
        if (!state || (window === "inspection" && h.engine.getInspection(runId)?.calls[0]?.physicalStatus !== "queued"))
          return;
        observed = true;
        snapshot = {
          spawns: state.pendingSpawns.size,
          waiters: state.agentWaiters.size,
          cleanup: state.pendingCleanup.size,
        };
        pause = h.engine.control("pause", runId).then(() => {
          finished = true;
        });
      };
      if (window === "inspection") h.engine.onInspectionChanged = observer;
      else observe(window, observer);
      const { runId } = await h.engine.start(SCRIPT, { background: true, agentRetries: 0 });
      await until(() => pause !== undefined);
      await delay(100);
      expect(snapshot && snapshot.spawns + snapshot.waiters + snapshot.cleanup).toBeGreaterThan(0);
      expect(finished).toBe(false);
      expect(h.stops).toHaveLength(1);
      expect(h.checks[0]).toMatchObject({ agentIds: ["child-1"], owners: [h.spawns[0].owner] });
      positive.resolve({ settled: true, pending: [] });
      await pause;
      expect(finished).toBe(true);
      expect(h.engine.hasPendingCleanup(runId)).toBe(false);
      expect(h.unowned).not.toHaveBeenCalled();
    },
  );

  it.each(["inspection", "tier", "usage"] as const)(
    "restore retains the captured child lease at %s without new-leaf writes",
    async (window) => {
      const h = harness();
      if (window === "usage") h.terminal();
      const positive = gate<{ settled: boolean; pending: string[] }>();
      h.quiesce(() => positive.promise);
      let replaced = false;
      let count = -1;
      const observer = () => {
        if (replaced || h.spawns.length === 0) return;
        const runId = (h.spawns[0].owner as { runId: string }).runId;
        if (window === "inspection" && h.engine.getInspection(runId)?.calls[0]?.physicalStatus !== "queued") return;
        replaced = true;
        h.engine.restore(h.session());
        count = h.entries.length;
      };
      if (window === "inspection") h.engine.onInspectionChanged = observer;
      else observe(window, observer);
      const { runId } = await h.engine.start(SCRIPT, { background: true, agentRetries: 0 });
      await until(() => replaced);
      await until(() => h.checks.length > 0);
      expect(h.stops).toHaveLength(1);
      expect(h.checks[0]).toMatchObject({ agentIds: ["child-1"], owners: [h.spawns[0].owner] });
      expect(h.engine.getRun(runId)?.status).toBe("interrupted");
      positive.resolve({ settled: true, pending: [] });
      await delay(100);
      expect(h.entries).toHaveLength(count);
      expect(h.unowned).not.toHaveBeenCalled();
    },
  );
});

describe("accepted execution admission", () => {
  it.each(["start", "resume"] as const)(
    "%s running observer restore dispatches no old checkpoint or child",
    async (mode) => {
      const h = harness();
      let runId: string | undefined;
      if (mode === "resume") {
        ({ runId } = await h.engine.start(SCRIPT, { background: true }));
        await until(() => h.spawns.length > 0);
        await h.engine.control("pause", runId);
      }
      const confirm = vi.fn(async () => true);
      let replaced = false;
      let count = -1;
      h.engine.onInspectionChanged = (id) => {
        if (replaced || h.engine.getRun(id)?.status !== "running") return;
        replaced = true;
        runId = id;
        h.engine.restore(h.session());
        count = h.entries.length;
      };
      const before = h.spawns.length;
      if (mode === "start") await h.engine.start(CHECKPOINT, { background: true, confirm });
      else await h.engine.resume(runId ?? "", h.session(), { background: true, confirm }, CHECKPOINT);
      await delay(300);
      expect(replaced).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(h.spawns).toHaveLength(before);
      expect(h.engine.getRun(runId ?? "")?.status).toBe("interrupted");
      expect(h.entries).toHaveLength(count);
    },
  );

  it.each(["start", "resume"] as const)("%s running observer stop is honoured before helper dispatch", async (mode) => {
    const h = harness();
    let runId: string | undefined;
    if (mode === "resume") {
      ({ runId } = await h.engine.start(SCRIPT, { background: true }));
      await until(() => h.spawns.length > 0);
      await h.engine.control("pause", runId);
    }
    const confirm = vi.fn(async () => true);
    let stopping: Promise<unknown> | undefined;
    h.engine.onInspectionChanged = (id) => {
      if (stopping || h.engine.getRun(id)?.status !== "running") return;
      runId = id;
      stopping = h.engine.control("stop", id);
    };
    const before = h.spawns.length;
    if (mode === "start") await h.engine.start(CHECKPOINT, { background: true, confirm });
    else await h.engine.resume(runId ?? "", h.session(), { background: true, confirm }, CHECKPOINT);
    await stopping;
    await delay(100);
    expect(h.engine.getRun(runId ?? "")?.status).toBe("stopped");
    expect(confirm).not.toHaveBeenCalled();
    expect(h.spawns).toHaveLength(before);
  });
});

it("terminal uncertain ownership remains visible to branch and shutdown handshakes until positive", async () => {
  const h = harness();
  h.quiesce(async (request) => ({ settled: false, pending: request.agentIds as string[] }));
  const { runId } = await h.engine.start(SCRIPT, { background: true });
  await until(() => h.spawns.length > 0 && (h.engine.getState(runId)?.agentWaiters.size ?? 0) > 0);
  await h.engine.control("stop", runId);
  expect(h.engine.hasPendingCleanup(runId)).toBe(true);
  const first = await h.engine.quiesceForBranchChange();
  expect(first).toMatchObject({ settled: false, pending: ["child-1"] });
  expect(h.engine.hasPendingCleanup(runId)).toBe(true);
  // Native and bus-first shutdown use this same engine handshake; do not
  // replace its promise or infer settlement from a terminal run status.
  const positive = gate<{ settled: boolean; pending: string[] }>();
  h.quiesce(() => positive.promise);
  let settled = false;
  const shutdown = h.engine.quiesceForBranchChange().then((value) => {
    settled = true;
    return value;
  });
  await delay(50);
  expect(settled).toBe(false);
  positive.resolve({ settled: true, pending: [] });
  expect(await shutdown).toEqual({ settled: true, pending: [] });
  expect(h.engine.hasPendingCleanup(runId)).toBe(false);
  expect(h.checks.every((request) => JSON.stringify(request.owners) === JSON.stringify([h.spawns[0].owner]))).toBe(
    true,
  );
});

it("a fresh accepted attempt clears superseded live error while preserving journal history and restored uncertainty", async () => {
  const h = harness();
  const { runId } = await h.engine.start(SCRIPT, { background: true, agentRetries: 0 });
  await until(() => (h.engine.getState(runId)?.agentWaiters.size ?? 0) > 0);
  await h.engine.control("pause", runId);
  expect(h.engine.getRun(runId)?.callResults["0"].error).toBe("workflow call cancelled");
  const historical = h.entries.filter((event) => event.kind === "call_result");
  await h.engine.resume(runId, h.session(), { background: true });
  await until(() => h.spawns.length === 2 && (h.engine.getState(runId)?.agentWaiters.size ?? 0) > 0);
  const run = h.engine.getRun(runId);
  if (!run) throw new Error("missing resumed run");
  expect(run.callResults["0"]).toBeUndefined();
  expect(h.engine.summary(run, true)).toMatchObject({
    calls: [{ status: "running", attemptId: `${runId}/0/attempt-2` }],
  });
  expect((h.engine.summary(run, true).calls as Record<string, unknown>[])[0].error).toBeUndefined();
  expect(h.entries.filter((event) => event.kind === "call_result")).toEqual(historical);
  h.engine.restore(h.session());
  expect(h.engine.getRun(runId)?.callResults["0"]).toBeUndefined();
  expect(h.engine.getInspection(runId)?.calls[0]).toMatchObject({
    attemptId: `${runId}/0/attempt-2`,
    journalOnly: true,
  });
  expect(h.engine.getInspection(runId)?.calls[0].errorPreview).toBeUndefined();
  expect(h.engine.getInspection(runId)?.calls[0].physicalStatus).toBeUndefined();
});

it.each(["start", "resume"] as const)(
  "%s revalidates after the running persist observer replaces its state",
  async (mode) => {
    const h = harness();
    let runId: string | undefined;
    if (mode === "resume") {
      ({ runId } = await h.engine.start(SCRIPT, { background: true }));
      await until(() => (h.engine.getState(runId ?? "")?.agentWaiters.size ?? 0) > 0);
      await h.engine.control("pause", runId);
    }
    const before = h.spawns.length;
    const append = h.journal.append;
    let replaced = false;
    let count = -1;
    h.journal.append = vi.fn((event) => {
      append(event);
      if (replaced || event.kind !== "workflow_transition" || event.status !== "running") return;
      replaced = true;
      runId = event.runId;
      h.engine.restore(h.session());
      count = h.entries.length;
    });
    const confirm = vi.fn(async () => true);
    if (mode === "start") await h.engine.start(CHECKPOINT, { background: true, confirm });
    else await h.engine.resume(runId ?? "", h.session(), { background: true, confirm }, CHECKPOINT);
    await delay(100);
    expect(replaced).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(h.spawns).toHaveLength(before);
    expect(h.engine.getRun(runId ?? "")?.status).toBe("interrupted");
    expect(h.entries).toHaveLength(count);
  },
);

it("a branch observer replacement cannot donate an uncertain exact-owner lease", async () => {
  const h = harness();
  const { runId } = await h.engine.start(SCRIPT, { background: true });
  await until(() => (h.engine.getState(runId)?.agentWaiters.size ?? 0) > 0);
  const old = h.engine.getState(runId);
  const branch = h.session();
  const gateResult = gate<{ settled: boolean; pending: string[] }>();
  h.quiesce(() => gateResult.promise);
  let replaced = false;
  let count = -1;
  h.engine.onInspectionChanged = () => {
    if (replaced || !old?.lifecycleSuspended) return;
    replaced = true;
    h.engine.restore(branch);
    count = h.entries.length;
  };
  const quiescing = h.engine.quiesceForBranchChange();
  expect(replaced).toBe(true);
  expect(h.engine.getState(runId)).not.toBe(old);
  expect(h.engine.hasPendingCleanup(runId)).toBe(false);
  gateResult.resolve({ settled: false, pending: ["child-1"] });
  expect(await quiescing).toEqual({ settled: false, pending: ["child-1"] });
  expect(old?.pendingCleanup.size).toBe(1);
  expect(h.engine.hasUnsettledWork()).toBe(true);
  expect(h.engine.getRun(runId)?.nonResumable).not.toBe(true);
  h.quiesce(async () => ({ settled: true, pending: [] }));
  expect(await h.engine.quiesceForBranchChange()).toEqual({ settled: true, pending: [] });
  expect(old?.pendingCleanup.size).toBe(0);
  expect(h.entries).toHaveLength(count);
  expect(h.checks.every((request) => JSON.stringify(request.owners) === JSON.stringify([h.spawns[0].owner]))).toBe(
    true,
  );
});

it("bounded shutdown reports retained uncertainty and requires a positive owner recheck after the RPC deadline", async () => {
  const h = harness();
  h.quiesce(async (request) => ({ settled: false, pending: request.agentIds as string[] }));
  const { runId } = await h.engine.start(SCRIPT, { background: true });
  await until(() => (h.engine.getState(runId)?.agentWaiters.size ?? 0) > 0);
  await h.engine.control("stop", runId);
  await until(() => h.engine.getState(runId)?.activeExecutionGenerations.size === 0);
  const positive = gate<{ settled: boolean; pending: string[] }>();
  h.quiesce(() => positive.promise);
  vi.useFakeTimers();
  const closing = h.engine.quiesceForBranchChange();
  await vi.advanceTimersByTimeAsync(9_001);
  expect(await closing).toEqual({ settled: false, pending: ["child-1"] });
  expect(h.engine.hasPendingCleanup(runId)).toBe(true);
  const count = h.entries.length;
  positive.resolve({ settled: true, pending: [] });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  // The expired RPC listener cannot establish new positive evidence.
  expect(h.engine.hasPendingCleanup(runId)).toBe(true);
  vi.useRealTimers();
  h.quiesce(async () => ({ settled: true, pending: [] }));
  expect(await h.engine.quiesceForBranchChange()).toEqual({ settled: true, pending: [] });
  expect(h.engine.hasPendingCleanup(runId)).toBe(false);
  expect(h.entries).toHaveLength(count);
});

it.each(["pause", "restore"] as const)("waiter usage publication keeps its captured lease through %s", async (mode) => {
  const h = harness();
  const positive = gate<{ settled: boolean; pending: string[] }>();
  h.quiesce(() => positive.promise);
  let boundary: Promise<unknown> | undefined;
  let finished = false;
  let count = -1;
  let runId = "";
  observe("usage", () => {
    const state = h.engine.getState(runId);
    expect(state?.agentWaiters.size).toBe(0); // Removed before usage notification.
    expect(state?.pendingSpawns.size).toBe(1); // Still continuously owned.
    if (mode === "pause")
      boundary = h.engine.control("pause", runId).then(() => {
        finished = true;
      });
    else {
      h.engine.restore(h.session());
      count = h.entries.length;
    }
  });
  ({ runId } = await h.engine.start(SCRIPT, { background: true }));
  await until(() => (h.engine.getState(runId)?.agentWaiters.size ?? 0) > 0);
  h.bus.emit("subagents:completed", {
    id: "child-1",
    owner: h.spawns[0].owner,
    result: "answer",
    managedTokens: { input: 1, output: 1, total: 2 },
  });
  await until(() => h.checks.length > 0);
  expect(finished).toBe(false);
  expect(h.checks[0]).toMatchObject({ agentIds: ["child-1"], owners: [h.spawns[0].owner] });
  positive.resolve({ settled: true, pending: [] });
  if (mode === "pause") {
    await boundary;
    expect(finished).toBe(true);
  } else {
    await delay(100);
    expect(h.entries).toHaveLength(count);
  }
  expect(h.unowned).not.toHaveBeenCalled();
});
