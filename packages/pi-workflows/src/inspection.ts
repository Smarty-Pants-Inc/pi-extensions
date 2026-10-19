/** Read-only, bounded presentation facts. No prompts, args, histories, or full results. */
import { createHash, randomUUID } from "node:crypto";
import type { ScriptRun } from "./journal.js";
import {
  type AgentRunOptions,
  MAX_RUNTIME_IDENTITY_LENGTH,
  type WorkflowRunOptions,
  type WorkflowRuntimeEvent,
} from "./runtime.js";

export const INSPECTION_LIMITS = {
  calls: 2_048,
  phases: 256,
  tasks: 256,
  events: 128,
  text: 512,
  preview: 300,
} as const;
export type InspectionStatus =
  | "unknown"
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";
export interface WorkflowInspectionPhase {
  readonly id: string;
  readonly frameId: string;
  /** Opaque frame-scoped hash of the full, untruncated title. */
  readonly phaseKey?: string;
  readonly title: string;
  readonly detail?: string;
  readonly declared: boolean;
  /** Only an explicit phase event proves entry; attribution and metadata do not. */
  readonly entered: boolean;
}
export interface WorkflowInspectionCall {
  readonly id: string;
  readonly frameId: string;
  readonly index: number;
  readonly kind: "agent" | "workflow" | "checkpoint" | "unknown";
  readonly label?: string;
  readonly phase?: string;
  /** Optional for legacy adapters; never infer this from a display label. */
  readonly phaseKey?: string;
  readonly agentType?: string;
  readonly tier?: string;
  readonly graphId?: string;
  readonly taskKey?: string;
  readonly taskId?: string;
  readonly status: InspectionStatus;
  /** Physical terminal status can differ from the script's logical outcome. */
  readonly physicalStatus?: InspectionStatus;
  readonly physicalDispatches?: number;
  readonly replayed?: boolean;
  readonly replayedAgentCount?: number;
  readonly childFrameId?: string;
  readonly observed: boolean;
  readonly journalOnly: boolean;
  readonly agentId?: string;
  readonly attemptId?: string;
  readonly outputFile?: string;
  readonly tokenCount?: number;
  readonly compactionCount?: number;
  readonly resultPreview?: string;
  readonly errorPreview?: string;
}
export interface WorkflowInspectionTask {
  readonly id: string;
  readonly frameId: string;
  readonly graphId: string;
  readonly taskId: string;
  readonly description?: string;
  readonly phase?: string;
  readonly attempt: number;
  readonly errorPreview?: string;
  readonly status: InspectionStatus | "skipped";
}
export interface WorkflowInspectionEvent {
  readonly id: string;
  readonly type: WorkflowRuntimeEvent["type"] | "log";
  readonly frameId: string;
  readonly stage?: string;
  readonly childFrameId?: string;
  readonly title?: string;
  readonly graphId?: string;
  readonly taskKey?: string;
  readonly helperId?: string;
  readonly helper?: string;
  readonly outcome?: string;
  readonly accepted?: boolean;
  readonly attempt?: number;
  readonly message?: string;
}
export interface WorkflowInspection {
  readonly runId: string;
  /** Opaque engine-state/execution identity; never use runId alone to own a UI mount. */
  readonly executionId: string;
  readonly executionGeneration: number;
  readonly revision: number;
  readonly name: string;
  readonly status: ScriptRun["status"];
  readonly observationSource: "execution" | "journal-only";
  readonly restored: boolean;
  readonly currentPhase?: string;
  readonly currentPhaseKey?: string;
  readonly phases: readonly WorkflowInspectionPhase[];
  readonly calls: readonly WorkflowInspectionCall[];
  readonly tasks: readonly WorkflowInspectionTask[];
  readonly events: readonly WorkflowInspectionEvent[];
  /** Counters cover observed callbacks, not anonymous historical journal records. */
  readonly logicalCalls: number;
  readonly replayedCalls: number;
  readonly physicalDispatches: number;
  readonly truncated: boolean;
  readonly resultPreview?: string;
  readonly errorPreview?: string;
}

