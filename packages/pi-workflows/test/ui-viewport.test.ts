import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEngine } from "../src/engine.js";
import type { WorkflowInspection } from "../src/inspection.js";
import type { ScriptRun } from "../src/journal.js";
import {
  formatWorkflowDetail,
  formatWorkflowRunLabel,
  liveWidgetLines,
  showWorkflowNavigator,
  workflowActionsFor,
} from "../src/ui.js";
import { WorkflowCommandCenter, type WorkflowNavigatorOptions } from "../src/ui-command-center.js";
import { parsePresentation } from "../src/ui-inspection.js";

const DOWN = "\u001b[B";
const ENTER = "\r";
const ESC = "\u001b";
const PAGE_DOWN = "\u001b[6~";
const PAGE_UP = "\u001b[5~";
const HOME = "\u001b[H";
const END = "\u001b[F";

function makeRun(id = "run-a", calls = 0): ScriptRun {
  return {
    runId: id,
    schemaVersion: 4,
    script: "",
    scriptHash: "hash",
    frozenArgsPresent: false,
    status: "running",
    startedAt: 1,
    updatedAt: 2,
    meta: { name: id, description: "Description", phases: [{ title: "Research", detail: "Declared only" }] },
    callStatus: Object.fromEntries(Array.from({ length: calls }, (_, i) => [i, "completed"])),
    callResults: Object.fromEntries(
      Array.from({ length: calls }, (_, i) => [
        i,
        {
          status: "completed",
          result: `result ${i}\n${Array.from({ length: 80 }, (_, line) => `line ${line}`).join("\n")}`,
          tokenCount: 10,
          compactionCount: 1,
          updatedAt: 2,
        },
      ]),
    ),
    agentIds: {},
    attempts: {},
    attemptIds: {},
    callTiers: {},
    workflowResultGenerations: {},
    compactions: {},
  };
}

function fakeEngine(initial: ScriptRun[] = [makeRun()]) {
  const states = new Map<string, { run: ScriptRun; executionGeneration?: number }>(
    initial.map((run) => [run.runId, { run, executionGeneration: 1 }]),
  );
  const control = vi.fn(async (_action: string, _id: string) => ({ action: "test" }));
  const engine = {
    list: () => [...states.keys()].map((runId) => ({ runId })),
    getRun: (id: string) => states.get(id)?.run,
    getState: (id: string) => states.get(id),
    control,
  } as unknown as WorkflowEngine;
  return { engine, states, control };
}

const mounted: WorkflowCommandCenter[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const component of mounted.splice(0)) component.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

function harness(initial = [makeRun()], options: WorkflowNavigatorOptions = {}) {
  const fake = fakeEngine(initial);
  let source = fake.engine;
  let sourceError: Error | undefined;
  let sessionCurrent = true;
  const terminal = { rows: 24 };
  const requestRender = vi.fn();
  const done = vi.fn();
  const notify = vi.fn();
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  let themePrefix = "";
  const theme = {
    fg: (_name: string, text: string) => `${themePrefix}${text}`,
    bold: (text: string) => text,
  } as Pick<Theme, "fg" | "bold">;
  const component = new WorkflowCommandCenter(
    { terminal, requestRender } as unknown as Pick<TUI, "terminal" | "requestRender">,
    theme,
    keys,
    () => {
      if (sourceError) throw sourceError;
      return source;
    },
    () => sessionCurrent,
    done,
    notify,
    options,
  );
  mounted.push(component);
  return {
    ...fake,
    component,
    terminal,
    requestRender,
    done,
    notify,
    keys,
    setSource(engine: WorkflowEngine) {
      source = engine;
    },
    replaceSession() {
      sessionCurrent = false;
    },
    failSource(error: Error) {
      sourceError = error;
    },
    changeTheme(prefix: string) {
      themePrefix = prefix;
    },
    text(width = 120) {
      return component.render(width).join("\n");
    },
    input(...keys: string[]) {
      for (const key of keys) component.handleInput(key);
    },
  };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function expectBounds(component: WorkflowCommandCenter, width: number, rows: number) {
  const lines = component.render(width);
  expect(lines.length).toBeLessThanOrEqual(rows);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  if (width >= 2 && rows >= 4 && lines.length) {
    expect(lines[0]).toMatch(/^╭.*╮$/u);
    expect(lines.at(-1)).toMatch(/^╰.*╯$/u);
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^│.*│$/u);
  }
}

