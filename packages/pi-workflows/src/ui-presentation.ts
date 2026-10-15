import type { WorkflowEngine } from "./engine.js";
import type { ScriptRun } from "./journal.js";
import { sanitizeDisplayText, sanitizeTerminalText } from "./safe-text.js";

export type RunStatus = ScriptRun["status"];
export type WorkflowAction = "refresh" | "pause" | "resume" | "stop" | "back";
export interface WorkflowActionItem {
  value: WorkflowAction;
  label: string;
}

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

/** ASCII marks occupy exactly one cell, including on ambiguous-width terminals. */
export function statusMark(status: string): string {
  if (status === "completed") return "+";
  if (status === "failed") return "!";
  if (status === "stopped" || status === "stopping") return "x";
  if (status === "paused" || status === "pausing" || status === "interrupted") return "=";
  if (status === "pending" || status === "queued") return ".";
  if (status === "skipped") return "-";
  return status === "running" ? ">" : "?";
}

export function elapsed(run: ScriptRun): string {
  const ms = (isTerminal(run.status) ? run.updatedAt : Date.now()) - run.startedAt;
  const seconds = Number.isFinite(ms) ? Math.floor(Math.max(0, ms) / 1_000) : 0;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function callIndexes(run: ScriptRun): string[] {
  return [...new Set([...Object.keys(run.callStatus), ...Object.keys(run.callResults)])]
    .filter((id) => /^(?:0|[1-9]\d*)$/u.test(id))
    .sort((a, b) => Number(a) - Number(b));
}

export function tokenCount(run: ScriptRun): number | undefined {
  const values = Object.values(run.callResults)
    .map((result) => result.tokenCount)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

export function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "(no stored result)";
  } catch {
    return "(result cannot be displayed as JSON)";
  }
}

/** Expanded views retain line breaks, but encode controls before any theme styling. */
export function expandedText(value: string): string {
  const limit = 16_000;
  const copy = value.slice(0, limit);
  return (
    copy
      .split("\n")
      .map((line) => sanitizeTerminalText(line))
      .join("\n") + (copy.length < value.length ? "\n[Display limited to 16000 characters]" : "")
  );
}

export function formatWorkflowRunLabel(run: ScriptRun): string {
  const phases = run.meta.phases?.length ? ` · phases ${run.meta.phases.length}` : "";
  return `${sanitizeDisplayText(run.meta.name, 200)} · ${run.status}${phases} · ${callIndexes(run).length} calls · ${elapsed(run)}`;
}

export function runSummary(run: ScriptRun): string {
  const statuses = Object.values(run.callStatus);
  const running = statuses.filter((status) => status === "running").length;
  const completed = statuses.filter((status) => status === "completed").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const tokens = tokenCount(run);
  return `${statusMark(run.status)} ${run.status} · ${elapsed(run)} · ${tokens ?? "?"} tokens · ${callIndexes(run).length} calls (${running} live / ${completed} done / ${failed} failed)`;
}

export function callLabel(run: ScriptRun, id: string): string {
  const result = run.callResults[id];
  const status = run.callStatus[id] ?? result?.status ?? "unknown";
  const tier = run.callTiers?.[id]?.tier ?? result?.tier;
  const compactions = run.compactions[id] ?? result?.compactionCount ?? 0;
  const preview = result?.error
    ? `error: ${sanitizeDisplayText(result.error, 120)}`
    : result?.result !== undefined
      ? `result: ${sanitizeDisplayText(resultText(result.result), 120)}`
      : "";
  return `${statusMark(status)} Call ${id} · ${status}${tier ? ` · tier ${sanitizeDisplayText(tier, 80)}` : ""} · compactions ${compactions}${preview ? ` · ${preview}` : ""}`;
}

export function callDetail(run: ScriptRun, id: string): string {
  const result = run.callResults[id];
  const agentId = run.agentIds[id] ?? result?.agentId;
  return [
    callLabel(run, id),
    ...(agentId ? [`Agent: ${sanitizeDisplayText(agentId, 128)}`] : []),
    ...(result?.tokenCount === undefined ? [] : [`Tokens: ${result.tokenCount}`]),
    "Stored call result preview (not a live conversation):",
    ...(result?.error ? [`Error: ${expandedText(result.error)}`] : []),
    result?.result === undefined ? "No stored result yet." : expandedText(resultText(result.result)),
  ].join("\n");
}

