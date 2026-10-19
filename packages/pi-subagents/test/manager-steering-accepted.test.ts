import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type ManagedSpawnCallbacks } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentOwner } from "../src/types.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  pruneWorktrees: vi.fn(), pruneWorktreesAsync: vi.fn(async () => {}),
}));

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp", modelRegistry: mockParentRegistry } as unknown as ExtensionContext;
const owner: AgentOwner = { extension: "pi-workflows", runId: "run", nodeId: "node", attemptId: "first" };
function request(attemptId = "first") {
  return { requestId: attemptId, spawnKey: attemptId, type: "Explore", prompt: "work", description: "work", thread: "thread", owner: { ...owner, attemptId } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Native steer may suspend in input handlers before it changes the SDK queue.
// This seam preserves that ordering, including a queue write after run end.
describe("truthful asynchronous steering and managed resume boundary", () => {
  let manager: AgentManager;
  let run: ReturnType<typeof deferred<Awaited<ReturnType<typeof runAgent>>>>;
  let acceptance: ReturnType<typeof deferred<"queued" | "handled">>;
  let nativeQueue: string[];
  let session: AgentSession;
  let steer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    registerAgents(new Map());
    setAgentTiersSettings({});
    run = deferred();
    acceptance = deferred();
    nativeQueue = [];
    steer = vi.fn(async (message: string) => {
      const result = await acceptance.promise;
      if (result === "queued") nativeQueue.push(message);
      return result;
    });
    session = {
      steer, getSteeringMessages: () => nativeQueue, dispose: vi.fn(), messages: [{ role: "user", content: "prior", timestamp: 0 }],
    } as unknown as AgentSession;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => { options.onSessionCreated?.(session); return run.promise; });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
  });

  afterEach(async () => {
    acceptance.resolve("handled");
    run.resolve({ responseText: "done", session, aborted: false, steered: false });
    await manager.dispose();
    setAgentTiersSettings({});
  });

  async function complete() {
    run.resolve({ responseText: "done", session, aborted: false, steered: false });
    await manager.getRecordMutable(manager.listAgents()[0].id)!.promise;
  }

  it("native rejection propagates instead of reporting success; legacy boolean steer remains optimistic", async () => {
    const id = manager.spawn(pi, ctx, "Explore", "work", { description: "work", isBackground: true });
    const submitted = manager.steerAccepted(id, "message", { session });
    const observed = expect(submitted).rejects.toThrow("native input rejected");
    acceptance.reject(new Error("native input rejected"));
    await observed;
    expect(nativeQueue).toEqual([]);
    expect(manager.steer(id, "legacy")).toBe(true);
    await Promise.resolve();
    await complete();
    expect(await manager.resume(id, "again")).toBeDefined();
  });

  it("returns false for stale session, owner tuple, inactive and missing identities", async () => {
    const { id } = manager.spawnManaged(pi, ctx, request(), {});
    for (const expected of [
      { session: {} as AgentSession },
      { session, owner: { ...owner, attemptId: "stale" } },
      { session, owner: { ...owner, nodeId: "other" } },
      { session, owner: { ...owner, runId: "other" } },
    ]) expect(await manager.steerAccepted(id, "message", expected)).toBe(false);
    expect(steer).not.toHaveBeenCalled();
    expect(await manager.steerAccepted("missing", "message", { session })).toBe(false);
    await complete();
    expect(await manager.steerAccepted(id, "message", { session, owner })).toBe(false);
  });

  it.each(["accept", "reject"])("pins reused managed thread while native input is pending, then releases on %s", async outcome => {
    const { id } = manager.spawnManaged(pi, ctx, request(), {});
    const copiedOwner = { ...manager.getRecordMutable(id)!.owner! };
    const submission = manager.steerAccepted(id, "UI", { session, owner: copiedOwner });
    const observed = submission.then(value => value, error => error as Error);
    await complete();
    expect(() => manager.spawnManaged(pi, ctx, request("second"), {})).toThrow(/pending UI steering/);
    expect(await manager.resume(id, "unsafe")).toBeUndefined();
    expect(manager.getRecord(id)?.owner).toEqual(copiedOwner);
    expect(manager.getManagedSpawn("second")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
    if (outcome === "reject") acceptance.reject(new Error("rejected"));
    else acceptance.resolve("handled");
    const result = await observed;
    if (outcome === "reject") expect(result).toMatchObject({ message: "rejected" });
    else expect(result).toBe(false); // Original run ended while input handlers awaited.
    const resumed = manager.spawnManaged(pi, ctx, request("second"), {});
    expect(resumed.id).toBe(id);
    await manager.getRecordMutable(id)!.promise;
    expect(manager.getRecord(id)?.owner?.attemptId).toBe("second");
    expect(resumeAgent).toHaveBeenCalledOnce();
  });

  it("keeps the pin until every simultaneous native submission settles", async () => {
    const { id } = manager.spawnManaged(pi, ctx, request(), {});
    const firstNative = deferred<"handled">();
    const secondNative = deferred<"handled">();
    steer.mockReturnValueOnce(firstNative.promise).mockReturnValueOnce(secondNative.promise);
    const first = manager.steerAccepted(id, "first", { session, owner: { ...owner } });
    const second = manager.steerAccepted(id, "second", { session, owner: { ...owner } });
    const secondObserved = expect(second).rejects.toThrow("second rejected");
    await complete();
    firstNative.resolve("handled");
    expect(await first).toBe(false);
    expect(() => manager.spawnManaged(pi, ctx, request("next"), {})).toThrow(/pending UI steering/);
    secondNative.reject(new Error("second rejected"));
    await secondObserved;
    expect(manager.spawnManaged(pi, ctx, request("next"), {}).id).toBe(id);
    await manager.getRecordMutable(id)!.promise;
  });

  it("does not permit a late native queue write to enter a replacement attempt", async () => {
    const { id } = manager.spawnManaged(pi, ctx, request(), {});
    const submission = manager.steerAccepted(id, "late", { session, owner: { ...owner } });
    await complete();
    acceptance.resolve("queued");
    expect(await submission).toBe(false);
    expect(nativeQueue).toEqual(["late"]);
    expect(() => manager.spawnManaged(pi, ctx, request("second"), {})).toThrow(/pending UI steering/);
    expect(await manager.resume(id, "unsafe")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
    // The public SDK queue lifetime, not a post-await identity check, gates reuse.
    nativeQueue = [];
    expect(manager.spawnManaged(pi, ctx, request("second"), {}).id).toBe(id);
    await manager.getRecordMutable(id)!.promise;
  });

  it("pins the logical thread across managed metadata reset while its native await is pending", async () => {
    const { id } = manager.spawnManaged(pi, ctx, request(), {});
    const submission = manager.steerAccepted(id, "late", { session, owner: { ...owner } });
    await complete();
    manager.resetManagedSpawns();
    expect(() => manager.spawnManaged(pi, ctx, request("second"), {})).toThrow(/pending UI steering/);
    acceptance.resolve("handled");
    expect(await submission).toBe(false);
  });

  it("successful native acceptance while running returns true without changing attempt identity", async () => {
    const { id } = manager.spawnManaged(pi, ctx, request(), {});
    const submission = manager.steerAccepted(id, "UI", { session, owner: { ...owner } });
    acceptance.resolve("queued");
    expect(await submission).toBe(true);
    expect(nativeQueue).toEqual(["UI"]);
    expect(manager.getRecord(id)?.owner).toEqual(owner);
    nativeQueue = []; // SDK consumes the steer in the original run.
    await complete();
    expect(manager.spawnManaged(pi, ctx, request("second"), {}).id).toBe(id);
    await manager.getRecordMutable(id)!.promise;
  });

  it("queued resumes keep accepted messages manager-owned and cancellation cannot leak them", async () => {
    const { id } = manager.spawnManaged(pi, ctx, request(), {});
    await complete();
    run = deferred();
    const blocker = manager.spawn(pi, ctx, "Explore", "blocker", { description: "blocker", isBackground: true });
    manager.spawnManaged(pi, ctx, request("second"), {});
    expect(manager.getRecord(id)?.status).toBe("queued");
    expect(await manager.steerAccepted(id, "queued", { session, owner: { ...owner, attemptId: "second" } })).toBe(true);
    expect(manager.getRecord(id)?.pendingSteers).toEqual(["queued"]);
    expect(steer).not.toHaveBeenCalled();
    manager.abort(id);
    expect(manager.getRecord(id)?.pendingSteers).toBeUndefined();
    run.resolve({ responseText: "blocker", session, aborted: false, steered: false });
    await manager.getRecordMutable(blocker)!.promise;
  });

  it("fires resume starting once at actual pool admission, before pending steer and native prompt", async () => {
    const { id } = manager.spawnManaged(pi, ctx, request(), {});
    const record = manager.getRecordMutable(id)!;
    record.outputFile = "/tmp/preserved.output";
    await complete();
    run = deferred();
    const blocker = manager.spawn(pi, ctx, "Explore", "blocker", { description: "blocker", isBackground: true });
    const order: string[] = [];
    const onResumeStarting = vi.fn(() => { order.push("boundary"); });
    const callbacks: ManagedSpawnCallbacks = { onResumeStarting };
    manager.spawnManaged(pi, ctx, request("second"), {}, callbacks);
    manager.spawnManaged(pi, ctx, request("second"), {}, callbacks);
    expect(onResumeStarting).not.toHaveBeenCalled();
    manager.steer(id, "queued");
    steer.mockImplementation(async () => { order.push("steer"); return "queued"; });
    vi.mocked(resumeAgent).mockImplementation(async () => { order.push("prompt"); return { text: "resumed" }; });
    run.resolve({ responseText: "blocker", session, aborted: false, steered: false });
    await manager.getRecordMutable(blocker)!.promise;
    await record.promise;
    expect(onResumeStarting).toHaveBeenCalledExactlyOnceWith(record, 1);
    expect(record.outputFile).toBe("/tmp/preserved.output");
    expect(record.session).toBe(session);
    expect(order).toEqual(["boundary", "steer", "prompt"]);
    manager.spawnManaged(pi, ctx, request("second"), {}, callbacks);
    expect(onResumeStarting).toHaveBeenCalledOnce();
  });

  it.each([false, true])("resume observer failures cannot prevent the reused native run (async=%s)", async asynchronous => {
    const { id } = manager.spawnManaged(pi, ctx, request(), {});
    await complete();
    const onResumeStarting = vi.fn(() => {
      if (asynchronous) return Promise.reject(new Error("observer failed"));
      throw new Error("observer failed");
    });
    manager.spawnManaged(pi, ctx, request("second"), {}, { onResumeStarting });
    await manager.getRecordMutable(id)!.promise;
    expect(onResumeStarting).toHaveBeenCalledOnce();
    expect(resumeAgent).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)?.result).toBe("resumed");
  });
});