function presentation(): WorkflowInspection {
  return {
    runId: "a",
    executionId: "execution-a",
    executionGeneration: 1,
    revision: 1,
    name: "a",
    status: "running",
    observationSource: "execution",
    restored: false,
    currentPhase: "Research",
    logicalCalls: 3,
    replayedCalls: 1,
    physicalDispatches: 2,
    truncated: false,
    phases: [
      { id: "research", frameId: "a", title: "Research", declared: true, entered: true },
      { id: "writing", frameId: "a", title: "Writing", declared: true, entered: false },
    ],
    calls: [
      {
        id: "a:0",
        frameId: "a",
        index: 0,
        kind: "agent",
        status: "running",
        label: "Find sources",
        phase: "Research",
        tier: "high",
        observed: true,
        journalOnly: false,
      },
      {
        id: "a:1",
        frameId: "a",
        index: 1,
        kind: "agent",
        status: "completed",
        label: "Write report",
        phase: "Writing",
        replayed: true,
        observed: true,
        journalOnly: false,
      },
      {
        id: "child:0",
        frameId: "child",
        index: 0,
        kind: "agent",
        status: "running",
        label: "Nested sources",
        phase: "Research",
        observed: true,
        journalOnly: false,
      },
    ],
    tasks: [{ id: "task-a", frameId: "a", taskId: "summarize", graphId: "graph-a", attempt: 1, status: "running" }],
    events: [{ id: "event-a", frameId: "a", type: "quality", helper: "verify", stage: "end", accepted: true }],
  };
}

