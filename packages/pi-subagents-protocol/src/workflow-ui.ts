import type { ManagedOwner } from "./types.js";
import { asRecord, parseManagedOwner, type RecordValue, rejectUnknownKeys } from "./validation.js";

/** Optional UI channels, independent of the required managed protocol handshake. */
export const WORKFLOW_UI_VERSION = 1;
export const WORKFLOW_UI_CHANNELS = {
  query: "pi-workflows:ui:query",
  changed: "pi-workflows:ui:changed",
  open: "pi-workflows:ui:open",
  openConversation: "subagents:ui:open-owned",
} as const;

/** Status is authoritative workflow state, never inferred from child counts. */
export interface WorkflowUiRunSummary {
  version: 1;
  surfaceId: string;
  runId: string;
  name: string;
  status:
    | "pending"
    | "running"
    | "pausing"
    | "paused"
    | "stopping"
    | "completed"
    | "failed"
    | "stopped"
    | "interrupted";
  currentPhase?: string;
  callCount: number;
  runningCalls: number;
  completedCalls: number;
  failedCalls: number;
  elapsedMs: number;
  tokenCount?: number;
  restored: boolean;
}

export interface WorkflowUiSnapshot {
  version: 1;
  surfaceId: string;
  runs: WorkflowUiRunSummary[];
}

/** Query replies use replyChannel(query, requestId) and RpcReply<WorkflowUiSnapshot>. */
export interface WorkflowUiQueryRequest {
  requestId: string;
}

/** Explicit user UI action, not model dispatch or human approval. Replies use RpcReply. */
export interface WorkflowUiOpenRequest {
  requestId: string;
  surfaceId: string;
  runId: string;
}

/** Exact attempt ownership prevents opening a replacement on a reused agent thread. */
export interface OwnedConversationOpenRequest {
  requestId: string;
  agentId: string;
  owner: ManagedOwner & { attemptId: string };
}

