/** Observation-only retained workflow children; no workflow engine/RPC dependency. */
import { type Component, isKeyRelease, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "@signalridge/pi-ui";
import type { AgentRecord } from "../types.js";
import type { Theme } from "./agent-display.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

type DisposableComponent = Component & { dispose?(): void };

export type OwnerGroup = { id: string; runId: string; records: AgentRecord[] };

export function workflowGroupId(record: AgentRecord): string | undefined {
  const owner = record.owner;
  if (owner?.extension !== "pi-workflows" || typeof owner.runId !== "string" || !owner.runId.trim()) return undefined;
  return JSON.stringify([owner.extension, owner.runId]);
}

/** A bounded child list that swaps its body for the existing conversation viewer. */
export class OwnerGroupViewer implements Component {
  private selectedId: string | undefined;
  private initialized = false;
  private child: DisposableComponent | undefined;
  private closed = false;
  private error: string | undefined;
  private keys: ViewerKeys;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private runId: string,
    private records: () => AgentRecord[],
    private open: (record: AgentRecord, done: () => void) => DisposableComponent,
    private done: () => void,
    keybindings?: ViewerKeybindings,
  ) { this.keys = createViewerKeys(keybindings); }

  private roster(): AgentRecord[] {
    const records = this.records();
    if (!this.initialized) { this.selectedId = records[0]?.id; this.initialized = true; }
    else if (!records.some(record => record.id === this.selectedId)) this.selectedId = undefined;
    return records;
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data)) return;
    if (this.child) { this.child.handleInput?.(data); return; }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) { this.done(); return; }
    const records = this.roster();
    const index = records.findIndex(record => record.id === this.selectedId);
    const page = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7) - 5);
    let next = index;
    if (this.keys.scrollUp(data)) next--;
    else if (this.keys.scrollDown(data)) next++;
    else if (this.keys.pageUp(data)) next -= page;
    else if (this.keys.pageDown(data)) next += page;
    else if (matchesKey(data, "home")) next = 0;
    else if (matchesKey(data, "end")) next = records.length - 1;
    else if (matchesKey(data, "enter")) {
      const record = records[index];
      if (!record?.session) this.error = record ? "No session yet; child retained" : "Selection gone; use ↑↓";
      else {
        try {
          this.child = this.open(record, () => {
            this.child?.dispose?.();
            this.child = undefined;
            this.tui.requestRender();
          });
          this.error = undefined;
        } catch { this.error = "Cannot open conversation; try again"; }
      }
    }
    if (records.length && next !== index) this.selectedId = records[Math.max(0, Math.min(records.length - 1, next))].id;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.child) return this.child.render(width);
    const records = this.roster();
    const selected = records.findIndex(record => record.id === this.selectedId);
    // Reserve header, two controls rows, and the shared adapter's two borders.
    const bodyRows = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7) - 5);
    const start = Math.max(0, selected - bodyRows + 1);
    const labels = records.map(record => sanitizeDisplayText(record.description));
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    const lines = [this.theme.fg("accent", `Workflow ${sanitizeDisplayText(this.runId)} · ${records.length} retained children`)];
    if (!records.length) lines.push("No retained children");
    for (let index = start; index < Math.min(records.length, start + bodyRows); index++) {
      const record = records[index];
      const discriminator = (counts.get(labels[index]) ?? 0) > 1 ? ` [${sanitizeDisplayText(record.id)}]` : "";
      // The discriminator leads the label so it survives narrow-width clipping.
      const text = `${record.id === this.selectedId ? ">" : " "}${discriminator} ${labels[index]} · ${record.status}${record.session ? "" : " · no session yet"}`;
      lines.push(this.theme.fg(record.id === this.selectedId ? "accent" : "muted", text));
    }
    lines.push(this.error ? this.theme.fg("error", this.error) : `${selected + 1}/${records.length} · ↑↓/PgUp/PgDn`);
    lines.push(width >= 22 ? "Esc back · Enter view" : width >= 10 ? "Esc back ↵" : "Esc ↵");
    return lines.map(line => truncateToWidth(line, Math.max(0, width)));
  }

  invalidate(): void { this.child?.invalidate(); }
  dispose(): void { this.closed = true; this.child?.dispose?.(); this.child = undefined; }
}
