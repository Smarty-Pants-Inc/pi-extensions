import { randomUUID } from "node:crypto";
import {
  type EventBus,
  type ManagedOwner,
  parseOwnedConversationOpenRequest,
  parseWorkflowUiOpenRequest,
  parseWorkflowUiQueryRequest,
  parseWorkflowUiSnapshot,
  replyChannel,
  WORKFLOW_UI_CHANNELS,
  type WorkflowUiRunSummary,
  type WorkflowUiSnapshot,
} from "@signalridge/pi-subagents-protocol";
import type { WorkflowEngine } from "./engine.js";

/** Compact peer projection: declared phases and retained children are not run authority. */
export function buildWorkflowUiSnapshot(engine: WorkflowEngine, surfaceId: string): WorkflowUiSnapshot {
  const runs: WorkflowUiRunSummary[] = [];
  const priority = (status: string): number =>
    ["pending", "running", "pausing", "stopping"].includes(status)
      ? 0
      : ["paused", "interrupted"].includes(status)
        ? 1
        : 2;
  const ordered = engine
    .list()
    .map((summary) => engine.getRun(String(summary.runId)))
    .filter((run): run is NonNullable<typeof run> => run !== undefined)
    .sort(
      (a, b) => priority(a.status) - priority(b.status) || b.startedAt - a.startedAt || a.runId.localeCompare(b.runId),
    );
  for (const run of ordered.slice(0, 256)) {
    const header = engine.getInspectionHeader(run.runId);
    const ids = new Set([...Object.keys(run.callStatus), ...Object.keys(run.callResults)]);
    const statuses = [...ids].map((id) => run.callStatus[id] ?? run.callResults[id]?.status);
    const tokenValues = Object.values(run.callResults)
      .map((result) => result.tokenCount)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
    const terminal = run.status === "completed" || run.status === "failed" || run.status === "stopped";
    const duration = (terminal ? run.updatedAt : Date.now()) - run.startedAt;
    runs.push({
      version: 1,
      surfaceId,
      runId: run.runId,
      name: run.meta.name.slice(0, 512),
      status: run.status,
      ...(header?.currentPhase?.trim() ? { currentPhase: header.currentPhase.slice(0, 512) } : {}),
      callCount: ids.size,
      runningCalls: statuses.filter((status) => status === "running").length,
      completedCalls: statuses.filter((status) => status === "completed").length,
      failedCalls: statuses.filter((status) => status === "failed").length,
      elapsedMs: Number.isFinite(duration) ? Math.max(0, duration) : 0,
      ...(tokenValues.length ? { tokenCount: Math.floor(tokenValues.reduce((total, value) => total + value, 0)) } : {}),
      restored: header?.restored ?? true,
    });
  }
  return parseWorkflowUiSnapshot({ version: 1, surfaceId, runs });
}

/** Open an exact retained attempt through the session owner's optional TUI endpoint. */
export function openOwnedConversation(
  events: EventBus,
  agentId: string,
  owner: ManagedOwner & { attemptId: string },
  isCurrent: () => boolean,
): Promise<void> {
  const request = parseOwnedConversationOpenRequest({ requestId: randomUUID(), agentId, owner });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    try {
      if (!isCurrent()) {
        finish(new Error("Agent selection is no longer active."));
        return;
      }
      unsubscribe = events.on(replyChannel(WORKFLOW_UI_CHANNELS.openConversation, request.requestId), (raw) => {
        if (!isCurrent()) {
          finish(new Error("Agent selection is no longer active."));
          return;
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          finish(new Error("Invalid agent conversation admission."));
          return;
        }
        const reply = raw as Record<string, unknown>;
        const data = reply.data;
        if (
          reply.success === true &&
          data !== null &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          (data as Record<string, unknown>).accepted === true
        )
          finish();
        else finish(new Error("Agent conversation is not available; use /agents to inspect retained sessions."));
      });
      timer = setTimeout(
        () => finish(new Error("Agent conversation UI is unavailable; update the subagent package or use /agents.")),
        2_000,
      );
      events.emit(WORKFLOW_UI_CHANNELS.openConversation, request);
    } catch {
      finish(new Error("Cannot open agent conversation; try again."));
    }
  });
}