describe("workflow live command center", () => {
  it("opens an initial run directly and falls back safely for missing IDs", () => {
    const h = harness([makeRun("a")], { initialRunId: "a" });
    expect(h.text()).toContain("Workflows / a");
    const missing = harness([makeRun("a")], { initialRunId: "missing" });
    expect(missing.text()).toContain("Runs (1)");
    expect(missing.text()).toContain("Selected run was removed.");
  });

  it("uses observed labels/phases/tasks/activity and filters phase calls by frame", async () => {
    const snapshot = presentation();
    const openConversation = vi.fn(async () => {});
    const h = harness([makeRun("a", 2)], { getPresentation: () => snapshot, openConversation });
    h.input(ENTER);
    expect(h.text()).toContain("entered; completion unknown; current");
    expect(h.text()).toContain("declared, progress unknown");
    expect(h.text()).toContain("Task summarize");
    expect(h.text()).toContain("Activity · 1 recent events");
    h.input(DOWN, ENTER);
    const text = h.text();
    expect(text).toContain("Workflows / a / Research");
    expect(text).toContain("Find sources");
    expect(text).not.toContain("Write report");
    expect(text).not.toContain("Nested sources");
    h.input(DOWN, ENTER, "c"); // Phase overview stays available before its attributed calls.
    await settled();
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("a", "0");
    expect(h.text()).toContain("Live callback facts");
    h.input(ESC, ESC, END, "c");
    await settled();
    expect(openConversation).toHaveBeenCalledTimes(1); // Never route a nested index into the root run.
    expect(h.text()).toContain("Nested conversation unavailable here; use /agents.");
  });

  it("keeps projected call selection stable across live additions and completed results", () => {
    const snapshot = presentation();
    const h = harness([makeRun("a", 2)], { getPresentation: () => snapshot, initialRunId: "a" });
    h.input(END);
    const calls = [...snapshot.calls];
    calls.unshift({
      id: "child:3",
      frameId: "child",
      index: 3,
      kind: "agent",
      label: "New child",
      status: "running",
      observed: true,
      journalOnly: false,
    });
    calls[calls.length - 1] = { ...calls[calls.length - 1], status: "failed", errorPreview: "failed\\u001b[2J" };
    Object.assign(snapshot, { calls });
    expect(h.text()).toContain("> ! Call 0 · Nested sources · failed");
    h.input(ENTER);
    expect(h.text()).toContain("Error: failed\\u001b[2J");
  });

  it("marks journal-only restoration as unknown and rejects malformed projection data", () => {
    const snapshot = presentation();
    Object.assign(snapshot, {
      observationSource: "journal-only",
      restored: true,
      currentPhase: undefined,
      phases: snapshot.phases.map((phase) => ({ ...phase, entered: false })),
    });
    const h = harness([makeRun("a", 2)], { getPresentation: () => snapshot, initialRunId: "a" });
    h.input(ENTER);
    expect(h.text()).toContain("restored; historical phases unknown");
    h.input(ESC);
    expect(h.text()).not.toContain("entered; completion unknown");
    Object.assign(snapshot, { calls: [{ ...snapshot.calls[0], status: "arbitrary" }] });
    expect(h.text()).toContain("Invalid presentation snapshot");
    expect(h.text()).toContain("Phase (declared, progress unknown)");
    expect(parsePresentation({ ...snapshot, runId: "other" }, "a")).toBeUndefined();
    expect(
      parsePresentation({ ...presentation(), calls: [presentation().calls[0], presentation().calls[0]] }, "a"),
    ).toBeUndefined();
    expect(
      parsePresentation({ ...presentation(), phases: [{ ...presentation().phases[0], id: "" }] }, "a"),
    ).toBeUndefined();
    expect(
      parsePresentation({ ...presentation(), calls: Array.from({ length: 2049 }, () => presentation().calls[0]) }, "a"),
    ).toBeUndefined();
  });

  it("retires a throwing presentation/source getter without eager or orphaned timers", () => {
    const h = harness([makeRun("a")], {
      initialRunId: "a",
      getPresentation: () => {
        throw new Error("projection inactive");
      },
    });
    expect(h.text()).toBe("");
    expect(h.notify).toHaveBeenCalledWith("projection inactive");
    expect(h.done).toHaveBeenCalledTimes(1);
    const other = harness();
    other.text();
    other.failSource(new Error("source inactive"));
    vi.advanceTimersByTime(1000);
    expect(other.done).toHaveBeenCalledTimes(1);
    expect(other.notify).toHaveBeenCalledWith("source inactive");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not open a neighbor when selected run disappears on the Enter boundary", () => {
    const h = harness([makeRun("a"), makeRun("b")]);
    h.text();
    h.states.delete("a");
    h.input(ENTER);
    expect(h.text()).toContain("Runs (1)");
    expect(h.text()).toContain("choose another run");
    h.input(ENTER);
    expect(h.text()).toContain("Runs (1)"); // No automatic neighbor even on another Enter.
    h.input(DOWN, ENTER);
    expect(h.text()).toContain("Workflows / b");
  });

  it("gives configured selection bindings precedence over control shortcuts", () => {
    const h = harness();
    h.keys.setUserBindings({ "tui.select.down": "x", "tui.select.confirm": "p" });
    h.input("p", "x");
    expect(h.text()).toContain("> - Phase (declared, progress unknown)");
    expect(h.control).not.toHaveBeenCalled();
    expect(h.text()).not.toContain("Stop is non-resumable");
  });
  it("reads incoming/completed state live and preserves selection by run ID", () => {
    const a = makeRun("a");
    const b = makeRun("b");
    b.startedAt = 2;
    const h = harness([a, b]);
    h.text();
    h.input(DOWN); // a, not an array index bound to b after insert.
    const c = makeRun("c");
    c.startedAt = 3;
    h.states.set(c.runId, { run: c });
    a.status = "completed";
    expect(h.text()).toContain("> + a · completed");
    h.input(ENTER);
    expect(h.text()).toContain("Workflows / a");
    expect(h.text()).not.toContain("Pause ·");
    h.input(ESC);
    expect(h.text()).toContain("> + a · completed");
  });

  it("anchors a scrolled viewport across inserted runs and cancels generation-stale stop confirmation", () => {
    const runs = Array.from({ length: 40 }, (_, i) => {
      const run = makeRun(`run-${i}`);
      run.startedAt = i;
      return run;
    });
    const h = harness(runs);
    h.input(END);
    const before = h.component.render(80).slice(2, -4);
    const extra = makeRun("new-run");
    extra.startedAt = 100;
    h.states.set(extra.runId, { run: extra, executionGeneration: 1 });
    expect(h.component.render(80).slice(2, -4)).toEqual(before);
    h.input(ENTER, "x");
    const state = h.states.get("run-0");
    if (!state) throw new Error("missing fixture state");
    state.executionGeneration = 2;
    h.input("x");
    expect(h.control).not.toHaveBeenCalled();
  });

  it("handles selected run removal while inspecting without targeting a neighbor", () => {
    const h = harness([makeRun("a"), makeRun("b")]);
    h.input(ENTER);
    h.states.delete("a");
    h.input("x");
    expect(h.control).not.toHaveBeenCalled();
    expect(h.text()).toContain("Selected run was removed.");
    expect(h.text()).toContain("Runs (1)");
  });

  it.each([6, 7, 24, 40].flatMap((rows) => [0, 30, 1000].map((calls) => ({ rows, calls }))))(
    "bounds list and keeps controls pinned at $rows rows / $calls calls",
    ({ rows, calls }) => {
      const h = harness([makeRun("a", calls)]);
      h.terminal.rows = rows;
      h.input(ENTER);
      for (const key of [PAGE_DOWN, PAGE_DOWN, PAGE_UP, END, HOME]) {
        h.input(key);
        expectBounds(h.component, 80, rows);
        const text = h.text(80);
        for (const label of ["Pause", "Stop", "Back"]) expect(text).toContain(label);
        expect(text).toContain("Tab controls");
      }
      h.input("\t", HOME, ENTER);
      expect(h.control).toHaveBeenCalledWith("pause", "a");
    },
  );

  it("drills into expanded call/final results with scrolling and preserved selection", () => {
    const run = makeRun("a", 2);
    run.finalResult = `final value\n${Array.from({ length: 100 }, (_, i) => `final ${i}`).join("\n")}`;
    run.callTiers["1"] = { tier: "high" };
    run.compactions["1"] = 3;
    const h = harness([run]);
    h.input(ENTER, END);
    expect(h.text()).toContain("Call 1 · completed · tier high · compactions 3");
    h.input(ENTER);
    expect(h.text()).toContain("Stored call result preview");
    h.input(END);
    expect(h.text()).toContain("line 79");
    h.input(HOME);
    expect(h.text()).toContain("Stored call result preview");
    h.input(PAGE_DOWN);
    const page = h.text();
    h.terminal.rows = 20;
    expect(h.text()).toContain("line 19");
    expect(page).not.toContain("line 0\n");
    h.input(ESC);
    expect(h.text()).toContain("> + Call 1");
    h.input(HOME, DOWN, DOWN, ENTER); // final, following overview + declared phase
    expect(h.text()).toContain("Final script result (stored preview)");
    h.input(END);
    expect(h.text()).toContain("final 99");
    h.input(ESC, ESC, ESC);
    expect(h.done).toHaveBeenCalledTimes(1);
  });

  it("keeps a logical expanded-result anchor when width changes", () => {
    const run = makeRun("a");
    run.finalResult = Array.from({ length: 80 }, (_, i) => `row-${i}: ${`segment-${i} 中文👩‍💻 `.repeat(20)}`).join(
      "\n",
    );
    const h = harness([run]);
    h.input(ENTER, HOME, DOWN, DOWN, ENTER);
    h.text(80);
    h.input(PAGE_DOWN);
    const before = h.component.render(80)[3];
    const marker = before.match(/segment-(\d+)/u)?.[1];
    expect(marker).toBeDefined();
    const narrow = h.component.render(40)[3];
    expect(narrow).toContain(`segment-${marker}`);
    const wide = h.component.render(160)[3];
    expect(wide).toContain(`segment-${marker}`);
  });

  it("honestly labels declared phases and does not infer completion", () => {
    const run = makeRun("a", 4);
    run.status = "completed";
    const h = harness([run]);
    h.input(ENTER, DOWN, ENTER);
    expect(h.text()).toContain("Progress unknown; declarations do not prove execution or completion.");
    expect(formatWorkflowDetail(h.engine, "a")).toContain("Phase (declared, progress unknown)");
  });

  it("uses injected select bindings and ignores kitty releases/repeats for confirmation", () => {
    const h = harness([makeRun("a"), makeRun("b")]);
    h.keys.setUserBindings({
      "tui.select.down": "j",
      "tui.select.up": "k",
      "tui.select.confirm": "o",
      "tui.select.cancel": "q",
      "tui.select.pageDown": "n",
      "tui.select.pageUp": "u",
    });
    h.input("j", "o");
    expect(h.text()).toContain("Workflows / b");
    expect(h.text()).toContain("j select · o open · q back");
    h.input("\u001b[120;1:3u");
    expect(h.text()).not.toContain("Stop is non-resumable");
    h.input("x", "\u001b[120;1:2u", "\u001b[120;1:3u");
    expect(h.control).not.toHaveBeenCalled();
    h.input("q");
    expect(h.text()).toContain("Stop cancelled.");
    h.input("q", "q");
    expect(h.done).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 8, 24].flatMap((rows) => [0, 1, 2, 3, 5, 12, 40].map((width) => ({ rows, width }))))(
    "handles tiny widths/heights, resize, and hostile wide outputs at $width × $rows",
    ({ rows, width }) => {
      const run = makeRun("a", 1000);
      run.meta.name = "中文 👩‍💻 e\u0301 \u001b[2J\u009btitle\u202e";
      run.callResults["0"].result = {
        toString: "not callable",
        payload: "raw\u001b[2J\u0000\u202e中文👩‍💻 e\u0301\n".repeat(200),
      };
      run.error = "error\u0000raw";
      const before = JSON.stringify(run);
      const h = harness([run]);
      h.terminal.rows = rows;
      expectBounds(h.component, width, rows);
      h.input(ENTER, END);
      expectBounds(h.component, width, rows);
      h.input(HOME, DOWN, DOWN, DOWN, ENTER, PAGE_DOWN);
      expectBounds(h.component, width, rows);
      h.terminal.rows = 24;
      expectBounds(h.component, 40, 24);
      expect(JSON.stringify(run)).toBe(before);
      const detail = formatWorkflowDetail(h.engine, "a");
      for (const control of ["\u0000", "\u001b", "\u009b", "\u202e"]) expect(detail).not.toContain(control);
      expect(detail).toContain("raw\\u001b[2J\\u0000\\u202e");
    },
  );

  it("bounds expanded output, phase declarations, and pathological viewport dimensions", () => {
    const run = makeRun("a", 1);
    run.meta.phases = Array.from({ length: 1000 }, (_, i) => ({ title: `phase ${i}` }));
    run.callResults["0"].result = "中文👩‍💻\\u001b[2J".repeat(10_000);
    const before = JSON.stringify(run);
    const h = harness([run], { initialRunId: "a" });
    h.input(END);
    expect(h.text()).toContain("Items 259/259");
    h.input(ENTER);
    h.text();
    h.input(END);
    expect(h.text()).toContain("Display limited to 16000 characters");
    h.terminal.rows = 100_000;
    expect(h.component.render(100_000).length).toBeLessThanOrEqual(120);
    for (const line of h.component.render(100_000)) expect(visibleWidth(line)).toBeLessThanOrEqual(500);
    for (const width of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(h.component.render(width)).toEqual([]);
    expect(JSON.stringify(run)).toBe(before);
  });

  it("styles on demand, with sanitized display copies passed into the theme", () => {
    const run = makeRun("\u001b[2J", 1);
    const h = harness([run]);
    expect(h.text()).not.toContain("\u001b");
    h.changeTheme("\u001b[32m");
    h.component.invalidate();
    expect(h.text()).toContain("\u001b[32m");
    expect(h.text()).not.toContain("\u001b[2J");
  });

  it("requires a different confirmation key, allows cancellation, and blocks busy dispatch", async () => {
    const h = harness();
    let release = () => {};
    h.control.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ action: "stop" });
        }),
    );
    h.input(ENTER, "x");
    expect(h.text()).toContain("Stop is non-resumable");
    expect(h.control).not.toHaveBeenCalled();
    h.input(ESC);
    expect(h.control).not.toHaveBeenCalled();
    h.input("x", "x", "x", ENTER, ENTER);
    expect(h.control).not.toHaveBeenCalled();
    h.input("y", "x", "p", "r");
    expect(h.control).toHaveBeenCalledExactlyOnceWith("stop", "run-a");
    release();
    await settled();
    expect(h.text()).toContain("Workflow stop requested.");
  });

  it("exposes Stop through always reachable action focus even with 1000 calls", () => {
    const h = harness([makeRun("a", 1000)]);
    h.input(ENTER, END, "\t", HOME, DOWN, ENTER);
    expect(h.control).not.toHaveBeenCalled();
    h.input(ENTER, ENTER);
    expect(h.control).not.toHaveBeenCalled();
    h.input("y");
    expect(h.control).toHaveBeenCalledExactlyOnceWith("stop", "a");
  });

  it.each(["pending", "pausing", "stopping", "completed", "failed", "stopped"] as const)(
    "rejects illegal pause/resume in %s",
    (status) => {
      const run = makeRun();
      run.status = status;
      const h = harness([run]);
      h.input(ENTER, "p", "r");
      expect(h.control).not.toHaveBeenCalled();
      expect(h.text()).toContain(`resume is unavailable in state ${status}`);
    },
  );

  it.each(["paused", "interrupted"] as const)(
    "supports legal resume and fences non-resumable %s runs",
    async (status) => {
      const run = makeRun();
      run.status = status;
      const h = harness([run]);
      h.input(ENTER, "r");
      await settled();
      expect(h.control).toHaveBeenCalledExactlyOnceWith("resume", run.runId);
      run.nonResumable = true;
      h.input("r");
      expect(h.control).toHaveBeenCalledTimes(1);
      expect(h.text()).toContain("resume is unavailable");
    },
  );

  it("never dispatches a control under a mismatched root run identity", () => {
    const run = makeRun("a");
    const h = harness([run], { initialRunId: "a" });
    h.text();
    run.runId = "different-root";
    h.input("p", "x", "x");
    expect(h.control).not.toHaveBeenCalled();
    expect(h.text()).toContain("Workflow run is no longer available.");
  });

  it("revalidates state, status, and engine after confirmation", () => {
    const h = harness();
    h.input(ENTER, "x");
    const replacement = makeRun();
    h.states.set(replacement.runId, { run: replacement });
    h.input("x");
    expect(h.control).not.toHaveBeenCalled();
    replacement.status = "completed";
    h.input("x");
    expect(h.control).not.toHaveBeenCalled();
    expect(h.text()).toContain("stop is unavailable");
    h.setSource(fakeEngine([makeRun()]).engine);
    h.input("p");
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith("Workflow engine changed; reopen /workflows.");
  });

  it("shows async errors and fences stale results from a replacement engine/session", async () => {
    const h = harness();
    h.control.mockRejectedValueOnce(new Error("pause failed\u001b[2J"));
    h.input(ENTER, "p");
    await settled();
    expect(h.text()).toContain("pause failed\\u001b[2J");
    let reject = (_error: Error) => {};
    h.control.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    h.input("p");
    h.replaceSession();
    reject(new Error("stale failure"));
    await settled();
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith("Workflow session changed; reopen /workflows.");
    expect(h.text()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires source errors and cleans mount refresh timers", () => {
    const h = harness();
    expect(vi.getTimerCount()).toBe(0);
    h.text();
    expect(vi.getTimerCount()).toBe(1);
    expect(h.requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(h.requestRender).toHaveBeenCalledTimes(1);
    h.setSource({
      list() {
        throw new Error("inactive surface");
      },
    } as unknown as WorkflowEngine);
    vi.advanceTimersByTime(1000);
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    h.component.dispose();
    h.input(ENTER);
    expect(h.done).toHaveBeenCalledTimes(1);
  });

  it("closes while a control/conversation is pending without late renders or unhandled rejection", async () => {
    let reject = (_error: Error) => {};
    const h = harness([makeRun("a", 1)], {
      openConversation: () =>
        new Promise((_resolve, failure) => {
          reject = failure;
        }),
    });
    h.input(ENTER, END, ENTER);
    h.text();
    h.input("c", ESC, ESC, ESC);
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const renders = h.requestRender.mock.calls.length;
    reject(new Error("late rejection"));
    await settled();
    expect(h.requestRender).toHaveBeenCalledTimes(renders);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("exposes optional conversation adapter only for selected calls, with errors visible", async () => {
    const openConversation = vi.fn(async () => {
      throw new Error("conversation unavailable");
    });
    const h = harness([makeRun("a", 1)], { openConversation });
    h.input(ENTER, END, "c");
    await settled();
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("a", "0");
    expect(h.text()).toContain("conversation unavailable");
    h.input(HOME, "c");
    await settled();
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(h.text()).toContain("Select a call");
  });
});

describe("workflow helper contracts and custom mount lifecycle", () => {
  it("retains usable safe helpers and bounded widgets", () => {
    const run = makeRun("\u001b[2J", 1000);
    expect(formatWorkflowRunLabel(run)).toContain("1000 calls");
    expect(formatWorkflowRunLabel(run)).not.toContain("\u001b");
    expect(liveWidgetLines([run], "detailed", Number.NaN).length).toBeLessThanOrEqual(43);
    expect(liveWidgetLines([run], "detailed", 1000).length).toBeLessThanOrEqual(1057);
    run.status = "completed";
    expect(liveWidgetLines([run])).toEqual([]);
    expect(workflowActionsFor("running").map((item) => item.value)).toEqual(["pause", "stop", "back"]);
    expect(workflowActionsFor("stopping").map((item) => item.value)).toEqual(["back"]);
    expect(formatWorkflowDetail(fakeEngine([]).engine, "missing")).toContain("no longer available");
  });

  it.each(["rpc", "json", "print", "tui"] as const)("does not mount custom UI without hasUI in %s", async (mode) => {
    const custom = vi.fn();
    const ctx = { mode, hasUI: false, ui: { custom, notify: vi.fn() } } as unknown as ExtensionCommandContext;
    await showWorkflowNavigator(ctx, () => {
      throw new Error("must not resolve engine");
    });
    expect(custom).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rpc", "json", "print"] as const)("rejects %s even when dialog-capable hasUI is true", async (mode) => {
    const custom = vi.fn();
    const ctx = { mode, hasUI: true, ui: { custom, notify: vi.fn() } } as unknown as ExtensionCommandContext;
    await showWorkflowNavigator(ctx, () => {
      throw new Error("must not resolve engine");
    });
    expect(custom).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owns one live component and disposes on external cancellation/custom rejection", async () => {
    const h = harness();
    const notify = vi.fn();
    const custom = vi.fn(async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
      const component = await factory(
        { terminal: h.terminal, requestRender: vi.fn() } as unknown as TUI,
        { fg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme,
        h.keys as unknown as Parameters<typeof factory>[2],
        () => {},
      );
      component.render(80);
      expect(vi.getTimerCount()).toBe(1);
      throw new Error("custom cancelled");
    });
    const ctx = {
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "session-a" },
      ui: { custom, notify },
    } as unknown as ExtensionCommandContext;
    await showWorkflowNavigator(ctx, h.engine);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("custom cancelled", "error");
    expect(vi.getTimerCount()).toBe(0);
  });
});