export type WorkflowInspectionHeader = Pick<
  WorkflowInspection,
  "currentPhase" | "currentPhaseKey" | "restored" | "revision" | "executionId" | "executionGeneration"
>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type StartEvent = Parameters<NonNullable<WorkflowRunOptions["onAgentStart"]>>[0];
type EndEvent = Parameters<NonNullable<WorkflowRunOptions["onAgentEnd"]>>[0];
const text = (value: unknown, limit: number = INSPECTION_LIMITS.text): string | undefined =>
  typeof value === "string" ? value.slice(0, limit) : undefined;
function identity(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RUNTIME_IDENTITY_LENGTH)
    throw new Error(
      `Inspection identity must be a non-empty string of at most ${MAX_RUNTIME_IDENTITY_LENGTH} characters`,
    );
  return value;
}
function preview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, INSPECTION_LIMITS.preview);
  try {
    return JSON.stringify(value)?.slice(0, INSPECTION_LIMITS.preview);
  } catch {
    return "[unavailable]";
  }
}
const phaseKey = (frameId: string, title: string): string =>
  createHash("sha256")
    .update(JSON.stringify([frameId, title]))
    .digest("hex");
function status(value: unknown): InspectionStatus {
  return value === "pending" ||
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "interrupted"
    ? value
    : "unknown";
}

/** Engine-owned projection; public consumers receive detached snapshots only. */
export class WorkflowPresentation {
  private executionId = randomUUID();
  private revision = 0;
  private observed = false;
  private truncated = false;
  private currentPhase?: string;
  private currentPhaseKey?: string;
  private readonly calls = new Map<string, Mutable<WorkflowInspectionCall>>();
  private readonly phases = new Map<string, Mutable<WorkflowInspectionPhase>>();
  private readonly tasks = new Map<string, Mutable<WorkflowInspectionTask>>();
  private readonly events: WorkflowInspectionEvent[] = [];
  private logicalCalls = 0;
  private replayedCalls = 0;
  private physicalDispatches = 0;
  constructor(
    private readonly rootFrameId: string,
    private readonly restored = false,
  ) {
    identity(rootFrameId);
  }

  reset(observed = true): void {
    this.executionId = randomUUID();
    this.observed = observed;
    this.currentPhase = undefined;
    this.currentPhaseKey = undefined;
    this.calls.clear();
    this.phases.clear();
    this.tasks.clear();
    this.events.length = 0;
    this.logicalCalls = this.replayedCalls = this.physicalDispatches = 0;
    this.truncated = false;
    this.revision++;
  }

  changed(): void {
    this.revision++;
  }

  private call(id: string, frameId: string, index: number): Mutable<WorkflowInspectionCall> {
    identity(id);
    identity(frameId);
    const existing = this.calls.get(id);
    if (existing) return existing;
    this.logicalCalls++;
    if (this.calls.size >= INSPECTION_LIMITS.calls) {
      this.calls.delete(this.calls.keys().next().value ?? "");
      this.truncated = true;
    }
    const call: Mutable<WorkflowInspectionCall> = {
      id,
      frameId,
      index,
      kind: "unknown",
      status: "unknown",
      observed: true,
      journalOnly: false,
    };
    this.calls.set(id, call);
    return call;
  }

  agentStart(event: StartEvent): void {
    for (const key of [event.id, event.frameId, event.graphId, event.taskKey, event.taskId, event.phaseKey])
      identity(key);
    const frameId = event.frameId ?? event.id.slice(0, event.id.lastIndexOf(":"));
    const index = event.callIndex ?? Number(event.id.slice(event.id.lastIndexOf(":") + 1));
    const call = this.call(event.id, frameId, index);
    Object.assign(call, {
      kind: "agent",
      label: text(event.label),
      phase: text(event.phase),
      phaseKey: identity(event.phaseKey),
      agentType: text(event.agentType),
      tier: text(event.tier),
      graphId: identity(event.graphId),
      taskKey: identity(event.taskKey),
      taskId: identity(event.taskId),
      status: "running",
      replayed: event.replayed === true,
      physicalDispatches: call.physicalDispatches ?? 0,
    });
    if (event.replayed) this.replayedCalls++;
    this.revision++;
  }