export function formatWorkflowDetail(engine: WorkflowEngine, runId: string): string {
  const state = engine.getState(runId);
  if (!state) return "Workflow run is no longer available.";
  const run = state.run;
  return [
    `${sanitizeDisplayText(run.meta.name, 200)} [${run.status}]`,
    `run: ${sanitizeDisplayText(run.runId, 128)}`,
    `elapsed: ${elapsed(run)}`,
    runSummary(run),
    ...(run.meta.phases ?? []).map(
      (phase) => `Phase (declared, progress unknown): ${sanitizeDisplayText(phase.title, 200)}`,
    ),
    ...callIndexes(run).map((id) => callDetail(run, id)),
    "Final script result:",
    run.finalResult === undefined ? "No stored final result yet." : expandedText(resultText(run.finalResult)),
    ...(run.error ? [`Error: ${expandedText(run.error)}`] : []),
  ].join("\n");
}

/** State-only availability; callers must additionally fence nonResumable/terminalIntent. */
export function workflowActionsFor(status: RunStatus): readonly WorkflowActionItem[] {
  const back: WorkflowActionItem = { value: "back", label: "Back" };
  const stop: WorkflowActionItem = { value: "stop", label: "Stop (non-resumable)" };
  switch (status) {
    case "pending":
    case "pausing":
      return [stop, back];
    case "running":
      return [{ value: "pause", label: "Pause" }, stop, back];
    case "paused":
    case "interrupted":
      return [{ value: "resume", label: "Resume" }, stop, back];
    case "stopping":
    case "completed":
    case "failed":
    case "stopped":
      return [back];
  }
}

export function actionsForRun(run: ScriptRun): readonly WorkflowActionItem[] {
  return workflowActionsFor(run.status).filter(
    (item) => item.value !== "resume" || (!run.nonResumable && !run.terminalIntent),
  );
}

export function liveWidgetLines(
  runs: readonly ScriptRun[],
  mode: "compact" | "detailed" = "compact",
  maxAgentsShown = 6,
  maxRows = 12,
): string[] {
  const active = runs.filter((run) => !isTerminal(run.status));
  if (!active.length) return [];
  const max = Number.isFinite(maxAgentsShown) ? Math.max(1, Math.min(32, Math.floor(maxAgentsShown))) : 6;
  const rows = Number.isFinite(maxRows) ? Math.max(1, Math.min(32, Math.floor(maxRows))) : 12;
  const lines = [`Workflows · ${active.length} active · /workflows`];
  if (rows === 1) return lines;
  let shown = Math.min(max, active.length, rows - 1);
  // When runs are hidden, reserve a dedicated overflow row before call details.
  if (active.length > shown && shown + 2 > rows) shown = Math.max(0, shown - 1);
  const visible = active.slice(0, shown);
  const hiddenRuns = active.length - visible.length;
  for (const [index, run] of visible.entries()) {
    const runLine = lines.length;
    lines.push(
      `  ${statusMark(run.status)} ${run.status} · ${elapsed(run)} · ${callIndexes(run).length} calls · ${sanitizeDisplayText(run.meta.name, 80)}`,
    );
    if (mode !== "detailed") continue;
    const calls = callIndexes(run);
    const live = calls.filter((id) => run.callStatus[id] === "running");
    const liveIds = new Set(live);
    const prioritized = [...live, ...calls.filter((id) => !liveIds.has(id))];
    const reserved = visible.length - index - 1 + (hiddenRuns > 0 ? 1 : 0);
    const callRows = Math.max(0, Math.min(max, rows - lines.length - reserved));
    const shownCalls = prioritized.slice(0, callRows);
    for (const id of shownCalls) lines.push(`    ${id}: ${run.callStatus[id] ?? run.callResults[id]?.status}`);
    const hiddenCalls = calls.length - shownCalls.length;
    if (hiddenCalls > 0) {
      const last = shownCalls.length ? lines.length - 1 : runLine;
      lines[last] += ` · ${hiddenCalls} more calls`;
    }
  }
  if (hiddenRuns > 0) lines.push(`  ${hiddenRuns} more workflows · /workflows`);
  return lines;
}

export function snapshotRunLine(run: ScriptRun): string {
  return formatWorkflowRunLabel(run);
}
