import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, AgentOwner, AgentRecord } from "../src/types.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const owner: AgentOwner = { extension: "pi-workflows", runId: "edges", nodeId: "node", attemptId: "A" };
function request(attemptId: string) {
  return { requestId: attemptId, spawnKey: attemptId, type: "NativeEdges", prompt: attemptId, description: attemptId,
    thread: "thread", owner: { ...owner, attemptId } };
}

// Real native steer dispositions, separately gated extension input handlers,
// provider turns, public queue updates and managed admission. No queue patching.
describe("native steering provenance edges", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
  let root: string;
  let ctx: ExtensionContext;
  let manager: AgentManager;
  let faux: ReturnType<typeof fauxProvider>;
  let providerStarted: ReturnType<typeof gate>;
  let providerRelease: ReturnType<typeof gate>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "subagents-provenance-edges-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(cwd); mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const entry = join(root, "input.ts");
    writeFileSync(entry, `import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default function(pi) {
        pi.on("input", async event => {
          if (!event.text.startsWith("delayed")) return { action: "continue" };
          writeFileSync(join(${JSON.stringify(root)}, event.text + "-started"), "started");
          while (!existsSync(join(${JSON.stringify(root)}, event.text + "-release")))
            await new Promise(resolve => setTimeout(resolve, 5));
          return { action: event.text.endsWith("handled") ? "handled" : "continue" };
        });
      }`);
    registerAgents(new Map([["NativeEdges", {
      name: "NativeEdges", description: "native", builtinToolNames: [], extensions: [entry], skills: false,
      systemPrompt: "child", promptMode: "replace", inheritContext: false, persistSession: false, outputTranscript: false,
    } satisfies AgentConfig]]));
    setAgentTiersSettings({});
    faux = fauxProvider({ provider: "provenance-edges-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    ctx = { cwd, isProjectTrusted: () => true, model: runtime.getModel("provenance-edges-faux", "physical"), modelRegistry: new ModelRegistry(runtime),
      sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent", hasUI: false, mode: "print",
    } as unknown as ExtensionContext;
    providerStarted = gate(); providerRelease = gate();
    manager = new AgentManager(undefined, 2, undefined, undefined, undefined, { append: () => {} });
  });

  afterEach(async () => {
    providerRelease.resolve();
    for (const text of ["delayed handled", "delayed queued", "delayed legacy", "delayed replacement", "delayed second handled"])
      release(text);
    await manager.dispose();
    vi.restoreAllMocks();
    registerAgents(new Map()); setAgentTiersSettings({});
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  function release(text: string) { writeFileSync(join(root, `${text}-release`), "open"); }
  async function started(...texts: string[]) {
    await vi.waitFor(() => {
      for (const text of texts) expect(existsSync(join(root, `${text}-started`))).toBe(true);
    });
  }
  async function running() {
    faux.appendResponses([async () => {
      providerStarted.resolve(); await providerRelease.promise; return fauxAssistantMessage("A done");
    }]);
    const { id } = manager.spawnManaged(pi, ctx, request("A"), {});
    await providerStarted.promise;
    return manager.getRecordMutable(id)!;
  }
  async function reuse(record: AgentRecord) {
    const session = record.session!;
    faux.appendResponses([fauxAssistantMessage("B done"), fauxAssistantMessage("legacy consumed")]);
    expect(manager.spawnManaged(pi, ctx, request("B"), {}).id).toBe(record.id);
    await record.promise;
    expect(record.session).toBe(session);
    expect(record.owner).toEqual(request("B").owner);
  }

  it.each(["reuse", "owned quiescence"])("handled completion cannot acquire late legacy-only provenance (%s)", async boundary => {
    const record = await running();
    const session = record.session!;
    const nativeSteer = vi.spyOn(session, "steer");
    expect(await manager.steerAccepted(record.id, "original", { session, owner })).toBe(true);
    expect(await nativeSteer.mock.results[0].value).toBe("queued");
    const accepted = manager.steerAccepted(record.id, "delayed handled", { session, owner });
    expect(manager.steer(record.id, "delayed legacy")).toBe(true);
    await started("delayed handled", "delayed legacy");
    expect(session.clearQueue().steering).toEqual(["original"]);
    providerRelease.resolve(); await record.promise;
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    release("delayed legacy");
    await vi.waitFor(() => expect(session.getSteeringMessages()).toEqual(["delayed legacy"]));
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    release("delayed handled");
    expect(await accepted).toBe(false);
    expect(await nativeSteer.mock.results[1].value).toBe("handled");
    expect(session.getSteeringMessages()).toEqual(["delayed legacy"]);
    expect(faux.state.callCount).toBe(1);
    if (boundary === "reuse") await reuse(record);
    else expect(await manager.quiesceOwned(owner.runId, [record.id], 100, [owner])).toEqual({ settled: true, pending: [] });
  });

  it.each([false, true])("late queued completion still pins reuse with independent legacy ordering (legacyFirst=%s)", async legacyFirst => {
    const record = await running();
    const session = record.session!;
    expect(await manager.steerAccepted(record.id, "original", { session, owner })).toBe(true);
    const accepted = manager.steerAccepted(record.id, "delayed queued", { session, owner });
    expect(manager.steer(record.id, "delayed legacy")).toBe(true);
    await started("delayed queued", "delayed legacy");
    expect(session.clearQueue().steering).toEqual(["original"]);
    providerRelease.resolve(); await record.promise;
    if (legacyFirst) {
      release("delayed legacy");
      await vi.waitFor(() => expect(session.getSteeringMessages()).toEqual(["delayed legacy"]));
    }
    release("delayed queued");
    expect(await accepted).toBe(false);
    if (!legacyFirst) {
      release("delayed legacy");
      await vi.waitFor(() => expect(session.getSteeringMessages()).toHaveLength(2));
    }
    expect(session.getSteeringMessages()).toEqual(legacyFirst ? ["delayed legacy", "delayed queued"] : ["delayed queued", "delayed legacy"]);
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    expect(session.clearQueue().steering).toHaveLength(2);
    await reuse(record);
  });

  it("handled completion preserves a genuine existing accepted queue pin", async () => {
    const record = await running();
    const session = record.session!;
    const queued = manager.steerAccepted(record.id, "delayed queued", { session, owner });
    const handled = manager.steerAccepted(record.id, "delayed handled", { session, owner });
    await started("delayed queued", "delayed handled");
    providerRelease.resolve(); await record.promise;
    release("delayed queued");
    expect(await queued).toBe(false);
    expect(session.getSteeringMessages()).toEqual(["delayed queued"]);
    release("delayed handled");
    expect(await handled).toBe(false);
    expect(session.getSteeringMessages()).toEqual(["delayed queued"]);
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    expect(await manager.quiesceOwned(owner.runId, [record.id], 40, [owner])).toEqual({ settled: false, pending: [record.id] });
    expect(session.clearQueue().steering).toEqual(["delayed queued"]);
  });

  it("clearing earlier accepted content does not release other in-flight handled operations", async () => {
    const record = await running();
    const session = record.session!;
    expect(await manager.steerAccepted(record.id, "original", { session, owner })).toBe(true);
    const first = manager.steerAccepted(record.id, "delayed handled", { session, owner });
    const second = manager.steerAccepted(record.id, "delayed second handled", { session, owner });
    await started("delayed handled", "delayed second handled");
    expect(session.clearQueue().steering).toEqual(["original"]);
    providerRelease.resolve(); await record.promise;
    release("delayed handled");
    expect(await first).toBe(false);
    expect(session.getSteeringMessages()).toEqual([]);
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    const pending = manager.quiesceOwned(owner.runId, [record.id], 1000, [owner]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(record.detached).not.toBe(true);
    release("delayed second handled");
    expect(await second).toBe(false);
    expect(await pending).toEqual({ settled: true, pending: [] });
    await reuse(record);
  });

  it("reentrant legacy steering cannot skip later empty queue subscribers", async () => {
    const record = await running();
    const session = record.session!;
    expect(await manager.steerAccepted(record.id, "original", { session, owner })).toBe(true);
    const observed: string[] = [];
    const stopX = session.subscribe(event => {
      if (event.type !== "queue_update" || event.steering.length !== 0) return;
      observed.push("X");
      expect(manager.steer(record.id, "delayed legacy")).toBe(true);
    });
    const stopY = session.subscribe(event => {
      if (event.type === "queue_update" && event.steering.length === 0) observed.push("Y");
    });
    expect(session.clearQueue().steering).toEqual(["original"]);
    expect(observed).toEqual(["X", "Y"]);
    stopX(); stopY();
    await started("delayed legacy");
    providerRelease.resolve(); await record.promise;
    release("delayed legacy");
    await vi.waitFor(() => expect(session.getSteeringMessages()).toEqual(["delayed legacy"]));
    await reuse(record);
  });

  it.each(["clear", "dispose"])("old observer retirement preserves a reentrant replacement without listener leaks (%s)", async retirement => {
    const record = await running();
    const session = record.session!;
    const subscribe = session.subscribe.bind(session);
    const stops: ReturnType<typeof vi.fn>[] = [];
    const listeners: ReturnType<typeof vi.fn>[] = [];
    const dispose = vi.spyOn(session, "dispose");
    vi.spyOn(session, "subscribe").mockImplementation(listener => {
      const observedListener = vi.fn(listener);
      listeners.push(observedListener);
      const stop = vi.fn(subscribe(observedListener));
      stops.push(stop);
      return stop;
    });
    expect(await manager.steerAccepted(record.id, "original", { session, owner })).toBe(true);
    let replacement: Promise<boolean> | undefined;
    const observed: string[] = [];
    const stopX = subscribe(event => {
      if (event.type !== "queue_update" || event.steering.length !== 0) return;
      observed.push("X");
      replacement = manager.steerAccepted(record.id, "delayed replacement", { session, owner });
    });
    const stopY = subscribe(event => {
      if (event.type === "queue_update" && event.steering.length === 0) observed.push("Y");
    });
    expect(session.clearQueue().steering).toEqual(["original"]);
    expect(observed).toEqual(["X", "Y"]);
    stopX(); stopY();
    await started("delayed replacement");
    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).not.toHaveBeenCalled();
    providerRelease.resolve(); await record.promise;
    release("delayed replacement");
    expect(await replacement).toBe(false);
    expect(session.getSteeringMessages()).toEqual(["delayed replacement"]);
    expect(stops[1]).not.toHaveBeenCalled();
    expect(() => manager.spawnManaged(pi, ctx, request("B"), {})).toThrow(/pending UI steering/);
    if (retirement === "clear") {
      expect(session.clearQueue().steering).toEqual(["delayed replacement"]);
      await vi.waitFor(() => expect(stops[1]).toHaveBeenCalledOnce());
      await reuse(record);
    }
    await manager.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(stops[0]).toHaveBeenCalledOnce();
    // Native disposal drops all listeners itself rather than invoking each
    // unsubscribe. Public queue updates must no longer reach either observer.
    for (const listener of listeners) listener.mockClear();
    session.clearQueue();
    for (const listener of listeners) expect(listener).not.toHaveBeenCalled();
    expect(manager.hasUnsettledWork()).toBe(false);
  });
});