  agentEnd(event: EndEvent): void {
    identity(event.id);
    const call = this.calls.get(event.id);
    if (!call) return;
    call.status = event.error ? "failed" : "completed";
    call.tier = text(event.tier) ?? call.tier;
    call.resultPreview = preview(event.result);
    call.errorPreview = text(event.error, INSPECTION_LIMITS.preview);
    call.tokenCount = event.tokens;
    this.revision++;
  }

  dispatch(options: AgentRunOptions, attemptId: string): void {
    identity(attemptId);
    const frameId = options.runId ?? this.rootFrameId;
    const index = options.callIndex ?? 0;
    const call = this.call(`${frameId}:${index}`, frameId, index);
    call.physicalDispatches = (call.physicalDispatches ?? 0) + 1;
    call.physicalStatus = "pending";
    call.attemptId = identity(attemptId);
    // An earlier retry's terminal identity/preview is not this new attempt.
    call.agentId = call.resultPreview = call.errorPreview = call.outputFile = undefined;
    call.tokenCount = call.compactionCount = undefined;
    this.physicalDispatches++;
    this.revision++;
  }

  managed(
    nodeId: string,
    fact: {
      status?: string;
      agentId?: string;
      tier?: string;
      outputFile?: string;
      tokenCount?: number;
      compactionCount?: number;
    },
  ): void {
    identity(nodeId);
    identity(fact.agentId);
    const id = nodeId.includes(":") ? nodeId : `${this.rootFrameId}:${nodeId}`;
    const call = this.calls.get(id);
    if (!call) return;
    if (fact.status !== undefined) call.physicalStatus = status(fact.status);
    if (fact.agentId !== undefined) call.agentId = identity(fact.agentId);
    if (fact.tier !== undefined) call.tier = text(fact.tier);
    if (fact.outputFile !== undefined) call.outputFile = text(fact.outputFile);
    if (fact.tokenCount !== undefined) call.tokenCount = fact.tokenCount;
    if (fact.compactionCount !== undefined) call.compactionCount = fact.compactionCount;
    this.revision++;
  }

  journalResult(frameId: string, index: number, result: unknown): void {
    identity(frameId);
    const call = this.calls.get(`${frameId}:${index}`);
    if (!call) return;
    call.resultPreview = preview(result);
    this.revision++;
  }

  log(message: string, frameId = this.rootFrameId): void {
    identity(frameId);
    this.record({ type: "log", frameId, message: text(message) });
  }

