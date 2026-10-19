import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, type Provider } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { getLifetimeTotal, type LifetimeUsage } from "../src/usage.js";

// Native ModelRuntime, AgentSession, message_end subscriptions and resumeAgent;
// only provider I/O is scripted, with explicit usage instead of faux estimates.
describe("managed usage (real Pi SDK)", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
  let root: string;
  let ctx: ExtensionContext;
  let manager: AgentManager;
  let remaining: LifetimeUsage[];
  let callCount: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "subagents-managed-usage-sdk-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    setAgentTiersSettings({});
    registerAgents(new Map([["UsageTest", {
      name: "UsageTest", description: "usage", builtinToolNames: [], extensions: false,
      skills: false, systemPrompt: "child", promptMode: "replace", inheritContext: false,
      persistSession: false, outputTranscript: false,
    } satisfies AgentConfig]]));
    remaining = [{ input: 12, output: 8, cacheWrite: 10 }, { input: 21, output: 9, cacheWrite: 20 }, { input: 1, output: 2, cacheWrite: 3 }];
    callCount = 0;
    const faux = fauxProvider({ provider: "managed-usage-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
    const stream: Provider["streamSimple"] = model => {
      callCount++;
      const usage = remaining.shift();
      if (!usage) throw new Error("Unexpected provider allocation");
      const message = { ...fauxAssistantMessage("DONE"), api: model.api, provider: model.provider, model: model.id,
        usage: { ...usage, cacheRead: 1000, totalTokens: getLifetimeTotal(usage) + 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        events.push({ type: "start", partial: message });
        events.push({ type: "done", reason: "stop", message });
        events.end(message);
      });
      return events;
    };
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider({ ...faux.provider, stream, streamSimple: stream });
    await runtime.refresh({ allowNetwork: false });
    ctx = { cwd, isProjectTrusted: () => true, model: runtime.getModel("managed-usage-faux", "physical"), modelRegistry: new ModelRegistry(runtime),
      sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent", hasUI: false, mode: "print",
    } as unknown as ExtensionContext;
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
  });

  afterEach(async () => {
    await manager.dispose();
    registerAgents(new Map());
    setAgentTiersSettings({});
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("charges 30 + 50 + 6 across one native named-thread session, preserving lifetime 86 and old terminal facts", async () => {
    const usages: LifetimeUsage[] = [];
    let id = "";
    let nativeSession: AgentSession | undefined;
    for (const [index, total] of [30, 50, 6].entries()) {
      const attemptId = `attempt-${index}`;
      const owner = { extension: "pi-workflows" as const, runId: "run", nodeId: attemptId, attemptId };
      const request = { requestId: attemptId, spawnKey: attemptId, type: "UsageTest", prompt: "work", description: "work", thread: "thread", owner };
      const spawned = manager.spawnManaged(pi, ctx, request, {}, { onAssistantUsage: usage => { usages.push({ ...usage }); } });
      if (index === 0) id = spawned.id;
      expect(spawned.id).toBe(id);
      const record = manager.getRecordMutable(id)!;
      await record.promise;
      expect(record.status).toBe("completed");
      if (index === 0) nativeSession = record.session;
      expect(record.session).toBe(nativeSession);
      expect(getLifetimeTotal(manager.getManagedUsage(id, owner))).toBe(total);
      expect(manager.getManagedSpawn(attemptId)?.terminal?.tokenCount).toBe(total);
      expect(manager.spawnManaged(pi, ctx, request, {}).created).toBe(false);
      expect(callCount).toBe(index + 1);
      expect(getLifetimeTotal(record.lifetimeUsage)).toBe([30, 80, 86][index]);
    }
    expect(usages).toEqual([{ input: 12, output: 8, cacheWrite: 10 }, { input: 21, output: 9, cacheWrite: 20 }, { input: 1, output: 2, cacheWrite: 3 }]);
    expect(nativeSession?.getSessionStats().tokens.cacheRead).toBe(3000);
    expect(manager.getManagedSpawn("attempt-0")?.terminal?.tokenCount).toBe(30);
    expect(manager.getManagedSpawn("attempt-1")?.terminal?.tokenCount).toBe(50);
    expect(manager.listAgents().reduce((sum, record) => sum + getLifetimeTotal(record.lifetimeUsage), 0)).toBe(86);
  });
});
