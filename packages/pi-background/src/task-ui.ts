import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { type JobManager, type JobSnapshot, LIMITS, type Stream } from "./contracts.js";
import { terminalText } from "./terminal-text.js";

// Bound untrusted input before terminal measurement/wrapping, independently of retention.
export const UI_LOG_BYTES = 64 * 1024;
type Utilities = Pick<
  typeof import("@earendil-works/pi-tui"),
  "matchesKey" | "isKeyRepeat" | "isKeyRelease" | "truncateToWidth" | "wrapTextWithAnsi" | "visibleWidth" | "Key"
>;

export interface TaskUIRuntime {
  manager: JobManager;
  live(): boolean;
  cancel(id: string): void;
  mount(close: () => void): () => void;
}

function plain(text: string, bytes: number = LIMITS.lineBytes, tail = false): string {
  let buffer = Buffer.from(text);
  if (buffer.length > bytes) {
    if (tail) {
      let start = buffer.length - bytes;
      while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
      buffer = buffer.subarray(start);
    } else {
      let end = bytes;
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      buffer = buffer.subarray(0, end);
    }
  }
  return terminalText(buffer.toString("utf8")).replaceAll("\t", " ");
}

function label(text: string): string {
  return plain(text).replaceAll("\n", " ");
}

/** One explicit interaction; no processes, timers, or subscriptions in construction. */
export class BackgroundView implements Component {
  private disposed = false;
  private release: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private selected: string | undefined;
  private selectedIndex = 0;
  private screen: "list" | "logs";
  private stream: Stream | "both" = "both";
  private follow = true;
  private offset = 0;
  private pageSize = 1;
  private logRows: string[] = [];
  private logText = "";
  // One bounded, sanitized snapshot; never infer positions by matching live duplicate lines.
  private pausedText: string | undefined;
  private pausedAnchor = 0;
  private rowStarts: number[] = [];
  private cache: { id: string; width: number; stream: string } | undefined;
  private confirmation: { action: "stop" | "clear"; id: string } | undefined;
  private busy: string | undefined;
  private error: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly utils: Utilities,
    private readonly runtime: TaskUIRuntime,
    private readonly done: () => void,
    id?: string,
  ) {
    this.selected = id;
    this.screen = id ? "logs" : "list";
  }

  mount(): void {
    if (this.disposed || this.unsubscribe || !this.valid()) return;
    this.release = this.runtime.mount(() => this.close());
    try {
      this.unsubscribe = this.runtime.manager.subscribe(() => {
        if (!this.valid()) return;
        if (this.follow) this.invalidate();
        // Pi coalesces chunk bursts; never send a model message for output.
        this.tui.requestRender();
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private valid(): boolean {
    if (this.disposed) return false;
    if (this.runtime.live()) return true;
    this.close();
    return false;
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.release?.();
    this.release = undefined;
    this.confirmation = undefined;
    this.logRows = [];
    this.logText = "";
    this.pausedText = undefined;
    this.rowStarts = [];
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private resumeLogs(): void {
    this.follow = true;
    this.pausedText = undefined;
    this.invalidate();
  }

  private pauseLogs(): void {
    if (!this.follow) return;
    this.follow = false;
    this.pausedText = this.logText;
    this.pausedAnchor = this.rowStarts[this.offset] ?? 0;
  }

  private wrapLogs(text: string, width: number): void {
    if (width === 1) {
      // A wide grapheme cannot occupy one cell. Show an explicit '?' placeholder,
      // one grapheme per row, rather than clipping it together with its neighbors.
      this.logRows = [];
      this.rowStarts = [];
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      let lineStart = 0;
      for (const line of text.split("\n")) {
        if (!line) {
          this.logRows.push("");
          this.rowStarts.push(lineStart);
        }
        for (const { segment, index } of segmenter.segment(line)) {
          this.logRows.push(this.utils.visibleWidth(segment) > 1 ? "?" : segment);
          this.rowStarts.push(lineStart + index);
        }
        lineStart += line.length + 1;
      }
    } else {
      this.logRows = this.utils.wrapTextWithAnsi(text, width);
      let cursor = 0;
      this.rowStarts = this.logRows.map((row) => {
        // Sequential positions within an immutable snapshot, not a live-text search.
        const start = row ? text.indexOf(row, cursor) : cursor;
        const position = start >= 0 ? start : cursor;
        cursor = position + row.length;
        if (text[cursor] === "\n") cursor++;
        return position;
      });
    }
  }

  private jobs(): JobSnapshot[] {
    const jobs = this.runtime.manager.list();
    const index = jobs.findIndex((job) => job.id === this.selected);
    if (index >= 0) this.selectedIndex = index;
    else {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, jobs.length - 1));
      this.selected = jobs[this.selectedIndex]?.id;
      this.screen = "list";
      this.confirmation = undefined;
      this.offset = 0;
      this.resumeLogs();
    }
    return jobs;
  }

  handleInput(data: string): void {
    if (!this.valid() || this.utils.isKeyRelease(data)) return;
    const { matchesKey: key, Key } = this.utils;
    const jobs = this.jobs();
    if (this.confirmation) {
      const captured = this.confirmation;
      this.confirmation = undefined;
      if (key(data, "y") && !this.utils.isKeyRepeat(data)) void this.act(captured);
      // Neither repeating x/d nor Enter can confirm. Other keys cancel, not navigate.
      if (this.valid()) this.tui.requestRender();
      return;
    }
    if (key(data, Key.escape)) {
      if (this.screen === "logs") {
        this.screen = "list";
        this.error = undefined;
      } else this.close();
    } else if (!this.busy) {
      const job = jobs.find((item) => item.id === this.selected);
      if (key(data, "x") && job && job.endedAt === undefined) {
        this.confirmation = { action: "stop", id: job.id };
      } else if (key(data, "d") && job && job.endedAt !== undefined) {
        this.confirmation = { action: "clear", id: job.id };
      } else if (key(data, Key.enter) && job && this.screen === "list") {
        this.screen = "logs";
        this.offset = 0;
        this.resumeLogs();
      } else if (this.screen === "logs" && key(data, "s")) {
        this.stream = this.stream === "both" ? "stdout" : this.stream === "stdout" ? "stderr" : "both";
        this.offset = 0;
        this.resumeLogs();
      } else if (this.screen === "logs" && key(data, "f")) {
        if (this.follow) this.pauseLogs();
        else this.resumeLogs();
      } else {
        let delta = 0;
        if (key(data, Key.up)) delta = -1;
        else if (key(data, Key.down)) delta = 1;
        else if (key(data, Key.pageUp)) delta = -this.pageSize;
        else if (key(data, Key.pageDown)) delta = this.pageSize;
        if (this.screen === "list") {
          if (key(data, Key.home)) this.selectedIndex = 0;
          else if (key(data, Key.end)) this.selectedIndex = jobs.length - 1;
          else this.selectedIndex += delta;
          this.selectedIndex = Math.max(0, Math.min(jobs.length - 1, this.selectedIndex));
          this.selected = jobs[this.selectedIndex]?.id;
        } else if (key(data, Key.end)) {
          this.resumeLogs();
        } else if (delta || key(data, Key.home)) {
          this.pauseLogs();
          const last = Math.max(0, this.logRows.length - 1);
          this.offset = key(data, Key.home) ? 0 : Math.max(0, Math.min(last, this.offset + delta));
          this.pausedAnchor = this.rowStarts[this.offset] ?? 0;
        }
      }
    }
    if (this.valid()) this.tui.requestRender();
  }

  private async act(captured: { action: "stop" | "clear"; id: string }): Promise<void> {
    if (!this.valid() || this.busy) return;
    this.busy = captured.id;
    this.error = undefined;
    try {
      const job = this.runtime.manager.get(captured.id);
      if (captured.action === "stop") {
        if (job.endedAt !== undefined) throw new Error("Job already finished; inspect its exit or clear it.");
        this.runtime.cancel(captured.id);
        await this.runtime.manager.stop(captured.id);
      } else {
        if (job.endedAt === undefined)
          throw new Error("Job has not finished; wait for confirmed exit before clearing.");
        this.runtime.manager.clear(captured.id);
        this.runtime.cancel(captured.id);
      }
      if (!this.valid()) return;
      this.invalidate();
    } catch (error) {
      if (!this.valid()) return;
      this.error = `Action failed: ${label(error instanceof Error ? error.message : String(error))}. Try again.`;
    } finally {
      this.busy = undefined;
      if (this.valid()) this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (!this.valid()) return [];
    const height = Math.max(1, Math.floor(this.tui.terminal.rows));
    const columns = Math.max(0, Math.floor(width));
    if (!columns) return [];
    const jobs = this.jobs();
    const job = jobs.find((item) => item.id === this.selected);
    const headers = [
      this.theme.fg("accent", `Background ${this.screen === "list" ? "tasks" : "logs"} · ${jobs.length} retained`),
      job ? `ID: ${label(job.id)}` : "No background jobs. Start with bash_background or monitor.",
    ];
    if (job) {
      headers.push(
        `Command: ${label(job.command)}`,
        `Cwd: ${label(job.cwd)}`,
        `Status: ${job.status} · exit=${job.exitCode ?? "-"} · signal=${job.signal ?? "-"} · dropped=${job.droppedBytes} bytes`,
      );
      if (job.error) headers.push(`Error: ${label(job.error)}`);
    }
    if (this.screen === "logs") {
      headers.push(
        `Stream: ${this.stream} · ${this.follow ? "following tail" : "scroll paused snapshot (End/f refresh)"} · tail ≤1000 lines/${UI_LOG_BYTES / 1024} KiB${columns === 1 ? " · wide glyphs shown as ?; resize to read" : ""}`,
      );
    }
    const footer = this.confirmation
      ? `${this.confirmation.action === "stop" ? "Stop" : "Clear"} ${label(this.confirmation.id)}? · y confirms · other keys cancel`
      : this.busy
        ? `Waiting for confirmed stop: ${label(this.busy)} · Esc back/close`
        : (this.error ??
          (this.screen === "list"
            ? "↑↓ Home/End PgUp/PgDn · Enter logs · x stop · d clear · Esc close"
            : "↑↓ Home/End PgUp/PgDn scroll · f follow · s stream · x stop · d clear · Esc tasks"));
    // Wrap controls/confirmation instead of silently hiding the last actions at 40 columns.
    // Tiny terminals retain one footer cell and an escapable content area.
    const footerGroups: string[] = [];
    for (const group of footer.split(" · ")) {
      const last = footerGroups.at(-1);
      if (last && this.utils.visibleWidth(`${last} · ${group}`) <= columns) {
        footerGroups[footerGroups.length - 1] = `${last} · ${group}`;
      } else footerGroups.push(...this.utils.wrapTextWithAnsi(group, Math.max(1, columns)));
    }
    const footers = (columns < 20 ? [footer] : footerGroups).slice(0, Math.max(1, height - 1));
    const headerBudget = Math.min(headers.length, Math.max(0, height - footers.length - 1));
    this.pageSize = Math.max(1, height - headerBudget - footers.length);
    let rows: string[];
    if (this.screen === "logs" && job) {
      if (
        !this.cache ||
        this.cache.id !== job.id ||
        this.cache.width !== columns ||
        this.cache.stream !== this.stream
      ) {
        this.logText =
          this.pausedText ?? plain(this.runtime.manager.logs(job.id, 1000, this.stream).text, UI_LOG_BYTES, true);
        this.wrapLogs(this.logText, columns);
        if (!this.follow) {
          // Keep the same source position through wrapping changes (including repeated text).
          this.offset = Math.max(0, this.rowStarts.length - 1);
          while (this.offset > 0 && this.rowStarts[this.offset] > this.pausedAnchor) this.offset--;
        }
        this.cache = { id: job.id, width: columns, stream: this.stream };
      }
      const last = Math.max(0, this.logRows.length - this.pageSize);
      // A paused anchor stays at the top even if resize leaves blank space below it.
      this.offset = this.follow ? last : Math.min(this.offset, Math.max(0, this.logRows.length - 1));
      rows = this.logRows.slice(this.offset, this.offset + this.pageSize);
    } else {
      const start = Math.max(0, this.selectedIndex - this.pageSize + 1);
      rows = jobs.slice(start, start + this.pageSize).map((item) => {
        const row = `${item.id === this.selected ? ">" : " "} ${label(item.id)} [${item.status}] ${label(item.description)}`;
        return item.id === this.selected ? this.theme.fg("accent", row) : row;
      });
    }
    const lines = [...headers.slice(0, headerBudget), ...rows];
    while (lines.length < height - footers.length) lines.push("");
    lines.push(
      ...footers.map((line) => this.theme.fg(this.confirmation ? "warning" : this.error ? "error" : "dim", line)),
    );
    return lines.slice(0, height).map((line) => this.utils.truncateToWidth(line, columns, ""));
  }
}

export async function showBackgroundUI(ctx: ExtensionContext, runtime: TaskUIRuntime, id?: string): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  // TUI-only host dependency: headless/RPC commands never load the renderer.
  const utilities = await import("@earendil-works/pi-tui");
  if (ctx.mode !== "tui" || !ctx.hasUI || !runtime.live()) return;
  if (id) runtime.manager.get(id);
  let view: BackgroundView | undefined;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keys, done) => {
        view = new BackgroundView(tui, theme, utilities, runtime, () => done(), id);
        view.mount();
        return view;
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } },
    );
  } finally {
    view?.dispose();
  }
}