/** A snapshot and opener belonging to one active TUI session/branch surface. */
export interface WorkflowUiSurface {
  snapshot: WorkflowUiSnapshot;
  open(runId: string): Promise<void>;
  notifyError(message: string): void;
}

/**
 * Optional UI-only peer bridge. It never controls a run or interprets child
 * state: an explicit user action enters the workflow owner's own navigator.
 * The source must enforce live session/branch affinity on every invocation.
 */
export class WorkflowUiBridge {
  private readonly unsubscribe: Array<() => void>;
  private opening: WorkflowUiSurface | undefined;
  private disposed = false;

  constructor(
    private readonly events: EventBus,
    private readonly source: () => WorkflowUiSurface | undefined,
  ) {
    this.unsubscribe = [
      events.on(WORKFLOW_UI_CHANNELS.query, (raw) => this.query(raw)),
      events.on(WORKFLOW_UI_CHANNELS.open, (raw) => this.open(raw)),
    ];
  }

  publish(): void {
    if (this.disposed) return;
    try {
      const surface = this.source();
      if (surface) this.events.emit(WORKFLOW_UI_CHANNELS.changed, parseWorkflowUiSnapshot(surface.snapshot));
    } catch {
      // Presentation observers cannot fail execution or journal publication.
    }
  }

  retire(surfaceId: string): void {
    if (this.disposed) return;
    try {
      this.events.emit(WORKFLOW_UI_CHANNELS.changed, parseWorkflowUiSnapshot({ version: 1, surfaceId, runs: [] }));
    } catch {
      // Retirement is best-effort display cleanup, never a lifecycle lock.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opening = undefined;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  private query(raw: unknown): void {
    if (this.disposed) return;
    let request: ReturnType<typeof parseWorkflowUiQueryRequest>;
    try {
      request = parseWorkflowUiQueryRequest(raw);
    } catch {
      return; // A malformed request has no admitted reply identity.
    }
    const channel = replyChannel(WORKFLOW_UI_CHANNELS.query, request.requestId);
    try {
      const surface = this.source();
      if (!surface) {
        this.events.emit(channel, { success: false, error: "Workflow TUI is not active." });
        return;
      }
      this.events.emit(channel, { success: true, data: parseWorkflowUiSnapshot(surface.snapshot) });
    } catch {
      this.events.emit(channel, { success: false, error: "Workflow TUI snapshot is unavailable." });
    }
  }

  private open(raw: unknown): void {
    if (this.disposed) return;
    let request: ReturnType<typeof parseWorkflowUiOpenRequest>;
    try {
      request = parseWorkflowUiOpenRequest(raw);
    } catch {
      return;
    }
    const channel = replyChannel(WORKFLOW_UI_CHANNELS.open, request.requestId);
    let surface: WorkflowUiSurface | undefined;
    try {
      surface = this.source();
      if (
        !surface ||
        surface.snapshot.surfaceId !== request.surfaceId ||
        !surface.snapshot.runs.some((run) => run.runId === request.runId)
      ) {
        this.events.emit(channel, { success: false, error: "Workflow selection is no longer active." });
        return;
      }
      if (this.opening) {
        this.events.emit(channel, { success: false, error: "Workflow inspector is already open." });
        return;
      }
      this.opening = surface;
      // Acknowledge admission, not dialog completion: interactive inspection
      // legitimately lasts longer than an RPC timeout.
      this.events.emit(channel, { success: true, data: { accepted: true } });
      const ownedSurface = surface;
      void Promise.resolve()
        .then(() => {
          const current = this.source();
          if (this.disposed || current?.snapshot.surfaceId !== request.surfaceId) return;
          if (!current.snapshot.runs.some((run) => run.runId === request.runId)) return;
          return ownedSurface.open(request.runId);
        })
        .catch(() => {
          try {
            if (!this.disposed && this.source()?.snapshot.surfaceId === request.surfaceId)
              ownedSurface.notifyError("Cannot open workflow inspector; try again.");
          } catch {
            // A retired UI must not mask or rethrow an async opener failure.
          }
        })
        .finally(() => {
          if (this.opening === ownedSurface) this.opening = undefined;
        });
    } catch {
      if (this.opening === surface) this.opening = undefined;
      this.events.emit(channel, { success: false, error: "Workflow inspector is unavailable." });
    }
  }
}
