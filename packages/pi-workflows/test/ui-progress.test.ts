import { describe, expect, it } from "vitest";
import type { ScriptRun } from "../src/journal.js";
import { parsePresentation } from "../src/ui-inspection.js";
import { liveWidgetLines } from "../src/ui-presentation.js";

function run(id: number, calls = 30): ScriptRun {
  return {
    runId: `run-${id}`,
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    meta: { name: `工作流 ${id}\u001b[2J\u202e`, description: "test" },
    callStatus: Object.fromEntries(
      Array.from({ length: calls }, (_, index) => [String(index), index === 6 ? "running" : "completed"]),
    ),
    callResults: {},
  } as unknown as ScriptRun;
}

describe("bounded passive workflow progress", () => {
  it.each([1, 2, 3, 6, 12, 24, 32])("bounds combined runs/calls to %s total rows with explicit overflow", (rows) => {
    const runs = Array.from({ length: 40 }, (_, index) => run(index, 1000));
    const original = JSON.stringify(runs);
    const lines = liveWidgetLines(runs, "detailed", 32, rows);
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines[0]).toContain("40 active");
    if (rows > 1) expect(lines.at(-1)).toContain("more workflows");
    for (const control of ["\u001b", "\u202e"]) expect(lines.join("\n")).not.toContain(control);
    expect(JSON.stringify(runs)).toBe(original);
  });

  it("prioritizes the live seventh call over completed predecessors and reports omitted calls", () => {
    const lines = liveWidgetLines([run(0)], "detailed", 6, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("6: running");
    expect(lines[2]).toContain("29 more calls");
  });

  it("keeps status ahead of a long hostile name and respects the configured run ceiling", () => {
    const runs = Array.from({ length: 10 }, (_, index) => run(index));
    runs[0].meta.name = "长".repeat(1000);
    const lines = liveWidgetLines(runs, "compact", 6, 12);
    expect(lines).toHaveLength(8); // header, six run rows, overflow.
    expect(lines[1]).toMatch(/^ {2}> running/);
    expect(lines.at(-1)).toContain("4 more workflows");
  });

  it("normalizes nonfinite bounds and hides terminal history", () => {
    expect(liveWidgetLines([run(0)], "detailed", Infinity, NaN).length).toBeLessThanOrEqual(12);
    const completed = run(0);
    completed.status = "completed";
    expect(liveWidgetLines([completed])).toEqual([]);
  });
});

describe("checkpoint presentation compatibility", () => {
  const presentation = {
    runId: "run",
    executionId: "execution",
    observationSource: "execution",
    restored: false,
    truncated: false,
    logicalCalls: 1,
    replayedCalls: 0,
    physicalDispatches: 0,
    phases: [{ id: "phase", frameId: "run", title: "Verify", declared: true, entered: true }],
    calls: [
      {
        id: "run:0",
        frameId: "run",
        index: 0,
        kind: "checkpoint",
        status: "completed",
        observed: true,
        journalOnly: false,
      },
    ],
    tasks: [],
    events: [],
  };
  it("accepts a real checkpoint call without discarding the entire phase projection", () => {
    const parsed = parsePresentation(presentation, "run");
    expect(parsed?.calls[0].kind).toBe("checkpoint");
    expect(parsed?.phases[0].entered).toBe(true);
  });
  it("rejects unsafe/fractional counters and malformed task error previews", () => {
    for (const logicalCalls of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parsePresentation({ ...presentation, logicalCalls }, "run")).toBeUndefined();
    }
    expect(
      parsePresentation(
        {
          ...presentation,
          tasks: [
            { id: "t", frameId: "run", graphId: "g", taskId: "t", attempt: 1, status: "failed", errorPreview: {} },
          ],
        },
        "run",
      ),
    ).toBeUndefined();
  });
});
