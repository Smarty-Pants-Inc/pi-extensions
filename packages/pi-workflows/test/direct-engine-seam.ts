/**
 * TEST-ONLY direct-engine seam (smarty-dev#11769).
 *
 * The model-facing `workflow` tool now refuses every call, so runtime/lifecycle
 * suites that only need *a* run started under the extension's real session
 * lifecycle drive the extension's own active WorkflowEngine directly. The
 * engine is captured from the existing `workflow_control list` path (spy on
 * WorkflowEngine.prototype.control), never through a runtime bypass. Options
 * mirror what the retired tool built (excludeTools, background default true,
 * signal, mainModel); the background delivery hook is the extension's own
 * `engine.onBackgroundExecution` callback, installed unchanged by
 * registerSurface. This module is not a product path and is not exported.
 */
import { vi } from "vitest";
import { type ScriptStartOptions, type ScriptStartResult, WorkflowEngine } from "../src/engine.js";
import { loadSavedWorkflow } from "../src/saved-workflows.js";

type ControlTool = { execute: (...args: unknown[]) => Promise<unknown> };

export interface DirectRunParams {
  script?: string;
  name?: string;
  args?: Record<string, unknown>;
  background?: boolean;
  resumeFromRunId?: string;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  tokenBudget?: number;
  agentTimeoutMs?: number;
}

/** Tool-shaped result; `details` is the engine's ScriptStartResult, or empty on error. */
export interface DirectRunResult {
  content: Array<{ type: "text"; text: string }>;
  details: Partial<ScriptStartResult>;
}

export interface DirectRunContext {
  cwd?: string;
  model?: { id?: string };
  sessionManager?: { getBranch(): unknown[] };
  hasUI?: boolean;
  ui?: {
    input?: (...args: unknown[]) => Promise<unknown>;
    select?: (...args: unknown[]) => Promise<unknown>;
    confirm?: (...args: unknown[]) => Promise<unknown>;
  };
}

function textResult(text: string, details: Partial<ScriptStartResult> = {}): DirectRunResult {
  return { content: [{ type: "text", text }], details };
}

/** Capture the extension's active engine through the existing workflow_control list path. */
export async function captureActiveEngine(
  control: ControlTool | undefined,
  ctx: unknown,
): Promise<WorkflowEngine | undefined> {
  if (!control) return undefined;
  const spy = vi.spyOn(WorkflowEngine.prototype, "control");
  try {
    await control.execute("capture-engine", { action: "list" }, undefined, undefined, ctx);
    return spy.mock.contexts.at(-1) as WorkflowEngine | undefined;
  } finally {
    spy.mockRestore();
  }
}

/**
 * Start (or resume) a fixture script on the active engine with the options the
 * retired tool used. Returns a tool-shaped result so assertions stay unchanged.
 */
export async function runOnActiveEngine(
  control: ControlTool | undefined,
  params: DirectRunParams,
  signal: AbortSignal | undefined,
  ctx: DirectRunContext,
): Promise<DirectRunResult> {
  try {
    const engine = await captureActiveEngine(control, ctx);
    if (!engine) throw new Error("No active workflow engine for this session");
    const script = params.script ?? (params.name ? loadSavedWorkflow(params.name, ctx.cwd) : undefined);
    if (!script) throw new Error(`Saved workflow "${params.name}" was not found.`);
    const options: ScriptStartOptions = {
      args: params.args,
      background: params.background ?? true,
      maxAgents: params.maxAgents,
      concurrency: params.concurrency,
      agentRetries: params.agentRetries,
      tokenBudget: params.tokenBudget,
      agentTimeoutMs: params.agentTimeoutMs,
      excludeTools: ["workflow", "workflow_control"],
      signal,
      mainModel: ctx.model?.id,
      loadSavedWorkflow: (name) => loadSavedWorkflow(name, ctx.cwd),
      // Foreground checkpoint confirmation exactly as the retired tool wired it.
      confirm:
        params.background === false && ctx.hasUI
          ? ((async (
              promptText: string,
              checkpointOptions: { kind?: string; default?: unknown; choices?: string[] },
              s: AbortSignal,
            ) => {
              if (checkpointOptions.kind === "input")
                return ctx.ui?.input?.(promptText, String(checkpointOptions.default ?? ""), { signal: s });
              if (checkpointOptions.kind === "select")
                return ctx.ui?.select?.(promptText, checkpointOptions.choices ?? [], { signal: s });
              return ctx.ui?.confirm?.(promptText, promptText, { signal: s });
            }) as unknown as ScriptStartOptions["confirm"])
          : undefined,
    };
    if (params.resumeFromRunId) {
      const resumed = await engine.resume(
        params.resumeFromRunId,
        ctx.sessionManager?.getBranch() ?? [],
        options,
        script,
      );
      if (!resumed) return textResult(`Workflow run not found: ${params.resumeFromRunId}`);
      return textResult(`Workflow ${resumed.runId} ${resumed.status}`, resumed);
    }
    const result = await engine.start(script, options);
    // Same delivery the retired tool armed for background runs, via the
    // extension's own lifecycle callback.
    if (result.background) engine.onBackgroundExecution?.(result.runId);
    return textResult(`Workflow ${result.runId} ${result.status}`, result);
  } catch (error: unknown) {
    return textResult(error instanceof Error ? error.message : String(error));
  }
}
