import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, defineTool, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";

vi.setConfig({ testTimeout: 30_000 });

describe("trust revocation at the provider loadout (installed Pi SDK)", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let oldAgentDir: string | undefined;
  let session: AgentSession | undefined;
  let faux: ReturnType<typeof fauxProvider>;
  let runtime: ModelRuntime;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "trust-loadout-sdk-"));
    cwd = join(root, "project");
    agentDir = join(root, "global");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ schedulingEnabled: false, toolDescriptionMode: "custom", scopeModels: true, agentTiers: { profiles: { globaltier: { model: "loadout-faux/outside", thinking: "inherit", description: "GLOBAL_TIER" } } } }));
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "custom", agentTiers: { profiles: { projecttier: { model: "inherit", thinking: "inherit", description: "PROJECT_TIER_SECRET" } } } }));
    writeFileSync(join(agentDir, "agent-tool-description.md"), "GLOBAL_DESCRIPTION_SAFE");
    writeFileSync(join(cwd, ".pi", "agent-tool-description.md"), "PROJECT_DESCRIPTION_SECRET");
    writeFileSync(join(agentDir, "agents", "global-worker.md"), "---\ndescription: global\ntools: none\nextensions: false\nskills: false\n---\nglobal");
    writeFileSync(join(cwd, ".pi", "agents", "project-worker.md"), "---\ndescription: PROJECT_AGENT_SECRET\n---\nproject");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["loadout-faux/safe"] }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: [] }));
    faux = fauxProvider({ provider: "loadout-faux", models: [{ id: "safe", contextWindow: 200_000 }, { id: "outside", contextWindow: 200_000 }] });
    runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
  });

  afterEach(async () => {
    if (session) await shutdownAndDisposeSession(session);
    session = undefined;
    faux.setResponses([]);
    for (const key of ["pi-subagents:manager", "pi-subagents:manager-active", "pi-subagents:rpc-owner"]) {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for(key)];
    }
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  async function start() {
    const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [{ name: "trust-subagents", factory: subagentsExtension }, { name: "trust-control", factory: pi => {
      pi.registerTool(defineTool({ name: "revoke", label: "Revoke", description: "Fixture trust revocation", parameters: Type.Object({}), execute: async () => {
        session?.settingsManager.setProjectTrusted(false);
        return { content: [{ type: "text", text: "revoked" }], details: {} };
      } }));
    } }] });
    await loader.reload();
    const registry = new ModelRegistry(runtime);
    const result = await createAgentSession({ cwd, agentDir, model: registry.find("loadout-faux", "safe"), modelRuntime: runtime, modelRegistry: registry, resourceLoader: loader, tools: ["Agent", "revoke"], sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: true }) });
    session = result.session;
    await session.bindExtensions({});
    return session;
  }

  it("replaces both the snapshotted description and configuration-derived schema before the next request", async () => {
    const owner = await start();
    const declarations: string[] = [];
    const call = vi.fn((context: TranscriptContext) => {
      const agent = getCurrentTools(context.messages).find(tool => tool.name === "Agent");
      expect(agent).toBeDefined();
      declarations.push(JSON.stringify(agent));
      return fauxAssistantMessage(fauxText("OK"));
    });
    faux.setResponses([call, call, call]);
    await owner.prompt("first");
    expect(owner.messages.at(-1), JSON.stringify(owner.messages.at(-1))).toMatchObject({ stopReason: "stop" });
    expect(declarations[0]).toContain("PROJECT_DESCRIPTION_SECRET");
    expect(declarations[0]).toContain("project-worker");
    expect(declarations[0]).toContain("projecttier");
    owner.settingsManager.setProjectTrusted(false); // No host event or extension reload.
    await owner.prompt("after trust revoked");
    expect(declarations[1]).toContain("GLOBAL_DESCRIPTION_SAFE");
    expect(declarations[1]).toContain("global-worker");
    expect(declarations[1]).toContain("globaltier");
    expect(declarations[1]).not.toMatch(/PROJECT_|project-worker|projecttier/);
    owner.settingsManager.setProjectTrusted(true);
    await owner.prompt("approved again");
    expect(declarations[2]).toContain("PROJECT_DESCRIPTION_SECRET");
    expect(declarations[2]).toContain("project-worker");
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("refreshes the mention-only provider declaration before a handled input bypasses the root prompt", async () => {
    const owner = await start();
    faux.setResponses([fauxAssistantMessage(fauxText("INITIAL"))]);
    await owner.prompt("initial declaration");
    owner.settingsManager.setProjectTrusted(false);
    faux.setResponses([
      context => {
        const declaration = JSON.stringify(getCurrentTools(context.messages).find(tool => tool.name === "Agent"));
        expect(declaration).toContain("GLOBAL_DESCRIPTION_SAFE");
        expect(declaration).toContain("global-worker");
        expect(declaration).not.toMatch(/PROJECT_|project-worker|projecttier/);
        return fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "global-worker", description: "safe task", prompt: "safe task" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxText("MENTION_CHILD_OK")),
      fauxAssistantMessage(fauxText("MENTION_COMPLETE")),
    ]);
    await owner.prompt("@global-worker safe task");
    expect(faux.state.callCount).toBe(4); // Initial prompt plus clone, child, and clone continuation.
  });

  it("refreshes a provider continuation when a tool revokes trust without another prompt", async () => {
    const owner = await start();
    faux.setResponses([
      context => {
        expect(JSON.stringify(getCurrentTools(context.messages))).toContain("PROJECT_DESCRIPTION_SECRET");
        return fauxAssistantMessage(fauxToolCall("revoke", {}), { stopReason: "toolUse" });
      },
      context => {
        const declaration = JSON.stringify(getCurrentTools(context.messages).find(tool => tool.name === "Agent"));
        expect(declaration).toContain("GLOBAL_DESCRIPTION_SAFE");
        expect(declaration).toContain("globaltier");
        expect(declaration).not.toMatch(/PROJECT_|project-worker|projecttier/);
        return fauxAssistantMessage(fauxText("REFRESHED_CONTINUATION"));
      },
    ]);
    await owner.prompt("revoke then continue");
    expect(owner.messages.at(-1), JSON.stringify(owner.messages.at(-1))).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "REFRESHED_CONTINUATION" }] });
    expect(faux.state.callCount).toBe(2);
  });

  it("blocks an explicit global out-of-scope tier despite a denied empty project override", async () => {
    const owner = await start();
    owner.settingsManager.setProjectTrusted(false);
    faux.setResponses([fauxAssistantMessage(fauxText("OUT_OF_SCOPE_RAN"))]);
    const agent = owner.getToolDefinition("Agent")!;
    const result = await agent.execute("scope", { subagent_type: "global-worker", description: "scope probe", prompt: "go", tier: "globaltier" }, undefined, undefined, owner.extensionRunner.createToolContext());
    expect(JSON.stringify(result.content)).toContain("Model not in scope");
  });

  it("keeps a deliberately inactive Agent inactive when refreshing declarations", async () => {
    const owner = await start();
    owner.setActiveToolsByName(owner.getActiveToolNames().filter(name => name !== "Agent"));
    owner.settingsManager.setProjectTrusted(false);
    faux.setResponses([context => {
      expect(getCurrentTools(context.messages).some(tool => tool.name === "Agent")).toBe(false);
      return fauxAssistantMessage(fauxText("OK"));
    }]);
    await owner.prompt("inactive remains inactive");
    expect(owner.getActiveToolNames()).not.toContain("Agent");
  });
});
