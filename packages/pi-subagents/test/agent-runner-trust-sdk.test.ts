import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import * as Pi from "@earendil-works/pi-coding-agent";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunOptions, runAgent } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";
import type { NestedAgentManager } from "../src/nested-tools.js";
import { captureProjectTrust, configurationContext, isSameConfiguration } from "../src/project-trust.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";
import { loadSettings } from "../src/settings.js";
import type { AgentConfig } from "../src/types.js";

vi.setConfig({ testTimeout: 30_000 });

describe("inherited child project trust (installed Pi SDK)", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let oldAgentDir: string | undefined;
  let ctx: ExtensionContext;
  let faux: ReturnType<typeof fauxProvider>;
  let sessions: AgentSession[];
  let projectExtension: string;
  let projectSkill: string;
  let factoryMarker: string;
  let launcherMarker: string;
  let launch: ReturnType<typeof vi.fn<Pi.McpTransportFactory>>;
  let confirm: ReturnType<typeof vi.fn>;

  function skill(base: string, name: string, text: string): string {
    const dir = join(base, "skills", name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, `---\nname: ${name}\ndescription: fixture\n---\n${text}`);
    return path;
  }

  function project(dir: string, server = "project-server") {
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ images: { blockImages: true } }));
    const extension = join(dir, ".pi", "extensions", "project-probe.js");
    writeFileSync(extension, `import { writeFileSync } from "node:fs";
export default function(pi) { writeFileSync(${JSON.stringify(factoryMarker)}, "factory"); }`);
    const namedSkill = skill(join(dir, ".pi"), "trust-probe", "PROJECT_SKILL_SECRET");
    skill(join(dir, ".agents"), "agents-probe", "AGENTS_SKILL_SECRET");
    for (const path of ["AGENTS.md", "CLAUDE.md", ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md", ".pi/prompts/probe.md"]) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), "PROJECT_PROMPT_SECRET");
    }
    writeFileSync(join(dir, ".pi", "mcp.json"), JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: { [server]: { type: "stdio", command: "NEVER_EXECUTE_TRUST_FIXTURE", exposure: "direct" } },
    }));
    return { extension, namedSkill };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "subagent-trust-sdk-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    factoryMarker = join(root, "factory-ran");
    launcherMarker = join(root, "launcher-ran");
    mkdirSync(agentDir);
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const fixture = project(cwd);
    projectExtension = fixture.extension;
    projectSkill = fixture.namedSkill;
    skill(agentDir, "trust-probe", "GLOBAL_SKILL_SAFE");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ images: { blockImages: false } }));
    // Intercept the public MCP transport factory: even a regression cannot
    // spawn a real stdio process or make a network request. A trusted positive
    // control proves the project entry would reach this launcher.
    launch = vi.fn<Pi.McpTransportFactory>((_entry, _cwd) => {
      writeFileSync(launcherMarker, "launch attempted");
      throw new Error("Safe fixture transport intercepted; no MCP launched");
    });
    const createMcp = Pi.createMcpExtension;
    vi.spyOn(Pi, "createMcpExtension").mockImplementation((options) => createMcp({ ...options, createTransport: launch, startupWaitMs: 100 }));
    faux = fauxProvider({ provider: "trust-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel("trust-faux", "physical");
    if (!model) throw new Error("Fixture model missing");
    confirm = vi.fn(async () => { throw new Error("Child must never request project trust"); });
    ctx = {
      cwd, model, modelRegistry: new ModelRegistry(runtime),
      isProjectTrusted: () => false,
      getSystemPrompt: () => "PARENT",
      hasUI: true, mode: "tui", ui: { confirm },
    } as unknown as ExtensionContext;
    sessions = [];
  });

  afterEach(async () => {
    for (const session of sessions) await shutdownAndDisposeSession(session);
    vi.restoreAllMocks();
    registerAgents(new Map());
    setScopeModelsEnabled(false);
    setAgentTiersSettings({});
    faux.setResponses([]);
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  async function spawn(config: Partial<AgentConfig> = {}, options: Partial<RunOptions> = {}, parent = ctx) {
    registerAgents(new Map([["trust-fixture", {
      name: "trust-fixture", description: "trust fixture", builtinToolNames: [],
      extensions: true, skills: true, systemPrompt: "CHILD", promptMode: "replace",
      ...config,
    } satisfies AgentConfig]]));
    const providerCall = vi.fn(() => fauxAssistantMessage(fauxText("CHILD_OK")));
    faux.setResponses([providerCall]);
    const result = await runAgent(parent, "trust-fixture", "go", {
      pi: { exec: async () => ({ code: 1, killed: false, stdout: "", stderr: "" }) } as unknown as ExtensionAPI,
      supervisorQuestions: false,
      onSessionCreated: (session) => sessions.push(session),
      ...options,
    });
    expect(result.responseText).toBe("CHILD_OK");
    expect(providerCall).toHaveBeenCalledOnce();
    return result.session;
  }

  it("denies globally aliased directories whose declarations and settings escape outside", async () => {
    const outside = join(root, "outside-global");
    mkdirSync(join(outside, "agents"), { recursive: true });
    writeFileSync(join(outside, "agents", "probe.md"), "---\nbroken: [\n---\n");
    writeFileSync(join(outside, "subagents.json"), JSON.stringify({ scopeModels: false }));
    writeFileSync(join(outside, "settings.json"), JSON.stringify({ images: { blockImages: true } }));
    const alias = join(root, "laundered-global");
    symlinkSync(join(cwd, ".pi"), alias);
    symlinkSync(join(outside, "agents"), join(cwd, ".pi", "agents"));
    symlinkSync(join(outside, "subagents.json"), join(cwd, ".pi", "subagents.json"));
    rmSync(join(cwd, ".pi", "settings.json"));
    symlinkSync(join(outside, "settings.json"), join(cwd, ".pi", "settings.json"));
    process.env.PI_CODING_AGENT_DIR = alias;
    expect(loadCustomAgents(cwd, true, false).size).toBe(0);
    expect(loadSettings(cwd, false)).toEqual({});
    const create = vi.spyOn(SettingsManager, "create");
    await expect(spawn({ extensions: false, skills: false })).rejects.toThrow("Project trust denied for global configuration source");
    expect(create).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    // The same resources under a genuine global root retain authority.
    process.env.PI_CODING_AGENT_DIR = outside;
    writeFileSync(join(outside, "agents", "probe.md"), "---\nextensions: false\nskills: false\n---\nsafe");
    expect(loadCustomAgents(cwd, true, false).has("probe")).toBe(true);
    expect(loadSettings(cwd, false)).toMatchObject({ scopeModels: false });
    expect((await spawn({ extensions: false, skills: false })).settingsManager.getBlockImages()).toBe(true);
  });

  it.each([false, true])("applies captured tier scope across different execution/config roots (trusted=%s)", async (trusted) => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["trust-faux/safe-only"] }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: [] }));
    setScopeModelsEnabled(true);
    setAgentTiersSettings({ profiles: { outside: { model: "trust-faux/physical", thinking: "inherit" } } });
    const worktree = join(root, "execution");
    mkdirSync(worktree);
    const parent = { ...ctx, isProjectTrusted: () => trusted };
    if (trusted) {
      await spawn({ extensions: false, skills: false }, { cwd: worktree, configCwd: cwd, agentTier: "outside" }, parent);
    } else {
      await expect(spawn({ extensions: false, skills: false }, { cwd: worktree, configCwd: cwd, agentTier: "outside" }, parent)).rejects.toThrow("Model not in scope");
      // Another denied config must not shed A's denial or read A's empty list.
      await expect(spawn({ extensions: false, skills: false }, { cwd: worktree, configCwd: worktree, agentTier: "outside" }, parent)).rejects.toThrow("Model not in scope");
    }
  });

  it.each([
    { filename: "settings.json", changed: false },
    { filename: "settings.json", changed: true },
    { filename: "mcp.json", changed: false },
    { filename: "mcp.json", changed: true },
  ])("rejects native global $filename aliases before SDK parsing (changed=$changed)", async ({ filename, changed }) => {
    const childRoot = changed ? join(root, "child-config") : cwd;
    if (changed) mkdirSync(childRoot);
    const target = join(cwd, ".pi", filename);
    // Passive project data must not become global authority via a symlink.
    writeFileSync(target, JSON.stringify(filename === "settings.json"
      ? { packages: [join(root, "outside-package")] }
      : { mcpServers: { probe: { command: "NEVER_EXECUTE_TRUST_FIXTURE" } } }));
    rmSync(join(agentDir, filename), { force: true });
    symlinkSync(target, join(agentDir, filename));
    const dir = join(agentDir, "agents");
    mkdirSync(dir);
    writeFileSync(join(dir, "safe.md"), "---\nextensions: true\n---\nsafe global definition");
    registerAgents(loadCustomAgents(cwd, true, false));
    const create = vi.spyOn(SettingsManager, "create");
    const resolve = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolve").mockRejectedValue(new Error("resolver must not run"));
    const explicit = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolveExtensionSources").mockRejectedValue(new Error("installer must not run"));
    await expect(runAgent(ctx, "safe", "go", { pi: {} as ExtensionAPI, configCwd: childRoot })).rejects.toThrow("Project trust denied for global configuration source");
    expect(create).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(explicit).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    { filename: "settings.json", relativeTarget: false },
    { filename: "settings.json", relativeTarget: true },
    { filename: "mcp.json", relativeTarget: false },
    { filename: "mcp.json", relativeTarget: true },
  ])("rejects raw dot-segment global $filename aliases before SDK parsing (relative=$relativeTarget)", async ({ filename, relativeTarget }) => {
    const outside = join(root, "outside-native");
    const genuineGlobal = join(root, "genuine-global");
    mkdirSync(join(cwd, ".pi", "inner"));
    mkdirSync(outside);
    mkdirSync(genuineGlobal);
    const target = join(genuineGlobal, filename);
    // Invalid native configuration proves the guard runs before host parsing.
    writeFileSync(target, "{INVALID_NATIVE_CONFIGURATION");
    symlinkSync(join(cwd, ".pi", "inner"), join(outside, "bridge"));
    symlinkSync(genuineGlobal, join(cwd, ".pi", "relay"));
    const rawTarget = relativeTarget ? `../outside-native/bridge/../relay/${filename}` : `${outside}/bridge/../relay/${filename}`;
    const alias = join(agentDir, filename);
    rmSync(alias, { force: true });
    symlinkSync(rawTarget, alias);
    expect(realpathSync.native(alias)).toBe(realpathSync.native(target));
    expect(readFileSync(alias, "utf8")).toBe("{INVALID_NATIVE_CONFIGURATION");
    const create = vi.spyOn(SettingsManager, "create");
    const resolve = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolve").mockRejectedValue(new Error("resolver must not run"));
    const explicit = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolveExtensionSources").mockRejectedValue(new Error("installer must not run"));
    const reload = vi.spyOn(Pi.DefaultResourceLoader.prototype, "reload");
    await expect(spawn()).rejects.toThrow("Project trust denied for global configuration source");
    expect(create).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(explicit).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(Pi.createMcpExtension).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(factoryMarker)).toBe(false);
    create.mockRestore();
    resolve.mockRestore();
    explicit.mockRestore();
    reload.mockRestore();
    // The identical traversal is allowed through an approved parent, even
    // when the child config is different and remains denied.
    writeFileSync(target, JSON.stringify(filename === "settings.json"
      ? { images: { blockImages: true } }
      : { autoEnableCodemode: false, mcpServers: { "dotdot-global": { type: "stdio", command: "NEVER_EXECUTE_TRUST_FIXTURE", exposure: "direct" } } }));
    const childRoot = join(root, "approved-control-child");
    mkdirSync(childRoot);
    const session = await spawn({ extensions: filename === "mcp.json" ? ["mcp"] : false, skills: false }, { configCwd: childRoot }, {
      ...ctx, isProjectTrusted: () => true,
    });
    expect(session.settingsManager.isProjectTrusted()).toBe(false);
    if (filename === "settings.json") {
      expect(session.settingsManager.getBlockImages()).toBe(true);
      expect(launch).not.toHaveBeenCalled();
    } else {
      expect(launch).toHaveBeenCalledOnce();
      expect(launch.mock.calls[0][0].name).toBe("dotdot-global");
    }
  });

  it("retains native global settings aliases into an approved parent configuration", async () => {
    rmSync(join(agentDir, "settings.json"));
    symlinkSync(join(cwd, ".pi", "settings.json"), join(agentDir, "settings.json"));
    const session = await spawn({ extensions: false, skills: false }, { configCwd: join(root, "different-config") }, {
      ...ctx, isProjectTrusted: () => true,
    });
    expect(session.settingsManager.isProjectTrusted()).toBe(false);
    expect(session.settingsManager.getBlockImages()).toBe(true);
    expect(session.settingsManager.getProjectSettings()).toEqual({});
  });

  it("retains native package resolution from genuinely global settings under denied trust", async () => {
    const pkg = join(root, "outside-package");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
    const sourceBoundary = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolvePackageSources")
      .mockRejectedValue(new Error("safe native package boundary intercepted"));
    registerAgents(new Map([["safe", {
      name: "safe", description: "global control", source: "global", builtinToolNames: [],
      extensions: true, skills: false, systemPrompt: "CHILD", promptMode: "replace",
    } satisfies AgentConfig]]));
    await expect(runAgent(ctx, "safe", "go", {
      pi: { exec: async () => ({ code: 1, killed: false, stdout: "", stderr: "" }) } as unknown as ExtensionAPI,
    })).rejects.toThrow("safe native package boundary intercepted");
    expect(sourceBoundary).toHaveBeenCalled();
    expect(JSON.stringify(sourceBoundary.mock.calls)).toContain(pkg);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["probe", "unknown-fallback", "direct", "global-alias"])("rejects denied definition provenance before package resolution: %s", async (selection) => {
    const dir = join(cwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    const name = selection === "unknown-fallback" ? "general-purpose" : "probe";
    const path = join(dir, `${name}.md`);
    // The executable is outside both configuration roots. Containment of the
    // requested extension cannot establish authority for this project request.
    writeFileSync(path, `---\ndescription: malicious\nextensions:\n  - ${join(agentDir, "extensions", "external.js")}\n---\nprobe`);
    if (selection === "global-alias") {
      mkdirSync(join(agentDir, "agents"));
      symlinkSync(path, join(agentDir, "agents", "alias.md"));
      expect(loadCustomAgents(cwd, true, false).size).toBe(0);
    }
    const discovered = loadCustomAgents(cwd);
    expect(discovered.get(name)?.source).toBe("project");
    if (selection === "direct") discovered.get(name)!.sourcePath = undefined;
    if (selection === "global-alias") discovered.delete(name);
    registerAgents(discovered);
    const resolve = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolve").mockRejectedValue(new Error("resolver must not run"));
    const explicit = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolveExtensionSources").mockRejectedValue(new Error("installer must not run"));
    const selected = selection === "unknown-fallback" ? "missing" : selection === "global-alias" ? "alias" : name;
    const execution = { ...ctx, cwd: join(root, "worktree") };
    configurationContext(execution, cwd);
    await expect(runAgent(execution, selected, "go", { pi: {} as ExtensionAPI })).rejects.toThrow("Project trust denied");
    expect(resolve).not.toHaveBeenCalled();
    expect(explicit).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it.each(["probe", "missing-fallback"])("rejects a global alias into the denied CHILD config before model setup: %s", async (selection) => {
    const childRoot = join(root, "child-config");
    const dir = join(childRoot, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(agentDir, "agents"));
    const name = selection === "probe" ? "probe" : "general-purpose";
    const path = join(dir, `${name}.md`);
    writeFileSync(path, `---\nextensions: ${join(root, "outside.js")}\n---\nprobe`);
    const alias = join(agentDir, "agents", `${name}.md`);
    symlinkSync(path, alias);
    // Actual discovery under A cannot know that the next config root is B.
    const discovered = loadCustomAgents(cwd, true, false);
    expect(discovered.get(name)).toMatchObject({ source: "global", sourcePath: alias });
    registerAgents(discovered);
    const resolve = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolve").mockRejectedValue(new Error("resolver must not run"));
    const explicit = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolveExtensionSources").mockRejectedValue(new Error("installer must not run"));
    const modelAccess = vi.fn(() => { throw new Error("model bridge must not run"); });
    Object.defineProperty(ctx, "modelRegistry", { get: modelAccess });
    await expect(runAgent(ctx, selection, "go", { pi: {} as ExtensionAPI, configCwd: childRoot })).rejects.toThrow("Project trust denied");
    expect(modelAccess).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(explicit).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it.each([true, false])("admits a real alias when its source is authorized (trusted project=%s)", async (trustedProject) => {
    const childRoot = join(root, "child-config");
    mkdirSync(childRoot);
    const source = declaration(trustedProject ? join(childRoot, ".pi") : join(root, "outside"), "probe", "extensions: false");
    mkdirSync(join(agentDir, "agents"));
    const alias = join(agentDir, "agents", "alias.md");
    symlinkSync(source, alias);
    const discovered = loadCustomAgents(cwd, true, false).get("alias")!;
    expect(discovered).toMatchObject({ source: "global", sourcePath: alias });
    const parent = trustedProject ? { ...ctx, cwd: childRoot, isProjectTrusted: () => true } : ctx;
    const session = await spawn(discovered, { configCwd: childRoot }, parent);
    expect(session.settingsManager.isProjectTrusted()).toBe(trustedProject);
  });

  function declaration(base: string, name: string, fields: string): string {
    const dir = join(base, "agents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.md`);
    writeFileSync(path, `---\ndescription: fixture\ntools: none\nskills: false\n${fields}\n---\nfixture`);
    return path;
  }

  function nestedManager() {
    const spawn = vi.fn<NestedAgentManager["spawn"]>(() => "intercepted-child");
    const spawnAndWait = vi.fn<NestedAgentManager["spawnAndWait"]>(async () => { throw new Error("INTERCEPTED_NESTED"); });
    const manager: NestedAgentManager = {
      spawn, spawnAndWait, getRecordMutable: () => undefined, resume: async () => undefined,
    };
    return { manager, spawn, spawnAndWait };
  }

  it.each([
    { trusted: false, globalIsolation: "isolated: true", explicit: undefined, expected: true },
    { trusted: true, globalIsolation: "isolated: true", explicit: undefined, expected: false },
    { trusted: false, globalIsolation: "isolated: false", explicit: undefined, expected: false },
    { trusted: false, globalIsolation: "", explicit: true, expected: true },
  ])("nested discovery admits only captured authority before invocation defaults: %j", async ({ trusted, globalIsolation, explicit, expected }) => {
    const globalPath = declaration(agentDir, "general-purpose", `${globalIsolation}\nextensions: ${join(root, "outside-probe.js")}`);
    const parentPath = declaration(agentDir, "parent", "isolated: false\nextensions: false\nallowed_subagents: general-purpose");
    declaration(join(cwd, ".pi"), "general-purpose", "isolated: false\nextensions: false");
    declaration(join(cwd, ".pi"), "denied-only", "extensions: false");
    const globalParent = loadCustomAgents(cwd, true, false).get("parent")!;
    expect(globalParent.sourcePath).toBe(parentPath);
    const intercepted = nestedManager();
    const session = await spawn(globalParent, {
      nestedRuntime: { manager: intercepted.manager, parentAgentId: "parent", depth: 1, maxSubagentDepth: 3 },
    }, { ...ctx, isProjectTrusted: () => trusted });
    registerAgents(loadCustomAgents(cwd, true, trusted));
    if (!trusted) expect(getAgentConfig("general-purpose")?.sourcePath).toBe(globalPath);
    const tool = session.getToolDefinition("Agent")!;
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool.parameters)).not.toContain("denied-only");
    // The live host context is deliberately contradictory. The runner's
    // immutable configuration authority, not a late execution callback, wins.
    const execution = { ...ctx, isProjectTrusted: () => !trusted };
    await tool.execute("nested", {
      subagent_type: "general-purpose", description: "probe", prompt: "go",
      ...(explicit === undefined ? {} : { isolated: explicit }),
    }, undefined, undefined, execution);
    expect(intercepted.spawnAndWait).toHaveBeenCalledOnce();
    const [, forwarded, , , options] = intercepted.spawnAndWait.mock.calls[0];
    expect(options.isolated).toBe(expected);
    expect(options.maxSubagentDepth).toBe(3);
    expect(captureProjectTrust(forwarded).trusted).toBe(trusted);
  });

  it.each([true, false])("preserves denied A/B lineage through installed nested tools and grandchild admission (background=%s)", async (background) => {
    const childRoot = join(root, "child-config");
    mkdirSync(childRoot);
    const a = declaration(join(cwd, ".pi"), "a", "extensions: false");
    const b = declaration(join(childRoot, ".pi"), "b", "extensions: false");
    declaration(agentDir, "safe", "extensions: false");
    symlinkSync(a, join(agentDir, "agents", "alias-a.md"));
    symlinkSync(b, join(agentDir, "agents", "alias-b.md"));
    writeFileSync(a, "---\nbroken: [\n---\n");
    writeFileSync(b, "---\nbroken: [\n---\n");
    const warning = vi.spyOn(console, "warn");
    const intercepted = nestedManager();
    const session = await spawn({ extensions: false, skills: false, allowedSubagents: "all", source: "global" }, {
      configCwd: childRoot,
      nestedRuntime: { manager: intercepted.manager, parentAgentId: "parent", depth: 1, maxSubagentDepth: 4 },
    });
    const tool = session.getToolDefinition("Agent")!;
    expect(JSON.stringify(tool.parameters)).not.toMatch(/alias-a|alias-b/);
    expect(warning).not.toHaveBeenCalled();
    // The invocation reload must retain the same pre-parse exclusion.
    declaration(join(cwd, ".pi"), "a", "extensions: false");
    declaration(join(childRoot, ".pi"), "b", "extensions: false");
    const execution = { ...ctx, cwd: join(root, "execution-only"), isProjectTrusted: () => true };
    for (const name of ["alias-a", "alias-b"]) {
      const result = await tool.execute("denied", { subagent_type: name, description: "probe", prompt: "go" }, undefined, undefined, execution);
      expect(result.isError).toBe(true);
    }
    expect(intercepted.spawnAndWait).not.toHaveBeenCalled();
    await tool.execute("safe", {
      subagent_type: "safe", description: "probe", prompt: "go", run_in_background: background,
    }, undefined, undefined, execution);
    const [, forwarded, , , options] = (background ? intercepted.spawn : intercepted.spawnAndWait).mock.calls[0];
    const trust = captureProjectTrust(forwarded);
    expect(trust.trusted).toBe(false);
    expect(trust.deniedRoots).toHaveLength(2);
    expect(trust.deniedRoots.some(path => isSameConfiguration(cwd, path))).toBe(true);
    expect(trust.deniedRoots.some(path => isSameConfiguration(childRoot, path))).toBe(true);
    expect(Object.isFrozen(trust.deniedRoots)).toBe(true);
    expect(options.maxSubagentDepth).toBe(4);
    // Strict parsing proves malformed aliases are excluded BEFORE parsing.
    writeFileSync(a, "---\nbroken: [\n---\n");
    writeFileSync(b, "---\nbroken: [\n---\n");
    expect([...loadCustomAgents(childRoot, true, false, trust.deniedRoots).keys()]).toEqual(["safe"]);
    const resolve = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolve").mockRejectedValue(new Error("resolver must not run"));
    const explicit = vi.spyOn(Pi.DefaultPackageManager.prototype, "resolveExtensionSources").mockRejectedValue(new Error("installer must not run"));
    // Reconstitute a process-global alias entry: the grandchild guard must
    // still reject its actual source under A with current config B.
    declaration(join(cwd, ".pi"), "a", `extensions: ${join(root, "outside.js")}`);
    registerAgents(loadCustomAgents(childRoot, true, false));
    await expect(runAgent(forwarded, "alias-a", "go", { pi: {} as ExtensionAPI, configCwd: childRoot })).rejects.toThrow("Project trust denied");
    expect(resolve).not.toHaveBeenCalled();
    expect(explicit).not.toHaveBeenCalled();
    // A genuine global definition remains usable, but cannot request A's code.
    declaration(agentDir, "safe", `extensions: ${projectExtension}`);
    registerAgents(loadCustomAgents(childRoot, true, false, trust.deniedRoots));
    await expect(runAgent(forwarded, "safe", "go", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI,
      configCwd: childRoot,
    })).rejects.toThrow("not trusted");
    expect(resolve).not.toHaveBeenCalled();
    expect(explicit).not.toHaveBeenCalled();
  });

  function denied(session: AgentSession) {
    expect(session.settingsManager.isProjectTrusted()).toBe(false);
    expect(session.settingsManager.getProjectSettings()).toEqual({});
    expect(session.settingsManager.getBlockImages()).toBe(false);
    expect(session.resourceLoader.getExtensions().extensions.map((e) => e.path)).not.toContain(projectExtension);
    expect(session.resourceLoader.getSkills().skills.map((s) => s.filePath)).not.toContain(projectSkill);
    expect(session.systemPrompt).not.toContain("PROJECT_SKILL_SECRET");
    expect(session.systemPrompt).not.toContain("AGENTS_SKILL_SECRET");
    expect(session.systemPrompt).not.toContain("PROJECT_PROMPT_SECRET");
    expect(session.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(existsSync(factoryMarker)).toBe(false);
    expect(existsSync(launcherMarker)).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  }

  it.each([{ extensions: true }, { extensions: ["mcp", "project-probe"] }, { extensions: ["*"] }])("denies project resources before factories with extensions $extensions", async ({ extensions }) => {
    const session = await spawn({ extensions });
    denied(session);
    expect(session.resourceLoader.getSkills().skills.map((s) => s.name)).toContain("trust-probe");
  });

  it("retains global extensions, skills, and MCP while denying the project configuration", async () => {
    const globalMarker = join(root, "global-factory");
    mkdirSync(join(agentDir, "extensions"));
    writeFileSync(join(agentDir, "extensions", "global-probe.js"), `import { writeFileSync } from "node:fs";
export default function () { writeFileSync(${JSON.stringify(globalMarker)}, "factory"); }`);
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: { "global-server": { type: "stdio", command: "NEVER_EXECUTE_GLOBAL_FIXTURE", exposure: "direct" } },
    }));
    const session = await spawn();
    expect(session.settingsManager.isProjectTrusted()).toBe(false);
    expect(session.settingsManager.getProjectSettings()).toEqual({});
    expect(existsSync(factoryMarker)).toBe(false);
    expect(existsSync(globalMarker)).toBe(true);
    expect(session.resourceLoader.getSkills().skills.map((s) => s.name)).toContain("trust-probe");
    expect(session.resourceLoader.getSkills().skills.map((s) => s.filePath)).not.toContain(projectSkill);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0].name).toBe("global-server");
    expect(existsSync(launcherMarker)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("filters outward-pointing descendants of denied global resource aliases", async () => {
    const outside = join(root, "outside-resources");
    mkdirSync(outside);
    const escapedSkill = skill(outside, "escaped-probe", "ESCAPED_SKILL_SECRET");
    const escapedExtension = join(outside, "probe.js");
    writeFileSync(escapedExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(factoryMarker)}, "escaped"); }`);
    const alias = join(root, "resource-alias");
    symlinkSync(join(cwd, ".pi"), alias);
    symlinkSync(outside, join(cwd, ".pi", "outward"));
    const extensionPath = join(alias, "outward", "probe.js");
    const skillPath = join(alias, "outward", "skills", "escaped-probe", "SKILL.md");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extensionPath], skills: [skillPath] }));
    const deniedSession = await spawn();
    expect(existsSync(factoryMarker)).toBe(false);
    expect(deniedSession.resourceLoader.getSkills().skills.map(s => s.name)).not.toContain("escaped-probe");
    expect(deniedSession.systemPrompt).not.toContain("ESCAPED_SKILL_SECRET");
    await expect(spawn({ extensions: [extensionPath] })).rejects.toThrow("not trusted");
    // Genuine global references to those same external files remain admitted.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [escapedExtension], skills: [escapedSkill] }));
    const globalSession = await spawn();
    expect(existsSync(factoryMarker)).toBe(true);
    expect(globalSession.resourceLoader.getSkills().skills.map(s => s.name)).toContain("escaped-probe");
  });

  it("preloads only global named skills for an untrusted parent", async () => {
    const session = await spawn({ skills: ["trust-probe", "agents-probe"] });
    denied(session);
    expect(session.systemPrompt).toContain("GLOBAL_SKILL_SAFE");
    expect(session.resourceLoader.getSkills().skills).toEqual([]);
  });

  it.each([undefined, () => undefined, () => { throw new Error("unknown trust"); }])("fails closed when public parent trust is absent, unknown, or throws", async (trust) => {
    const parent = { ...ctx, isProjectTrusted: trust } as unknown as ExtensionContext;
    denied(await spawn({ skills: ["trust-probe"] }, {}, parent));
  });

  it.each(["relative", "absolute", "symlink"])("rejects explicit %s project extension paths before their factory", async (kind) => {
    let path = kind === "relative" ? ".pi/extensions/project-probe.js" : projectExtension;
    if (kind === "symlink") {
      path = join(root, "alias.js");
      symlinkSync(projectExtension, path);
    }
    await expect(spawn({ extensions: [path] })).rejects.toThrow("not trusted");
    expect(existsSync(factoryMarker)).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it("filters project paths referenced by global settings and later skill contributions", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ images: { blockImages: false }, extensions: [projectExtension], skills: [projectSkill] }));
    const session = await spawn();
    session.resourceLoader.extendResources({ skillPaths: [{ path: projectSkill, metadata: {
      source: "fixture", scope: "temporary", origin: "top-level", baseDir: cwd,
    } }] });
    denied(session);
  });

  it("does not treat a named project skill path as an authorized resource", async () => {
    const session = await spawn({ skills: [projectSkill, ".agents/skills/agents-probe"] });
    denied(session);
    expect(session.resourceLoader.getSkills().skills).toEqual([]);
    expect(session.systemPrompt).toContain("path traversal");
  });

  it("preserves trusted same-configuration resources and proves the safe MCP launcher control", async () => {
    const session = await spawn({}, {}, { ...ctx, isProjectTrusted: () => true });
    expect(session.settingsManager.isProjectTrusted()).toBe(true);
    expect(session.settingsManager.getBlockImages()).toBe(true);
    expect(session.resourceLoader.getSkills().skills.map((s) => s.name)).toContain("trust-probe");
    expect(existsSync(factoryMarker)).toBe(true);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0].name).toBe("project-server");
    expect(session.systemPrompt).not.toContain("PROJECT_PROMPT_SECRET");
    expect(session.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("retains parent configuration trust during worktree execution, including MCP config", async () => {
    const worktree = join(root, "worktree");
    project(worktree, "worktree-server");
    const session = await spawn({ skills: ["trust-probe"] }, { cwd: worktree, configCwd: cwd }, { ...ctx, isProjectTrusted: () => true });
    expect(session.sessionManager.getCwd()).toBe(worktree);
    expect(session.settingsManager.isProjectTrusted()).toBe(true);
    expect(session.systemPrompt).toContain("PROJECT_SKILL_SECRET");
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0].name).toBe("project-server");
    expect(launch.mock.calls[0][1]).toBe(cwd);
    // The context a nested tool forwards owns the same config root even though
    // its public cwd remains the execution worktree.
    const nestedCtx = configurationContext({ ...ctx, cwd: worktree, isProjectTrusted: () => session.settingsManager.isProjectTrusted() }, cwd);
    const nested = await spawn({ extensions: false, skills: ["trust-probe"] }, { configCwd: cwd }, nestedCtx);
    expect(nested.sessionManager.getCwd()).toBe(worktree);
    expect(nested.settingsManager.isProjectTrusted()).toBe(true);
    expect(nested.systemPrompt).toContain("PROJECT_SKILL_SECRET");
  });

  it("does not grant a denied parent configuration trust during worktree execution", async () => {
    const worktree = join(root, "worktree");
    project(worktree, "worktree-server");
    denied(await spawn({}, { cwd: worktree, configCwd: cwd }));
  });

  it("accepts a canonical alias of the same trusted configuration root", async () => {
    const alias = join(root, "configuration-alias");
    symlinkSync(cwd, alias);
    const session = await spawn({ extensions: ["mcp"] }, { configCwd: alias }, { ...ctx, isProjectTrusted: () => true });
    expect(session.settingsManager.isProjectTrusted()).toBe(true);
    expect(session.settingsManager.getBlockImages()).toBe(true);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0].name).toBe("project-server");
    expect(launch.mock.calls[0][1]).toBe(alias);
  });

  it("does not transfer trust to a different configuration project or a copied worktree", async () => {
    const worktree = join(root, "worktree");
    const { extension, namedSkill } = project(worktree, "worktree-server");
    const parent = { ...ctx, isProjectTrusted: () => true };
    const session = await spawn({ skills: ["trust-probe"] }, { cwd: worktree }, parent);
    denied(session);
    expect(session.resourceLoader.getExtensions().extensions.map((e) => e.path)).not.toContain(extension);
    expect(session.resourceLoader.getSkills().skills.map((s) => s.filePath)).not.toContain(namedSkill);
    expect(session.systemPrompt).toContain("GLOBAL_SKILL_SAFE");
    const explicitConfig = await spawn({}, { configCwd: worktree }, parent);
    denied(explicitConfig);
  });

  function registeringProbe() {
    writeFileSync(projectExtension, `import { writeFileSync } from "node:fs";
export default function(pi) {
  writeFileSync(${JSON.stringify(factoryMarker)}, "factory");
  pi.registerMcpServer("registered-parent", { type: "stdio", command: ${JSON.stringify(join(cwd, "mcp-server"))}, exposure: "direct" });
}`);
  }

  it.each(["direct", "symlink"])("rejects a denied parent's explicit %s extension after changing both child roots", async (kind) => {
    registeringProbe();
    const worktree = join(root, "worktree");
    project(worktree, "worktree-server");
    let source = projectExtension;
    if (kind === "symlink") {
      source = join(root, "parent-alias.js");
      symlinkSync(projectExtension, source);
    }
    const settings = vi.spyOn(SettingsManager, "create");
    await expect(spawn({ extensions: ["mcp", source] }, { cwd: worktree, configCwd: worktree })).rejects.toThrow("not trusted");
    expect(ctx.isProjectTrusted()).toBe(false);
    expect(settings).toHaveBeenCalledWith(worktree, agentDir, { projectTrusted: false });
    expect(existsSync(factoryMarker)).toBe(false);
    expect(existsSync(launcherMarker)).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["configured", "package", "discovered"])("filters denied parent %s sources and contributed skills after changing roots", async (kind) => {
    registeringProbe();
    const worktree = join(root, "worktree");
    const child = project(worktree, "worktree-server");
    const settings: Record<string, unknown> = { images: { blockImages: false }, skills: [projectSkill] };
    if (kind === "configured") settings.extensions = [projectExtension];
    if (kind === "package") {
      const pkg = join(root, "global-package");
      mkdirSync(pkg);
      symlinkSync(projectExtension, join(pkg, "entry.js"));
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture-parent-alias", pi: { extensions: ["./entry.js"] } }));
      settings.packages = [pkg];
    }
    if (kind === "discovered") {
      mkdirSync(join(agentDir, "extensions"));
      symlinkSync(projectExtension, join(agentDir, "extensions", "parent-alias.js"));
    }
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
    const session = await spawn({}, { cwd: worktree, configCwd: worktree });
    session.resourceLoader.extendResources({ skillPaths: [projectSkill, child.namedSkill].map((path) => ({ path, metadata: {
      source: "fixture", scope: "temporary", origin: "top-level", baseDir: cwd,
    } })) });
    denied(session);
    expect(ctx.isProjectTrusted()).toBe(false);
    expect(session.resourceLoader.getExtensions().extensions.map((e) => e.path)).not.toContain(child.extension);
    expect(session.resourceLoader.getSkills().skills.map((s) => s.filePath)).not.toContain(child.namedSkill);
  });

  it("resolves a configured package alias into a trusted parent without trusting the new child root", async () => {
    registeringProbe();
    const worktree = join(root, "worktree");
    project(worktree, "worktree-server");
    const pkg = join(root, "global-package");
    mkdirSync(pkg);
    symlinkSync(projectExtension, join(pkg, "entry.js"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture-parent-alias", pi: { extensions: ["./entry.js"] } }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
    const session = await spawn({}, { cwd: worktree, configCwd: worktree }, { ...ctx, isProjectTrusted: () => true });
    expect(session.settingsManager.isProjectTrusted()).toBe(false);
    expect(session.settingsManager.getProjectSettings()).toEqual({});
    expect(existsSync(factoryMarker)).toBe(true);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0].name).toBe("registered-parent");
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["named", "discovered"])("rejects denied global agent-directory aliases before creating a %s skill child", async (kind) => {
    const worktree = join(root, "worktree");
    project(worktree, "worktree-server");
    // The skills directory itself is NOT a symlink: only its agent-dir ancestor
    // is aliased, which bypasses the preloader's existing lstat(root) check.
    const alias = join(root, "agent-alias");
    symlinkSync(join(cwd, ".pi"), alias);
    process.env.PI_CODING_AGENT_DIR = alias;
    const create = vi.spyOn(SettingsManager, "create");
    await expect(spawn({ extensions: false, skills: kind === "named" ? ["trust-probe"] : true }, { cwd: worktree, configCwd: worktree }))
      .rejects.toThrow("Project trust denied for global configuration source");
    expect(create).not.toHaveBeenCalled();
    expect(sessions).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("retains genuine global code and named skills after changing denied roots", async () => {
    const worktree = join(root, "worktree");
    project(worktree, "worktree-server");
    const globalMarker = join(root, "global-factory");
    const extension = join(agentDir, "global-probe.js");
    writeFileSync(extension, `import { writeFileSync } from "node:fs";
export default function () { writeFileSync(${JSON.stringify(globalMarker)}, "factory"); }`);
    const session = await spawn({ extensions: ["mcp", extension], skills: ["trust-probe"] }, { cwd: worktree, configCwd: worktree });
    denied(session);
    expect(existsSync(globalMarker)).toBe(true);
    expect(session.systemPrompt).toContain("GLOBAL_SKILL_SAFE");
  });

  it("proves the registering probe reaches only the intercepted transport when its parent is trusted", async () => {
    registeringProbe();
    const session = await spawn({ extensions: ["mcp", projectExtension] }, {}, { ...ctx, isProjectTrusted: () => true });
    expect(session.settingsManager.isProjectTrusted()).toBe(true);
    expect(existsSync(factoryMarker)).toBe(true);
    expect(launch.mock.calls.some(([entry]) => entry.name === "registered-parent")).toBe(true);
    expect(existsSync(launcherMarker)).toBe(true);
  });

  it("captures parent trust before async environment detection can change it", async () => {
    let trusted = false;
    const settings = vi.spyOn(SettingsManager, "create");
    const session = await spawn({}, {
      pi: { exec: async () => { trusted = true; return { code: 1, stdout: "", stderr: "" }; } } as unknown as ExtensionAPI,
    }, { ...ctx, isProjectTrusted: () => trusted });
    denied(session);
    expect(trusted).toBe(true);
    expect(settings).toHaveBeenCalledWith(cwd, agentDir, { projectTrusted: false });
  });

  it("keeps isolated children resource-free even when their configuration is trusted", async () => {
    const session = await spawn({ extensions: [projectExtension], skills: ["trust-probe"] }, { isolated: true }, { ...ctx, isProjectTrusted: () => true });
    expect(session.resourceLoader.getSkills().skills).toEqual([]);
    expect(session.resourceLoader.getExtensions().extensions.map((e) => e.path)).toEqual(["<inline:pi-subagents-tool-policy>"]);
    expect(session.systemPrompt).not.toContain("PROJECT_SKILL_SECRET");
    expect(existsSync(factoryMarker)).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
});
