import { setTimeout as delay } from "node:timers/promises";
import { parseManagedSpawnRequest } from "@signalridge/pi-subagents-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEngine, type WorkflowQuiesceResult } from "../src/engine.js";
import { JOURNAL_ENTRY_TYPE, type JournalEvent, type WorkflowOwner } from "../src/journal.js";
import { createManagedSpawnClient, type WorkflowEventBus } from "../src/rpc-client.js";

const SCRIPT = 'export const meta = {name:"restore-allocation",description:"test"}; return await agent("work");';
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
// Same bus/reply harness as engine-owner-windows: actual engine, runtime,
// native helper and public managed RPC; no replacement workflow runner.
function harness(options: { started?: boolean; dropReply?: boolean; rejectReply?: boolean } = {}) {
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
  let unownedStops = 0;
  let discoverable = true;
  let quiesce = async (_request: Record<string, unknown>): Promise<WorkflowQuiesceResult> => ({
    settled: true,
    pending: [],
  });
  for (const operation of ["spawn-managed", "stop-owned", "quiesce-owned", "reconcile-managed"]) {
    bus.on(`subagents:rpc:${operation}`, (raw) => {
      const request = raw as Record<string, unknown>;
      let answer: unknown;
      if (operation === "spawn-managed") {
        parseManagedSpawnRequest(request);
        spawns.push(request);
        const id = `child-${spawns.length}`;
        if (options.started) bus.emit("subagents:started", { id, owner: request.owner });
        if (options.dropReply) return; // Host allocated; only transport delivery is lost.
        if (options.rejectReply) {
          bus.emit(`subagents:rpc:${operation}:reply:${request.requestId}`, {
            success: false,
            error: "managed reply transport failed after allocation",
          });
          return;
        }
        answer = { id, tier: "medium", state: "queued" };
      } else if (operation === "stop-owned") {
        stops.push(request);
      } else if (operation === "quiesce-owned") {
        checks.push(request);
        const ids = request.agentIds as string[];
        const owners = request.owners as unknown[];
        expect(ids.length).toBeGreaterThan(0); // Empty owner queries prove no allocation settlement.
        expect(owners).toHaveLength(ids.length);
        const missing = ids.filter((id, index) => {
          const spawn = spawns[Number(id.replace("child-", "")) - 1];
          return !spawn || JSON.stringify(spawn.owner) !== JSON.stringify(owners[index]);
        });
        answer = missing.length ? { settled: false, pending: missing } : quiesce(request);
      } else {
        const spawn = spawns.find(
          (item) => item.spawnKey === request.spawnKey && JSON.stringify(item.owner) === JSON.stringify(request.owner),
        );
        if (!spawn || !discoverable) {
          bus.emit(`subagents:rpc:${operation}:reply:${request.requestId}`, {
            success: false,
            error: "Managed spawn key not found or owner mismatch",
          });
          return;
        }
        answer = { id: `child-${spawns.indexOf(spawn) + 1}`, state: "queued" };
      }
      void Promise.resolve(answer).then((data) =>
        bus.emit(`subagents:rpc:${operation}:reply:${request.requestId}`, { success: true, data }),
      );
    });
  }
  bus.on("subagents:rpc:stop", () => {
    unownedStops++;
  });
  const session = () =>
    entries.map((data) => ({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data: structuredClone(data) }));
  const engine = new WorkflowEngine(
    bus,
    createManagedSpawnClient(bus),
    { append: (event) => entries.push(event) },
    session,
    async () => ({
      routingPolicyFingerprint: "test",
      routingPolicy: {
        defaultTier: "medium",
        profiles: { medium: { model: "inherit", thinking: "medium" } },
        blockedProfiles: [],
        blockedDefaultTier: false,
      },
    }),
  );
  engines.push(engine);
  return {
    engine,
    bus,
    entries,
    session,
    spawns,
    stops,
    checks,
    unownedStops: () => unownedStops,
    setDiscoverable: (value: boolean) => {
      discoverable = value;
    },
    quiesce: (fn: typeof quiesce) => {
      quiesce = fn;
    },
  };
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

describe("synchronous restore allocation transfer", () => {
  it.each(["queued-positive", "queued-negative", "started-positive"] as const)(
    "%s retains the old exact owner before the same-cycle branch handshake",
    async (window) => {
      const h = harness({ started: window === "started-positive" });
      const result = gate<WorkflowQuiesceResult>();
      h.quiesce(() => result.promise);
      let old: ReturnType<WorkflowEngine["getState"]>;
      let replacement: ReturnType<WorkflowEngine["getState"]>;
      let replayed: unknown;
      let count = -1;
      let handshake: Promise<WorkflowQuiesceResult> | undefined;
      let finished = false;
      let observed = false;
      h.engine.onInspectionChanged = (id) => {
        if (observed) return;
        const state = h.engine.getState(id);
        const pending = state && [...state.pendingSpawns.values()][0];
        const captured = window === "started-positive" ? pending?.startedAgentId : pending?.agentId;
        if (captured !== "child-1") return;
        if (window !== "started-positive" && h.engine.getInspection(id)?.calls[0]?.physicalStatus !== "queued") return;
        observed = true;
        old = state;
        expect(old?.agentWaiters.size).toBe(0);
        expect(old?.pendingCleanup.size).toBe(0);
        // No await or microtask between restore and the public handshake: this
        // is the gap missed by waiting for dispatcher-finally registration.
        h.engine.restore(h.session());
        expect(old?.pendingCleanup.size).toBe(1);
        replacement = h.engine.getState(id);
        replayed = structuredClone(replacement?.run);
        count = h.entries.length;
        handshake = h.engine.quiesceForBranchChange().then((value) => {
          finished = true;
          return value;
        });
      };
      const { runId } = await h.engine.start(SCRIPT, { background: true, agentRetries: 0 });
      await until(() => handshake !== undefined && h.checks.length > 0);
      const confirmation = old && [...old.pendingCleanup][0];
      await delay(50);
      expect(finished).toBe(false);
      expect(old?.pendingCleanup.size).toBe(1);
      expect(old && [...old.pendingCleanup][0]).toBe(confirmation);
      expect(h.stops).toHaveLength(1);
      expect(h.checks).toHaveLength(1);
      expect(h.checks[0]).toMatchObject({ agentIds: ["child-1"], owners: [h.spawns[0].owner] });
      expect(replacement).not.toBe(old);
      expect(replacement?.pendingCleanup.size).toBe(0);
      expect(h.engine.getRun(runId)?.status).toBe("interrupted");

      if (window === "queued-negative") {
        result.resolve({ settled: false, pending: ["child-1"] });
        expect(await handshake).toEqual({ settled: false, pending: ["child-1"] });
        expect(old?.pendingCleanup.size).toBe(1);
        expect(h.engine.hasUnsettledWork()).toBe(true);
        expect(h.engine.getRun(runId)).toEqual(replayed);
        const positive = gate<WorkflowQuiesceResult>();
        h.quiesce(() => positive.promise);
        finished = false;
        const recheck = h.engine.quiesceForBranchChange().then((value) => {
          finished = true;
          return value;
        });
        await until(() => h.checks.length === 2);
        await delay(30);
        expect(finished).toBe(false);
        expect(old?.pendingCleanup.size).toBe(1);
        positive.resolve({ settled: true, pending: [] });
        expect(await recheck).toEqual({ settled: true, pending: [] });
      } else {
        result.resolve({ settled: true, pending: [] });
        expect(await handshake).toEqual({ settled: true, pending: [] });
      }
      await until(() => old?.activeExecutionGenerations.size === 0);
      expect(old?.pendingCleanup.size).toBe(0);
      expect(h.engine.hasUnsettledWork()).toBe(false);
      h.bus.emit("subagents:completed", { id: "child-1", owner: h.spawns[0].owner, result: "stale" });
      expect(h.engine.getState(runId)).toBe(replacement);
      expect(h.engine.getRun(runId)).toEqual(replayed);
      expect(h.entries).toHaveLength(count);
      expect(h.unownedStops()).toBe(0);
      expect(h.checks.every((request) => JSON.stringify(request.owners) === JSON.stringify([h.spawns[0].owner]))).toBe(
        true,
      );
      expect(await h.engine.quiesceForBranchChange()).toEqual({ settled: true, pending: [] });
      expect(h.checks).toHaveLength(window === "queued-negative" ? 2 : 1);
      expect(h.stops).toHaveLength(window === "queued-negative" ? 2 : 1);
    },
  );

  it("deduplicates the captured allocation with waiter and dispatcher-finally cleanup", async () => {
    const h = harness();
    const positive = gate<WorkflowQuiesceResult>();
    h.quiesce(() => positive.promise);
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await until(() => (h.engine.getState(runId)?.agentWaiters.size ?? 0) > 0);
    const old = h.engine.getState(runId);
    h.engine.restore(h.session());
    expect(old?.pendingCleanup.size).toBe(1);
    const handshake = h.engine.quiesceForBranchChange();
    await until(() => h.checks.length > 0);
    await delay(30);
    expect(old?.pendingCleanup.size).toBe(1);
    expect(h.stops).toHaveLength(1);
    expect(h.checks).toHaveLength(1);
    positive.resolve({ settled: true, pending: [] });
    expect(await handshake).toEqual({ settled: true, pending: [] });
    await until(() => old?.activeExecutionGenerations.size === 0);
    expect(old?.pendingCleanup.size).toBe(0);
    expect(h.stops).toHaveLength(1);
    expect(h.checks).toHaveLength(1);
  });

  it.each(["timeout", "timeout-started", "rejection"] as const)(
    "%s retains a submitted allocation without a reply until positive exact-owner cleanup",
    async (window) => {
      const h = harness({
        dropReply: window !== "rejection",
        started: window === "timeout-started",
        rejectReply: window === "rejection",
      });
      const negative = gate<WorkflowQuiesceResult>();
      h.quiesce(() => negative.promise);
      if (window !== "rejection") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { runId } = await h.engine.start(SCRIPT, { background: true, agentRetries: 0 });
      const old = h.engine.getState(runId);
      await until(() => h.spawns.length === 1);
      expect(old?.controller.signal.aborted).toBe(false);
      expect([...(old?.pendingSpawns.values() ?? [])][0]).toMatchObject({ phase: "submitted", agentId: undefined });
      if (window !== "rejection") await vi.advanceTimersByTimeAsync(15_001);
      await until(() => h.checks.length === 1);
      expect(old?.controller.signal.aborted).toBe(false); // Cleanup is not conditional on abortion.
      expect(old?.pendingCleanup.size).toBe(1);
      expect(h.checks[0]).toMatchObject({ agentIds: ["child-1"], owners: [h.spawns[0].owner] });
      expect(h.stops).toHaveLength(1);
      let finished = false;
      const handshake = h.engine.quiesceForBranchChange().then((value) => {
        finished = true;
        return value;
      });
      await delay(30);
      expect(finished).toBe(false);
      expect(h.checks).toHaveLength(1);
      negative.resolve({ settled: false, pending: ["child-1"] });
      expect(await handshake).toEqual({ settled: false, pending: ["child-1"] });
      await until(() => old?.activeExecutionGenerations.size === 0);
      expect(old?.pendingSpawns.size).toBe(0);
      expect(old?.pendingCleanup.size).toBe(1);
      expect(h.engine.hasUnsettledWork()).toBe(true);
      vi.useRealTimers();
      h.quiesce(async () => ({ settled: false, pending: ["child-1"] }));
      expect(
        await createManagedSpawnClient(h.bus).quiesceOwned?.(runId, ["child-1"], 1, [
          h.spawns[0].owner as WorkflowOwner,
        ]),
      ).toEqual({ settled: false, pending: ["child-1"] });
      const positive = gate<WorkflowQuiesceResult>();
      h.quiesce(() => positive.promise);
      const recheck = h.engine.quiesceForBranchChange();
      await until(() => h.checks.length === 3);
      expect(old?.pendingCleanup.size).toBe(1);
      positive.resolve({ settled: true, pending: [] });
      expect(await recheck).toEqual({ settled: true, pending: [] });
      expect(old?.pendingCleanup.size).toBe(0);
      expect(h.engine.hasUnsettledWork()).toBe(false);
      expect(h.stops).toHaveLength(2);
      expect(h.unownedStops()).toBe(0);
    },
  );

  it("keeps a submitted spawn key when reconciliation cannot yet discover the child", async () => {
    const h = harness({ dropReply: true });
    h.setDiscoverable(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runId } = await h.engine.start(SCRIPT, { background: true, agentRetries: 0 });
    const old = h.engine.getState(runId);
    await until(() => h.spawns.length === 1);
    await vi.advanceTimersByTimeAsync(15_001);
    await until(() => old?.activeExecutionGenerations.size === 0);
    vi.useRealTimers();
    expect(old?.pendingSpawns.size).toBe(0);
    expect(old?.pendingCleanup.size).toBe(1);
    const confirmation = old && [...old.pendingCleanup][0];
    h.engine.restore(h.session());
    for (let i = 0; i < 2; i++) {
      expect(await h.engine.quiesceForBranchChange()).toEqual({
        settled: false,
        pending: [h.spawns[0].spawnKey],
      });
      expect(old && [...old.pendingCleanup][0]).toBe(confirmation);
    }
    expect(h.stops).toHaveLength(0);
    expect(h.checks).toHaveLength(0); // No empty-ID owner query can release it.
    h.setDiscoverable(true);
    const positive = gate<WorkflowQuiesceResult>();
    h.quiesce(() => positive.promise);
    const recheck = h.engine.quiesceForBranchChange();
    await until(() => h.checks.length === 1);
    expect(old?.pendingCleanup.size).toBe(1);
    expect(h.checks[0]).toMatchObject({ agentIds: ["child-1"], owners: [h.spawns[0].owner] });
    positive.resolve({ settled: true, pending: [] });
    expect(await recheck).toEqual({ settled: true, pending: [] });
    expect(old?.pendingCleanup.size).toBe(0);
    expect(h.stops).toHaveLength(1);
  });

  it.each(["restore", "branch"] as const)("%s releases a reserved pre-RPC lease locally", async (boundary) => {
    const h = harness();
    let observed = false;
    let handshake: Promise<WorkflowQuiesceResult> | undefined;
    h.engine.onInspectionChanged = (id) => {
      if (observed) return;
      const old = h.engine.getState(id);
      if (old?.pendingSpawns.size !== 1) return;
      observed = true;
      expect([...old.pendingSpawns.values()][0]).toMatchObject({ agentId: undefined, startedAgentId: undefined });
      if (boundary === "restore") h.engine.restore(h.session());
      handshake = h.engine.quiesceForBranchChange();
      expect(old.pendingCleanup.size).toBe(0);
    };
    await h.engine.start(SCRIPT, { background: true });
    await until(() => handshake !== undefined);
    expect(await handshake).toEqual({ settled: true, pending: [] });
    expect(h.spawns).toHaveLength(0);
    expect(h.stops).toHaveLength(0);
    expect(h.checks).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect(await h.engine.quiesceForBranchChange()).toEqual({ settled: true, pending: [] });
    expect(h.engine.hasPendingCleanup(h.engine.list()[0]?.runId as string)).toBe(false);
  });
});
