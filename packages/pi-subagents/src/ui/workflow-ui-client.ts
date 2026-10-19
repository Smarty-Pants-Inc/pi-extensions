import { randomUUID } from "node:crypto";
import {
  type EventBus,
  parseWorkflowUiSnapshot,
  replyChannel,
  WORKFLOW_UI_CHANNELS,
  type WorkflowUiRunSummary,
  type WorkflowUiSnapshot,
} from "@signalridge/pi-subagents-protocol";

function replyData(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error("Invalid workflow UI reply.");
  const values: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || !["success", "data", "error"].includes(key)) throw new Error("Invalid workflow UI reply.");
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Invalid workflow UI reply.");
    values[key] = descriptor.value as unknown;
  }
  if (values.success !== true) throw new Error(typeof values.error === "string" ? values.error : "Workflow UI unavailable.");
  return values.data;
}

const TIMEOUT_MS = 2_000;
export const WORKFLOW_FINISHED_LINGER_MS = 4_000;

export function isWorkflowTerminal(run: WorkflowUiRunSummary): boolean {
  return ["completed", "failed", "stopped"].includes(run.status);
}

/** Optional, session/branch-bound presentation peer. No execution or model polling. */
export class WorkflowUiClient {
  private snapshot: WorkflowUiSnapshot | undefined;
  private readonly finishedAt = new Map<string, number>();
  private readonly requests = new Set<(error?: Error) => void>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private revision = 0;
  private querying = false;
  private queryAgain = false;
  private queryingSurface: string | undefined;
  private candidate: WorkflowUiSnapshot | undefined;

  constructor(
    private readonly events: EventBus,
    private readonly isCurrent: () => boolean,
    private readonly changed: () => void,
    private readonly retiredSurfaces: Set<string> = new Set(),
  ) {
    this.unsubscribe = events.on(WORKFLOW_UI_CHANNELS.changed, raw => this.accept(raw));
    this.query();
  }

  /** Keep expired terminal identities in the bounded snapshot so repeated ticks cannot relinger them. */
  runs(retainedRunIds: ReadonlySet<string>, now = Date.now()): WorkflowUiRunSummary[] {
    if (!this.live()) return [];
    return (this.snapshot?.runs ?? []).filter(run => !isWorkflowTerminal(run) || retainedRunIds.has(run.runId) ||
      now - (this.finishedAt.get(run.runId) ?? now) < WORKFLOW_FINISHED_LINGER_MS);
  }

