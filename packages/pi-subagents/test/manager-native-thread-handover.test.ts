import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, AgentOwner, AgentRecord } from "../src/types.js";
import { cleanupWorktree, cleanupWorktreeAsync, createWorktree } from "../src/worktree.js";

// Only Git allocation/removal is replaced. Providers, input handlers, native
// queues, session shutdown, manager ownership and resume are real SDK paths.
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

describe("native steering/thread handover regression gates", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
  let root: string;
  let cwd: string;
  let ctx: ExtensionContext;
  let manager: AgentManager;
  let faux: ReturnType<typeof fauxProvider>;
  let providerStarted: ReturnType<typeof gate>;
  let providerRelease: ReturnType<typeof gate>;
  let completed: ReturnType<typeof vi.fn>;
  let append: ReturnType<typeof vi.fn>;
  let inputStarted: string;
  let inputRelease: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "subagents-native-handover-"));
    cwd = join(root, "project");
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
          writeFileSync(${JSON.stringify(join(root, "input-cwd-preserved"))}, String(existsSync(cwd)));
          return { action: event.text === "delayed handled" ? "handled" : "continue" };
        });
      }`);
    setAgentTiersSettings({});
    registerAgents(new Map([["NativeTest", {
      name: "NativeTest", description: "native", builtinToolNames: [], extensions: [entry], skills: false,
      systemPrompt: "child", promptMode: "replace", inheritContext: false, persistSession: false, outputTranscript: false,
    } satisfies AgentConfig]]));
    faux = fauxProvider({ provider: "handover-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    ctx = { cwd, isProjectTrusted: () => true, model: runtime.getModel("handover-faux", "physical"), modelRegistry: new ModelRegistry(runtime),
      sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent", hasUI: false, mode: "print",
    } as unknown as ExtensionContext;
    providerStarted = gate(); providerRelease = gate();
    completed = vi.fn(); append = vi.fn();
    manager = new AgentManager(completed, 1, undefined, undefined, undefined, { append });
    vi.mocked(createWorktree).mockImplementation((repoRoot, id) => {
      const path = join(root, `worktree-${id}`); mkdirSync(path);
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
    writeFileSync(inputRelease, "open");
    await manager.dispose();
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
  async function initialThread() {
    faux.setResponses([fauxAssistantMessage("A done")]);
    const { id } = manager.spawnManaged(pi, ctx, request("A"), {});
    const record = manager.getRecordMutable(id)!;
    await record.promise;
    return record;
  }

  it("aborted queued B cannot donate its late native queue write to C; only public clearQueue unlocks reuse", async () => {
    const record = await initialThread();
    const session = record.session!;
    blockProvider();
    const blocker = manager.spawn(pi, ctx, "NativeTest", "blocker", { description: "blocker", isBackground: true });
    await providerStarted.promise;
    manager.spawnManaged(pi, ctx, request("B"), {});
    expect(record.status).toBe("queued");
    expect(await manager.steerAccepted(record.id, "delayed B", { session, owner: request("B").owner })).toBe(true);
    expect(await manager.steerAccepted(record.id, "drop B", { session, owner: request("B").owner })).toBe(true);
    expect(record.pendingSteers).toEqual(["delayed B", "drop B"]);
    providerRelease.resolve();
    await manager.getRecordMutable(blocker)!.promise;
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    expect(manager.abortOwned(record.id, request("B").owner)).toBe(true);
    const boundary = vi.fn();
    expect(() => manager.spawnManaged(pi, ctx, request("C"), {}, { onResumeStarting: boundary })).toThrow();
    writeFileSync(inputRelease, "open");
    await record.promise;
    expect(session.getSteeringMessages()).toEqual(["delayed B"]);
    expect(() => manager.spawnManaged(pi, ctx, request("C"), {}, { onResumeStarting: boundary })).toThrow(/pending UI steering/);
    expect(await manager.resume(record.id, "unsafe")).toBeUndefined();
    expect(manager.getManagedSpawn("C")).toBeUndefined();
    expect(faux.state.callCount).toBe(2); // A and blocker only; neither aborted B nor refused C ran.
    expect(boundary).not.toHaveBeenCalled();
    expect(record.owner).toEqual(request("B").owner);
    expect(session.clearQueue().steering).toEqual(["delayed B"]);
    faux.appendResponses([context => {
      expect(JSON.stringify(context.messages)).not.toContain("delayed B");
      return fauxAssistantMessage("C done");
    }]);
    expect(manager.spawnManaged(pi, ctx, request("C"), {}, { onResumeStarting: boundary }).id).toBe(record.id);
    await record.promise;
    expect(record.session).toBe(session);
    expect(record.result).toBe("C done");
    expect(boundary).toHaveBeenCalledOnce();
  });

  it("accepted pre-session flush retains native ownership after the provider ends", async () => {
    blockProvider();
    let accepted!: Promise<boolean>;
    const { id } = manager.spawnManaged(pi, ctx, request("A"), {}, { onSpawned: id => { accepted = manager.steerAccepted(id, "delayed first"); } });
    expect(await accepted).toBe(true);
    await providerStarted.promise;
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    const record = manager.getRecordMutable(id)!;
    manager.abort(id);
    providerRelease.resolve();
    await record.promise;
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    writeFileSync(inputRelease, "open");
    await vi.waitFor(() => expect(record.session!.getSteeringMessages()).toEqual(["delayed first"]));
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    record.session!.clearQueue();
    faux.appendResponses([fauxAssistantMessage("B done")]);
    expect(manager.spawnManaged(pi, ctx, request("B"), {}).id).toBe(id);
    await record.promise;
  });

  it("stopped A with a pending provider rejects B before owner/key/usage/persistence/callback mutation", async () => {
    blockProvider();
    const { id } = manager.spawnManaged(pi, ctx, request("A"), {});
    await providerStarted.promise;
    const record = manager.getRecordMutable(id)!;
    manager.abortOwned(id, owner);
    const previousOwner = record.owner;
    const previousInvocation = record.invocation;
    const previousPromise = record.promise;
    const previousTombstone = manager.getManagedSpawn("A");
    const previousUsage = manager.getManagedUsage(id, owner);
    const writes = append.mock.calls.length;
    const boundary = vi.fn(); const allocated = vi.fn();
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {}, { onResumeStarting: boundary, onSpawned: allocated })).toThrow(/settling|resumable/);
    expect(record.owner).toBe(previousOwner);
    expect(record.invocation).toBe(previousInvocation);
    expect(record.promise).toBe(previousPromise);
    expect(manager.getManagedUsage(id, owner)).toEqual(previousUsage);
    expect(manager.getManagedUsage(id, request("B").owner)).toBeUndefined();
    expect(manager.getManagedSpawn("A")).toEqual(previousTombstone);
    expect(manager.getManagedSpawn("B")).toBeUndefined();
    expect(append).toHaveBeenCalledTimes(writes);
    expect(boundary).not.toHaveBeenCalled(); expect(allocated).not.toHaveBeenCalled();
    providerRelease.resolve(); await previousPromise;
    expect(completed).toHaveBeenCalledExactlyOnceWith(record);
    expect(completed.mock.calls[0][0].owner).toBe(previousOwner);
    faux.appendResponses([fauxAssistantMessage("B done")]);
    expect(manager.spawnManaged(pi, ctx, request("B"), {}, { onResumeStarting: boundary }).id).toBe(id);
    await record.promise;
    expect(boundary).toHaveBeenCalledOnce();
    expect(record.owner).toEqual(request("B").owner);
  });

  it("quarantined A with pending native session shutdown refuses B without allocating a replacement", async () => {
    blockProvider();
    const { id } = manager.spawnManaged(pi, ctx, request("A"), {});
    await providerStarted.promise;
    const record = manager.getRecordMutable(id)!;
    const shutdownStarted = gate(); const shutdownRelease = gate();
    const runner = record.session!.extensionRunner!;
    const emit = runner.emit.bind(runner);
    const spy = vi.spyOn(runner, "emit").mockImplementation(async (...args) => {
      if (args[0].type !== "session_shutdown") return emit(...args);
      shutdownStarted.resolve(); await shutdownRelease.promise;
      return emit(...args);
    });
    try {
      const quiesced = manager.quiesceAll(0);
      await shutdownStarted.promise;
      providerRelease.resolve();
      expect(await quiesced).toMatchObject({ settled: false, pending: [id] });
      expect(record.detached).toBe(true);
      const previousOwner = record.owner;
      const previous = manager.getManagedSpawn("A");
      const writes = append.mock.calls.length;
      const boundary = vi.fn(); const allocated = vi.fn();
      expect(() => manager.spawnManaged(pi, ctx, request("B"), {}, { onResumeStarting: boundary, onSpawned: allocated })).toThrow(/settling|resumable/);
      expect(record.owner).toBe(previousOwner);
      expect(manager.getManagedSpawn("A")).toEqual(previous);
      expect(manager.getManagedSpawn("B")).toBeUndefined();
      expect(append).toHaveBeenCalledTimes(writes);
      expect(manager.listAgentsMutable()).toEqual([]);
      expect(boundary).not.toHaveBeenCalled(); expect(allocated).not.toHaveBeenCalled();
      shutdownRelease.resolve(); await record.promise;
      faux.appendResponses([fauxAssistantMessage("B done")]);
      const next = manager.spawnManaged(pi, ctx, request("B"), {});
      expect(next.id).not.toBe(id); // Settled, detached sessions are not reused.
      await manager.getRecordMutable(next.id)!.promise;
    } finally {
      shutdownRelease.resolve(); spy.mockRestore();
    }
  });

  it("legacy boolean steering keeps its optimistic native queue behavior without acquiring UI pins", async () => {
    blockProvider();
    const { id } = manager.spawnManaged(pi, ctx, request("A"), {});
    await providerStarted.promise;
    const record = manager.getRecordMutable(id)!;
    expect(manager.steer(id, "delayed legacy")).toBe(true);
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    providerRelease.resolve(); await record.promise;
    writeFileSync(inputRelease, "open");
    await vi.waitFor(() => expect(record.session!.getSteeringMessages()).toEqual(["delayed legacy"]));
    faux.appendResponses([fauxAssistantMessage("B done"), fauxAssistantMessage("legacy consumed")]);
    expect(manager.spawnManaged(pi, ctx, request("B"), {}).id).toBe(id);
    await record.promise;
    expect(record.owner).toEqual(request("B").owner);
  });

  it("required persistence failure rolls back the eligible handover identity and usage baseline", async () => {
    const record = await initialThread();
    const previousOwner = record.owner; const previousInvocation = record.invocation;
    const usage = manager.getManagedUsage(record.id, owner);
    const original = manager.getManagedSpawn("A");
    append.mockImplementationOnce(() => { throw new Error("journal unavailable"); });
    const boundary = vi.fn();
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {}, { onResumeStarting: boundary })).toThrow("journal unavailable");
    expect(record.owner).toBe(previousOwner); expect(record.invocation).toBe(previousInvocation);
    expect(manager.getManagedUsage(record.id, owner)).toEqual(usage);
    expect(manager.getManagedSpawn("A")).toEqual(original);
    expect(manager.getManagedSpawn("B")).toBeUndefined();
    expect(boundary).not.toHaveBeenCalled();
    faux.appendResponses([fauxAssistantMessage("B done")]);
    expect(manager.spawnManaged(pi, ctx, request("B"), {}).id).toBe(record.id);
    await record.promise;
  });

  it.each(["handled", "reject", "clear handled", "dispose handled", "dispose reject"])("handed-off cwd survives the pending native hook until %s settles, with exactly one cleanup", async outcome => {
    blockProvider();
    let id = "";
    const waiter = manager.spawnAndWait(pi, ctx, "NativeTest", "work", { description: "work", isolation: "worktree" }, value => { id = value; });
    await providerStarted.promise;
    const record: AgentRecord = manager.getRecordMutable(id)!;
    const path = record.worktree!.path;
    const session: AgentSession = record.session!;
    const hookRelease = gate(); const hookStarted = gate();
    let restore: (() => void) | undefined;
    if (outcome.includes("reject")) {
      // Public extension dispatch seam: the native steer still owns the await
      // and propagates rejection. No queue internals are replaced or patched.
      const dispatch = session.extensionRunner!.emitInput.bind(session.extensionRunner);
      const spy = vi.spyOn(session.extensionRunner!, "emitInput").mockImplementation(async (...args) => {
        if (args[0] !== "delayed handled") return dispatch(...args);
        hookStarted.resolve(); await hookRelease.promise;
        expect(existsSync(path)).toBe(true);
        throw new Error("input rejected");
      });
      restore = () => spy.mockRestore();
    }
    expect(manager.handoff(id)).toBe(true); expect((await waiter).handedOff).toBe(true);
    const submitted = manager.steerAccepted(id, "delayed handled", { session });
    const observed = submitted.then(value => value, error => error as Error);
    if (outcome.includes("reject")) await hookStarted.promise;
    else await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    providerRelease.resolve(); await record.promise;
    expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
    if (outcome.startsWith("clear")) {
      manager.clearCompleted();
      expect(manager.getRecordMutable(id)).toBe(record);
      expect(cleanupWorktree).not.toHaveBeenCalled();
    }
    if (outcome.startsWith("dispose")) {
      const failures = await manager.dispose();
      expect(failures).toHaveLength(1);
      expect(cleanupWorktreeAsync).not.toHaveBeenCalled();
      expect(existsSync(path)).toBe(true);
    }
    hookRelease.resolve(); writeFileSync(inputRelease, "open");
    const result = await observed;
    if (outcome.includes("reject")) expect(result).toMatchObject({ message: "input rejected" });
    else {
      expect(result).toBe(false);
      expect(readFileSync(join(root, "input-cwd-preserved"), "utf-8")).toBe("true");
    }
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    expect(cleanupWorktree).toHaveBeenCalledOnce();
    expect(record.worktree).toBeUndefined();
    if (outcome.startsWith("clear")) expect(manager.getRecordMutable(id)).toBeUndefined();
    if (outcome.startsWith("dispose")) {
      expect(cleanupWorktreeAsync).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(manager.getCleanupFailures()).toEqual([]));
    }
    await manager.dispose();
    expect(cleanupWorktree).toHaveBeenCalledOnce();
    restore?.();
  });
});
