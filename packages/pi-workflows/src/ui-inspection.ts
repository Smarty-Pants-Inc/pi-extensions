import type {
  WorkflowInspection,
  WorkflowInspectionCall,
  WorkflowInspectionEvent,
  WorkflowInspectionPhase,
  WorkflowInspectionTask,
} from "./inspection.js";
import type { ScriptRun } from "./journal.js";
import { sanitizeDisplayText } from "./safe-text.js";
import { expandedText, statusMark } from "./ui-presentation.js";

/** Only the UI's consumed projection fields, checked at the adapter boundary. */
export interface WorkflowPresentationSnapshot {
  readonly runId: string;
  readonly executionId: string;
  readonly executionGeneration?: number;
  readonly revision?: number;
  readonly currentPhase?: string;
  readonly currentPhaseKey?: string;
  readonly observationSource: WorkflowInspection["observationSource"];
  readonly restored: boolean;
  readonly truncated: boolean;
  readonly logicalCalls: number;
  readonly replayedCalls: number;
  readonly physicalDispatches: number;
  readonly phases: readonly PresentationPhase[];
  readonly calls: readonly PresentationCall[];
  readonly tasks: readonly WorkflowInspectionTask[];
  readonly events: readonly WorkflowInspectionEvent[];
}

export type PresentationPhase = WorkflowInspectionPhase;
export type PresentationCall = WorkflowInspectionCall;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024;
}
function optionalText(value: unknown): value is string | undefined {
  return value === undefined || text(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function optionalCount(value: unknown): value is number | undefined {
  return value === undefined || count(value);
}
function status(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["unknown", "pending", "queued", "running", "completed", "failed", "stopped", "interrupted"].includes(value)
  );
}
function phase(value: unknown): value is PresentationPhase {
  return (
    record(value) &&
    text(value.id) &&
    text(value.frameId) &&
    text(value.title) &&
    optionalText(value.detail) &&
    optionalText(value.phaseKey) &&
    typeof value.declared === "boolean" &&
    typeof value.entered === "boolean"
  );
}
function call(value: unknown): value is PresentationCall {
  return (
    record(value) &&
    text(value.id) &&
    text(value.frameId) &&
    Number.isInteger(value.index) &&
    count(value.index) &&
    (value.kind === "agent" || value.kind === "workflow" || value.kind === "checkpoint" || value.kind === "unknown") &&
    status(value.status) &&
    typeof value.observed === "boolean" &&
    typeof value.journalOnly === "boolean" &&
    [
      "label",
      "phase",
      "phaseKey",
      "agentType",
      "tier",
      "graphId",
      "taskKey",
      "taskId",
      "agentId",
      "attemptId",
      "resultPreview",
      "errorPreview",
    ].every((key) => optionalText(value[key])) &&
    ["tokenCount", "compactionCount", "physicalDispatches", "replayedAgentCount"].every((key) =>
      optionalCount(value[key]),
    ) &&
    (value.physicalStatus === undefined || status(value.physicalStatus)) &&
    (value.replayed === undefined || typeof value.replayed === "boolean")
  );
}
function task(value: unknown): value is WorkflowInspectionTask {
  return (
    record(value) &&
    ["id", "frameId", "graphId", "taskId"].every((key) => text(value[key])) &&
    optionalText(value.description) &&
    optionalText(value.phase) &&
    optionalText(value.errorPreview) &&
    count(value.attempt) &&
    (status(value.status) || value.status === "skipped")
  );
}
function event(value: unknown): value is WorkflowInspectionEvent {
  return (
    record(value) &&
    text(value.id) &&
    text(value.frameId) &&
    typeof value.type === "string" &&
    ["phase", "task", "workflow", "quality", "control-attempt", "log"].includes(value.type) &&
    ["stage", "title", "graphId", "taskKey", "helperId", "helper", "outcome", "message"].every((key) =>
      optionalText(value[key]),
    ) &&
    optionalCount(value.attempt) &&
    (value.accepted === undefined || typeof value.accepted === "boolean")
  );
}
function array<T extends { readonly id: string }>(
  value: unknown,
  maximum: number,
  validate: (item: unknown) => item is T,
): value is T[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every(validate)) return false;
  const items: readonly T[] = value;
  return items.every((item) => item.id.length > 0) && new Set(items.map((item) => item.id)).size === items.length;
}

