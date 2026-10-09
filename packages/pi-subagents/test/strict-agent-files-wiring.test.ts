import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentConfig, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import { CHILD_CONTEXT_RPC } from "../src/cross-extension-rpc.js";
import subagentsExtension from "../src/index.js";
import { configurationContext } from "../src/project-trust.js";

function makePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    emit: vi.fn((event: string, data: unknown) => {
      for (const handler of listeners.get(event) ?? []) handler(data);
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      const handlers = listeners.get(event) ?? new Set<(data: unknown) => void>();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    }),
  };
  return {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    tools,
    commands,
    lifecycle,
  } as any;
}

function sessionCtx() {
  return {
    isProjectTrusted: () => true,
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => undefined), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const BROKEN = "---\ndescription: Use this: that\n---\n\nBroken.\n";

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
}

function writeBrokenAgent(): string {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "broken.md");
  writeFileSync(path, BROKEN);
  return path;
}

describe("strictAgentFiles activation wiring", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "strict-agent-files-"));
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    delete (globalThis as any)[Symbol.for("pi-subagents:manager-active")];
    delete (globalThis as any)[Symbol.for("pi-subagents:rpc-owner")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    setFallbackSubagent(undefined);
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each(["false", "unknown", "throwing", "trusted"].flatMap(trust =>
    (trust === "trusted" ? [false] : [false, true]).map(malformed => ({ trust, malformed })),
  ))("gates own configuration at root bootstrap and replacement: $trust, malformed=$malformed", async ({ trust, malformed }) => {
    const global = mkdtempSync(join(tmpdir(), "global-agent-trust-"));
    process.env.PI_CODING_AGENT_DIR = global;
    const pi = makePi();
    const ctx = sessionCtx();
    ctx.isProjectTrusted = trust === "unknown" ? undefined : () => {
      if (trust === "throwing") throw new Error("unavailable");
      return trust === "trusted";
    };
    try {
      mkdirSync(join(global, "agents"));
      writeFileSync(join(global, "agents", "global.md"), "---\ndescription: safe\n---\nglobal");
      writeFileSync(join(global, "subagents.json"), JSON.stringify({ strictAgentFiles: true, toolDescriptionMode: "custom", maxSubagentDepth: 3, fallbackSubagent: "none" }));
      writeFileSync(join(global, "agent-tool-description.md"), "GLOBAL_DESCRIPTION");
      writeSettings({ strictAgentFiles: true, toolDescriptionMode: "custom", maxSubagentDepth: 15 });
      if (malformed) writeFileSync(join(cwd, ".pi", "subagents.json"), "{malformed");
      writeFileSync(join(cwd, ".pi", "agent-tool-description.md"), "PROJECT_DESCRIPTION");
      const broken = writeBrokenAgent();
      mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
      writeFileSync(join(cwd, ".agents", "agents", "workspace.md"), "---\ndescription: workspace override\n---\nworkspace");
      if (trust === "trusted") writeFileSync(broken, "---\ndescription: approved\n---\nproject");
      subagentsExtension(pi);
      await pi.lifecycle.get("session_start")({}, ctx);
      expect(getAgentConfig("global")?.source).toBe("global");
      expect(getAgentConfig("Explore")?.isDefault).toBe(true);
      expect(getAgentConfig("broken")?.source).toBe(trust === "trusted" ? "project" : undefined);
      expect(getAgentConfig("workspace")?.source).toBe(trust === "trusted" ? "project" : undefined);
      expect(pi.tools.get("Agent").description).toBe(trust === "trusted" ? "PROJECT_DESCRIPTION" : "GLOBAL_DESCRIPTION");
      const loaded = () => pi.events.emit.mock.calls.filter(([name]: [string]) => name === "subagents:settings_loaded").at(-1)?.[1].settings;
      expect(loaded().maxSubagentDepth).toBe(trust === "trusted" ? 15 : 3);
      expect(loaded().strictAgentFiles).toBe(true);
      if (trust === "trusted") {
        ctx.isProjectTrusted = () => false;
        const result = await pi.tools.get("Agent").execute("denied-reload", {
          subagent_type: "broken", prompt: "must not run", description: "denied",
        }, undefined, undefined, ctx);
        expect(JSON.stringify(result)).toContain("Unknown or disabled agent type");
        expect(getAgentConfig("broken")).toBeUndefined();
        expect(loaded().maxSubagentDepth).toBe(3);
      }
      // A replacement context must revoke project settings and definitions,
      // including malformed files that would otherwise block the global tier.
      writeFileSync(join(cwd, ".pi", "subagents.json"), "{malformed");
      writeFileSync(broken, BROKEN);
      await pi.lifecycle.get("session_start")({}, { ...ctx, isProjectTrusted: () => false });
      expect(loaded().maxSubagentDepth).toBe(3);
      expect(getAgentConfig("broken")).toBeUndefined();
      expect(pi.tools.get("Agent").description).toBe("GLOBAL_DESCRIPTION");
      expect(warn.mock.calls.flat().join(" ")).not.toContain("malformed settings");
    } finally {
      await pi.lifecycle.get("session_shutdown")?.({}, ctx);
      rmSync(global, { recursive: true, force: true });
    }
  });

  it("does not launder project settings, definitions, or descriptions through global aliases", async () => {
    const global = mkdtempSync(join(tmpdir(), "aliased-global-agents-"));
    process.env.PI_CODING_AGENT_DIR = global;
    const pi = makePi();
    const ctx = sessionCtx();
    ctx.isProjectTrusted = () => false;
    try {
      const broken = writeBrokenAgent();
      writeSettings({ toolDescriptionMode: "custom", defaultModel: "evil/model" });
      writeFileSync(join(cwd, ".pi", "agent-tool-description.md"), "PROJECT_DESCRIPTION");
      mkdirSync(join(global, "agents"));
      symlinkSync(broken, join(global, "agents", "aliased.md"));
      symlinkSync(join(cwd, ".pi", "subagents.json"), join(global, "subagents.json"));
      symlinkSync(join(cwd, ".pi", "agent-tool-description.md"), join(global, "agent-tool-description.md"));
      // Captured configuration ownership wins over an execution-only cwd.
      configurationContext(ctx, cwd);
      ctx.cwd = join(global, "execution");
      subagentsExtension(pi);
      await pi.lifecycle.get("session_start")({}, ctx);
      expect(getAgentConfig("aliased")).toBeUndefined();
      expect(getAgentConfig("broken")).toBeUndefined();
      expect(pi.tools.get("Agent").description).not.toContain("PROJECT_DESCRIPTION");
      const loaded = pi.events.emit.mock.calls.find(([name]: [string]) => name === "subagents:settings_loaded")?.[1].settings;
      expect(loaded).toEqual({});
      expect(warn.mock.calls.flat().join(" ")).not.toContain("Skipping agent file");
    } finally {
      await pi.lifecycle.get("session_shutdown")?.({}, ctx);
      rmSync(global, { recursive: true, force: true });
    }
  });

  it("keeps globally configured strict parsing under denied trust", async () => {
    const global = mkdtempSync(join(tmpdir(), "strict-global-agents-"));
    process.env.PI_CODING_AGENT_DIR = global;
    try {
      mkdirSync(join(global, "agents"));
      const path = join(global, "agents", "broken.md");
      writeFileSync(path, BROKEN);
      writeFileSync(join(global, "subagents.json"), JSON.stringify({ strictAgentFiles: true }));
      const pi = makePi();
      subagentsExtension(pi);
      await expect(pi.lifecycle.get("session_start")({}, { ...sessionCtx(), isProjectTrusted: () => false })).rejects.toThrow(path);
    } finally {
      rmSync(global, { recursive: true, force: true });
    }
  });

  it("fails startup with the path when strict mode is enabled", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });

    const pi = makePi();
    subagentsExtension(pi);
    await expect(pi.lifecycle.get("session_start")?.({}, sessionCtx())).rejects.toThrow(path);
  });

  it("validates the session cwd rather than process.cwd", async () => {
    const sessionCwd = mkdtempSync(join(tmpdir(), "strict-agent-session-cwd-"));
    try {
      const agentsDir = join(sessionCwd, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      const path = join(agentsDir, "broken.md");
      writeFileSync(path, BROKEN);
      writeFileSync(join(sessionCwd, ".pi", "subagents.json"), JSON.stringify({ strictAgentFiles: true }));

      const pi = makePi();
      subagentsExtension(pi);
      const activation = sessionCtx();
      activation.cwd = sessionCwd;
      await expect(pi.lifecycle.get("session_start")?.({}, activation)).rejects.toThrow(path);
    } finally {
      rmSync(sessionCwd, { recursive: true, force: true });
    }
  });

  it("does not leave the child-context responder after strict validation fails", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });
    const pi = makePi();
    subagentsExtension(pi);
    await expect(pi.lifecycle.get("session_start")?.({}, sessionCtx())).rejects.toThrow(path);
    expect(getAgentConfig("broken")).toBeUndefined();
    expect(pi.events.on).toHaveBeenCalledWith(CHILD_CONTEXT_RPC, expect.any(Function));

    pi.events.emit(CHILD_CONTEXT_RPC, { requestId: "strict-failure" });
    expect(pi.events.emit.mock.calls.some(([event]: [string]) => event === `${CHILD_CONTEXT_RPC}:reply:strict-failure`)).toBe(false);
  });

  it("skips malformed files with a warning by default", async () => {
    writeBrokenAgent();

    const pi = makePi();
    subagentsExtension(pi);
    await pi.lifecycle.get("session_start")?.({}, sessionCtx());
    expect(String(warn.mock.calls[0]?.[0])).toContain("Skipping agent file");
  });

  it("uses strict mode only for startup, not later reloads", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });
    writeFileSync(path, "---\ndescription: Fixed\n---\n\nFixed.\n");

    const pi = makePi();
    subagentsExtension(pi);
    await pi.lifecycle.get("session_start")?.({}, sessionCtx());
    writeFileSync(path, BROKEN);

    // This tool call reaches an SDK child: use a real parent runtime so the
    // reload behavior is tested without a missing-runtime admission failure.
    const faux = fauxProvider({ provider: "strict-files-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel("strict-files-faux", "physical");
    if (!model) throw new Error("Physical model was not registered in real Pi runtime");
    const registry = new ModelRegistry(runtime);
    const providerCall = vi.fn(() => fauxAssistantMessage(fauxText("done")));
    faux.setResponses([providerCall]);
    try {
      const agentTool = [...pi.tools.values()].find((tool: any) => tool.name === "Agent");
      expect(agentTool).toBeDefined();
      const result = await agentTool.execute(
        "call-1",
        { subagent_type: "nope", prompt: "x" },
        undefined,
        vi.fn(),
        {
          isProjectTrusted: () => true,
          hasUI: false,
          ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
          cwd,
          model,
          modelRegistry: registry,
          sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
          getSystemPrompt: vi.fn(() => "parent"),
        },
      );
      expect(JSON.stringify(result)).not.toContain("Nested mappings");
      expect(providerCall).toHaveBeenCalledOnce();
    } finally {
      faux.setResponses([]);
    }
  });

  it("routes /agents disable to the active lower-priority source after a higher file is skipped", async () => {
    const malformedProject = join(cwd, ".pi", "agents", "fallback.md");
    const activeWorkspace = join(cwd, ".agents", "agents", "fallback.md");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
    writeFileSync(malformedProject, BROKEN);
    writeFileSync(activeWorkspace, "---\ndescription: Workspace fallback\n---\n\nWorkspace body.\n");

    const pi = makePi();
    subagentsExtension(pi);
    await pi.lifecycle.get("session_start")?.({}, sessionCtx());
    const command = pi.commands.get("agents");
    expect(command).toBeDefined();

    let agentMenuShown = 0;
    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Agents") return agentMenuShown++ === 0 ? "Agent types (4)" : undefined;
        if (title === "fallback") return "Disable";
        return undefined;
      }),
      custom: vi.fn()
        .mockResolvedValueOnce("fallback")
        .mockResolvedValueOnce(undefined),
      confirm: vi.fn(async () => true),
      editor: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };

    await command.handler("", {
      ui,
      cwd,
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent"),
    });

    expect(readFileSync(malformedProject, "utf-8")).toBe(BROKEN);
    expect(readFileSync(activeWorkspace, "utf-8")).toContain("enabled: false");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(activeWorkspace), "info");
  });

  it("ejects a default and then resets the active exported file", async () => {
    const pi = makePi();
    subagentsExtension(pi);
    await pi.lifecycle.get("session_start")?.({}, sessionCtx());
    const command = pi.commands.get("agents");
    expect(command).toBeDefined();
    const projectPath = join(cwd, ".pi", "agents", "general-purpose.md");

    const runMenu = async (action: string, location?: string) => {
      let agentMenuShown = 0;
      const ui = {
        select: vi.fn(async (title: string) => {
          if (title === "Agents") return agentMenuShown++ === 0 ? "Agent types (3)" : undefined;
          if (title === "general-purpose") return action;
          if (title === "Choose location") return location;
          return undefined;
        }),
        custom: vi.fn()
          .mockResolvedValueOnce("general-purpose")
          .mockResolvedValueOnce(undefined),
        confirm: vi.fn(async () => true),
        editor: vi.fn(),
        input: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      };
      await command.handler("", {
        ui,
        cwd,
        model: undefined,
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
        sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
        getSystemPrompt: vi.fn(() => "parent"),
      });
      return ui;
    };

    await runMenu("Eject (export as .md)", "Project (.pi/agents/)");
    expect(readFileSync(projectPath, "utf-8")).toContain("description:");

    const ui = await runMenu("Reset to default");
    expect(existsSync(projectPath)).toBe(false);
    expect(ui.notify).toHaveBeenCalledWith("Restored default general-purpose", "info");
  });
});