  async open(run: WorkflowUiRunSummary): Promise<void> {
    if (!this.live() || this.snapshot?.surfaceId !== run.surfaceId || !this.snapshot.runs.some(item => item.runId === run.runId))
      throw new Error("Workflow selection is no longer active.");
    const reply = await this.request(WORKFLOW_UI_CHANNELS.open, { surfaceId: run.surfaceId, runId: run.runId });
    if (!this.live() || this.snapshot?.surfaceId !== run.surfaceId || !reply || typeof reply !== "object" ||
      Array.isArray(reply) || ![Object.prototype, null].includes(Object.getPrototypeOf(reply)) ||
      Object.getOwnPropertyDescriptor(reply, "accepted")?.value !== true) throw new Error("Workflow inspector did not accept the selection.");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.snapshot) this.retireSurface(this.snapshot.surfaceId);
    this.unsubscribe();
    for (const finish of [...this.requests]) finish(new Error("Workflow UI retired."));
    this.snapshot = undefined;
    this.candidate = undefined;
    this.queryAgain = false;
    this.finishedAt.clear();
  }

  private live(): boolean { return !this.disposed && this.isCurrent(); }

  private accept(raw: unknown): void {
    if (!this.live()) return;
    let snapshot: WorkflowUiSnapshot;
    try { snapshot = parseWorkflowUiSnapshot(raw); } catch { return; }
    if (this.retiredSurfaces.has(snapshot.surfaceId)) return;
    // Once a replacement follows an empty retirement, late old-source frames
    // cannot cancel its pending ownership check. Ordinary same-source updates
    // (including an initially empty active peer) still work without a query.
    if (this.candidate && this.snapshot?.runs.length === 0 && this.snapshot.surfaceId === snapshot.surfaceId) return;
    this.revision++;
    if (this.snapshot && this.snapshot.surfaceId !== snapshot.surfaceId) {
      // An empty retirement can arrive before the replacement's publication.
      // Only the active peer's query responder can authorize a new source.
      this.candidate = snapshot;
      this.query();
      return;
    }
    this.candidate = undefined;
    this.apply(snapshot);
  }

  private retireSurface(surfaceId: string): void {
    this.retiredSurfaces.add(surfaceId);
    if (this.retiredSurfaces.size > 256) this.retiredSurfaces.delete(this.retiredSurfaces.values().next().value!);
  }

  private query(): void {
    if (!this.live()) return;
    if (this.querying) {
      // Coalesce same-source revisions; a query sent before a new publication
      // cannot verify that source, so schedule one fresh event-triggered query.
      if (this.candidate?.surfaceId !== this.queryingSurface) this.queryAgain = true;
      return;
    }
    this.querying = true;
    const revision = this.revision;
    const surfaceId = this.candidate?.surfaceId;
    this.queryingSurface = surfaceId;
    void this.request(WORKFLOW_UI_CHANNELS.query, {}).then(raw => {
      if (!this.live()) return;
      let snapshot: WorkflowUiSnapshot;
      try { snapshot = parseWorkflowUiSnapshot(raw); } catch { return; }
      if (this.retiredSurfaces.has(snapshot.surfaceId)) return;
      if (surfaceId) {
        if (this.candidate?.surfaceId !== surfaceId) return;
        if (snapshot.surfaceId !== surfaceId) {
          // A valid ownership reply rejects only the candidate it queried.
          // Release the empty-peer guard without retiring the active source.
          this.candidate = undefined;
          this.queryAgain = false;
          return;
        }
        if (this.snapshot) this.retireSurface(this.snapshot.surfaceId);
        // The reply verifies ownership, not freshness. Later publications win.
        const latest = this.candidate;
        this.candidate = undefined;
        this.apply(latest);
      } else if (revision === this.revision) this.accept(snapshot);
    }, () => {}).finally(() => {
      this.querying = false;
      this.queryingSurface = undefined;
      const again = this.queryAgain;
      this.queryAgain = false;
      if (again && this.candidate && this.live()) this.query();
    });
  }

  private apply(snapshot: WorkflowUiSnapshot): void {
    const old = this.snapshot?.surfaceId === snapshot.surfaceId ? this.finishedAt : new Map<string, number>();
    const next = new Map<string, number>();
    for (const run of snapshot.runs) if (isWorkflowTerminal(run)) next.set(run.runId, old.get(run.runId) ?? Date.now());
    this.finishedAt.clear();
    for (const [id, time] of next) this.finishedAt.set(id, time);
    this.snapshot = snapshot;
    this.changed();
  }

  private request(channel: string, payload: Record<string, string>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const finish = (error?: Error, data?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        this.requests.delete(finish);
        if (error) reject(error); else resolve(data);
      };
      this.requests.add(finish);
      if (!this.live()) { finish(new Error("Workflow UI retired.")); return; }
      const requestId = randomUUID();
      try {
        unsubscribe = this.events.on(replyChannel(channel, requestId), raw => {
          if (!this.live()) { finish(new Error("Workflow UI retired.")); return; }
          try { finish(undefined, replyData(raw)); }
          catch (error) { finish(error instanceof Error ? error : new Error("Invalid workflow UI reply.")); }
        });
        timer = setTimeout(() => finish(new Error("Workflow UI unavailable; retained children remain inspectable.")), TIMEOUT_MS);
        this.events.emit(channel, { requestId, ...payload });
      } catch { finish(new Error("Workflow UI unavailable.")); }
    });
  }
}
