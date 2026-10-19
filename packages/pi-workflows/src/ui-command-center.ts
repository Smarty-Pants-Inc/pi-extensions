import { createHash } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isKeyRelease,
  isKeyRepeat,
  Key,
  type Keybinding,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { WorkflowEngine } from "./engine.js";
import type { ScriptRun } from "./journal.js";
import { sanitizeDisplayText } from "./safe-text.js";
import {
  inspectionCallDetail,
  inspectionCallLabel,
  type PresentationCall,
  type PresentationPhase,
  parsePresentation,
  type WorkflowPresentationSnapshot,
} from "./ui-inspection.js";
import {
  actionsForRun,
  callDetail,
  callIndexes,
  callLabel,
  expandedText,
  formatWorkflowRunLabel,
  resultText,
  runSummary,
  statusMark,
  type WorkflowAction,
  type WorkflowActionItem,
} from "./ui-presentation.js";

export interface WorkflowNavigatorOptions {
  /** Drill directly into a current run; missing runs fall back to the run list. */
  initialRunId?: string;
  /**
   * Synchronous, detached WorkflowInspection-shaped snapshot from the current
   * engine. Undefined means unavailable. Validated and read-only; never control
   * authority. Must not perform I/O or retain UI resources. Exceptions retire
   * this interaction. Journal-only phases are never inferred to have run.
   */
  getPresentation?: (runId: string) => unknown;
  /**
   * Optional host-owned conversation surface. IDs identify only a call in the
   * current workflow; this UI never controls a child agent. The adapter must
   * independently fence session/ownership and reject unavailable conversations.
   * No protocol method or cross-extension source import is assumed here.
   */
  openConversation?: (runId: string, callIndex: string) => Promise<void>;
}

interface Selection {
  id?: string;
  index: number;
  offset: number;
  topId?: string;
  /** A vanished identity cannot be replaced until the user navigates. */
  cleared?: boolean;
}
interface InspectionItem {
  id: string;
  label: () => string;
  detail: () => string;
  callIndex?: string;
  phaseId?: string;
  taskId?: string;
  conversationUnavailable?: string;
}
type Control = "pause" | "resume" | "stop";
interface Target {
  runId: string;
  engine: WorkflowEngine;
  state: NonNullable<ReturnType<WorkflowEngine["getState"]>>;
  run: ScriptRun;
  status: ScriptRun["status"];
  executionGeneration: number;
}

interface DetailLayout {
  itemId: string;
  width: number;
  text: string;
  lines: string[];
  positions: number[];
}

/** Raw, sanitized text only: preserve a logical source anchor when word wrapping changes. */
function detailLayout(itemId: string, text: string, width: number): DetailLayout {
  const lines: string[] = [];
  const positions: number[] = [];
  let base = 0;
  for (const line of text.split("\n")) {
    let cursor = 0;
    for (const wrapped of wrapTextWithAnsi(line, Math.max(1, width))) {
      const part = wrapped.trimStart();
      const found = line.indexOf(part, cursor);
      const start = found >= cursor ? found : cursor;
      positions.push(base + start);
      lines.push(wrapped);
      cursor = start + part.length;
    }
    base += line.length + 1;
  }
  return { itemId, width, text, lines, positions };
}

function boundedDimension(value: number, max: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;
}

/** One explicitly opened interaction. No editor hooks or eager background resources. */
export class WorkflowCommandCenter implements Component {
  private disposed = false;
  private timer?: ReturnType<typeof setInterval>;
  private engine?: WorkflowEngine;
  private runs: ScriptRun[] = [];
  private inspectedRun?: ScriptRun;
  private presentation?: WorkflowPresentationSnapshot;
  private phaseFilter?: string;
  private phaseSelection: Selection = { index: 0, offset: 0 };
  private taskFilter?: string;
  private taskSelection: Selection = { index: 0, offset: 0 };
  private readonly projectionVersions = new Map<
    string,
    { executionId: string; executionGeneration?: number; revision?: number }
  >();
  private runSelection: Selection = { index: 0, offset: 0 };
  private inspectionSelection: Selection = { index: 0, offset: 0 };
  private runId?: string;
  private expandedId?: string;
  private items: InspectionItem[] = [];
  private detailOffset = 0;
  private detailLines = 0;
  private detailLayout?: DetailLayout;
  private pageSize = 1;
  private action: WorkflowAction = "back";
  private controlsFocused = false;
  private busy = false;
  private message = "";
  private messageIsError = false;
  private stopConfirmation?: Target & { confirmKey: "y" | "s" };

  constructor(
    private readonly tui: Pick<TUI, "terminal" | "requestRender">,
    private readonly theme: Pick<Theme, "fg" | "bold">,
    private readonly keys: Pick<KeybindingsManager, "matches" | "getKeys">,
    private readonly source: () => WorkflowEngine,
    private readonly isSessionCurrent: () => boolean,
    private readonly done: () => void,
    private readonly notify: (message: string) => void,
    private readonly options: WorkflowNavigatorOptions = {},
  ) {
    this.runId = options.initialRunId;
    this.runSelection.id = options.initialRunId;
  }

  invalidate(): void {
    // Styles are evaluated on every render. No cached themed strings.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.detailLayout = undefined;
    this.stopConfirmation = undefined;
    this.runs = [];
    this.items = [];
    this.presentation = undefined;
    this.projectionVersions.clear();
    this.inspectedRun = undefined;
    this.engine = undefined;
  }

