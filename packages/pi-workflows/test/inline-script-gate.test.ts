/**
 * The `workflow` tool must refuse any call that carries `script` before the
 * engine starts, so no `vm.Script` runs and no VM helper process is spawned:
 * `node:vm` is not a sandbox. Saved workflow files in the user's Pi agent
 * directory (written by `/workflows save`) still run by name.
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
import piWorkflows, { INLINE_WORKFLOW_DISABLED_MESSAGE } from "../src/index.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
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

  it.each([
    ["script only", { script: SCRIPT, background: false }],
    ["script with a saved name", { script: SCRIPT, name: "trusted", background: false }],
    ["script with a built-in name", { script: SCRIPT, name: "code-review", background: false }],
    ["script with resumeFromRunId", { script: SCRIPT, resumeFromRunId: "run-1", background: false }],
    ["empty script", { script: "", background: false }],
  ])("refuses %s before any VM execution", async (_label, params) => {
    const savedDir = join(root, "agent", "workflows", "saved");
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(join(savedDir, "trusted.js"), SCRIPT);
    const start = vi.spyOn(WorkflowEngine.prototype, "start");
    const resume = vi.spyOn(WorkflowEngine.prototype, "resume");
    const fixture = createFixture(root);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({} as never, fixture.ctx as never);

    const result = await fixture.workflow().execute("call", params, undefined, undefined, fixture.ctx);

    expect(result.content[0]?.text).toBe(INLINE_WORKFLOW_DISABLED_MESSAGE);
    expect(result.details.status).toBe("failed");
    expect(start).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await fixture.lifecycle.get("session_shutdown")?.({} as never, fixture.ctx as never);
  });

  it.each([
    ["resumeFromRunId without name", { resumeFromRunId: "run-1", background: false }, "Provide the `name`"],
    ["a built-in name with no saved file", { name: "code-review", background: false }, "Unknown workflow name"],
    ["no name at all", { background: false }, "Provide the `name`"],
  ])("refuses %s without starting or replaying anything", async (_label, params, expected) => {
    const start = vi.spyOn(WorkflowEngine.prototype, "start");
    const resume = vi.spyOn(WorkflowEngine.prototype, "resume");
    const fixture = createFixture(root);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({} as never, fixture.ctx as never);

    const result = await fixture.workflow().execute("call", params, undefined, undefined, fixture.ctx);

    expect(result.content[0]?.text).toContain(expected);
    expect(start).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await fixture.lifecycle.get("session_shutdown")?.({} as never, fixture.ctx as never);
  });

  it("refuses workflow_control resume, which would replay a journal-stored script", async () => {
    const control = vi.spyOn(WorkflowEngine.prototype, "control");
    const resume = vi.spyOn(WorkflowEngine.prototype, "resume");
    const fixture = createFixture(root);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({} as never, fixture.ctx as never);
    const tool = fixture.tool("workflow_control");

    const result = await tool.execute("call", { action: "resume", run_id: "run-1" }, undefined, undefined, fixture.ctx);

    expect(result.content[0]?.text).toContain("workflow_control resume is disabled");
    expect(control).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    await fixture.lifecycle.get("session_shutdown")?.({} as never, fixture.ctx as never);
  });

  it("still runs a saved workflow file from the user agent directory by name", async () => {
    const savedDir = join(root, "agent", "workflows", "saved");
    mkdirSync(savedDir, { recursive: true });
    const saved = 'export const meta = { name: "trusted", description: "test" }; return 1;';
    writeFileSync(join(savedDir, "trusted.js"), saved);
    const start = vi.spyOn(WorkflowEngine.prototype, "start");
    const fixture = createFixture(root);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({} as never, fixture.ctx as never);

    const result = await fixture
      .workflow()
      .execute("call", { name: "trusted", background: false }, undefined, undefined, fixture.ctx);

    expect(result.content[0]?.text).not.toBe(INLINE_WORKFLOW_DISABLED_MESSAGE);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toBe(saved);
    expect(result.details.status, result.content[0]?.text).toBe("completed");
    await fixture.lifecycle.get("session_shutdown")?.({} as never, fixture.ctx as never);
  });
});