const SNAPSHOT_KEYS = new Set(["version", "surfaceId", "runs"]);
const SUMMARY_KEYS = new Set([
  "version",
  "surfaceId",
  "runId",
  "name",
  "status",
  "currentPhase",
  "callCount",
  "runningCalls",
  "completedCalls",
  "failedCalls",
  "elapsedMs",
  "tokenCount",
  "restored",
]);
const QUERY_KEYS = new Set(["requestId"]);
const OPEN_KEYS = new Set(["requestId", "surfaceId", "runId"]);
const CONVERSATION_KEYS = new Set(["requestId", "agentId", "owner"]);
const OWNER_KEYS = new Set(["extension", "runId", "nodeId", "attemptId"]);
const STATUSES = new Set<unknown>([
  "pending",
  "running",
  "pausing",
  "paused",
  "stopping",
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);

/** Own data fields only: never invoke payload getters or accept inherited identity. */
function plainRecord(raw: unknown, keys: ReadonlySet<string>, label: string): RecordValue {
  const value = asRecord(raw, label);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const data: RecordValue = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.has(key)) throw new Error(`${label} contains an unsupported field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`${label} must contain data fields`);
    data[key] = descriptor.value as unknown;
  }
  rejectUnknownKeys(data, keys, label);
  return data;
}

/** Validate without trimming or sanitizing; only display consumers sanitize text. */
function originalString(raw: unknown, label: string, max: number): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return raw;
}

function count(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`${label} must be a finite nonnegative safe integer`);
  }
  return raw;
}

function parseSummary(raw: unknown): WorkflowUiRunSummary {
  const value = plainRecord(raw, SUMMARY_KEYS, "workflow UI run summary");
  if (value.version !== WORKFLOW_UI_VERSION) throw new Error("workflow UI run summary version is invalid");
  if (!STATUSES.has(value.status)) throw new Error("workflow UI run summary status is invalid");
  if (typeof value.restored !== "boolean") throw new Error("workflow UI run summary restored flag is invalid");
  const callCount = count(value.callCount, "callCount");
  const runningCalls = count(value.runningCalls, "runningCalls");
  const completedCalls = count(value.completedCalls, "completedCalls");
  const failedCalls = count(value.failedCalls, "failedCalls");
  if (runningCalls + completedCalls + failedCalls > callCount)
    throw new Error("workflow UI call totals exceed callCount");
  if (typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) {
    throw new Error("elapsedMs must be finite and nonnegative");
  }
  const currentPhase =
    value.currentPhase === undefined ? undefined : originalString(value.currentPhase, "currentPhase", 512);
  const tokenCount = value.tokenCount === undefined ? undefined : count(value.tokenCount, "tokenCount");
  return {
    version: WORKFLOW_UI_VERSION,
    surfaceId: originalString(value.surfaceId, "surfaceId", 256),
    runId: originalString(value.runId, "runId", 256),
    name: originalString(value.name, "name", 512),
    status: value.status as WorkflowUiRunSummary["status"],
    ...(currentPhase === undefined ? {} : { currentPhase }),
    callCount,
    runningCalls,
    completedCalls,
    failedCalls,
    elapsedMs: value.elapsedMs,
    ...(tokenCount === undefined ? {} : { tokenCount }),
    restored: value.restored,
  };
}

/** Detached wire data only; callers still enforce active session/branch/surface affinity. */
export function parseWorkflowUiSnapshot(raw: unknown): WorkflowUiSnapshot {
  const value = plainRecord(raw, SNAPSHOT_KEYS, "workflow UI snapshot");
  if (value.version !== WORKFLOW_UI_VERSION) throw new Error("workflow UI snapshot version is invalid");
  const surfaceId = originalString(value.surfaceId, "surfaceId", 256);
  if (!Array.isArray(value.runs) || value.runs.length > 256)
    throw new Error("workflow UI runs must contain at most 256 entries");
  const rawRuns = value.runs;
  if (Object.getPrototypeOf(rawRuns) !== Array.prototype || Reflect.ownKeys(rawRuns).length !== rawRuns.length + 1) {
    throw new Error("workflow UI runs must be a plain dense array");
  }
  const runs: WorkflowUiRunSummary[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rawRuns.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(rawRuns, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      throw new Error("workflow UI runs must contain data entries");
    const run = parseSummary(descriptor.value);
    if (run.surfaceId !== surfaceId) throw new Error("workflow UI run surfaceId does not match snapshot");
    if (ids.has(run.runId)) throw new Error("workflow UI snapshot contains duplicate runIds");
    ids.add(run.runId);
    runs.push(run);
  }
  return { version: WORKFLOW_UI_VERSION, surfaceId, runs };
}

export function parseWorkflowUiQueryRequest(raw: unknown): WorkflowUiQueryRequest {
  const value = plainRecord(raw, QUERY_KEYS, "workflow UI query request");
  return { requestId: originalString(value.requestId, "requestId", 128) };
}

export function parseWorkflowUiOpenRequest(raw: unknown): WorkflowUiOpenRequest {
  const value = plainRecord(raw, OPEN_KEYS, "workflow UI open request");
  return {
    requestId: originalString(value.requestId, "requestId", 128),
    surfaceId: originalString(value.surfaceId, "surfaceId", 256),
    runId: originalString(value.runId, "runId", 256),
  };
}

/** User UI action only; replies use replyChannel(openConversation, requestId) and RpcReply. */
export function parseOwnedConversationOpenRequest(raw: unknown): OwnedConversationOpenRequest {
  const value = plainRecord(raw, CONVERSATION_KEYS, "owned conversation open request");
  const rawOwner = plainRecord(value.owner, OWNER_KEYS, "owner");
  const owner = parseManagedOwner(rawOwner, true);
  if (rawOwner.extension !== "pi-workflows") throw new Error('owner.extension must be "pi-workflows"');
  return {
    requestId: originalString(value.requestId, "requestId", 128),
    agentId: originalString(value.agentId, "agentId", 128),
    owner: {
      extension: owner.extension,
      runId: originalString(rawOwner.runId, "owner.runId", 256),
      nodeId: originalString(rawOwner.nodeId, "owner.nodeId", 256),
      attemptId: originalString(rawOwner.attemptId, "owner.attemptId", 256),
    },
  };
}