/** Never interpret unknown adapter data as control authority or mutate its strings. */
export function parsePresentation(value: unknown, runId: string): WorkflowPresentationSnapshot | undefined {
  if (
    !record(value) ||
    value.runId !== runId ||
    !text(value.executionId) ||
    !optionalCount(value.executionGeneration) ||
    !optionalCount(value.revision) ||
    !optionalText(value.currentPhase) ||
    !optionalText(value.currentPhaseKey) ||
    (value.observationSource !== "execution" && value.observationSource !== "journal-only") ||
    typeof value.restored !== "boolean" ||
    typeof value.truncated !== "boolean" ||
    !count(value.logicalCalls) ||
    !count(value.replayedCalls) ||
    !count(value.physicalDispatches) ||
    !array(value.phases, 256, phase) ||
    !array(value.calls, 2048, call) ||
    !array(value.tasks, 256, task) ||
    !array(value.events, 128, event)
  )
    return undefined;
  return {
    runId,
    executionId: value.executionId,
    executionGeneration: value.executionGeneration,
    revision: value.revision,
    currentPhase: value.currentPhase,
    currentPhaseKey: value.currentPhaseKey,
    observationSource: value.observationSource,
    restored: value.restored,
    truncated: value.truncated,
    logicalCalls: value.logicalCalls,
    replayedCalls: value.replayedCalls,
    physicalDispatches: value.physicalDispatches,
    phases: value.phases,
    calls: value.calls,
    tasks: value.tasks,
    events: value.events,
  };
}

export function inspectionCallLabel(call: WorkflowInspectionCall): string {
  return (
    `${statusMark(call.status)} Call ${call.index} · ${sanitizeDisplayText(call.label ?? call.kind, 160)} · ${call.status}` +
    `${call.phase ? ` · phase ${sanitizeDisplayText(call.phase, 120)}` : ""}` +
    `${call.tier ? ` · tier ${sanitizeDisplayText(call.tier, 80)}` : ""}` +
    ` · compactions ${call.compactionCount ?? 0}` +
    `${call.replayed ? " · replayed" : ""}` +
    `${call.journalOnly ? " · journal-only" : ""}` +
    `${call.errorPreview ? ` · error: ${sanitizeDisplayText(call.errorPreview, 120)}` : call.resultPreview ? ` · result: ${sanitizeDisplayText(call.resultPreview, 120)}` : ""}`
  );
}

export function inspectionCallDetail(call: WorkflowInspectionCall, run: ScriptRun): string {
  return [
    inspectionCallLabel(call),
    `Frame: ${sanitizeDisplayText(call.frameId, 200)}${call.frameId === run.runId ? " (root)" : " (nested)"}`,
    ...(call.agentType ? [`Agent type: ${sanitizeDisplayText(call.agentType, 200)}`] : []),
    ...(call.agentId ? [`Agent: ${sanitizeDisplayText(call.agentId, 128)}`] : []),
    ...(call.tokenCount === undefined ? [] : [`Tokens: ${call.tokenCount}`]),
    ...(call.physicalStatus
      ? [`Physical status: ${call.physicalStatus} · dispatches ${call.physicalDispatches ?? 0}`]
      : []),
    ...(call.taskId ? [`Task: ${sanitizeDisplayText(call.taskId, 200)}`] : []),
    call.observed
      ? "Live callback facts (stored preview, not a conversation)."
      : "Journal-only call; historical label/phase is unknown.",
    ...(call.errorPreview ? [`Error: ${expandedText(call.errorPreview)}`] : []),
    ...(call.resultPreview ? [expandedText(call.resultPreview)] : []),
  ].join("\n");
}
