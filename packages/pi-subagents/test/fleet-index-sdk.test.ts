import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI } from "@earendil-works/pi-tui";
import { replyChannel, WORKFLOW_UI_CHANNELS } from "@signalridge/pi-subagents-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import subagentsExtension from "../src/index.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class Bus {
  listeners = new Map<string, Set<(data: unknown) => void>>();
  on(event: string, handler: (data: unknown) => void) {
    const set = this.listeners.get(event) ?? new Set(); set.add(handler); this.listeners.set(event, set);
    return () => { set.delete(handler); if (!set.size) this.listeners.delete(event); };
  }
  emit(event: string, data: unknown) { for (const handler of [...this.listeners.get(event) ?? []]) handler(data); }
}
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
type Result = { content: Array<{ text: string }>; details?: { status: string; agentId?: string } };
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: ((result: unknown) => void) | undefined, ctx: ExtensionCommandContext) => Promise<Result> };

/** Real index, manager, native child session/input rejection/provider and transcript. */
describe("Fleet index controls with the native Pi SDK", () => {
  let root: string;
  let previousAgentDir: string | undefined;
  let ctx: ExtensionCommandContext;
  let bus: Bus;
  let tools: Map<string, Tool>;
  let lifecycle: Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>;
  let provider: ReturnType<typeof fauxProvider>;
  let release: ReturnType<typeof deferred<void>>;
  let viewer: (Component & { dispose?(): void }) | undefined;
  let close: (() => void) | undefined;
  let input: ((key: string) => { consume?: boolean } | undefined) | undefined;
  let notify: ReturnType<typeof vi.fn>;
  let tui: TUI;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "fleet-index-sdk-")); const cwd = join(root, "project"); const agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true }); mkdirSync(agentDir);
    previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
    const entry = join(root, "commands.ts");
    writeFileSync(entry, 'export default function(pi) { pi.registerCommand("fixture-command", { description: "fixture", handler: async () => {} }); }');
    writeFileSync(join(cwd, ".pi", "agents", "UiTest.md"), `---\ndescription: UI test\ntools: none\nextensions: ${entry}\nskills: false\npersist_session: false\n---\nAnswer the task.`);
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async", maxConcurrent: 1 }));
    provider = fauxProvider({ provider: "fleet-index-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(provider.provider); await runtime.refresh({ allowNetwork: false });
    release = deferred();
    provider.setResponses([async () => { await release.promise; return fauxAssistantMessage("DONE"); }, async () => { await release.promise; return fauxAssistantMessage("SECOND"); }]);
    bus = new Bus(); tools = new Map(); lifecycle = new Map(); notify = vi.fn();
    let widget: Component | undefined;
    let focus: unknown = { getText: () => "", setText: () => {} };
    tui = { terminal: { rows: 40, columns: 120 }, requestRender: vi.fn(), getFocusedComponent: () => focus, mode: "fullscreen" } as unknown as TUI;
    const ui = {
      notify, setStatus: vi.fn(), getEditorText: () => "",
      setWidget: (_: string, factory: ((host: TUI, theme: typeof theme) => Component) | undefined) => { widget = factory?.(tui, theme); },
      onTerminalInput: (handler: typeof input) => { input = handler; return () => { input = undefined; }; },
      custom: (factory: (host: TUI, theme: typeof theme, keys: undefined, done: (result: undefined) => void) => Component) => new Promise<undefined>(resolve => {
        close = () => { viewer?.dispose?.(); resolve(undefined); close = undefined; focus = { getText: () => "", setText: () => {} }; };
        viewer = factory(tui, theme, undefined, close); focus = viewer;
      }),
    };
    ctx = { cwd, ui, mode: "tui", hasUI: true, isProjectTrusted: () => true, model: runtime.getModel("fleet-index-faux", "physical"),
      modelRegistry: new ModelRegistry(runtime), sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent",
    } as unknown as ExtensionCommandContext;
    const pi = { events: bus, on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => lifecycle.set(name, handler),
      registerTool: (tool: Tool) => tools.set(tool.name, tool), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn(),
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    };
    subagentsExtension(pi as never); await lifecycle.get("session_start")?.({}, ctx);
    void widget;
  });

  afterEach(async () => {
    release.resolve(); close?.(); await lifecycle.get("session_shutdown")?.({}, ctx);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); viewer = undefined;
  });

  it("retains the exact composer draft when native steering rejects an extension command", async () => {
    const spawn = vi.spyOn(AgentManager.prototype, "spawnManaged");
    const owner = { extension: "pi-workflows", runId: "run", nodeId: "call-1", attemptId: "attempt-1" };
    let id = "";
    bus.on("subagents:rpc:spawn-managed:reply:spawn", raw => { id = (raw as { data: { id: string } }).data.id; });
    bus.emit("subagents:rpc:spawn-managed", { requestId: "spawn", spawnKey: "spawn", type: "UiTest", prompt: "work", description: "native", owner });
    await vi.waitFor(() => expect(provider.state.callCount).toBe(1));
    const manager = spawn.mock.contexts[0]; const record = manager.getRecordMutable(id)!; const session = record.session!;
    let accepted = false;
    bus.on(replyChannel(WORKFLOW_UI_CHANNELS.openConversation, "open"), raw => { accepted = (raw as { success: boolean }).success; expect(viewer).toBeUndefined(); });
    bus.emit(WORKFLOW_UI_CHANNELS.openConversation, { requestId: "open", agentId: id, owner });
    expect(accepted).toBe(true); await vi.waitFor(() => expect(viewer).toBeDefined());
    viewer!.render(120); viewer!.handleInput!("\r"); for (const char of "/fixture-command") viewer!.handleInput!(char); viewer!.handleInput!("\r");
    await vi.waitFor(() => expect(viewer!.render(120).join("\n")).toContain("draft retained"));
    expect(viewer!.render(120).join("\n")).toContain("/fixture-command"); expect(session.getSteeringMessages()).toEqual([]);
    expect(record.status).toBe("running"); expect(record.owner).toEqual(owner);
    close?.(); release.resolve(); await record.promise;
  });

  it("refuses arbitrary Ctrl+B targets with multiple native foreground calls and hands off only the explicitly viewed record", async () => {
    const spawns = vi.spyOn(AgentManager.prototype, "spawnAndWait");
    const firstWait = tools.get("Agent")!.execute("first", { prompt: "first", description: "first", subagent_type: "UiTest" }, undefined, undefined, ctx);
    const secondWait = tools.get("Agent")!.execute("second", { prompt: "second", description: "second", subagent_type: "UiTest" }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(provider.state.callCount).toBe(2));
    const manager = spawns.mock.contexts[0]; const records = manager.listAgentsMutable().sort((a, b) => a.startedAt - b.startedAt);
    expect(records).toHaveLength(2); expect(input!("\x02")).toEqual({ consume: true });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Multiple foreground"), "info"); expect(records.every(record => !record.isBackground)).toBe(true);
    input!("\x1b[B"); input!("\x1b[B"); input!("\x1b[B"); input!("\r"); await vi.waitFor(() => expect(viewer).toBeDefined());
    expect(viewer!.render(120).join("\n")).toContain("second"); viewer!.handleInput!("b"); viewer!.handleInput!("b");
    expect(records[1].isBackground).toBe(false); // A legacy held arm key is not confirmation.
    viewer!.handleInput!("y");
    const handedOff = await secondWait; expect(handedOff.content[0].text).toContain("continues in background"); expect(handedOff.details?.agentId).toBe(records[1].id);
    expect(records[1].isBackground).toBe(true); expect(records[0].isBackground).toBe(false);
    close?.(); await new Promise(resolve => setImmediate(resolve)); input!("\x1b");
    // The one background slot is occupied. The remaining foreground stays live.
    expect(input!("\x02")).toEqual({ consume: true }); expect(notify).toHaveBeenCalledWith(expect.stringContaining("Background pool is full"), "warning");
    expect(records[0].session!.isStreaming).toBe(true);
    const path = records[1].outputFile!; const prefix = readFileSync(path, "utf-8");
    release.resolve(); await firstWait; await records[1].promise;
    expect(readFileSync(path, "utf-8").startsWith(prefix)).toBe(true); expect(readFileSync(path, "utf-8")).toContain("SECOND");
    expect(records[1].resultConsumed).toBe(false); expect(provider.state.callCount).toBe(2);
  });
});