  runtime(event: WorkflowRuntimeEvent): void {
    const rawFrameId = typeof event.frameId === "string" ? event.frameId : this.rootFrameId;
    const frameId = identity(rawFrameId) ?? this.rootFrameId;
    // Validate before retaining state: display limits must never alias keys.
    for (const key of ["runId", "childFrameId", "graphId", "taskKey", "taskId", "helperId", "phaseKey"])
      identity(event[key]);
    if (event.type === "phase" && typeof event.title === "string") {
      const title = text(event.title) ?? "";
      // Hash exact titles so bounded display labels cannot alias identities or retain unbounded input.
      const key = phaseKey(rawFrameId, event.title);
      if (rawFrameId === this.rootFrameId) {
        this.currentPhase = title;
        this.currentPhaseKey = key;
      }
      if (!this.phases.has(key)) {
        if (this.phases.size >= INSPECTION_LIMITS.phases) {
          this.phases.delete(this.phases.keys().next().value ?? "");
          this.truncated = true;
        }
        this.phases.set(key, {
          id: `${frameId}:phase-${this.revision}`,
          frameId,
          phaseKey: key,
          title,
          declared: false,
          entered: true,
        });
      }
    }
    if (event.type === "task" && typeof event.taskKey === "string" && typeof event.taskId === "string") {
      const id = identity(event.taskKey) ?? "";
      if (!this.tasks.has(id) && this.tasks.size >= INSPECTION_LIMITS.tasks) {
        this.tasks.delete(this.tasks.keys().next().value ?? "");
        this.truncated = true;
      }
      this.tasks.set(id, {
        id,
        frameId,
        graphId: identity(event.graphId) ?? "",
        taskId: identity(event.taskId) ?? "",
        description: text(event.description),
        phase: text(event.phase),
        attempt: typeof event.attempt === "number" ? event.attempt : 0,
        errorPreview: text(event.error, INSPECTION_LIMITS.preview),
        status: event.stage === "skip" ? "skipped" : event.stage === "end" ? status(event.status) : "running",
      });
    }
    if (event.type === "control-attempt" && event.helper === "checkpoint" && typeof event.callIndex === "number") {
      const call = this.call(`${frameId}:${event.callIndex}`, frameId, event.callIndex);
      call.kind = "checkpoint";
      call.label = "checkpoint";
      call.phase = text(event.phase);
      call.phaseKey = identity(event.phaseKey);
      call.graphId = identity(event.graphId);
      call.taskKey = identity(event.taskKey);
      call.taskId = identity(event.taskId);
      call.physicalDispatches = 0;
      call.replayed = event.stage === "replay";
      if (call.replayed) this.replayedCalls++;
      call.status =
        event.stage === "start"
          ? "running"
          : event.outcome === "cancelled"
            ? "interrupted"
            : event.outcome === "failed"
              ? "failed"
              : "completed";
    }
    if (event.type === "workflow" && typeof event.callIndex === "number") {
      const call = this.call(`${frameId}:${event.callIndex}`, frameId, event.callIndex);
      call.kind = "workflow";
      call.childFrameId = identity(event.childFrameId);
      call.phase = text(event.phase);
      call.phaseKey = identity(event.phaseKey);
      call.graphId = identity(event.graphId);
      call.taskKey = identity(event.taskKey);
      call.taskId = identity(event.taskId);
      // Only the resolver can prove a saved name. Unknown/legacy sources fail closed.
      call.label = event.sourceKind === "saved" ? (text(event.name) ?? "nested workflow") : "nested workflow";
      call.replayed = event.stage === "replay";
      call.replayedAgentCount = typeof event.replayedAgentCount === "number" ? event.replayedAgentCount : undefined;
      if (event.stage === "replay") this.replayedCalls++;
      call.status =
        event.stage === "start"
          ? "running"
          : event.outcome === "cancelled"
            ? "interrupted"
            : event.outcome === "failed"
              ? "failed"
              : "completed";
    }
    this.record({
      type: event.type,
      frameId,
      stage: text(event.stage),
      childFrameId: identity(event.childFrameId),
      title: text(event.title),
      graphId: identity(event.graphId),
      taskKey: identity(event.taskKey),
      helperId: identity(event.helperId),
      helper: text(event.helper),
      outcome: text(event.outcome),
      accepted: typeof event.accepted === "boolean" ? event.accepted : undefined,
      attempt: typeof event.attempt === "number" ? event.attempt : undefined,
    });
  }

  private record(event: Omit<WorkflowInspectionEvent, "id">): void {
    this.events.push({ ...event, id: `${this.executionId}:event-${++this.revision}` });
    if (this.events.length > INSPECTION_LIMITS.events) {
      this.events.shift();
      this.truncated = true;
    }
  }

  settle(runStatus: ScriptRun["status"]): void {
    // Stop owns its terminal barrier; draining execution alone is not settlement.
    if (runStatus === "stopping") return;
    for (const call of this.calls.values()) {
      if (call.status === "running" || call.status === "pending" || call.status === "queued") {
        // A final workflow outcome does not prove unpaired calls succeeded.
        call.status = runStatus === "stopped" ? "stopped" : "interrupted";
      }
    }
    this.revision++;
  }

  header(executionGeneration: number): WorkflowInspectionHeader {
    return {
      currentPhase: this.currentPhase,
      currentPhaseKey: this.currentPhaseKey,
      restored: this.restored && !this.observed,
      revision: this.revision,
      executionId: this.executionId,
      executionGeneration,
    };
  }

