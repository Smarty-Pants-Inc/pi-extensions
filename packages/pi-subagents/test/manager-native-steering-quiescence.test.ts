import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, AgentOwner, AgentRecord } from "../src/types.js";
import { cleanupWorktree, cleanupWorktreeAsync, createWorktree } from "../src/worktree.js";

// Only checkout allocation/removal is replaced. Provider turns, native queues,
// input dispatch, queue_update, session lifecycle and managed admission are real.
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), isWorktreeIsolationEnabled: () => true,
  cleanupWorktree: vi.fn(), cleanupWorktreeAsync: vi.fn(),
  pruneWorktrees: vi.fn(), pruneWorktreesAsync: vi.fn(async () => {}),
}));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const owner: AgentOwner = { extension: "pi-workflows", runId: "run", nodeId: "node", attemptId: "A" };
function request(attemptId: string) {
  return { requestId: attemptId, spawnKey: attemptId, type: "NativeTest", prompt: attemptId, description: attemptId,
    thread: "thread", owner: { ...owner, attemptId } };
}

describe("native steering quiescence and queue provenance", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
  let root: string;
  let ctx: ExtensionContext;
  let manager: AgentManager;
  let faux: ReturnType<typeof fauxProvider>;
  let providerStarted: ReturnType<typeof gate>;
  let providerRelease: ReturnType<typeof gate>;
  let inputStarted: string;
  let inputRelease: string;
  let extraGates: ReturnType<typeof gate>[];

  beforeEach(async () => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "subagents-quiescence-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(cwd); mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    inputStarted = join(root, "input-started");
    inputRelease = join(root, "input-release");
    const entry = join(root, "input.ts");
    writeFileSync(entry, `import { existsSync, writeFileSync } from "node:fs";
      export default function(pi) {
        pi.on("input", async (event, ctx) => {
          if (!event.text.startsWith("delayed")) return { action: "continue" };
          const cwd = ctx.cwd;
          writeFileSync(${JSON.stringify(inputStarted)}, "started");
          while (!existsSync(${JSON.stringify(inputRelease)})) await new Promise(resolve => setTimeout(resolve, 5));
          writeFileSync(${JSON.stringify(join(root, "cwd-preserved"))}, String(existsSync(cwd)));
          return { action: event.text === "delayed handled" ? "handled" : "continue" };
        });
      }`);
    registerAgents(new Map([["NativeTest", {
      name: "NativeTest", description: "native", builtinToolNames: [], extensions: [entry], skills: false,
      systemPrompt: "child", promptMode: "replace", inheritContext: false, persistSession: false, outputTranscript: false,
    } satisfies AgentConfig]]));
    setAgentTiersSettings({});
    faux = fauxProvider({ provider: "quiescence-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    ctx = { cwd, isProjectTrusted: () => true, model: runtime.getModel("quiescence-faux", "physical"), modelRegistry: new ModelRegistry(runtime),
      sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent", hasUI: false, mode: "print",
    } as unknown as ExtensionContext;
    providerStarted = gate(); providerRelease = gate(); extraGates = [];
    manager = new AgentManager(undefined, 2, undefined, undefined, undefined, { append: () => {} });
    vi.mocked(createWorktree).mockImplementation((repoRoot, id) => {
      const path = join(root, `checkout-${id}`); mkdirSync(path);
      return { path, repoRoot, workPath: path, branch: `branch-${id}`, baseSha: "fixture" };
    });
    vi.mocked(cleanupWorktree).mockImplementation((_repo, worktree) => {
      rmSync(worktree.path, { recursive: true, force: true });
      return { hasChanges: false, cleanupSucceeded: true };
    });
    vi.mocked(cleanupWorktreeAsync).mockImplementation(async (...args) => cleanupWorktree(...args));
  });

  afterEach(async () => {
    providerRelease.resolve();
    for (const release of extraGates) release.resolve();
    writeFileSync(inputRelease, "open");
    await manager.dispose();
    vi.restoreAllMocks();
    registerAgents(new Map()); setAgentTiersSettings({});
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  function blockProvider() {
    faux.appendResponses([async () => {
      providerStarted.resolve(); await providerRelease.promise;
      return fauxAssistantMessage("DONE");
    }]);
  }
  async function running(managed: boolean, isolated = false) {
    blockProvider();
    const id = managed ? manager.spawnManaged(pi, ctx, request("A"), {}).id :
      manager.spawn(pi, ctx, "NativeTest", "work", { description: "work", isBackground: true, ...(isolated ? { isolation: "worktree" as const } : {}) });
    await providerStarted.promise;
    return manager.getRecordMutable(id)!;
  }
  function quiesce(record: AgentRecord, managed: boolean, budget = 1000) {
    return managed ? manager.quiesceOwned(owner.runId, [record.id], budget, [owner]) : manager.quiesceAll(budget);
  }

  it.each([false, true])("provider-done / hook-pending drains inside the shared budget without disposing (owned=%s)", async managed => {
    const record = await running(managed, !managed);
    const session = record.session!;
    const path = record.worktree?.path;
    const dispose = vi.spyOn(session, "dispose");
    const submission = manager.steerAccepted(record.id, "delayed handled", { session, ...(managed ? { owner } : {}) });
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    providerRelease.resolve(); await record.promise;
    const pending = quiesce(record, managed);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(dispose).not.toHaveBeenCalled();
    expect(record.detached).not.toBe(true);
    if (path) expect(existsSync(path)).toBe(true);
    writeFileSync(inputRelease, "open");
    expect(await submission).toBe(false);
    expect(await pending).toEqual({ settled: true, pending: [] });
    expect(record.session).toBe(session);
    expect(dispose).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "cwd-preserved"), "utf-8")).toBe("true");
    expect(faux.state.callCount).toBe(1);
    if (path) { expect(existsSync(path)).toBe(false); expect(cleanupWorktree).toHaveBeenCalledOnce(); }
  });

  it.each([false, true])("input rejection drains truthfully without premature quarantine (owned=%s)", async managed => {
    const record = await running(managed);
    const session = record.session!;
    const started = gate(); const release = gate(); extraGates.push(release);
    // The public dispatch seam rejects; native steer still owns the await and
    // propagates it. No steer, queue or provider internals are replaced.
    const dispatch = session.extensionRunner!.emitInput.bind(session.extensionRunner);
    vi.spyOn(session.extensionRunner!, "emitInput").mockImplementation(async (...args) => {
      if (args[0] !== "reject") return dispatch(...args);
      started.resolve(); await release.promise; throw new Error("input rejected");
    });
    const observed = manager.steerAccepted(record.id, "reject", { session }).catch(error => error as Error);
    await started.promise;
    providerRelease.resolve(); await record.promise;
    const pending = quiesce(record, managed);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(record.detached).not.toBe(true);
    release.resolve();
    expect(await observed).toMatchObject({ message: "input rejected" });
    expect(await pending).toEqual({ settled: true, pending: [] });
    expect(session.getSteeringMessages()).toEqual([]);
    expect(faux.state.callCount).toBe(1);
  });

  it.each([false, true])("late accepted queue remains pending after the hook settles (owned=%s)", async managed => {
    const record = await running(managed);
    const session = record.session!;
    const submission = manager.steerAccepted(record.id, "delayed queued", { session });
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    providerRelease.resolve(); await record.promise;
    const pending = quiesce(record, managed);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(record.detached).not.toBe(true);
    writeFileSync(inputRelease, "open");
    expect(await submission).toBe(false);
    expect(await pending).toEqual({ settled: false, pending: [record.id] });
    expect(session.getSteeringMessages()).toEqual(["delayed queued"]);
    expect(record.detached).toBe(true);
    expect(faux.state.callCount).toBe(1);
    // Reload retires the old manager through dispose; retained queue provenance
    // does not create a permanent public navigation deadlock after retirement.
    await manager.dispose();
    expect(manager.getRecord(record.id)).toBeUndefined();
    expect(manager.hasUnsettledWork()).toBe(false);
  });

  it("deadline expiry preserves the checkout for a still-running native hook", async () => {
    const record = await running(false, true);
    const path = record.worktree!.path;
    const session = record.session!;
    const submission = manager.steerAccepted(record.id, "delayed handled", { session });
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    providerRelease.resolve(); await record.promise;
    expect(await quiesce(record, false, 40)).toEqual({ settled: false, pending: [record.id] });
    expect(record.detached).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(cleanupWorktree).not.toHaveBeenCalled();
    writeFileSync(inputRelease, "open");
    expect(await submission).toBe(false);
    expect(readFileSync(join(root, "cwd-preserved"), "utf-8")).toBe("true");
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    expect(cleanupWorktree).toHaveBeenCalledOnce();
  });

  it("owned quiescence drains the exact nested hook before removing either checkout", async () => {
    blockProvider();
    const { id } = manager.spawnManaged(pi, ctx, { ...request("A"), thread: undefined }, { isolation: "worktree" });
    await providerStarted.promise;
    const parent = manager.getRecordMutable(id)!;
    const parentRelease = providerRelease;
    extraGates.push(parentRelease);
    providerStarted = gate(); providerRelease = gate();
    blockProvider();
    const childId = manager.spawn(pi, ctx, "NativeTest", "child", {
      description: "child", parentAgentId: id, cwd: parent.worktree!.path, isolation: "worktree", isBackground: true,
    });
    await providerStarted.promise;
    const child = manager.getRecordMutable(childId)!;
    const parentPath = parent.worktree!.path;
    const childPath = child.worktree!.path;
    const session = child.session!;
    const dispose = vi.spyOn(session, "dispose");
    const submitted = manager.steerAccepted(childId, "delayed handled", { session });
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    providerRelease.resolve(); await child.promise;
    parentRelease.resolve();
    const pending = manager.quiesceOwned(owner.runId, [id], 1000, [owner]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(dispose).not.toHaveBeenCalled();
    expect(existsSync(parentPath)).toBe(true);
    expect(existsSync(childPath)).toBe(true);
    writeFileSync(inputRelease, "open");
    expect(await submitted).toBe(false);
    expect(await pending).toEqual({ settled: true, pending: [] });
    await parent.promise;
    expect(parent.detached).not.toBe(true);
    expect(child.detached).not.toBe(true);
    expect(existsSync(parentPath)).toBe(false);
    expect(existsSync(childPath)).toBe(false);
    expect(cleanupWorktree).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(root, "cwd-preserved"), "utf-8")).toBe("true");
    expect(faux.state.callCount).toBe(2);
  });

  it("owned quiescence waits only the exact owned record's native operations", async () => {
    const record = await running(true);
    const siblingStarted = gate(); const siblingRelease = gate(); extraGates.push(siblingRelease);
    faux.appendResponses([async () => {
      siblingStarted.resolve(); await siblingRelease.promise; return fauxAssistantMessage("sibling");
    }]);
    const siblingId = manager.spawn(pi, ctx, "NativeTest", "sibling", { description: "sibling", isBackground: true });
    await siblingStarted.promise;
    const sibling = manager.getRecordMutable(siblingId)!;
    const hookStarted = gate(); const hookRelease = gate(); extraGates.push(hookRelease);
    const siblingSession = sibling.session!;
    const dispatch = siblingSession.extensionRunner!.emitInput.bind(siblingSession.extensionRunner);
    vi.spyOn(siblingSession.extensionRunner!, "emitInput").mockImplementation(async (...args) => {
      if (args[0] !== "sibling hook") return dispatch(...args);
      hookStarted.resolve(); await hookRelease.promise; return { action: "handled" };
    });
    const unrelated = manager.steerAccepted(siblingId, "sibling hook", { session: siblingSession });
    await hookStarted.promise;
    const owned = manager.steerAccepted(record.id, "delayed handled", { session: record.session! });
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    providerRelease.resolve(); siblingRelease.resolve();
    await Promise.all([record.promise, sibling.promise]);
    const pending = quiesce(record, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    writeFileSync(inputRelease, "open");
    expect(await owned).toBe(false);
    expect(await pending).toEqual({ settled: true, pending: [] });
    expect(sibling.detached).not.toBe(true);
    expect(sibling.session).toBe(siblingSession);
    expect(manager.hasUnsettledWork()).toBe(true);
    hookRelease.resolve();
    expect(await unrelated).toBe(false);
    expect(manager.hasUnsettledWork()).toBe(false);
    expect(faux.state.callCount).toBe(2);
  });

  it("simultaneous input operations share one bounded deadline", async () => {
    const record = await running(true);
    const session = record.session!;
    const firstStarted = gate(); const secondStarted = gate();
    const firstRelease = gate(); const secondRelease = gate();
    extraGates.push(firstRelease, secondRelease);
    const dispatch = session.extensionRunner!.emitInput.bind(session.extensionRunner);
    vi.spyOn(session.extensionRunner!, "emitInput").mockImplementation(async (...args) => {
      if (args[0] !== "first" && args[0] !== "second") return dispatch(...args);
      const first = args[0] === "first";
      (first ? firstStarted : secondStarted).resolve();
      await (first ? firstRelease : secondRelease).promise;
      return { action: "handled" };
    });
    const first = manager.steerAccepted(record.id, "first", { session });
    const second = manager.steerAccepted(record.id, "second", { session });
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    providerRelease.resolve(); await record.promise;
    const start = Date.now();
    const pending = quiesce(record, true, 200);
    await new Promise(resolve => setTimeout(resolve, 100));
    firstRelease.resolve();
    expect(await first).toBe(false);
    expect(record.detached).not.toBe(true);
    expect(await pending).toEqual({ settled: false, pending: [record.id] });
    expect(Date.now() - start).toBeLessThan(300);
    secondRelease.resolve();
    expect(await second).toBe(false);
    expect(faux.state.callCount).toBe(1);
  });

  it.each(["consumed", "cleared", "consumed during legacy", "cleared during legacy"])("retires %s accepted provenance before a delayed legacy write", async retirement => {
    const record = await running(true);
    const session = record.session!;
    expect(await manager.steerAccepted(record.id, "accepted", { session, owner })).toBe(true);
    expect(session.getSteeringMessages()).toEqual(["accepted"]);
    const emptyObserved = vi.fn();
    const unsubscribe = session.subscribe(event => {
      if (event.type === "queue_update" && event.steering.length === 0) emptyObserved();
    });
    const legacyAlreadyPending = retirement.endsWith("during legacy");
    if (legacyAlreadyPending) {
      expect(manager.steer(record.id, "delayed legacy")).toBe(true);
      await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    }
    if (retirement.startsWith("cleared")) expect(session.clearQueue().steering).toEqual(["accepted"]);
    else {
      const nextStarted = gate(); const nextRelease = gate(); extraGates.push(nextRelease);
      faux.appendResponses([async () => { nextStarted.resolve(); await nextRelease.promise; return fauxAssistantMessage("consumed"); }]);
      providerRelease.resolve();
      await nextStarted.promise;
      expect(session.getSteeringMessages()).toEqual([]);
      // No manager eligibility lookup occurred between native consumption and
      // legacy submission. The queue_update observation must retire provenance.
      providerRelease = nextRelease;
    }
    expect(emptyObserved).toHaveBeenCalledOnce();
    unsubscribe();
    if (!legacyAlreadyPending) {
      expect(manager.steer(record.id, "delayed legacy")).toBe(true);
      await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    }
    providerRelease.resolve(); await record.promise;
    writeFileSync(inputRelease, "open");
    await vi.waitFor(() => expect(session.getSteeringMessages()).toEqual(["delayed legacy"]));
    faux.appendResponses([fauxAssistantMessage("B done"), fauxAssistantMessage("legacy consumed")]);
    expect(manager.spawnManaged(pi, ctx, request("B"), {}).id).toBe(record.id);
    await record.promise;
    expect(record.session).toBe(session);
    expect(record.owner).toEqual(request("B").owner);
  });

  it("public clearQueue never releases an accepted operation still in flight alongside legacy steering", async () => {
    const record = await running(true);
    const session = record.session!;
    expect(await manager.steerAccepted(record.id, "accepted", { session })).toBe(true);
    const pendingAccepted = manager.steerAccepted(record.id, "delayed accepted", { session, owner });
    expect(manager.steer(record.id, "delayed legacy")).toBe(true);
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    expect(session.clearQueue().steering).toEqual(["accepted"]);
    providerRelease.resolve(); await record.promise;
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    writeFileSync(inputRelease, "open");
    expect(await pendingAccepted).toBe(false);
    await vi.waitFor(() => expect(session.getSteeringMessages()).toHaveLength(2));
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    expect(session.clearQueue().steering).toHaveLength(2);
    faux.appendResponses([fauxAssistantMessage("B done")]);
    expect(manager.spawnManaged(pi, ctx, request("B"), {}).id).toBe(record.id);
    await record.promise;
    expect(session.getSteeringMessages()).toEqual([]);
  });
});
