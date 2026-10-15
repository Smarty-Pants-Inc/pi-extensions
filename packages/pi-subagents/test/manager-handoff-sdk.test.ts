import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

// Real provider, native session/input queue, manager lifecycle and transcript.
// No live network, install, branch, commit or Git worktree operations.
describe("manager handoff and steering (real Pi SDK)", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
  let root: string;
  let cwd: string;
  let ctx: ExtensionContext;
  let faux: ReturnType<typeof fauxProvider>;
  let manager: AgentManager;
  let providerStarted: ReturnType<typeof deferred>;
  let providerRelease: ReturnType<typeof deferred>;
  let providerSignal: SimpleStreamOptions["signal"];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "subagents-handoff-sdk-"));
    cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    setAgentTiersSettings({});
    registerAgents(new Map([["HandoffTest", {
      name: "HandoffTest", description: "handoff", builtinToolNames: [], extensions: false,
      skills: false, systemPrompt: "child", promptMode: "replace", inheritContext: false,
      persistSession: false,
    } satisfies AgentConfig]]));
    faux = fauxProvider({ provider: "handoff-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    ctx = { cwd, isProjectTrusted: () => true, model: runtime.getModel("handoff-faux", "physical"), modelRegistry: new ModelRegistry(runtime),
      sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent", hasUI: false, mode: "print",
    } as unknown as ExtensionContext;
    providerStarted = deferred();
    providerRelease = deferred();
    faux.setResponses([async (_context, options) => {
      providerSignal = options?.signal;
      providerStarted.resolve();
      await providerRelease.promise;
      return fauxAssistantMessage("DONE");
    }]);
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
  });

  afterEach(async () => {
    providerRelease.resolve();
    if (existsSync(root)) writeFileSync(join(root, "input-release"), "open");
    await manager.dispose();
    registerAgents(new Map());
    setAgentTiersSettings({});
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("hands off a live provider turn with the same native session and uninterrupted transcript", async () => {
    await manager.dispose();
    const completed = vi.fn();
    manager = new AgentManager(completed, 1);
    const parent = new AbortController();
    let id = "";
    let record!: AgentRecord;
    const path = join(root, "transcript.output");
    const waiter = manager.spawnAndWait(pi, ctx, "HandoffTest", "work", {
      description: "work", signal: parent.signal,
      onSessionCreated: session => { record.outputCleanup = streamToOutputFile(session, path, id, cwd); },
    }, createdId => {
      id = createdId;
      record = manager.getRecordMutable(id)!;
      record.outputFile = path;
      writeInitialEntry(path, id, "work", cwd);
    });
    await providerStarted.promise;
    const session = record.session!;
    const providerPromise = record.promise;
    const transcriptCleanup = record.outputCleanup;
    const prefix = readFileSync(path, "utf-8");
    expect(session.isStreaming).toBe(true);
    expect(manager.handoff(id)).toBe(true);
    expect(await waiter).toEqual({ id, record, handedOff: true });
    parent.abort();
    expect(providerSignal?.aborted).toBe(false);
    expect(session.isStreaming).toBe(true);
    expect(record.session).toBe(session);
    expect(record.promise).toBe(providerPromise);
    expect(record.outputCleanup).toBe(transcriptCleanup);
    expect(readFileSync(path, "utf-8")).toBe(prefix);
    providerRelease.resolve();
    await providerPromise;
    expect(record.status).toBe("completed");
    expect(record.resultConsumed).toBe(false);
    expect(faux.state.callCount).toBe(1);
    expect(completed).toHaveBeenCalledExactlyOnceWith(record);
    expect(record.session).toBe(session);
    expect(readFileSync(path, "utf-8").startsWith(prefix)).toBe(true);
    const transcript = readFileSync(path, "utf-8").trim().split("\n").map(line => JSON.parse(line));
    expect(transcript).toHaveLength(2);
    expect(transcript[1].message.content).toContainEqual({ type: "text", text: "DONE" });
  });

  it.each(["stop", "shutdown"])("%s still aborts the same handed-off native provider", async operation => {
    let id = "";
    const waiter = manager.spawnAndWait(pi, ctx, "HandoffTest", "work", { description: "work" }, value => { id = value; });
    await providerStarted.promise;
    const record = manager.getRecordMutable(id)!;
    const session = record.session!;
    expect(manager.handoff(id)).toBe(true);
    await waiter;
    let shutdown: ReturnType<AgentManager["dispose"]> | undefined;
    if (operation === "stop") expect(manager.abort(id)).toBe(true);
    else shutdown = manager.dispose();
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
    providerRelease.resolve();
    await record.promise;
    await shutdown;
    expect(record.status).toBe("stopped");
    expect(faux.state.callCount).toBe(1);
    if (operation === "stop") expect(record.session).toBe(session);
  });

  it("awaits native rejection and pins managed reuse across an actual delayed input handler/idle queue", async () => {
    const entry = join(root, "input.ts");
    const inputStarted = join(root, "input-started");
    const inputRelease = join(root, "input-release");
    writeFileSync(entry, `import { existsSync, writeFileSync } from "node:fs";
      export default function(pi) {
        pi.registerCommand("fixture-command", { description: "fixture", handler: async () => {} });
        pi.on("input", async event => {
          if (event.text === "delayed UI") {
            writeFileSync(${JSON.stringify(inputStarted)}, "started");
            while (!existsSync(${JSON.stringify(inputRelease)})) await new Promise(resolve => setTimeout(resolve, 5));
          }
          return { action: "continue" };
        });
      }`);
    registerAgents(new Map([["HandoffTest", {
      name: "HandoffTest", description: "handoff", builtinToolNames: [], extensions: [entry], skills: false,
      systemPrompt: "child", promptMode: "replace", inheritContext: false, persistSession: false,
    } satisfies AgentConfig]]));
    const owner = { extension: "pi-workflows" as const, runId: "run", nodeId: "node", attemptId: "first" };
    const request = { requestId: "first", spawnKey: "first", type: "HandoffTest", prompt: "work", description: "work", thread: "thread", owner };
    const { id } = manager.spawnManaged(pi, ctx, request, {});
    await providerStarted.promise;
    const record = manager.getRecordMutable(id)!;
    const session: AgentSession = record.session!;
    await expect(manager.steerAccepted(id, "/fixture-command", { session, owner: { ...owner } })).rejects.toThrow(/Extension command/);
    expect(session.getSteeringMessages()).toEqual([]);
    const submitted = manager.steerAccepted(id, "delayed UI", { session, owner: { ...owner } });
    await vi.waitFor(() => expect(existsSync(inputStarted)).toBe(true));
    providerRelease.resolve();
    await record.promise;
    expect(session.isStreaming).toBe(false);
    const next = { ...request, requestId: "second", spawnKey: "second", prompt: "next", owner: { ...owner, attemptId: "second" } };
    expect(() => manager.spawnManaged(pi, ctx, next, {})).toThrow(/pending UI steering/);
    expect(await manager.resume(id, "unsafe")).toBeUndefined();
    writeFileSync(inputRelease, "open");
    expect(await submitted).toBe(false);
    expect(session.getSteeringMessages()).toEqual(["delayed UI"]);
    expect(() => manager.spawnManaged(pi, ctx, next, {})).toThrow(/pending UI steering/);
    expect(manager.getRecord(id)?.owner?.attemptId).toBe("first");
    // Explicitly clearing the public SDK queue proves no stale UI message can
    // enter the next attempt; the manager never manipulates private queues.
    expect(session.clearQueue().steering).toEqual(["delayed UI"]);
    faux.appendResponses([context => {
      expect(context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("delayed UI"))).toBe(false);
      return fauxAssistantMessage("SECOND");
    }]);
    const boundary = vi.fn();
    expect(manager.spawnManaged(pi, ctx, next, {}, { onResumeStarting: boundary }).id).toBe(id);
    await record.promise;
    expect(boundary).toHaveBeenCalledOnce();
    expect(boundary.mock.calls[0][0]).toBe(record);
    expect(record.session).toBe(session);
    expect(record.result).toBe("SECOND");
    expect(record.owner?.attemptId).toBe("second");
  });
});
