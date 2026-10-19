/**
 * schedule-menu.ts — `/agents → Scheduled jobs` submenu.
 *
 * Minimal v1 surface: list scheduled jobs, select one to inspect details +
 * confirm cancellation. No create wizard (the `Agent` tool's `schedule` param
 * is the canonical creation path), no toggle/cleanup (cancel is enough for
 * "I scheduled something dumb, get rid of it"). Add management surfaces here
 * if real demand emerges.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "@signalridge/pi-ui";
import type { SubagentScheduler } from "../schedule.js";
import type { ScheduledSubagent } from "../types.js";
import { selectItem } from "./select-item.js";

/** Format an ISO timestamp as relative time ("in 4h", "2d ago", "not set"). */
function relTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "not set";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "not set";
  const diff = t - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  if (abs < 60_000) return future ? "in <1m" : "<1m ago";
  const m = Math.round(abs / 60_000);
  if (m < 60) return future ? `in ${m}m` : `${m}m ago`;
  const h = Math.round(abs / 3_600_000);
  if (h < 24) return future ? `in ${h}h` : `${h}h ago`;
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}

/** One-line textual status. Active outcomes take priority over enabled state. */
export function statusText(j: ScheduledSubagent): string {
  if (j.lastStatus === "running") return "running";
  if (j.lastStatus === "error") return "error";
  if (!j.enabled) return "disabled";
  return "ready";
}

function displayCell(text: string, width: number): string {
  // Drop only trusted truncation resets, after neutralizing untrusted controls.
  return stripTerminalSequences(truncateToWidth(sanitizeDisplayText(text), width));
}

/** Compact selectable row — name, schedule, agent type, next/last run, count. */
function formatJob(j: ScheduledSubagent, scheduler: SubagentScheduler): string {
  const next = scheduler.getNextRun(j.id);
  return [
    statusText(j),
    displayCell(j.name, 18).padEnd(18),
    displayCell(j.schedule, 14).padEnd(14),
    `[${sanitizeDisplayText(j.subagent_type)}]`,
    `next ${relTime(next)}`,
    `last ${relTime(j.lastRun)}`,
    `runs ${j.runCount}`,
  ].join("  ");
}

/** Multi-line details block for the cancel confirm. */
function formatDetails(j: ScheduledSubagent, scheduler: SubagentScheduler): string {
  const next = scheduler.getNextRun(j.id) ?? "not set";
  return [
    `name:      ${j.name}`,
    `schedule:  ${j.schedule} (${j.scheduleType})`,
    `agent:     ${j.subagent_type}`,
    `prompt:    ${displayCell(j.prompt, 200)}`,
    `created:   ${j.createdAt}`,
    `last run:  ${j.lastRun ?? "not set"} (${j.lastStatus ?? "not set"})`,
    `next run:  ${next}`,
    `runs:      ${j.runCount}`,
  ].map(line => sanitizeDisplayText(line)).join("\n");
}

/**
 * List scheduled jobs; selecting one opens a cancel-confirm with details.
 * Returns when the user backs out or after a cancellation.
 */
export async function showSchedulesMenu(
  ctx: ExtensionCommandContext,
  scheduler: SubagentScheduler,
): Promise<void> {
  if (!scheduler.isActive()) {
    ctx.ui.notify("Scheduler is not active in this session.", "warning");
    return;
  }

  const jobs = scheduler.list();
  if (jobs.length === 0) {
    ctx.ui.notify("No scheduled jobs.", "info");
    return;
  }

  const job = await selectItem(
    ctx.ui,
    `Scheduled jobs (${jobs.length}) · select to cancel`,
    jobs,
    (item) => formatJob(item, scheduler),
  );
  if (!job) return;

  const ok = await ctx.ui.confirm(`Cancel "${sanitizeDisplayText(job.name)}"?`, formatDetails(job, scheduler));
  if (!ok) return;

  scheduler.removeJob(job.id);
  ctx.ui.notify(`Cancelled "${sanitizeDisplayText(job.name)}".`, "info");
}
