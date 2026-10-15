import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, MANAGED_SPAWN_ENTRY_TYPE, type ManagedSpawnRequest, type ManagedSpawnTombstone } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentOwner, AgentRecord } from "../src/types.js";
import { addUsage, getLifetimeTotal, type LifetimeUsage } from "../src/usage.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp", modelRegistry: mockParentRegistry } as unknown as ExtensionContext;
const zero = { input: 0, output: 0, cacheWrite: 0 };
const thirty = { input: 12, output: 8, cacheWrite: 10 };
const fifty = { input: 21, output: 9, cacheWrite: 20 };
function request(attemptId: string, thread = "thread"): ManagedSpawnRequest {
  return {
    requestId: attemptId, spawnKey: attemptId, type: "Explore", prompt: attemptId,
    description: attemptId, thread,
    owner: { extension: "pi-workflows", runId: "run", nodeId: attemptId, attemptId },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const session = () => ({ dispose: vi.fn(), messages: [] }) as unknown as AgentSession;
const result = (child: AgentSession) => ({ responseText: "done", session: child, aborted: false, steered: false });
const entriesFor = (facts: ManagedSpawnTombstone[]) => facts.map(data => ({ type: "custom", customType: MANAGED_SPAWN_ENTRY_TYPE, data }));
const baselineSize = (manager: AgentManager) => (Reflect.get(manager, "managedUsageBaselines") as Map<string, unknown>).size;

describe("manager-owned managed attempt usage", () => {
  let manager: AgentManager;
  const extraManagers: AgentManager[] = [];
  let facts: ManagedSpawnTombstone[];
  beforeEach(() => {
    vi.resetAllMocks();
    registerAgents(new Map());
    setAgentTiersSettings({});
    facts = [];
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: fact => { facts.push(fact); } });
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      const child = session();
      options.onAssistantUsage?.(thirty);
      options.onSessionCreated?.(child);
      return Promise.resolve(result(child));
    });
    vi.mocked(resumeAgent).mockImplementation((_session, _prompt, options) => {
      options?.onAssistantUsage?.(fifty);
      return Promise.resolve({ text: "resumed" });
    });
  });
  afterEach(async () => {
    await manager.dispose();
    await Promise.all(extraManagers.splice(0).map(value => value.dispose()));
    registerAgents(new Map());
    setAgentTiersSettings({});
  });

  it("accounts three sequential same-thread calls without decreasing Fleet lifetime totals", async () => {
    const first = request("one");
    const { id } = manager.spawnManaged(pi, ctx, first, {});
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getManagedUsage(id, { ...first.owner })).toEqual(thirty);
    expect(manager.getManagedSpawn(first.spawnKey)?.terminal?.tokenCount).toBe(30);
    expect(manager.listAgents().reduce((sum, record) => sum + getLifetimeTotal(record.lifetimeUsage), 0)).toBe(30);
    const second = request("two");
    const boundary = vi.fn(() => manager.getManagedUsage(id, second.owner));
    expect(manager.spawnManaged(pi, ctx, second, {}, { onResumeStarting: boundary }).id).toBe(id);
    expect(manager.getManagedUsage(id, first.owner)).toBeUndefined();
    await manager.getRecordMutable(id)?.promise;
    expect(boundary).toHaveBeenCalledOnce();
    expect(boundary.mock.results[0]?.value).toEqual(zero);
    expect(manager.getManagedUsage(id, second.owner)).toEqual(fifty);
    expect(manager.getRecord(id)?.lifetimeUsage).toEqual({ input: 33, output: 17, cacheWrite: 30 });
    expect(manager.getManagedSpawn(second.spawnKey)?.terminal?.tokenCount).toBe(50);
    expect(manager.listAgents().reduce((sum, record) => sum + getLifetimeTotal(record.lifetimeUsage), 0)).toBe(80);
    vi.mocked(resumeAgent).mockImplementation((_session, _prompt, options) => {
      options?.onAssistantUsage?.({ input: 1, output: 2, cacheWrite: 3 });
      return Promise.resolve({ text: "third" });
    });
    const third = request("three");
    manager.spawnManaged(pi, ctx, third, {});
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getManagedSpawn(third.spawnKey)?.terminal?.tokenCount).toBe(6);
    expect(getLifetimeTotal(manager.getRecord(id)?.lifetimeUsage)).toBe(86);
    expect(manager.getManagedUsage(id, second.owner)).toBeUndefined();
    expect(manager.getManagedSpawn(first.spawnKey)?.terminal?.tokenCount).toBe(30);
    expect(manager.getManagedSpawn(second.spawnKey)?.terminal?.tokenCount).toBe(50);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resumeAgent).toHaveBeenCalledTimes(2);
    expect(baselineSize(manager)).toBe(1);
  });

  it("keeps different threads independent and never allocates on duplicate spawn-key replay", async () => {
    const one = request("one", "one-thread");
    const first = manager.spawnManaged(pi, ctx, one, {});
    const replay = manager.spawnManaged(pi, ctx, one, {});
    expect(replay).toMatchObject({ id: first.id, created: false });
    await manager.getRecordMutable(first.id)?.promise;
    const two = request("two", "two-thread");
    const second = manager.spawnManaged(pi, ctx, two, {});
    await manager.getRecordMutable(second.id)?.promise;
    expect(second.id).not.toBe(first.id);
    expect(manager.getManagedUsage(first.id, one.owner)).toEqual(thirty);
    expect(manager.getManagedUsage(second.id, two.owner)).toEqual(thirty);
    expect(manager.spawnManaged(pi, ctx, one, {}).terminal?.tokenCount).toBe(30);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(baselineSize(manager)).toBe(2);
    expect(manager.listAgents().reduce((sum, record) => sum + getLifetimeTotal(record.lifetimeUsage), 0)).toBe(60);
  });

  it("captures allocation before creation observers and synchronous early runner usage", async () => {
    await manager.dispose();
    manager = new AgentManager(undefined, 1, undefined, undefined, record => {
      expect(manager.getManagedUsage(record.id, record.owner!)).toEqual(zero);
      addUsage(record.lifetimeUsage, { input: 1, output: 1, cacheWrite: 1 });
    }, { append: () => {} });
    const call = request("early");
    const { id } = manager.spawnManaged(pi, ctx, call, {}, { onAssistantUsage: () => {
      expect(manager.getManagedUsage(manager.listAgents()[0]!.id, call.owner)).toEqual({ input: 13, output: 9, cacheWrite: 11 });
    } });
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getManagedSpawn(call.spawnKey)?.terminal?.tokenCount).toBe(33);
  });

  it.each(["extension", "runId", "nodeId", "attemptId"] as const)("requires exact %s and returns detached getter values", async component => {
    const call = request("one");
    const { id } = manager.spawnManaged(pi, ctx, call, {});
    await manager.getRecordMutable(id)?.promise;
    const incorrect = { ...call.owner, [component]: "other" } as AgentOwner;
    expect(manager.getManagedUsage(id, incorrect)).toBeUndefined();
    expect(manager.getManagedUsage("missing", call.owner)).toBeUndefined();
    const value = manager.getManagedUsage(id, { ...call.owner })!;
    value.input = 999;
    expect(manager.getManagedUsage(id, call.owner)).toEqual(thirty);
    expect(manager.getRecord(id)?.lifetimeUsage).toEqual(thirty);
    manager.getRecordMutable(id)!.owner = Object.freeze({ ...call.owner });
    expect(manager.getManagedUsage(id, call.owner)).toBeUndefined();
  });

  it("requires the allocated record identity even when a replacement has the same id and owner", async () => {
    const call = request("identity");
    const { id } = manager.spawnManaged(pi, ctx, call, {});
    await manager.getRecordMutable(id)?.promise;
    const record = manager.getRecordMutable(id)!;
    const agents = Reflect.get(manager, "agents") as Map<string, AgentRecord>;
    agents.set(id, { ...record });
    expect(manager.getManagedUsage(id, call.owner)).toBeUndefined();
    agents.set(id, record);
    expect(manager.getManagedUsage(id, call.owner)).toEqual(thirty);
  });

  it("clamps corrupt or regressing components to finite nonnegative deltas without rewriting lifetime", async () => {
    const call = request("one");
    const { id } = manager.spawnManaged(pi, ctx, call, {});
    await manager.getRecordMutable(id)?.promise;
    const record = manager.getRecordMutable(id)!;
    record.lifetimeUsage = { input: Number.NaN, output: Number.POSITIVE_INFINITY, cacheWrite: -1 };
    expect(manager.getManagedUsage(id, call.owner)).toEqual(zero);
    expect(record.lifetimeUsage.cacheWrite).toBe(-1);
  });

  it("persists zero for an unused attempt and includes cache-write-only usage", async () => {
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      const child = session();
      options.onSessionCreated?.(child);
      return Promise.resolve(result(child));
    });
    const first = request("zero");
    const { id } = manager.spawnManaged(pi, ctx, first, {});
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getManagedUsage(id, first.owner)).toEqual(zero);
    expect(manager.getManagedSpawn(first.spawnKey)?.terminal?.tokenCount).toBe(0);
    vi.mocked(resumeAgent).mockImplementation((_session, _prompt, options) => {
      options?.onAssistantUsage?.({ ...zero, cacheWrite: 7 });
      return Promise.resolve({ text: "cache" });
    });
    const second = request("cache");
    manager.spawnManaged(pi, ctx, second, {});
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getManagedSpawn(second.spawnKey)?.terminal?.tokenCount).toBe(7);
  });

  it.each(["failure", "rejection", "aborted"])("counts usage honestly on a %s, not just successful results", async outcome => {
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      const child = session();
      options.onSessionCreated?.(child);
      options.onAssistantUsage?.(thirty);
      if (outcome === "rejection") return Promise.reject(new Error("provider error"));
      return Promise.resolve({ ...result(child), aborted: outcome === "aborted", ...(outcome === "failure" ? { failure: "provider error" } : {}) });
    });
    const call = request(outcome);
    const { id } = manager.spawnManaged(pi, ctx, call, {});
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getManagedSpawn(call.spawnKey)).toMatchObject({ state: "failed", terminal: { tokenCount: 30 } });
    expect(manager.getManagedUsage(id, call.owner)).toEqual(thirty);
    const next = request("next");
    manager.spawnManaged(pi, ctx, next, {});
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getManagedUsage(id, next.owner)).toEqual(fifty);
    expect(manager.getManagedSpawn(next.spawnKey)?.terminal?.tokenCount).toBe(50);
    expect(getLifetimeTotal(manager.getRecord(id)?.lifetimeUsage)).toBe(80);
  });

  it("keeps queued spawn/resume baselines at zero and never charges cancelled work for previous calls", async () => {
    const first = request("first");
    const { id } = manager.spawnManaged(pi, ctx, first, {});
    await manager.getRecordMutable(id)?.promise;
    const pending = deferred<Awaited<ReturnType<typeof runAgent>>>();
    const child = session();
    vi.mocked(runAgent).mockReturnValue(pending.promise);
    const blocker = manager.spawn(pi, ctx, "Explore", "block", { description: "block", isBackground: true });
    const queued = request("queued", "other-thread");
    const queuedId = manager.spawnManaged(pi, ctx, queued, {}).id;
    expect(manager.getRecord(queuedId)?.status).toBe("queued");
    expect(manager.getManagedUsage(queuedId, queued.owner)).toEqual(zero);
    manager.abortOwned(queuedId, queued.owner);
    expect(manager.getManagedSpawn(queued.spawnKey)?.terminal?.tokenCount).toBe(0);
    const resumed = request("resumed");
    expect(manager.spawnManaged(pi, ctx, resumed, {}).state).toBe("queued");
    expect(manager.getManagedUsage(id, resumed.owner)).toEqual(zero);
    expect(getLifetimeTotal(manager.getRecord(id)?.lifetimeUsage)).toBe(30);
    manager.abortOwned(id, resumed.owner);
    expect(manager.getManagedSpawn(resumed.spawnKey)).toMatchObject({ state: "stopped", terminal: { tokenCount: 0 } });
    expect(resumeAgent).not.toHaveBeenCalled();
    pending.resolve(result(child));
    await manager.getRecordMutable(blocker)?.promise;
    const next = request("next");
    manager.spawnManaged(pi, ctx, next, {});
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getManagedUsage(id, next.owner)).toEqual(fifty);
  });

  it("keeps a queued reused baseline through slot acquisition, usage callbacks and settlement", async () => {
    const first = request("first");
    const { id } = manager.spawnManaged(pi, ctx, first, {});
    await manager.getRecordMutable(id)?.promise;
    const pending = deferred<Awaited<ReturnType<typeof runAgent>>>();
    const child = session();
    vi.mocked(runAgent).mockReturnValue(pending.promise);
    const blocker = manager.spawn(pi, ctx, "Explore", "block", { description: "block", isBackground: true });
    const second = request("second");
    const boundary = vi.fn(() => manager.getManagedUsage(id, second.owner));
    expect(manager.spawnManaged(pi, ctx, second, {}, { onResumeStarting: boundary }).state).toBe("queued");
    expect(boundary).not.toHaveBeenCalled();
    expect(manager.getManagedUsage(id, second.owner)).toEqual(zero);
    pending.resolve(result(child));
    await manager.getRecordMutable(blocker)?.promise;
    await manager.getRecordMutable(id)?.promise;
    expect(boundary).toHaveBeenCalledOnce();
    expect(boundary.mock.results[0]?.value).toEqual(zero);
    expect(manager.getManagedUsage(id, second.owner)).toEqual(fifty);
    expect(manager.getManagedSpawn(second.spawnKey)?.terminal?.tokenCount).toBe(50);
    expect(getLifetimeTotal(manager.getRecord(id)?.lifetimeUsage)).toBe(80);
  });

  it("captures a reused baseline at owner rotation before persistence callbacks or resume start", async () => {
    const first = request("first");
    const { id } = manager.spawnManaged(pi, ctx, first, {});
    await manager.getRecordMutable(id)?.promise;
    const record = manager.getRecordMutable(id)!;
    const second = request("second");
    const persistence = Reflect.get(manager, "managedPersistence") as { append: (fact: ManagedSpawnTombstone) => void };
    persistence.append = fact => {
      facts.push(fact);
      if (fact.spawnKey === second.spawnKey && fact.state === "queued") {
        expect(manager.getManagedUsage(id, second.owner)).toEqual(zero);
        addUsage(record.lifetimeUsage, { input: 1, output: 2, cacheWrite: 3 });
      }
    };
    manager.spawnManaged(pi, ctx, second, {});
    await record.promise;
    expect(manager.getManagedUsage(id, second.owner)).toEqual({ input: 22, output: 11, cacheWrite: 23 });
    expect(manager.getManagedSpawn(second.spawnKey)?.terminal?.tokenCount).toBe(56);
  });

  it("rolls back owner and usage baseline when reused allocation persistence fails", async () => {
    const first = request("first");
    const { id } = manager.spawnManaged(pi, ctx, first, {});
    await manager.getRecordMutable(id)?.promise;
    const persistence = Reflect.get(manager, "managedPersistence") as { append: (fact: ManagedSpawnTombstone) => void };
    persistence.append = () => { throw new Error("journal unavailable"); };
    const second = request("second");
    expect(() => manager.spawnManaged(pi, ctx, second, {})).toThrow("journal unavailable");
    expect(manager.getManagedUsage(id, first.owner)).toEqual(thirty);
    expect(manager.getManagedUsage(id, second.owner)).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("finalizes stopped usage, suppresses detached callbacks, and retires runtime baselines on removal/disposal", async () => {
    const pending = deferred<Awaited<ReturnType<typeof runAgent>>>();
    const child = session();
    let usage!: (value: LifetimeUsage) => void;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      usage = options.onAssistantUsage!;
      options.onSessionCreated?.(child);
      usage(thirty);
      return pending.promise;
    });
    const call = request("stopped");
    const { id } = manager.spawnManaged(pi, ctx, call, {});
    manager.abortOwned(id, call.owner);
    usage({ input: 1, output: 2, cacheWrite: 3 });
    pending.resolve(result(child));
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getManagedSpawn(call.spawnKey)).toMatchObject({ state: "stopped", terminal: { tokenCount: 36 } });
    manager.clearCompleted();
    expect(manager.getManagedUsage(id, call.owner)).toBeUndefined();
    expect(baselineSize(manager)).toBe(0);
    usage(fifty);
    expect(manager.spawnManaged(pi, ctx, call, {}).terminal?.tokenCount).toBe(36);
    const next = request("next", "next-thread");
    const nextId = manager.spawnManaged(pi, ctx, next, {}).id;
    await manager.getRecordMutable(nextId)?.promise;
    expect(baselineSize(manager)).toBe(1);
    const disposing = manager.dispose();
    expect(manager.getManagedUsage(nextId, next.owner)).toBeUndefined();
    expect(baselineSize(manager)).toBe(0);
    await disposing;
  });

  it("replays old terminal token facts unchanged and never invents a restored interrupted baseline", async () => {
    const call = request("old");
    const { id } = manager.spawnManaged(pi, ctx, call, {});
    const active = manager.getManagedSpawn(call.spawnKey)!;
    await manager.getRecordMutable(id)?.promise;
    const oldFact = manager.getManagedSpawn(call.spawnKey)!;
    oldFact.terminal!.tokenCount = 80;
    const restored = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
    const interrupted = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
    extraManagers.push(restored, interrupted);
    restored.restoreManagedSpawns(entriesFor([oldFact]));
    expect(restored.spawnManaged(pi, ctx, call, {})).toMatchObject({ id, created: false, terminal: { tokenCount: 80 } });
    expect(restored.getManagedUsage(id, call.owner)).toBeUndefined();
    const recovered = interrupted.restoreManagedSpawns(entriesFor([active]));
    expect(recovered[0]?.terminal).not.toHaveProperty("tokenCount");
    expect(interrupted.spawnManaged(pi, ctx, call, {})).toMatchObject({ id, state: "interrupted", created: false });
    expect(interrupted.getManagedUsage(id, call.owner)).toBeUndefined();
    expect(baselineSize(restored)).toBe(0);
    expect(baselineSize(interrupted)).toBe(0);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("never reports a managed baseline for ordinary legacy records or detached attempts", async () => {
    const legacy = manager.spawn(pi, ctx, "Explore", "ordinary", { description: "ordinary" });
    await manager.getRecordMutable(legacy)?.promise;
    expect(manager.getRecord(legacy)?.lifetimeUsage).toEqual(thirty);
    expect(manager.getManagedUsage(legacy, request("one").owner)).toBeUndefined();
    const pending = deferred<Awaited<ReturnType<typeof runAgent>>>();
    const child = session();
    vi.mocked(runAgent).mockReturnValue(pending.promise);
    const call = request("detached");
    const { id } = manager.spawnManaged(pi, ctx, call, {});
    manager.detachForBranchChange();
    expect(manager.getManagedUsage(id, call.owner)).toBeUndefined();
    pending.resolve(result(child));
    await manager.getRecordMutable(id)?.promise;
  });
});
