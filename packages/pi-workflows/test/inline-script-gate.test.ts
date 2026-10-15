/**
 * The model-callable `workflow` tool must refuse every call (inline `script`,
 * saved `name`, `resumeFromRunId`, or any combination) before any saved-file
 * read, engine call, `vm.Script`, or helper spawn: `node:vm` is not a sandbox
 * and a file in the agent directory is not trusted, because the model can write
 * it (smarty-dev#11769). The user-typed saved `/name` command still runs.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ManagedRoutingPolicy,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  routingPolicyFingerprint,
} from "@signalridge/pi-subagents-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import piWorkflows, { INLINE_WORKFLOW_DISABLED_MESSAGE, WORKFLOW_TOOL_DISABLED_MESSAGE } from "../src/index.js";
import { loadSavedWorkflow } from "../src/saved-workflows.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("../src/saved-workflows.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/saved-workflows.js")>();
  return { ...actual, loadSavedWorkflow: vi.fn(actual.loadSavedWorkflow) };
});

type ToolResult = { content: Array<{ type: string; text: string }>; details: { status?: string } };
type WorkflowTool = {
  name: string;
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<ToolResult>;
};

function createFixture(cwd: string) {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    on(event: string, handler: (data: unknown) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    emit(event: string, data: unknown) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
  events.on("subagents:rpc:context", (raw) => {
    const { requestId } = raw as { requestId: string };
    events.emit(`subagents:rpc:context:reply:${requestId}`, {
      success: true,
      data: { child: false, capability: "childContext" },
    });
  });
  events.on("subagents:rpc:ping", (raw) => {
    const { requestId } = raw as { requestId: string };
    const policy: ManagedRoutingPolicy = {
      defaultTier: "medium",
      profiles: { medium: { model: "inherit", thinking: "medium" } },
      blockedProfiles: [],
      blockedDefaultTier: false,
    };
    events.emit(`subagents:rpc:ping:reply:${requestId}`, {
      success: true,
      data: {
        version: PROTOCOL_VERSION,
        capabilities: PROTOCOL_CAPABILITIES,
        routingPolicy: { policy, fingerprint: routingPolicyFingerprint(policy) },
      },
    });
  });
  const lifecycle = new Map<string, (...args: never[]) => unknown>();
  const tools: WorkflowTool[] = [];
  const entries: unknown[] = [];
  const pi = {
    events,
    registerMessageRenderer: vi.fn(),
    appendEntry: (_type: string, data: unknown) => entries.push(data),
    registerTool: (tool: WorkflowTool) => tools.push(tool),
    registerCommand: vi.fn(),
    getCommands: () => [],
    on: (event: string, handler: (...args: never[]) => unknown) => {
      lifecycle.set(event, handler);
      return () => lifecycle.delete(event);
    },
  };
  const ctx = {
    cwd,
    hasUI: false,
    mode: "print",
    ui: { setWidget: vi.fn(), notify: vi.fn(), confirm: vi.fn(), input: vi.fn(), select: vi.fn() },
    sessionManager: {
      getLeafId: () => null,
      getBranch: () =>
        entries.map((data, index) => ({
          id: `entry-${index + 1}`,
          type: "custom",
          customType: "pi-workflows:journal",
          data,
        })),
    },
  };
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`${name} tool not registered`);
    return found;
  };
  const workflow = () => tool("workflow");
  return { pi, ctx, lifecycle, workflow, tool };
}

const SCRIPT = 'export const meta = { name: "inline", description: "test" }; return 1;';

describe("workflow tool inline script gate", () => {
  let root: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "workflows-inline-gate-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the exported inline message as the same gate message, naming smarty-dev#11769", () => {
    expect(INLINE_WORKFLOW_DISABLED_MESSAGE).toBe(WORKFLOW_TOOL_DISABLED_MESSAGE);
    expect(WORKFLOW_TOOL_DISABLED_MESSAGE).toContain("smarty-dev#11769");
  });

  it.each([
    ["script only", { script: SCRIPT, background: false }],
    ["script with a saved name", { script: SCRIPT, name: "trusted", background: false }],
    ["script with a built-in name", { script: SCRIPT, name: "code-review", background: false }],
    ["script with resumeFromRunId", { script: SCRIPT, resumeFromRunId: "run-1", background: false }],
    ["script, name and resumeFromRunId", { script: SCRIPT, name: "trusted", resumeFromRunId: "run-1" }],
    ["empty script", { script: "", background: false }],
    ["a saved name", { name: "trusted", background: false }],
    ["a saved name in the background", { name: "trusted" }],
    ["a saved name with resumeFromRunId", { name: "trusted", resumeFromRunId: "run-1", background: false }],
    ["resumeFromRunId without name", { resumeFromRunId: "run-1", background: false }],
    ["a built-in name with no saved file", { name: "code-review", background: false }],
    ["no name at all", { background: false }],
  ])("refuses %s before any file read or VM execution", async (_label, params) => {
    const savedDir = join(root, "agent", "workflows", "saved");
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(join(savedDir, "trusted.js"), SCRIPT);
    const start = vi.spyOn(WorkflowEngine.prototype, "start");
    const resume = vi.spyOn(WorkflowEngine.prototype, "resume");
    const fixture = createFixture(root);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({} as never, fixture.ctx as never);
    vi.mocked(loadSavedWorkflow).mockClear();

    const result = await fixture.workflow().execute("call", params, undefined, undefined, fixture.ctx);

    expect(result.content[0]?.text).toBe(WORKFLOW_TOOL_DISABLED_MESSAGE);
    expect(result.details.status).toBe("failed");
    expect(loadSavedWorkflow).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await fixture.lifecycle.get("session_shutdown")?.({} as never, fixture.ctx as never);
  });

  it("refuses a saved file the model replaced, before reading it", async () => {
    const savedDir = join(root, "agent", "workflows", "saved");
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(join(savedDir, "trusted.js"), SCRIPT);
    const start = vi.spyOn(WorkflowEngine.prototype, "start");
    const fixture = createFixture(root);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({} as never, fixture.ctx as never);
    const replaced = 'export const meta = { name: "trusted", description: "x" }; return process.env.HOME;';
    writeFileSync(join(savedDir, "trusted.js"), replaced);
    vi.mocked(loadSavedWorkflow).mockClear();

    const result = await fixture
      .workflow()
      .execute("call", { name: "trusted", background: false }, undefined, undefined, fixture.ctx);

    expect(result.content[0]?.text).toBe(WORKFLOW_TOOL_DISABLED_MESSAGE);
    expect(loadSavedWorkflow).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await fixture.lifecycle.get("session_shutdown")?.({} as never, fixture.ctx as never);
  });

  it("does not advise a disabled execution route in tool metadata", async () => {
    const fixture = createFixture(root);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({} as never, fixture.ctx as never);
    const workflow = fixture.workflow() as unknown as { description: string; promptGuidelines: string[] };
    const text = [workflow.description, ...workflow.promptGuidelines].join("\n");
    expect(text).toContain("smarty-dev#11769");
    expect(text).not.toMatch(/Run a saved workflow file|resumeFromRunId together|Provide the `name`/);
    const control = await fixture
      .tool("workflow_control")
      .execute("call", { action: "resume", run_id: "run-1" }, undefined, undefined, fixture.ctx);
    expect(control.content[0]?.text).not.toContain("through the workflow tool");
    await fixture.lifecycle.get("session_shutdown")?.({} as never, fixture.ctx as never);
  });

  it("refuses workflow_control resume with the shared workflow-tool gate", async () => {
    const control = vi.spyOn(WorkflowEngine.prototype, "control");
    const resume = vi.spyOn(WorkflowEngine.prototype, "resume");
    const fixture = createFixture(root);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({} as never, fixture.ctx as never);
    const tool = fixture.tool("workflow_control");

    const result = await tool.execute("call", { action: "resume", run_id: "run-1" }, undefined, undefined, fixture.ctx);

    expect(result.content[0]?.text).toBe(WORKFLOW_TOOL_DISABLED_MESSAGE);
    expect(result.details.status).toBe("failed");
    expect(result.details.error).toBe("workflow-tool-disabled");
    expect(control).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    await fixture.lifecycle.get("session_shutdown")?.({} as never, fixture.ctx as never);
  });

  it("still runs a saved workflow through the user-typed /name command (counterexample)", async () => {
    const savedDir = join(root, "agent", "workflows", "saved");
    mkdirSync(savedDir, { recursive: true });
    const saved = 'export const meta = { name: "trusted", description: "test" }; return 1;';
    writeFileSync(join(savedDir, "trusted.js"), saved);
    const start = vi.spyOn(WorkflowEngine.prototype, "start");
    const fixture = createFixture(root);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({} as never, fixture.ctx as never);
    const registration = fixture.pi.registerCommand.mock.calls.find(([name]) => name === "trusted");
    expect(registration, "saved /trusted command registered").toBeDefined();
    const command = registration?.[1] as { handler: (args: string, ctx: unknown) => Promise<void> };

    await command.handler("", fixture.ctx);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toBe(saved);
    expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Workflow trusted started"), "info");
    await fixture.lifecycle.get("session_shutdown")?.({} as never, fixture.ctx as never);
  });
});