  snapshot(run: ScriptRun, executionGeneration: number): WorkflowInspection {
    identity(run.runId);
    const phases: WorkflowInspectionPhase[] = [];
    const declaredKeys = new Set<string>();
    for (const [index, phase] of (run.meta.phases ?? []).slice(0, INSPECTION_LIMITS.phases).entries()) {
      const key = phaseKey(this.rootFrameId, phase.title);
      // Repeated literal declarations do not invent additional progress units.
      if (declaredKeys.has(key)) continue;
      declaredKeys.add(key);
      phases.push({
        id: `${this.rootFrameId}:declared-${index}`,
        frameId: this.rootFrameId,
        phaseKey: key,
        title: text(phase.title) ?? "",
        detail: text(phase.detail),
        declared: true,
        entered: this.phases.has(key),
      });
    }
    for (const [key, phase] of this.phases) {
      if (!declaredKeys.has(key)) phases.push({ ...phase });
    }
    const calls = new Map<string, WorkflowInspectionCall>();
    for (const [nodeId, durableStatus] of Object.entries(run.callStatus).slice(0, INSPECTION_LIMITS.calls)) {
      const result = run.callResults[nodeId];
      calls.set(`${this.rootFrameId}:${nodeId}`, {
        id: `${this.rootFrameId}:${nodeId}`,
        frameId: this.rootFrameId,
        index: Number(nodeId),
        kind: "unknown",
        status: status(durableStatus),
        observed: false,
        journalOnly: true,
        tier: text(result?.tier ?? run.callTiers[nodeId]?.tier),
        // A terminal result without managed identity may be local work. Never attach a prior child's id.
        agentId: identity(result === undefined ? run.agentIds[nodeId] : result.agentId),
        attemptId: identity(run.attemptIds[nodeId]),
        outputFile: text(result?.outputFile),
        tokenCount: result?.tokenCount,
        compactionCount: result?.compactionCount ?? run.compactions[nodeId],
        resultPreview: preview(result?.result),
        errorPreview: text(result?.error, INSPECTION_LIMITS.preview),
      });
    }
    for (const [id, observed] of this.calls) {
      const durable = calls.get(id);
      // Replayed calls may reference their retained historical child/results, never an invented live dispatch.
      const replayFacts =
        observed.replayed && durable?.status === "completed"
          ? {
              agentId: durable.agentId,
              attemptId: durable.attemptId,
              outputFile: durable.outputFile,
              compactionCount: durable.compactionCount,
              resultPreview: durable.resultPreview,
            }
          : {};
      const merged = { ...replayFacts, ...observed };
      if (observed.replayed && observed.resultPreview === undefined) merged.resultPreview = replayFacts.resultPreview;
      calls.set(id, merged);
    }
    const boundedCalls = [...calls.values()].slice(-INSPECTION_LIMITS.calls);
    return structuredClone({
      runId: run.runId,
      executionId: this.executionId,
      executionGeneration,
      revision: this.revision,
      name: text(run.meta.name) ?? "",
      status: run.status,
      observationSource: this.observed ? "execution" : "journal-only",
      restored: this.restored && !this.observed,
      currentPhase: this.currentPhase,
      currentPhaseKey: this.currentPhaseKey,
      phases: phases.slice(0, INSPECTION_LIMITS.phases),
      calls: boundedCalls,
      tasks: [...this.tasks.values()],
      events: this.events,
      logicalCalls: this.logicalCalls,
      replayedCalls: this.replayedCalls,
      physicalDispatches: this.physicalDispatches,
      truncated:
        this.truncated ||
        calls.size > INSPECTION_LIMITS.calls ||
        phases.length > INSPECTION_LIMITS.phases ||
        (run.meta.phases?.length ?? 0) > INSPECTION_LIMITS.phases,
      resultPreview: preview(run.finalResult),
      errorPreview: text(run.error, INSPECTION_LIMITS.preview),
    });
  }
}
