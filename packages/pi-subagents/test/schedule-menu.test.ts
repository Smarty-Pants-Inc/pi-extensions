import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentScheduler } from "../src/schedule.js";
import type { ScheduledSubagent } from "../src/types.js";
import { showSchedulesMenu } from "../src/ui/schedule-menu.js";

describe("schedule display copies", () => {
  it("neutralizes row, confirmation, and notification labels without changing stored names/prompts", async () => {
    const hostile = "界🙂\x1b[2J\x1b]8;;https://bad\x07\u009b2J\u202e";
    const job: ScheduledSubagent = { id: "job", name: hostile, description: hostile, schedule: hostile, scheduleType: "once", subagent_type: hostile,
      prompt: `${hostile}\n${"🙂".repeat(200)}`, createdAt: hostile, enabled: true, runCount: 0 };
    const before = JSON.stringify(job);
    const displays: string[] = [];
    const removeJob = vi.fn();
    const scheduler = { isActive: () => true, list: () => [job], getNextRun: () => hostile, removeJob } as unknown as SubagentScheduler;
    const ctx = { ui: {
      select: async (title: string, rows: string[]) => { displays.push(title, ...rows); return rows[0]; },
      confirm: async (title: string, details: string) => { displays.push(title, details); return true; },
      notify: (text: string) => displays.push(text),
    } } as unknown as ExtensionCommandContext;
    await showSchedulesMenu(ctx, scheduler);
    for (const display of displays) {
      expect(display).not.toMatch(/[\x1b\x07\u009b\u202e]/u);
      expect(display).not.toMatch(/[\ud800-\udfff]/u);
    }
    expect(displays.join("\n")).toContain("\\u001b");
    expect(JSON.stringify(job)).toBe(before);
    expect(removeJob).toHaveBeenCalledWith("job");
  });
});
