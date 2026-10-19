import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";
import type { AgentConfig } from "../src/types.js";
import * as worktrees from "../src/worktree.js";

vi.setConfig({ testTimeout: 30_000 });

// Real SDK resource discovery, factories, registry, model turns and manager.
// Only Git worktree operations are replaced with temporary directory lifecycle
// seams: this test must not create branches, commits or actual Git worktrees.
describe("child background ownership (real Pi SDK)", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let root: string;
  let cwd: string;
  let agentDir: string;
  let ctx: ExtensionContext;
  let runtime: ModelRuntime;
  let faux: ReturnType<typeof fauxProvider>;
  let providerCall: ReturnType<typeof vi.fn>;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
  const sessions: AgentSession[] = [];
  let manager: AgentManager | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "subagents-background-sdk-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    setAgentTiersSettings({});
    faux = fauxProvider({ provider: "background-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
    runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel("background-faux", "physical");
    if (!model) throw new Error("Fixture model missing");
    ctx = {
      cwd, isProjectTrusted: () => true, model, modelRegistry: new ModelRegistry(runtime),
      sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent",
      hasUI: false, mode: "print",
    } as unknown as ExtensionContext;
    providerCall = vi.fn(() => fauxAssistantMessage(fauxText("DONE")));
    faux.setResponses([providerCall, providerCall, providerCall]);
    register({ extensions: true });
  });

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    for (const session of sessions.splice(0)) await shutdownAndDisposeSession(session);
    faux.setResponses([]);
    registerAgents(new Map());
    setAgentTiersSettings({});
    vi.restoreAllMocks();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  function register(config: Partial<AgentConfig>) {
    registerAgents(new Map([["OwnershipTest", {
      name: "OwnershipTest", description: "Ownership test", builtinToolNames: ["read"],
      skills: false, systemPrompt: "child", promptMode: "replace", inheritContext: false, ...config,
    } satisfies AgentConfig]]));
  }

  function background(entry: string) {
    mkdirSync(dirname(entry), { recursive: true });
    // Model a restored async job: its process finishes only when the test opens
    // the gate AFTER prompt completion. If this factory loads, tool filtering
    // alone cannot stop its exit handler from waking the retained session.
    const processCode = `const fs = require("node:fs"); setInterval(() => { if (fs.existsSync(${JSON.stringify(join(root, "exit-gate"))})) process.exit(0); }, 20);`;
    writeFileSync(entry, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
export default function(pi) {
  writeFileSync(${JSON.stringify(join(root, "factory-ran"))}, "yes");
  for (const name of ["job", "wake"]) pi.registerTool({
    name, label: name, description: name, parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "queued" }], details: {} }),
  });
  let child;
  let closed = false;
  pi.on("session_start", () => {
    child = spawn(process.execPath, ["-e", ${JSON.stringify(processCode)}], { stdio: "ignore" });
    child.on("exit", () => {
      if (closed) return;
      writeFileSync(${JSON.stringify(join(root, "wake-ran"))}, "yes");
      pi.sendUserMessage("Delayed job finished", { deliverAs: "followUp" });
    });
  });
  pi.on("session_shutdown", () => { closed = true; child?.kill(); });
}`);
    return entry;
  }

  function packageFixture(kind: "exact" | "glob" | "conventional" | "symlink" = "exact", configured = true) {
    const directory = join(root, "generic-package-folder");
    const entry = background(join(directory, kind === "exact" || kind === "symlink" ? "src/index.ts" : "extensions/jobs.ts"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: "@fixture/pi-background",
      ...(kind === "conventional" ? {} : { pi: { extensions: [kind === "glob" ? "./extensions/*.ts" : "./src/index.ts"] } }),
    }));
    const source = kind === "symlink" ? join(root, "package-alias") : directory;
    if (kind === "symlink") symlinkSync(directory, source, "dir");
    if (configured) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [source] }));
    return { source, entry };
  }

  function ordinaryPackage(kind: "glob" | "conventional", configured: boolean) {
    const directory = join(root, "ordinary-package-folder");
    const entry = join(directory, "extensions", "jobs.ts");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, `export default function(pi) {
  pi.on("session_start", () => {
    for (const name of ["job", "wake"]) pi.registerTool({
      name, label: name, description: name, parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
    });
  });
}`);
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: "@fixture/ordinary",
      ...(kind === "conventional" ? {} : { pi: { extensions: ["./extensions/*.ts"] } }),
    }));
    if (configured) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [directory] }));
    return { directory, entry };
  }

  function configuredAlias(kind: "glob" | "conventional") {
    const target = packageFixture(kind, false);
    const ordinary = ordinaryPackage("glob", true);
    const alias = join(dirname(ordinary.entry), "visible.ts");
    symlinkSync(target.entry, alias, "file");
    writeFileSync(join(ordinary.directory, "package.json"), JSON.stringify({
      name: "@fixture/ordinary", pi: { extensions: ["./extensions/visible.ts"] },
    }));
    return { ...target, alias };
  }

  async function run(config: Partial<AgentConfig> = { extensions: true }) {
    register(config);
    const warnings: string[] = [];
    const result = await runAgent(ctx, "OwnershipTest", "answer", {
      pi, onToolActivity: (activity) => warnings.push(activity.toolName),
      onSessionCreated: (session) => sessions.push(session),
    });
    return { ...result, warnings };
  }

  function assertFiltered(session: AgentSession) {
    const paths = session.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
    expect(paths).toContain("builtin:mcp");
    expect(session.getAllTools().map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["job", "wake"]));
    for (const name of ["job", "wake"]) {
      expect(session.getAllTools().map((tool) => tool.name)).not.toContain(name);
      expect(session.getActiveToolNames()).not.toContain(name);
    }
    expect(existsSync(join(root, "factory-ran"))).toBe(false);
  }

  it.each(["exact", "glob", "conventional", "symlink"] as const)("filters a discovered %s package before its factory executes", async (kind) => {
    packageFixture(kind);
    const other = join(cwd, ".pi", "extensions", "ordinary.ts");
    writeFileSync(other, `export default function(pi) { pi.registerTool({ name: "ordinary", label: "ordinary", description: "ordinary", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) }); }`);
    const { session, responseText, warnings } = await run();
    expect(responseText).toBe("DONE");
    assertFiltered(session);
    expect(session.getActiveToolNames()).toContain("ordinary");
    expect(session.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toContain(other);
    expect(warnings).toContainEqual(expect.stringMatching(/extension-error:pi-background.*asynchronous model wakes.*excluded/));
    writeFileSync(join(root, "exit-gate"), "exit");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(providerCall).toHaveBeenCalledOnce();
    expect(existsSync(join(root, "wake-ran"))).toBe(false);
  });

  it("preserves default inheritance when an unrelated ordinary factory fails", async () => {
    packageFixture();
    const other = join(cwd, ".pi", "extensions", "ordinary.ts");
    writeFileSync(other, "export default function() { throw new Error('ordinary fixture failure'); }");
    const { session, responseText } = await run();
    expect(responseText).toBe("DONE");
    assertFiltered(session);
    expect(session.resourceLoader.getExtensions().errors).toContainEqual(expect.objectContaining({
      path: other, error: expect.stringContaining("ordinary fixture failure"),
    }));
    expect(providerCall).toHaveBeenCalledOnce();
  });

  it("filters a standalone pi-background resource and names intentional tool selectors in warnings", async () => {
    background(join(cwd, ".pi", "extensions", "pi-background.ts"));
    const { session, warnings } = await run({ extensions: ["*"], extSelectors: ["ext:pi-background/job"] });
    assertFiltered(session);
    expect(warnings).toContainEqual(expect.stringContaining("pi-background cannot load"));
    expect(warnings).toContainEqual(expect.stringContaining("ext:pi-background referenced"));
  });

  it.each(["name", "alias", "package-path", "entry-path", "wildcard-plus-name"] as const)("refuses intentional %s selection by name before loading", async (selection) => {
    const { source, entry } = packageFixture();
    const extensions = selection === "name" ? ["PI-BACKGROUND"] : selection === "alias" ? ["src"] :
      selection === "package-path" ? [source] : selection === "entry-path" ? [entry] : ["*", "pi-background"];
    await expect(run({ extensions })).rejects.toThrow(/pi-background cannot load.*asynchronous model wakes.*requested extension/);
    expect(existsSync(join(root, "factory-ran"))).toBe(false);
    expect(providerCall).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it.each(["direct", "symlink", "directory"] as const)("refuses a directory-backed module's %s source before evaluation", async (kind) => {
    const directory = join(root, "module-package");
    const entry = background(join(directory, "index.js"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@fixture/pi-background", main: "index.js" }));
    const alias = join(root, "generic-module.js");
    symlinkSync(entry, alias, "file");
    await expect(run({ extensions: [kind === "direct" ? entry : kind === "symlink" ? alias : directory] })).rejects.toThrow("pi-background cannot load");
    expect(existsSync(join(root, "factory-ran"))).toBe(false);
    expect(providerCall).not.toHaveBeenCalled();
    const sibling = join(directory, "sibling.js");
    writeFileSync(sibling, "export default function() {}");
    expect((await run({ extensions: [sibling] })).warnings).toEqual([]);
  });

  it("loads an ordinary directory-backed module through host semantics", async () => {
    const directory = join(root, "module-package");
    mkdirSync(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@fixture/ordinary", main: "index.js" }));
    writeFileSync(join(directory, "index.js"), "export default function() {}");
    expect((await run({ extensions: [directory] })).warnings).toEqual([]);
  });

  it.each([false, true])("keeps A's unrelated entry when B's canonical direct entry is explicit (reverse=%s)", async (reverse) => {
    const b = ordinaryPackage("glob", false);
    const a = join(root, "package-a");
    mkdirSync(a);
    const alias = join(a, "alias.ts");
    const extra = join(a, "extra.ts");
    symlinkSync(b.entry, alias, "file");
    writeFileSync(extra, "export default function() {}");
    writeFileSync(join(a, "package.json"), JSON.stringify({ name: "@fixture/package-a", pi: { extensions: ["./alias.ts", "./extra.ts"] } }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: reverse ? [b.directory, a] : [a, b.directory] }));
    for (const extensions of [["*", b.entry], [b.entry, "*"], ["package-a", b.entry]]) {
      const { session, warnings } = await run({ extensions });
      const paths = session.resourceLoader.getExtensions().extensions.map(extension => extension.path);
      expect(paths).toContain(extra);
      expect(paths.filter(path => !path.startsWith("builtin:") && !path.startsWith("<") && realpathSync(path) === realpathSync(b.entry))).toHaveLength(1);
      expect(warnings).toEqual([]);
    }
  });

  it.each(["file", "package"] as const)("validates deduplicated %s source aliases in both orders with one factory", async (kind) => {
    const fixture = ordinaryPackage("glob", false);
    const alias = join(root, kind === "file" ? "file-alias.ts" : "package-alias");
    const real = kind === "file" ? fixture.entry : fixture.directory;
    symlinkSync(real, alias, kind === "file" ? "file" : "dir");
    writeFileSync(fixture.entry, `import { appendFileSync } from "node:fs"; export default function() { appendFileSync(${JSON.stringify(join(root, "ordinary-factories"))}, "x"); }`);
    for (const sources of [[real, alias], [alias, real]]) {
      const { session, warnings } = await run({ extensions: ["*", ...sources] });
      expect(session.resourceLoader.getExtensions().extensions.filter(extension => !extension.path.startsWith("builtin:") && !extension.path.startsWith("<"))).toHaveLength(1);
      expect(warnings).toEqual([]);
    }
    expect(readFileSync(join(root, "ordinary-factories"), "utf-8")).toBe("xx");
    await expect(run({ extensions: ["*", real, join(root, "missing.ts")] })).rejects.toThrow("was not found");
  });

  it("releases a real SDK-owned watcher before disposal and emits teardown once", async () => {
    const entry = join(root, "watcher.ts");
    const marker = join(root, "watcher-lifecycle");
    writeFileSync(join(root, "watched"), "watch");
    writeFileSync(entry, `import { watch, appendFileSync } from "node:fs";
      export default function(pi) {
        let watcher;
        pi.on("session_start", () => { watcher = watch(${JSON.stringify(join(root, "watched"))}, () => {}); appendFileSync(${JSON.stringify(marker)}, "start\\n"); });
        pi.on("session_shutdown", () => { watcher.close(); appendFileSync(${JSON.stringify(marker)}, "released\\n"); });
      }`);
    const { session } = await run({ extensions: [entry] });
    const dispose = session.dispose.bind(session);
    vi.spyOn(session, "dispose").mockImplementation(() => { appendFileSync(marker, "dispose\n"); dispose(); });
    await Promise.all([shutdownAndDisposeSession(session), shutdownAndDisposeSession(session)]);
    expect(readFileSync(marker, "utf-8")).toBe("start\nreleased\ndispose\n");
  });

  it("releases an actual watcher on an aborted setup before session handoff", async () => {
    const entry = join(root, "setup-watcher.ts");
    const marker = join(root, "setup-lifecycle");
    const gate = join(root, "setup-gate");
    writeFileSync(join(root, "watched"), "watch");
    writeFileSync(entry, `import { watch, appendFileSync, existsSync } from "node:fs";
      export default function(pi) {
        let watcher;
        pi.on("session_start", async () => {
          watcher = watch(${JSON.stringify(join(root, "watched"))}, () => {});
          appendFileSync(${JSON.stringify(marker)}, "start\\n");
          while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 5));
        });
        pi.on("session_shutdown", () => { watcher.close(); appendFileSync(${JSON.stringify(marker)}, "released\\n"); });
      }`);
    register({ extensions: [entry] });
    const controller = new AbortController();
    const pending = runAgent(ctx, "OwnershipTest", "answer", { pi, signal: controller.signal });
    // Attach rejection observation before opening the async SDK setup barrier.
    const outcome = pending.then(async result => { await shutdownAndDisposeSession(result.session); return undefined; }, error => error);
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      controller.abort(new Error("setup stopped"));
    } finally { writeFileSync(gate, "open"); }
    expect(await outcome).toMatchObject({ message: "setup stopped" });
    expect(readFileSync(marker, "utf-8")).toBe("start\nreleased\n");
    expect(providerCall).not.toHaveBeenCalled();
  });

  it("merges configured glob ownership with explicit selection of the same entry", async () => {
    const { entry } = packageFixture("glob");
    await expect(run({ extensions: [entry] })).rejects.toThrow(/pi-background cannot load.*requested extension/);
    expect(existsSync(join(root, "factory-ran"))).toBe(false);
    expect(providerCall).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it.each(["glob", "conventional"] as const)("recognizes an unconfigured direct %s entry", async (kind) => {
    const { entry } = packageFixture(kind, false);
    await expect(run({ extensions: [entry] })).rejects.toThrow(/pi-background cannot load.*requested extension/);
    expect(existsSync(join(root, "factory-ran"))).toBe(false);
    expect(providerCall).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it.each(["exact", "glob", "conventional"] as const)("recognizes a generic file symlink to an unconfigured %s entry", async (kind) => {
    const { entry } = packageFixture(kind, false);
    const alias = join(root, "ordinary-alias.ts");
    symlinkSync(entry, alias, "file");
    await expect(run({ extensions: [alias] })).rejects.toThrow(/pi-background cannot load.*requested extension/);
    expect(existsSync(join(root, "factory-ran"))).toBe(false);
    expect(providerCall).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it("merges configured ownership across file aliases and lets exclusions win", async () => {
    const { entry } = packageFixture("glob");
    const alias = join(root, "ordinary-alias.ts");
    symlinkSync(entry, alias, "file");
    await expect(run({ extensions: [alias] })).rejects.toThrow("pi-background cannot load");
    const { session, warnings } = await run({ extensions: ["*", alias], excludeExtensions: ["pi-background"] });
    assertFiltered(session);
    expect(warnings).not.toContainEqual(expect.stringContaining("did not match any discovered extension"));
    expect(warnings).not.toContainEqual(expect.stringContaining("pi-background cannot load"));
  });

  it.each(["glob", "conventional"] as const)("does not let a configured ordinary file alias conceal a %s background owner", async (kind) => {
    configuredAlias(kind);
    const { session, warnings } = await run();
    assertFiltered(session);
    expect(warnings).toContainEqual(expect.stringContaining("pi-background cannot load"));
    expect(providerCall).toHaveBeenCalledOnce();
  });

  it("retains canonical ownership even when probe resources are disabled", async () => {
    const { source } = configuredAlias("glob");
    const target = realpathSync(source);
    const resolveSources = DefaultPackageManager.prototype.resolveExtensionSources;
    vi.spyOn(DefaultPackageManager.prototype, "resolveExtensionSources").mockImplementation(
      async function(this: DefaultPackageManager, sources, options) {
        const resolved = await resolveSources.call(this, sources, options);
        return sources.length === 1 && sources[0] === target
          ? { ...resolved, extensions: resolved.extensions.map(resource => ({ ...resource, enabled: false })) }
          : resolved;
      },
    );
    const { session, warnings } = await run();
    assertFiltered(session);
    expect(warnings).toContainEqual(expect.stringContaining("pi-background cannot load"));
  });

  it("finds a declaring ancestor beyond a nearer non-owning package manifest", async () => {
    const { source } = packageFixture("glob", false);
    const entry = background(join(source, "extensions", "nested", "jobs.ts"));
    writeFileSync(join(dirname(entry), "package.json"), JSON.stringify({
      name: "@fixture/inner", private: true, type: "module",
    }));
    writeFileSync(join(source, "package.json"), JSON.stringify({
      name: "@fixture/pi-background", pi: { extensions: ["./extensions/**/*.ts"] },
    }));
    await expect(run({ extensions: [entry] })).rejects.toThrow("pi-background cannot load");
    expect(existsSync(join(root, "factory-ran"))).toBe(false);
    expect(providerCall).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it("does not attribute an undeclared sibling to its enclosing package", async () => {
    const { source } = packageFixture("exact", false);
    const entry = join(source, "ordinary.ts");
    writeFileSync(entry, "export default function() {}");
    const { session, warnings } = await run({ extensions: [entry] });
    expect(session.resourceLoader.getExtensions().extensions.map(extension => extension.path)).toContain(entry);
    expect(warnings).toEqual([]);
    expect(existsSync(join(root, "factory-ran"))).toBe(false);
  });

  it.each(["glob", "conventional"] as const)("retains %s package names for named selection and live tool narrowing", async (kind) => {
    const { entry } = ordinaryPackage(kind, true);
    const { session, warnings } = await run({ extensions: ["ordinary"], extSelectors: ["ext:ordinary/job"] });
    expect(session.resourceLoader.getExtensions().extensions.map(extension => extension.path)).toContain(entry);
    expect(session.getAllTools().map(tool => tool.name)).toEqual(expect.arrayContaining(["job", "wake"]));
    expect(session.getActiveToolNames()).toContain("job");
    expect(session.getActiveToolNames()).not.toContain("wake");
    expect(warnings).toEqual([]);
  });

  it.each(["glob", "conventional"] as const)("retains unconfigured %s ownership and source aliases for direct file selection", async (kind) => {
    const { entry } = ordinaryPackage(kind, false);
    const alias = join(root, "ordinary-alias.ts");
    symlinkSync(entry, alias, "file");
    const { session, warnings } = await run({ extensions: [alias], extSelectors: ["ext:ordinary/job"] });
    expect(session.getActiveToolNames()).toContain("job");
    expect(session.getActiveToolNames()).not.toContain("wake");
    expect(warnings).toEqual([]);
    const byAlias = await run({ extensions: [alias], extSelectors: ["ext:ordinary-alias/job"] });
    expect(byAlias.session.getActiveToolNames()).toContain("job");
    expect(byAlias.session.getActiveToolNames()).not.toContain("wake");
    expect(byAlias.warnings).toEqual([]);
  });

  it("probes an unconfigured candidate package once for multiple direct entries", async () => {
    const { directory, entry } = ordinaryPackage("glob", false);
    const second = join(directory, "extensions", "extra.ts");
    writeFileSync(second, "export default function() {}");
    const resolver = vi.spyOn(DefaultPackageManager.prototype, "resolveExtensionSources");
    const { session, warnings } = await run({ extensions: [entry, second], extSelectors: ["ext:ordinary/job"] });
    expect(resolver.mock.calls.filter(([sources]) => sources.length === 1 && sources[0] === realpathSync(directory))).toHaveLength(1);
    expect(session.getActiveToolNames()).toContain("job");
    expect(session.getActiveToolNames()).not.toContain("wake");
    expect(warnings).toEqual([]);
  });

  it("keeps explicit ordinary selectors and user exclusions authoritative", async () => {
    packageFixture("glob");
    const other = join(cwd, ".pi", "extensions", "ordinary.ts");
    writeFileSync(other, "export default function() {}");
    const { session, warnings } = await run({ extensions: ["*", other], excludeExtensions: ["pi-background"] });
    assertFiltered(session);
    expect(session.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toContain(other);
    expect(warnings).toEqual([]);
  });

  it("cannot wake a terminal managed child after cleanup and pool-slot release", async () => {
    packageFixture();
    const workPath = join(root, "execution-worktree");
    vi.spyOn(worktrees, "createWorktree").mockImplementation(() => {
      mkdirSync(workPath);
      return { path: workPath, workPath, repoRoot: cwd, branch: "fixture-only", baseSha: "fixture-only" };
    });
    const cleanup = vi.spyOn(worktrees, "cleanupWorktree").mockImplementation((_cwd, info) => {
      rmSync(info.path, { recursive: true, force: true });
      return { hasChanges: false, cleanupSucceeded: true };
    });
    vi.spyOn(worktrees, "pruneWorktrees").mockImplementation(() => {});
    vi.spyOn(worktrees, "pruneWorktreesAsync").mockResolvedValue();
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
    const warnings: string[] = [];
    const spawned = manager.spawnManaged(pi, ctx, {
      requestId: "request", spawnKey: "run/node/attempt", type: "OwnershipTest", prompt: "answer", description: "answer",
      owner: { extension: "pi-workflows", runId: "run", nodeId: "node", attemptId: "attempt" },
    }, { isolation: "worktree" }, { onToolActivity: (activity) => warnings.push(activity.toolName) });
    const record = manager.getRecordMutable(spawned.id);
    await record?.promise;
    expect(manager.getManagedSpawn("run/node/attempt")?.state).toBe("completed");
    expect(record?.session).toBeDefined();
    assertFiltered(record!.session!);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(existsSync(workPath)).toBe(false);
    expect(manager.hasRunning()).toBe(false);
    expect(warnings).toContainEqual(expect.stringContaining("pi-background cannot load"));
    writeFileSync(join(root, "exit-gate"), "exit");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(providerCall).toHaveBeenCalledOnce();
    expect(existsSync(join(root, "wake-ran"))).toBe(false);
    expect(record?.session?.isStreaming).toBe(false);
    expect(record?.session?.messages.filter(message => message.role === "assistant")).toHaveLength(1);
    // A second background record starts immediately: the first released its slot.
    const second = manager.spawn(pi, ctx, "OwnershipTest", "again", { description: "again", isBackground: true });
    expect(manager.getRecord(second)?.status).toBe("running");
    await manager.getRecordMutable(second)?.promise;
    expect(providerCall).toHaveBeenCalledTimes(2);
  });

  it("control: the same discovered fixture really wakes an ordinary parent after prompt completion", async () => {
    packageFixture();
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }), noSkills: true });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, modelRuntime: runtime, model: ctx.model, sessionManager: SessionManager.inMemory(cwd),
    });
    sessions.push(session);
    await session.bindExtensions({});
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["job", "wake"]));
    await session.prompt("answer");
    expect(providerCall).toHaveBeenCalledOnce();
    writeFileSync(join(root, "exit-gate"), "exit");
    await vi.waitFor(() => expect(providerCall).toHaveBeenCalledTimes(2));
    await session.waitForIdle();
    expect(existsSync(join(root, "wake-ran"))).toBe(true);
  });
});
