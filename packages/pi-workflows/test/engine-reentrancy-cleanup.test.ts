import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import { JOURNAL_ENTRY_TYPE, type JournalEvent } from "../src/journal.js";
import type { ManagedSpawnClient, WorkflowEventBus } from "../src/rpc-client.js";
import * as runtime from "../src/runtime.js";

const SCRIPT = 'export const meta = {name:"fences",description:"test"}; return 1;';
const engines: WorkflowEngine[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result = (value: unknown = "answer"): runtime.WorkflowRunResult => ({
  meta: { name: "fences", description: "test" },
  result: value,
  logs: [],
  phases: [],
  agentCount: 1,
  durationMs: 0,
});
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
  const client: ManagedSpawnClient = {
    spawn: vi.fn(async () => ({ id: "child", state: "running" as const })),
    stop: vi.fn(async () => {}),
    stopOwned: vi.fn(async () => {}),
    quiesceOwned: vi.fn(async () => ({ settled: true, pending: [] })),
    checkProtocol: async () => ({
      routingPolicyFingerprint: "test",
      routingPolicy: {
        defaultTier: "medium",
        profiles: { medium: { model: "inherit", thinking: "medium" } },
        blockedProfiles: [],
        blockedDefaultTier: false,
      },
    }),
  };
  const journal = {
    append: vi.fn((event: JournalEvent) => {
      entries.push(event);
    }),
  };
  const session = () =>
    entries.map((data) => ({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data: structuredClone(data) }));
  const engine = new WorkflowEngine(bus, client, journal, session);
  engines.push(engine);
  return { engine, client, entries, journal, session, bus };
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function suspendedRuntime() {
  vi.spyOn(runtime, "runWorkflow").mockImplementation(async (_script, options) => {
    await new Promise<void>((_resolve, reject) =>
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
    return result();
  });
}
function ownedRuntime(onRunning?: () => void) {
  vi.spyOn(runtime, "runWorkflow").mockImplementation(async (_script, options) => {
    const value = await options.agent?.run("work", {
      signal: options.signal,
      callIndex: 0,
      runId: options.runId,
      onRunning,
    });
    return result(value);
  });
}

describe("workflow exact-state control and cleanup", () => {
  it.each(["restore", "fence+restore", "dispose"])(
    "fences a queued stop before any journal mutation (%s)",
    async (mode) => {
      suspendedRuntime();
      const h = harness();
      const { runId } = await h.engine.start(SCRIPT, { background: true });
      const oldState = h.engine.getState(runId);
      const branch = h.session();
      const stopping = h.engine.control("stop", runId);
      if (mode === "dispose") h.engine.dispose();
      else {
        if (mode === "fence+restore") h.engine.fenceCommittedBranch();
        h.engine.restore(branch);
        h.engine.resumeLifecycle();
      }
      const count = h.entries.length;
      await stopping;
      await flush();
      expect(h.entries).toHaveLength(count);
      if (mode !== "dispose") {
        expect(h.engine.getState(runId)).not.toBe(oldState);
        expect(h.engine.getRun(runId)?.status).toBe("interrupted");
        expect(h.engine.getRun(runId)?.nonResumable).not.toBe(true);
      }
    },
  );

  it("rechecks identity after the stopping observer restores the same run", async () => {
    suspendedRuntime();
    const h = harness();
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    const old = h.engine.getState(runId);
    if (!old) throw new Error("missing accepted state");
    const branch = h.session();
    h.engine.onInspectionChanged = () => {
      if (old.run.status !== "stopping") return;
      h.engine.onInspectionChanged = undefined;
      h.engine.restore(branch);
    };
    await h.engine.control("stop", runId);
    await flush();
    expect(old.run.nonResumable).not.toBe(true);
    expect(h.engine.getRun(runId)?.status).toBe("interrupted");
    expect(h.entries.filter((e) => e.kind === "terminal_recovery")).toEqual([]);
  });

  it.each(["negative", "pending"])("retains %s owned cleanup until an explicit positive recheck", async (mode) => {
    ownedRuntime();
    const h = harness();
    const attempts: Array<{ ids: string[]; owners: unknown }> = [];
    h.client.quiesceOwned = vi.fn(async (_run, ids, _timeout, owners) => {
      attempts.push({ ids, owners });
      if (attempts.length > 1) return { settled: true, pending: [] };
      return mode === "negative" ? { settled: false, pending: ids } : new Promise(() => {});
    });
    const settled = vi.fn();
    h.engine.onRunSettled = settled;
    const { runId } = await h.engine.start(SCRIPT, { background: true, tokenBudget: 123, agentRetries: 0 });
    await flush();
    vi.useFakeTimers();
    const first = h.engine.control("stop", runId);
    const duplicate = h.engine.control("stop", runId);
    await flush();
    if (mode === "pending") await vi.advanceTimersByTimeAsync(9_001);
    await first;
    await duplicate;
    await flush();
    expect(h.engine.hasUnsettledWork()).toBe(true);
    expect(h.engine.hasPendingCleanup(runId)).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    await expect(h.engine.control("rm", runId)).rejects.toThrow(/cleanup/);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1); // No recurring model/RPC polling.
    await h.engine.control("stop", runId);
    await flush();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(h.client.stop).not.toHaveBeenCalled();
    expect(h.engine.getState(runId)?.frozenOptions.tokenBudget).toBe(123);
    expect(h.engine.hasPendingCleanup(runId)).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(h.engine.hasUnsettledWork()).toBe(false);
    await h.engine.control("rm", runId);
  });

  it.each(["failed", "stopping"] as const)(
    "permits explicit cleanup rechecks independent of %s status",
    async (status) => {
      ownedRuntime();
      const h = harness();
      h.client.quiesceOwned = vi.fn(async (_run, ids) => ({ settled: false, pending: ids }));
      const { runId } = await h.engine.start(SCRIPT, { background: true });
      await flush();
      await h.engine.control("stop", runId);
      const state = h.engine.getState(runId);
      if (!state) throw new Error("missing state");
      state.run.status = status; // UI must use the cleanup API, not infer obligations from this status.
      expect(h.engine.hasPendingCleanup(runId)).toBe(true);
      h.client.quiesceOwned = vi.fn(async () => ({ settled: true, pending: [] }));
      await h.engine.control("stop", runId);
      expect(h.engine.hasPendingCleanup(runId)).toBe(false);
      expect(h.client.quiesceOwned).toHaveBeenCalledTimes(1);
      expect(h.engine.hasUnsettledWork()).toBe(false);
    },
  );

  it("quarantines old cleanup obligations and late confirmations on replacement", async () => {
    ownedRuntime();
    const h = harness();
    const cleanup = deferred<{ settled: boolean; pending: string[] }>();
    h.client.quiesceOwned = vi.fn(() => cleanup.promise);
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await flush();
    const branch = h.session();
    vi.useFakeTimers();
    const stopping = h.engine.control("stop", runId);
    await flush();
    await vi.advanceTimersByTimeAsync(9_001);
    await stopping;
    h.engine.restore(branch);
    const count = h.entries.length;
    expect(h.engine.hasPendingCleanup(runId)).toBe(false);
    cleanup.resolve({ settled: true, pending: [] });
    await flush();
    expect(h.entries).toHaveLength(count);
    expect(h.engine.getRun(runId)?.status).toBe("interrupted");
  });
});

describe("workflow journal and admission reentrancy", () => {
  it("stop during journal retry owns the only terminal notification", async () => {
    vi.useFakeTimers();
    const h = harness();
    let appended = false;
    const append = h.journal.append;
    h.journal.append = vi.fn((event) => {
      if (event.kind === "call_result" && !appended) throw new Error("transient");
      append(event);
    });
    vi.spyOn(runtime, "runWorkflow").mockImplementation(async (_script, options) => {
      options.onAgentJournal?.({ index: 0, hash: "hash", result: "old answer", runId: options.runId });
      return result("should not deliver");
    });
    const terminals: string[] = [];
    h.engine.onRunSettled = () => {
      terminals.push(h.engine.list()[0].status as string);
    };
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await flush();
    const stopping = h.engine.control("stop", runId);
    await flush();
    appended = true;
    await vi.advanceTimersByTimeAsync(30);
    await stopping;
    expect(terminals).toEqual(["stopped"]);
    expect(h.engine.getRun(runId)?.finalResult).toBeUndefined();
    expect(h.entries.some((e) => e.kind === "workflow_transition" && e.status === "completed")).toBe(false);
  });

  it("journals the accepted result before an observer can restore a replacement leaf", async () => {
    const h = harness();
    const finish = deferred<runtime.WorkflowRunResult>();
    let journalCall!: () => void;
    vi.spyOn(runtime, "runWorkflow").mockImplementation((_script, options) => {
      options.onAgentStart?.({ id: `${options.runId}:0`, label: "test", prompt: "test", callIndex: 0 });
      journalCall = () =>
        options.onAgentJournal?.({ index: 0, hash: "hash", result: "old answer", runId: options.runId });
      return finish.promise;
    });
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    const branch = h.session();
    let replacementStart = -1;
    h.engine.onInspectionChanged = () => {
      if (!h.engine.getInspection(runId)?.calls.some((call) => call.resultPreview === "old answer")) return;
      h.engine.onInspectionChanged = undefined;
      h.engine.restore(branch);
      replacementStart = h.entries.length;
    };
    journalCall();
    finish.resolve(result());
    await flush();
    expect(replacementStart).toBeGreaterThan(-1);
    expect(h.entries.slice(replacementStart)).toEqual([]);
    expect(h.engine.getRun(runId)?.callResults).toEqual({});
    expect(h.entries.filter((e) => e.kind === "call_result")).toHaveLength(1);
  });

  it("keeps an accepted result and retry payload detached from the caller", async () => {
    vi.useFakeTimers();
    const h = harness();
    let persist = false;
    const append = h.journal.append;
    h.journal.append = vi.fn((event) => {
      if (event.kind === "call_result" && !persist) throw new Error("transient");
      append(event);
    });
    const value = { answer: "accepted" };
    const delta = { retained: "accepted" };
    vi.spyOn(runtime, "runWorkflow").mockImplementation(async (_script, options) => {
      options.onAgentJournal?.({ index: 0, hash: "hash", result: value, storeDelta: delta });
      value.answer = "mutated";
      delta.retained = "mutated";
      return result();
    });
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await flush();
    expect(h.engine.getRun(runId)?.callResults["0"].result).toEqual({ answer: "accepted" });
    persist = true;
    await vi.advanceTimersByTimeAsync(30);
    expect(h.entries.filter((e) => e.kind === "call_result")).toMatchObject([
      { result: { result: { answer: "accepted" } }, storeDelta: { retained: "accepted" } },
    ]);
  });

  it.each(["queued", "legacy"])("does not regress an exact started attempt on %s reply", async (reply) => {
    const running = vi.fn();
    ownedRuntime(running);
    const h = harness();
    const response = deferred<Awaited<ReturnType<ManagedSpawnClient["spawn"]>>>();
    let owner!: { extension: "pi-workflows"; runId: string; nodeId: string; attemptId: string };
    h.client.spawn = vi.fn((_task, runId, nodeId, attemptId) => {
      owner = { extension: "pi-workflows", runId, nodeId, attemptId: attemptId ?? "" };
      return response.promise;
    });
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await flush();
    h.bus.emit("subagents:started", { id: "child", owner: { ...owner, attemptId: "attempt-99" } });
    expect(h.engine.getInspection(runId)?.calls[0].physicalStatus).toBe("pending");
    h.bus.emit("subagents:started", { id: "child", owner });
    expect(h.engine.getInspection(runId)?.calls[0].physicalStatus).toBe("running");
    response.resolve(reply === "queued" ? { id: "child", state: "queued" } : "child");
    await flush();
    expect(h.engine.getInspection(runId)?.calls[0].physicalStatus).toBe("running");
    expect(running).toHaveBeenCalledTimes(1);
    h.bus.emit("subagents:started", { id: "child", owner });
    expect(running).toHaveBeenCalledTimes(1);
    h.bus.emit("subagents:completed", { id: "child", owner, result: "done" });
    await flush();
    expect(h.engine.getRun(runId)?.status).toBe("completed");
  });

  it("does not regress an exact buffered terminal on a queued reply", async () => {
    ownedRuntime();
    const h = harness();
    const response = deferred<Awaited<ReturnType<ManagedSpawnClient["spawn"]>>>();
    let owner!: { extension: "pi-workflows"; runId: string; nodeId: string; attemptId: string };
    h.client.spawn = vi.fn((_task, runId, nodeId, attemptId) => {
      owner = { extension: "pi-workflows", runId, nodeId, attemptId: attemptId ?? "" };
      return response.promise;
    });
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await flush();
    h.bus.emit("subagents:completed", { id: "child", owner, result: "done" });
    const statuses: string[] = [];
    h.engine.onInspectionChanged = () => {
      statuses.push(h.engine.getInspection(runId)?.calls[0].physicalStatus ?? "missing");
    };
    response.resolve({ id: "child", state: "queued" });
    await flush();
    expect(statuses).not.toContain("queued");
    expect(h.engine.getRun(runId)?.status).toBe("completed");
  });
});