  private close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  private retire(error: unknown): void {
    if (this.disposed) return;
    this.notify(sanitizeDisplayText(error instanceof Error ? error.message : String(error), 500));
    this.close();
  }

  private currentEngine(): WorkflowEngine | undefined {
    if (this.disposed) return undefined;
    try {
      if (!this.isSessionCurrent()) throw new Error("Workflow session changed; reopen /workflows.");
      const engine = this.source();
      if (this.engine && engine !== this.engine) throw new Error("Workflow engine changed; reopen /workflows.");
      this.engine = engine;
      return engine;
    } catch (error: unknown) {
      this.retire(error);
      return undefined;
    }
  }

  private clearSelection(selection: Selection): void {
    selection.id = undefined;
    selection.index = -1;
    selection.cleared = true;
  }

  private selection(): Selection {
    return !this.runId
      ? this.runSelection
      : this.taskFilter
        ? this.taskSelection
        : this.phaseFilter
          ? this.phaseSelection
          : this.inspectionSelection;
  }

  private synchronize(selection: Selection, ids: readonly string[]): boolean {
    const existing = selection.id === undefined ? -1 : ids.indexOf(selection.id);
    const anchor = selection.topId === undefined ? -1 : ids.indexOf(selection.topId);
    if (anchor >= 0) selection.offset = anchor;
    if (selection.id !== undefined && existing < 0) {
      this.clearSelection(selection);
      return false;
    }
    if (selection.cleared) return true;
    selection.index = existing >= 0 ? existing : Math.max(0, Math.min(selection.index, ids.length - 1));
    selection.id = ids[selection.index];
    return true;
  }

  private invalidateProjectionSelection(): void {
    const selected = this.expandedId ?? this.selection().id;
    if (
      this.phaseFilter ||
      this.taskFilter ||
      (this.presentation && /^(projected:|phase:|task:|events$)/u.test(selected ?? ""))
    ) {
      this.phaseFilter = undefined;
      this.taskFilter = undefined;
      this.expandedId = undefined;
      this.clearSelection(this.inspectionSelection);
    }
  }

  private readPresentation(engine: WorkflowEngine, run: ScriptRun): void {
    const raw = this.options.getPresentation?.(run.runId);
    const snapshot = raw === undefined ? undefined : parsePresentation(raw, run.runId);
    const header = typeof engine.getInspectionHeader === "function" ? engine.getInspectionHeader(run.runId) : undefined;
    const previous = this.projectionVersions.get(run.runId);
    const identity = header ?? snapshot;
    const changed =
      !!identity &&
      !!previous &&
      (identity.executionId !== previous.executionId || identity.executionGeneration !== previous.executionGeneration);
    const rejected =
      raw !== undefined &&
      (!snapshot ||
        (typeof engine.getInspectionHeader === "function" &&
          (!header ||
            snapshot.executionId !== header.executionId ||
            (snapshot.executionGeneration !== undefined &&
              snapshot.executionGeneration !== header.executionGeneration) ||
            (snapshot.revision !== undefined && snapshot.revision !== header.revision))) ||
        (!!snapshot &&
          !!previous &&
          !changed &&
          snapshot.revision !== undefined &&
          previous.revision !== undefined &&
          snapshot.revision < previous.revision));
    if (changed || ((rejected || !snapshot) && this.presentation)) this.invalidateProjectionSelection();
    this.presentation = rejected ? undefined : snapshot;
    if (identity)
      this.projectionVersions.set(run.runId, {
        executionId: identity.executionId,
        executionGeneration: identity.executionGeneration,
        revision: changed ? identity.revision : Math.max(previous?.revision ?? 0, identity.revision ?? 0),
      });
    if (rejected)
      this.setMessage(
        "Invalid presentation snapshot (stale or malformed); showing journal facts only. Select again.",
        true,
      );
    else if (changed) this.setMessage("Execution changed; projection selection cleared. Select again.");
  }

  /** Re-read authoritative state on render AND immediately before input/actions. */
  private refresh(): boolean {
    const engine = this.currentEngine();
    if (!engine) return false;
    try {
      this.runs = engine
        .list()
        .map((summary) => engine.getRun(String(summary.runId)))
        .filter((run): run is ScriptRun => run !== undefined)
        .sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId));
      const runSelectionPresent = this.synchronize(
        this.runSelection,
        this.runs.map((run) => run.runId),
      );
      if (!this.runId && !runSelectionPresent) {
        this.setMessage("Selected run was removed; choose another run.", true);
        return false;
      }
      if (this.runId && !engine.getRun(this.runId)) {
        this.runId = undefined;
        this.inspectedRun = undefined;
        this.phaseFilter = undefined;
        this.taskFilter = undefined;
        this.expandedId = undefined;
        this.clearSelection(this.runSelection);
        this.controlsFocused = false;
        this.stopConfirmation = undefined;
        this.setMessage("Selected run was removed.", true);
        return false;
      }
      const run = this.runId ? engine.getRun(this.runId) : undefined;
      this.inspectedRun = run;
      if (run) this.readPresentation(engine, run);
      else this.presentation = undefined;
      if (this.phaseFilter && !this.presentation?.phases.some((phase) => phase.id === this.phaseFilter)) {
        this.phaseFilter = undefined;
        this.taskFilter = undefined;
        this.expandedId = undefined;
        this.clearSelection(this.inspectionSelection);
        this.setMessage("Selected phase is gone; choose another item.", true);
      }
      if (this.taskFilter && !this.presentation?.tasks.some((task) => task.id === this.taskFilter)) {
        this.taskFilter = undefined;
        this.expandedId = undefined;
        this.clearSelection(this.selection());
        this.setMessage("Selected task is gone; choose another item.", true);
      }
      this.items = run ? this.inspectionItems(run) : [];
      if (
        run &&
        !this.synchronize(
          this.selection(),
          this.items.map((item) => item.id),
        )
      )
        this.setMessage("Selected item is gone; choose another item.", true);
      if (this.expandedId && !this.items.some((item) => item.id === this.expandedId)) {
        this.expandedId = undefined;
        this.clearSelection(this.selection());
        this.setMessage("Selected detail is gone; choose another item.", true);
      }
      const actions = this.actions(run);
      if (!actions.some((item) => item.value === this.action)) this.action = actions[0]?.value ?? "back";
      if (this.stopConfirmation && !this.sameTarget(this.stopConfirmation)) {
        this.stopConfirmation = undefined;
        this.setMessage("Run changed; stop confirmation cancelled.", true);
        return false;
      }
      return true;
    } catch (error: unknown) {
      this.retire(error);
      return false;
    }
  }

  private phaseAmbiguous(phase: PresentationPhase): boolean {
    return (
      !phase.phaseKey &&
      (this.presentation?.phases.filter(
        (candidate) =>
          candidate.frameId === phase.frameId &&
          sanitizeDisplayText(candidate.title, 200) === sanitizeDisplayText(phase.title, 200),
      ).length ?? 0) > 1
    );
  }

  private inPhase(call: PresentationCall, phase: PresentationPhase): boolean {
    if (call.frameId !== phase.frameId) return false;
    if (phase.phaseKey !== undefined || call.phaseKey !== undefined)
      return phase.phaseKey !== undefined && call.phaseKey === phase.phaseKey;
    return !this.phaseAmbiguous(phase) && call.phase === phase.title;
  }

  private phaseItem(phase: PresentationPhase, overview = false): InspectionItem {
    const projection = this.presentation;
    const current =
      phase.frameId === this.runId &&
      (projection?.currentPhaseKey !== undefined || phase.phaseKey !== undefined
        ? phase.phaseKey !== undefined && projection?.currentPhaseKey === phase.phaseKey
        : !this.phaseAmbiguous(phase) && projection?.currentPhase === phase.title);
    return {
      id: overview ? `phase-overview:${phase.id}` : `phase:${phase.id}`,
      phaseId: overview ? undefined : phase.id,
      label: () =>
        `${overview ? "Phase overview / details · " : "- Phase "}(${phase.entered ? "entered; completion unknown" : "declared, progress unknown"}${current ? "; current" : ""}): ${sanitizeDisplayText(phase.title, 200)}`,
      detail: () =>
        `${sanitizeDisplayText(phase.title, 512)}\n${expandedText(phase.detail ?? "")}\n${phase.entered ? "Explicit phase entry observed; completion unknown." : "Declared phase; progress unknown."}${this.phaseAmbiguous(phase) ? "\nAmbiguous phase attribution: colliding display titles; exact call filtering unavailable." : ""}`,
    };
  }

  private taskItem(task: WorkflowPresentationSnapshot["tasks"][number], overview = false): InspectionItem {
    const sameName = (this.presentation?.tasks ?? [])
      .filter((candidate) => candidate.taskId === task.taskId)
      .map((candidate) => candidate.id)
      .sort();
    // A compact discriminator stays visible even when graph/key prefixes collide.
    // Exact identities, not this display ordinal, own selection and call links.
    const discriminator = sameName.length > 1 ? ` [#${sameName.indexOf(task.id) + 1}]` : "";
    return {
      id: overview ? `task-overview:${task.id}` : `task:${task.id}`,
      taskId: overview ? undefined : task.id,
      label: () =>
        `${statusMark(task.status)} Task ${sanitizeDisplayText(task.taskId, 80)}${discriminator} · ${task.status} · attempt ${task.attempt}${overview ? " · overview / details" : ""}`,
      detail: () =>
        `Task: ${sanitizeDisplayText(task.taskId, 160)}\nKey: ${sanitizeDisplayText(task.id, 1024)}\nFrame: ${sanitizeDisplayText(task.frameId, 200)}\nGraph: ${sanitizeDisplayText(task.graphId, 200)}\n${task.status} · attempt ${task.attempt}\n${expandedText(task.description ?? "")}\nPhase: ${sanitizeDisplayText(task.phase ?? "unknown", 200)}${task.errorPreview ? `\nError: ${expandedText(task.errorPreview)}` : ""}`,
    };
  }

  private inspectionItems(run: ScriptRun): InspectionItem[] {
    const projection = this.presentation;
    const selectedPhase = projection?.phases.find((phase) => phase.id === this.phaseFilter);
    const selectedTask = projection?.tasks.find((task) => task.id === this.taskFilter);
    const taskCalls = (task: WorkflowPresentationSnapshot["tasks"][number]) =>
      projection?.calls.filter(
        (call) => call.taskKey === task.id && call.frameId === task.frameId && call.graphId === task.graphId,
      ) ?? [];
    const projectedCalls = selectedTask
      ? taskCalls(selectedTask)
      : (projection?.calls.filter((call) => !selectedPhase || this.inPhase(call, selectedPhase)) ?? []);
    const tasks = (projection?.tasks ?? []).filter(
      (task) =>
        !selectedPhase ||
        taskCalls(task).some((call) => this.inPhase(call, selectedPhase)) ||
        (selectedPhase.phaseKey === undefined &&
          !this.phaseAmbiguous(selectedPhase) &&
          task.frameId === selectedPhase.frameId &&
          task.phase === selectedPhase.title),
    );
    const calls: InspectionItem[] = projectedCalls.map((call) => ({
      id: `projected:${call.id}`,
      // Nested frame indexes are not root replay keys and must never be sent to a host conversation adapter.
      callIndex:
        call.kind === "agent" && call.frameId === run.runId && Object.hasOwn(run.callStatus, String(call.index))
          ? String(call.index)
          : undefined,
      conversationUnavailable:
        call.kind !== "agent"
          ? `Conversation unavailable: ${call.kind} call is not an agent; use /agents for retained conversations.`
          : call.frameId !== run.runId
            ? "Nested conversation unavailable here; use /agents."
            : !Object.hasOwn(run.callStatus, String(call.index))
              ? "Conversation unavailable: root journal call is missing."
              : undefined,
      label: () => inspectionCallLabel(call),
      detail: () =>
        inspectionCallDetail(call, run) +
        (call.frameId === run.runId && run.callResults[String(call.index)]
          ? `\n${callDetail(run, String(call.index))}`
          : ""),
    }));
    if (!selectedPhase && !selectedTask) {
      const covered = new Set(
        projectedCalls.filter((call) => call.frameId === run.runId).map((call) => String(call.index)),
      );
      for (const id of callIndexes(run)) {
        if (!covered.has(id))
          calls.push({
            id: `call:${id}`,
            callIndex: id,
            label: () => callLabel(run, id),
            detail: () => callDetail(run, id),
          });
      }
    }
    if (selectedTask)
      return [
        this.taskItem(selectedTask, true),
        ...calls,
        ...(!calls.length
          ? [
              {
                id: "empty-task",
                label: () => "No exact task-linked calls observed.",
                detail: () =>
                  "No calls with this task key, frame and graph are available. Call order and labels are not associations.",
              },
            ]
          : []),
      ];
    if (selectedPhase)
      return [
        this.phaseItem(selectedPhase, true),
        ...tasks.map((task) => this.taskItem(task)),
        ...calls,
        ...(!calls.length
          ? [
              {
                id: "empty-phase",
                label: () =>
                  this.phaseAmbiguous(selectedPhase)
                    ? "Ambiguous phase attribution; exact filtering unavailable."
                    : "No observed calls attributed to this phase.",
                detail: () =>
                  "No exact calls attributed to this phase. Historical journal-only calls have unknown phases; colliding legacy titles are ambiguous.",
              },
            ]
          : []),
      ];
    const declarationOccurrences = new Map<string, number>();
    const phases: InspectionItem[] = projection
      ? projection.phases.map((phase) => this.phaseItem(phase))
      : (run.meta.phases ?? []).slice(0, 256).map((phase) => {
          // Journal declarations have no projection identity or call attribution.
          // Hash their exact titles so reordering/removal cannot alias an index.
          const key = createHash("sha256").update(phase.title).digest("hex");
          const occurrence = declarationOccurrences.get(key) ?? 0;
          declarationOccurrences.set(key, occurrence + 1);
          return {
            id: `journal-phase:${key}:${occurrence}`,
            label: () => `- Phase (declared, progress unknown): ${sanitizeDisplayText(phase.title, 200)}`,
            detail: () =>
              `Declared phase: ${sanitizeDisplayText(phase.title, 512)}\nProgress unknown; declarations do not prove execution or completion.\n${expandedText(phase.detail ?? "")}`,
          };
        });
    return [
      {
        id: "overview",
        label: () =>
          `Overview / description${run.error ? ` · error: ${sanitizeDisplayText(run.error, 120)}` : ""}${run.nonResumable ? " · non-resumable" : ""}`,
        detail: () =>
          [
            runSummary(run),
            `Run: ${sanitizeDisplayText(run.runId, 128)}`,
            expandedText(run.meta.description),
            ...(run.error ? [`Error: ${expandedText(run.error)}`] : []),
            ...(run.nonResumable ? ["This run is non-resumable."] : []),
            ...(!projection && (run.meta.phases?.length ?? 0) > 256
              ? ["Phase display limited to 256 declarations."]
              : []),
            ...(projection
              ? [
                  `Projection: ${projection.observationSource}${projection.restored ? " · restored; historical phases unknown" : ""}`,
                  ...(typeof this.engine?.getInspectionHeader !== "function"
                    ? ["Adapter freshness unverified: no authoritative inspection header."]
                    : []),
                  `Logical calls: ${projection.logicalCalls} · replayed: ${projection.replayedCalls} · physical dispatches: ${projection.physicalDispatches}`,
                  ...(projection.truncated ? ["Projection history is bounded; older facts may be omitted."] : []),
                ]
              : []),
          ].join("\n"),
      },
      ...phases,
      {
        id: "final",
        label: () => `Final script result · ${run.finalResult === undefined ? "not stored" : "stored"}`,
        detail: () =>
          `Final script result (stored preview):\n${run.finalResult === undefined ? "No stored final result yet." : expandedText(resultText(run.finalResult))}`,
      },
      ...tasks.map((task) => this.taskItem(task)),
      ...(projection?.events.length
        ? [
            {
              id: "events",
              label: () => `Activity · ${projection.events.length} recent events (bounded)`,
              detail: () =>
                projection.events
                  .map(
                    (event) =>
                      `${event.type}${event.stage ? ` / ${sanitizeDisplayText(event.stage, 100)}` : ""} · ${sanitizeDisplayText(event.title ?? event.helper ?? event.message ?? "", 500)}${event.outcome ? ` · ${sanitizeDisplayText(event.outcome, 100)}` : ""}${event.accepted === undefined ? "" : ` · accepted: ${event.accepted ? "yes" : "no"}`}${event.attempt === undefined ? "" : ` · attempt ${event.attempt}`}`,
                  )
                  .join("\n"),
            },
          ]
        : []),
      ...calls,
    ];
  }

  private actions(run?: ScriptRun): readonly WorkflowActionItem[] {
    if (!run) return [{ value: "back", label: "Close" }];
    const engine = this.engine;
    if ((run.status === "failed" || run.status === "stopping") && engine?.hasPendingCleanup?.(run.runId) === true)
      return [{ value: "stop", label: "Retry cleanup" }, ...actionsForRun(run).filter((item) => item.value !== "stop")];
    return actionsForRun(run);
  }

  private setMessage(message: string, error = false): void {
    this.message = sanitizeDisplayText(message, 500);
    this.messageIsError = error;
  }

  private target(): Target | undefined {
    const engine = this.currentEngine();
    if (!engine || !this.runId) return undefined;
    const state = engine.getState(this.runId);
    const run = engine.getRun(this.runId);
    if (!state || !run || state.run !== run || run.runId !== this.runId) {
      this.setMessage("Workflow run is no longer available.", true);
      return undefined;
    }
    return {
      runId: this.runId,
      engine,
      state,
      run,
      status: run.status,
      executionGeneration: state.executionGeneration,
    };
  }

  private sameTarget(target: Target): boolean {
    return (
      this.currentEngine() === target.engine &&
      target.run.runId === target.runId &&
      target.engine.getState(target.runId) === target.state &&
      target.engine.getRun(target.runId) === target.run &&
      target.run.status === target.status &&
      target.state.executionGeneration === target.executionGeneration
    );
  }

  private requestControl(action: Control, repeat = false, armedWithYes = false): void {
    if (this.busy) return;
    try {
      const target = this.target();
      if (!target) return;
      if (!this.actions(target.run).some((item) => item.value === action)) {
        this.stopConfirmation = undefined;
        this.setMessage(`${action} is unavailable in state ${target.run.status}.`, true);
        return;
      }
      if (action === "stop") {
        if (repeat) return;
        // If a configured confirm=y selected Stop, held y must not confirm it.
        const confirmKey = armedWithYes ? "s" : "y";
        this.stopConfirmation = { ...target, confirmKey };
        this.setMessage(
          `Stop is non-resumable. Confirmation owns ${confirmKey} / n / Esc: ${confirmKey} confirms; n or Esc cancels.`,
        );
        return;
      }
      this.stopConfirmation = undefined;
      this.busy = true;
      this.setMessage(`${action} requested…`);
      // Catch synchronous throws and async rejections; no fire-and-forget rejection.
      void this.executeControl(action, target);
    } catch (error: unknown) {
      this.setMessage(error instanceof Error ? error.message : String(error), true);
    }
  }

  private confirmStop(): void {
    const target = this.stopConfirmation;
    this.stopConfirmation = undefined;
    if (!target || this.busy) return;
    try {
      if (!this.sameTarget(target) || !this.actions(target.run).some((item) => item.value === "stop"))
        throw new Error("Run changed; stop confirmation cancelled.");
      this.busy = true;
      this.setMessage("stop requested…");
      void this.executeControl("stop", target);
    } catch (error: unknown) {
      this.setMessage(error instanceof Error ? error.message : String(error), true);
    }
  }

  private async executeControl(action: Control, target: Target): Promise<void> {
    try {
      if (!this.sameTarget(target)) throw new Error("Run changed; action cancelled.");
      if (!this.actions(target.run).some((item) => item.value === action))
        throw new Error("Action is no longer legal.");
      await target.engine.control(action, target.runId);
      // A resume may legitimately replace its state; only the engine/session must survive.
      if (!this.disposed && this.currentEngine() === target.engine) this.setMessage(`Workflow ${action} requested.`);
    } catch (error: unknown) {
      if (!this.disposed && this.currentEngine() === target.engine) {
        this.setMessage(error instanceof Error ? error.message : String(error), true);
      }
    } finally {
      this.busy = false;
      if (!this.disposed) this.tui.requestRender();
    }
  }

  private async openConversation(): Promise<void> {
    if (this.busy || !this.options.openConversation) return;
    this.busy = true;
    try {
      const target = this.target();
      const item = this.selectedItem();
      if (!target || item?.callIndex === undefined) throw new Error(this.conversationHint());
      if (!this.sameTarget(target)) throw new Error("Run changed; conversation cancelled.");
      await this.options.openConversation(target.runId, item.callIndex);
      if (!this.disposed && this.currentEngine() === target.engine) this.setMessage("Returned from conversation.");
    } catch (error: unknown) {
      if (!this.disposed && this.currentEngine())
        this.setMessage(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.busy = false;
      if (!this.disposed) this.tui.requestRender();
    }
  }

  private selectedItem(): InspectionItem | undefined {
    return this.items.find((candidate) => candidate.id === (this.expandedId ?? this.selection().id));
  }

  private conversationHint(): string {
    const item = this.selectedItem();
    if (item?.conversationUnavailable) return item.conversationUnavailable;
    if (item?.callIndex === undefined) return "Select a call to open its conversation.";
    return this.options.openConversation ? "c conversation" : "Conversation unavailable: no host hook; use /agents.";
  }

  private back(): void {
    if (this.stopConfirmation) {
      this.stopConfirmation = undefined;
      this.setMessage("Stop cancelled.");
    } else if (this.expandedId) {
      this.expandedId = undefined;
      this.controlsFocused = false;
    } else if (this.taskFilter) {
      this.taskFilter = undefined;
      this.controlsFocused = false;
    } else if (this.phaseFilter) {
      this.phaseFilter = undefined;
      this.controlsFocused = false;
    } else if (this.runId) {
      this.runId = undefined;
      this.controlsFocused = false;
    } else this.close();
  }

  private inputAction(
    data: string,
  ): "up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel" | "home" | "end" | "controls" | undefined {
    const bindings = [
      ["tui.select.cancel", "cancel", Key.escape],
      ["tui.select.confirm", "confirm", Key.enter],
      ["tui.select.up", "up", Key.up],
      ["tui.select.down", "down", Key.down],
      ["tui.select.pageUp", "pageUp", Key.pageUp],
      ["tui.select.pageDown", "pageDown", Key.pageDown],
    ] as const;
    // Resolve configured ownership before ANY fixed key or fallback arrow.
    for (const [binding, action] of bindings) if (this.keys.matches(data, binding)) return action;
    for (const [, action, fallback] of bindings) if (matchesKey(data, fallback)) return action;
    if (matchesKey(data, Key.home)) return "home";
    if (matchesKey(data, Key.end)) return "end";
    if (matchesKey(data, Key.tab) || matchesKey(data, "ctrl+o")) return "controls";
    return undefined;
  }

  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    if (!this.refresh()) {
      if (!this.disposed) this.tui.requestRender();
      return;
    }
    if (this.stopConfirmation) {
      // Raw held x/Enter in legacy terminals is indistinguishable from repeated
      // presses. Only a DIFFERENT explicit key confirms, never a timing heuristic.
      if (!isKeyRepeat(data)) {
        if (matchesKey(data, this.stopConfirmation.confirmKey)) this.confirmStop();
        else if (matchesKey(data, "n") || matchesKey(data, Key.escape) || this.keys.matches(data, "tui.select.cancel"))
          this.back();
      }
      if (!this.disposed) this.tui.requestRender();
      return;
    }
    const inputAction = this.inputAction(data);
    if (inputAction === "cancel") this.back();
    else if (this.busy) return;
    else if (!inputAction && matchesKey(data, "p")) this.requestControl("pause");
    else if (!inputAction && matchesKey(data, "r")) this.requestControl("resume");
    else if (!inputAction && matchesKey(data, "x")) this.requestControl("stop", isKeyRepeat(data));
    else if (!inputAction && matchesKey(data, "c")) {
      // An invalidated identity stays empty until navigation; do not replace its
      // disappearance notice or route this pending activation to a fallback.
      if (!this.selection().cleared) {
        if (this.options.openConversation) void this.openConversation();
        else this.setMessage(this.conversationHint());
      }
    } else if (inputAction === "controls") {
      this.controlsFocused = !this.controlsFocused;
      this.stopConfirmation = undefined;
    } else {
      const up = inputAction === "up";
      const down = inputAction === "down";
      const pageUp = inputAction === "pageUp";
      const pageDown = inputAction === "pageDown";
      const home = inputAction === "home";
      const end = inputAction === "end";
      const enter = inputAction === "confirm";
      const movement = up || down || pageUp || pageDown || home || end;
      if (movement) {
        this.stopConfirmation = undefined;
        const delta = up ? -1 : down ? 1 : pageUp ? -this.pageSize : this.pageSize;
        if (this.controlsFocused) {
          const actions = this.actions(this.inspectedRun);
          const index = actions.findIndex((item) => item.value === this.action);
          this.action =
            actions[Math.max(0, Math.min(actions.length - 1, home ? 0 : end ? actions.length - 1 : index + delta))]
              ?.value ?? "back";
        } else if (this.expandedId) {
          const max = Math.max(0, this.detailLines - this.pageSize);
          this.detailOffset = Math.max(0, Math.min(max, home ? 0 : end ? max : this.detailOffset + delta));
        } else {
          const selection = this.selection();
          const ids = this.runId ? this.items.map((item) => item.id) : this.runs.map((run) => run.runId);
          selection.index = Math.max(
            0,
            Math.min(ids.length - 1, home ? 0 : end ? ids.length - 1 : selection.index + delta),
          );
          selection.id = ids[selection.index];
          selection.cleared = false;
        }
      } else if (enter) {
        if (this.controlsFocused) {
          if (this.action === "back") this.back();
          else if (this.action !== "refresh")
            this.requestControl(this.action, isKeyRepeat(data), matchesKey(data, "y"));
        } else if (!this.runId && this.runSelection.id) {
          this.runId = this.runSelection.id;
          this.inspectionSelection = { index: 0, offset: 0 };
          this.phaseFilter = undefined;
          this.taskFilter = undefined;
          this.action = "back";
        } else if (this.runId && !this.expandedId) {
          const selection = this.selection();
          const item = this.items.find((candidate) => candidate.id === selection.id);
          if (item?.phaseId) {
            this.phaseFilter = item.phaseId;
            this.phaseSelection = { index: 0, offset: 0 };
          } else if (item?.taskId) {
            this.taskFilter = item.taskId;
            this.taskSelection = { index: 0, offset: 0 };
          } else this.expandedId = selection.id;
          this.detailOffset = 0;
        }
      }
    }
    if (!this.disposed) this.tui.requestRender();
  }

  private controlsHelp(): string {
    return this.inputAction("\t") === "controls"
      ? "Tab controls"
      : this.inputAction("\u000f") === "controls"
        ? "Ctrl+O controls"
        : "Controls key unavailable";
  }

  private keyHelp(binding: Keybinding, fallback: string): string {
    const keys = this.keys.getKeys(binding);
    const key = keys[0] ?? fallback;
    const labels: Record<string, string> = {
      up: "↑",
      down: "↓",
      enter: "Enter",
      escape: "Esc",
      pageUp: "PgUp",
      pageDown: "PgDn",
      tab: "Tab",
      home: "Home",
      end: "End",
    };
    return sanitizeDisplayText(labels[key] ?? key, 50);
  }

  render(availableWidth: number): string[] {
    if (this.disposed) return [];
    this.refresh();
    if (this.disposed) return [];
    // One slow mount-owned refresh, never polling the model or animating responses.
    if (this.timer === undefined)
      this.timer = setInterval(() => {
        if (this.refresh() && !this.disposed) this.tui.requestRender();
        else if (!this.disposed) this.tui.requestRender();
      }, 1_000);
    const width = boundedDimension(availableWidth, 500);
    const height = boundedDimension(this.tui.terminal.rows, 120);
    if (!width || !height) return [];
    const framed = width >= 2 && height >= 4;
    const inner = framed ? width - 2 : width;
    const run = this.inspectedRun;
    const selectedPhase = this.presentation?.phases.find((phase) => phase.id === this.phaseFilter);
    const selectedTask = this.presentation?.tasks.find((task) => task.id === this.taskFilter);
    const breadcrumb = run
      ? `Workflows / ${sanitizeDisplayText(run.meta.name, 200)}${selectedPhase ? ` / ${sanitizeDisplayText(selectedPhase.title, 200)}` : ""}${selectedTask ? ` / Task ${sanitizeDisplayText(selectedTask.taskId, 160)}` : ""}${this.expandedId ? ` / ${sanitizeDisplayText(this.items.find((item) => item.id === this.expandedId)?.callIndex !== undefined ? `Call ${this.items.find((item) => item.id === this.expandedId)?.callIndex}` : this.expandedId, 128)}` : ""}`
      : `Workflows / Runs (${this.runs.length})`;
    const actions = this.actions(run);
    const buttons = actions
      .map((item) => (item.value === this.action && this.controlsFocused ? `[${item.label}]` : item.label))
      .join(" · ");
    const controls =
      visibleWidth(buttons) <= inner
        ? buttons
        : `${this.controlsFocused ? "> " : ""}${actions.find((item) => item.value === this.action)?.label ?? "Back"} · ${this.controlsHelp()}/${this.keyHelp("tui.select.up", "up")}/${this.keyHelp("tui.select.down", "down")}`;
    const help = `${this.controlsHelp()} · ${this.keyHelp("tui.select.up", "up")}/${this.keyHelp("tui.select.down", "down")} select · ${this.keyHelp("tui.select.confirm", "enter")} open · ${this.keyHelp("tui.select.cancel", "escape")} back`;
    const controlHelp = actions
      .map((item) =>
        item.value === "pause" && !this.inputAction("p")
          ? "p pause"
          : item.value === "resume" && !this.inputAction("r")
            ? "r resume"
            : item.value === "stop" && !this.inputAction("x")
              ? `x then y ${item.label === "Retry cleanup" ? "retry cleanup" : "stop"}`
              : "",
      )
      .filter(Boolean)
      .join(" · ");
    const fixedMovement = [
      this.inputAction("\u001b[H") === "home" ? "Home" : "",
      this.inputAction("\u001b[F") === "end" ? "End" : "",
    ]
      .filter(Boolean)
      .join("/");
    const conversation = this.conversationHint();
    const extraHelp = `${this.keyHelp("tui.select.pageUp", "pageUp")}/${this.keyHelp("tui.select.pageDown", "pageDown")}${fixedMovement ? ` ${fixedMovement}` : ""}${controlHelp ? ` · ${controlHelp}` : ""}${run && (!this.inputAction("c") || conversation !== "c conversation") ? ` · ${conversation}` : ""}`;
    const notice = this.stopConfirmation
      ? `Stop is non-resumable · ${this.stopConfirmation.confirmKey} confirms · n / Esc cancels (confirmation owns these keys)`
      : this.message;
    // At tiny heights keep controls/help operable; borders remain complete when possible.
    if (height <= 5) {
      if (height === 1)
        return [
          this.theme.fg(
            this.messageIsError ? "error" : "warning",
            truncateToWidth(notice || `${controls} · ${this.keyHelp("tui.select.cancel", "escape")} back`, inner, ""),
          ),
        ];
      const compact = [
        this.theme.fg("accent", truncateToWidth(breadcrumb, inner, "")),
        this.theme.fg(this.messageIsError ? "error" : "warning", truncateToWidth(notice || controls, inner, "")),
        this.theme.fg("dim", truncateToWidth(help, inner, "")),
      ].slice(3 - Math.min(3, height - (framed ? 2 : 0)));
      if (!framed) return compact;
      const border = (text: string) => this.theme.fg("borderAccent", text);
      return [
        border(`╭${"─".repeat(inner)}╮`),
        ...compact.map(
          (line) => border("│") + line + " ".repeat(Math.max(0, inner - visibleWidth(line))) + border("│"),
        ),
        border(`╰${"─".repeat(inner)}╯`),
      ];
    }
    const top = [this.theme.fg("accent", this.theme.bold(truncateToWidth(breadcrumb, inner, "")))];
    if (run && height >= 8) top.push(this.theme.fg("muted", truncateToWidth(runSummary(run), inner, "")));
    const bottom = [
      ...(notice && height >= 6
        ? [this.theme.fg(this.messageIsError ? "error" : "warning", truncateToWidth(notice, inner, ""))]
        : []),
      this.theme.fg(this.controlsFocused ? "accent" : "muted", truncateToWidth(controls, inner, "")),
      this.theme.fg("dim", truncateToWidth(help, inner, "")),
      ...(height >= 10 ? [this.theme.fg("dim", truncateToWidth(extraHelp, inner, ""))] : []),
    ];
    this.pageSize = Math.max(1, height - (framed ? 2 : 0) - top.length - bottom.length);
    const body: string[] = [];
    if (this.expandedId) {
      const item = this.items.find((candidate) => candidate.id === this.expandedId);
      const text = item?.detail() ?? "Detail unavailable.";
      const previous = this.detailLayout;
      const layout =
        previous?.itemId === this.expandedId && previous.width === inner && previous.text === text
          ? previous
          : detailLayout(this.expandedId, text, inner);
      if (previous?.itemId === this.expandedId && previous.width !== inner && previous.text === text) {
        const anchor = previous.positions[this.detailOffset] ?? 0;
        let offset = 0;
        while (offset + 1 < layout.positions.length && layout.positions[offset + 1] <= anchor) offset++;
        this.detailOffset = offset;
      }
      this.detailLayout = layout;
      this.detailLines = layout.lines.length;
      this.detailOffset = Math.max(0, Math.min(this.detailOffset, layout.lines.length - this.pageSize));
      body.push(...layout.lines.slice(this.detailOffset, this.detailOffset + this.pageSize));
    } else {
      const selection = this.selection();
      const count = run ? this.items.length : this.runs.length;
      selection.offset = Math.max(0, Math.min(selection.offset, count - this.pageSize));
      if (selection.index >= 0 && selection.index < selection.offset) selection.offset = selection.index;
      if (selection.index >= selection.offset + this.pageSize) selection.offset = selection.index - this.pageSize + 1;
      selection.topId = run ? this.items[selection.offset]?.id : this.runs[selection.offset]?.runId;
      for (let index = selection.offset; index < Math.min(count, selection.offset + this.pageSize); index++) {
        const selected = index === selection.index && selection.id !== undefined;
        const candidate = this.runs[index];
        const label = run
          ? (this.items[index]?.label() ?? "")
          : candidate
            ? `${statusMark(candidate.status)} ${formatWorkflowRunLabel(candidate)}`
            : "";
        body.push(
          this.theme.fg(
            selected && !this.controlsFocused ? "accent" : "text",
            truncateToWidth(`${selected ? ">" : " "} ${label}`, inner, ""),
          ),
        );
      }
      if (!count) body.push(this.theme.fg("muted", truncateToWidth("No workflow runs in this session.", inner, "")));
    }
    const room = Math.max(0, height - (framed ? 2 : 0) - top.length - bottom.length);
    if (height >= 10) {
      const selection = this.selection();
      const count = run ? this.items.length : this.runs.length;
      const position = this.expandedId
        ? `Lines ${this.detailOffset + 1}-${Math.min(this.detailLines, this.detailOffset + this.pageSize)}/${this.detailLines}`
        : `Items ${selection.id ? selection.index + 1 : 0}/${count}`;
      bottom[bottom.length - 1] = this.theme.fg("dim", truncateToWidth(`${position} · ${extraHelp}`, inner, ""));
    }
    const content = [
      ...top,
      ...body.slice(0, room),
      ...Array.from({ length: Math.max(0, room - body.length) }, () => ""),
      ...bottom,
    ];
    if (!framed) return content.map((line) => truncateToWidth(line, width, "")).slice(0, height);
    const border = (text: string) => this.theme.fg("borderAccent", text);
    return [
      border(`╭${"─".repeat(inner)}╮`),
      ...content.map((line) => {
        const clipped = truncateToWidth(line, inner, "");
        return border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border("│");
      }),
      border(`╰${"─".repeat(inner)}╯`),
    ];
  }
}
