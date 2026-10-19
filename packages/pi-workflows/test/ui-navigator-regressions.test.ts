import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEngine } from "../src/engine.js";
import type { WorkflowInspectionHeader } from "../src/inspection.js";
import type { ScriptRun } from "../src/journal.js";
import { WorkflowCommandCenter } from "../src/ui-command-center.js";
import { parsePresentation, type WorkflowPresentationSnapshot } from "../src/ui-inspection.js";

const ENTER = "\r";
const ESC = "\u001b";
const DOWN = "\u001b[B";
const HOME = "\u001b[H";
const END = "\u001b[F";
type Projection = { -readonly [K in keyof WorkflowPresentationSnapshot]: WorkflowPresentationSnapshot[K] };

function snapshot(): Projection {
  return {
    runId: "root",
    executionId: "exec-1",
    executionGeneration: 1,
    revision: 1,
    observationSource: "execution",
    restored: false,
    truncated: false,
    currentPhase: "Research",
    currentPhaseKey: "phase-key-a",
    logicalCalls: 2,
    replayedCalls: 0,
    physicalDispatches: 2,
    phases: [
      {
        id: "phase-a",
        phaseKey: "phase-key-a",
        frameId: "root",
        title: "Research",
        detail: "Research detail",
        declared: true,
        entered: true,
      },
      { id: "phase-b", phaseKey: "phase-key-b", frameId: "root", title: "Write", declared: true, entered: false },
    ],
    calls: [
      {
        id: "root:0",
        frameId: "root",
        index: 0,
        kind: "agent",
        label: "First call",
        phase: "Research",
        phaseKey: "phase-key-a",
        status: "running",
        observed: true,
        journalOnly: false,
        graphId: "graph-a",
        taskKey: "task-a",
        taskId: "same",
      },
      {
        id: "root:1",
        frameId: "root",
        index: 1,
        kind: "agent",
        label: "Neighbor call",
        phase: "Write",
        phaseKey: "phase-key-b",
        status: "completed",
        observed: true,
        journalOnly: false,
        graphId: "graph-b",
        taskKey: "task-b",
        taskId: "same",
      },
    ],
    tasks: [
      {
        id: "task-a",
        taskId: "same",
        frameId: "root",
        graphId: "graph-a",
        phase: "Research",
        status: "failed",
        attempt: 2,
        errorPreview: "task error",
      },
      {
        id: "task-b",
        taskId: "same",
        frameId: "root",
        graphId: "graph-b",
        phase: "Write",
        status: "completed",
        attempt: 1,
      },
    ],
    events: [],
  };
}

function run(): ScriptRun {
  return {
    runId: "root",
    schemaVersion: 4,
    script: "",
    scriptHash: "hash",
    frozenArgsPresent: false,
    status: "running",
    startedAt: 1,
    updatedAt: 2,
    meta: { name: "root", description: "Root description", phases: [{ title: "Journal phase" }] },
    callStatus: { "0": "running", "1": "completed" },
    callResults: {},
    agentIds: {},
    attempts: {},
    attemptIds: {},
    callTiers: {},
    workflowResultGenerations: {},
    compactions: {},
  };
}

const mounted: WorkflowCommandCenter[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const component of mounted.splice(0)) component.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

function harness(authoritative = false, hook = true) {
  const journal = run();
  const state = { run: journal, executionGeneration: 1 };
  let projection: unknown = snapshot();
  let header: WorkflowInspectionHeader | undefined = {
    executionId: "exec-1",
    executionGeneration: 1,
    revision: 1,
    restored: false,
  };
  const control = vi.fn(async () => ({}));
  const conversation = vi.fn(async () => {});
  const engine = {
    list: () => [{ runId: journal.runId }],
    getRun: (id: string) => (id === journal.runId ? journal : undefined),
    getState: (id: string) => (id === journal.runId ? state : undefined),
    control,
    ...(authoritative ? { getInspectionHeader: () => header } : {}),
  } as unknown as WorkflowEngine;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const component = new WorkflowCommandCenter(
    { terminal: { rows: 40 }, requestRender: vi.fn() } as unknown as Pick<TUI, "terminal" | "requestRender">,
    { fg: (_name: string, text: string) => text, bold: (text: string) => text } as Pick<Theme, "fg" | "bold">,
    keys,
    () => engine,
    () => true,
    vi.fn(),
    vi.fn(),
    { initialRunId: "root", getPresentation: () => projection, ...(hook ? { openConversation: conversation } : {}) },
  );
  mounted.push(component);
  return {
    component,
    engine,
    journal,
    state,
    control,
    conversation,
    keys,
    set projection(value: unknown) {
      projection = value;
    },
    set header(value: WorkflowInspectionHeader | undefined) {
      header = value;
    },
    input(...inputs: string[]) {
      for (const input of inputs) component.handleInput(input);
    },
    text() {
      return component.render(220).join("\n");
    },
  };
}

const settled = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("navigator control confirmation and key ownership", () => {
  it("never stops for raw held x or Enter alone; only x then y confirms", () => {
    const h = harness();
    h.input(...Array.from({ length: 50 }, () => "x"), ...Array.from({ length: 50 }, () => ENTER));
    expect(h.control).not.toHaveBeenCalled();
    expect(h.text()).toContain("y confirms");
    expect(h.text()).not.toContain("x×2");
    h.input("y");
    expect(h.control).toHaveBeenCalledExactlyOnceWith("stop", "root");
  });

  it("never stops for raw held Enter on the Stop action", () => {
    const h = harness();
    h.input("\t", HOME, DOWN, ...Array.from({ length: 50 }, () => ENTER));
    expect(h.control).not.toHaveBeenCalled();
    h.input("y");
    expect(h.control).toHaveBeenCalledExactlyOnceWith("stop", "root");
  });

  it("requires another key even when configured confirm=y arms Stop", () => {
    const h = harness();
    h.keys.setUserBindings({ "tui.select.confirm": "y" });
    h.input("\t", HOME, DOWN, ...Array.from({ length: 50 }, () => "y"));
    expect(h.control).not.toHaveBeenCalled();
    expect(h.text()).toContain("s confirms");
    h.input("s");
    expect(h.control).toHaveBeenCalledExactlyOnceWith("stop", "root");
  });

  it("ignores Kitty releases/repeats when arming and confirming", () => {
    const h = harness();
    h.input("\u001b[120;1:2u", "\u001b[120;1:3u");
    expect(h.text()).not.toContain("y confirms");
    h.input("x", "\u001b[121;1:2u", "\u001b[121;1:3u", ENTER, "x");
    expect(h.control).not.toHaveBeenCalled();
    h.input("\u001b[121;1:1u");
    expect(h.control).toHaveBeenCalledExactlyOnceWith("stop", "root");
  });

  it("modal yes/no owns its keys even when y/n are ordinary configured actions", () => {
    const h = harness();
    h.keys.setUserBindings({ "tui.select.down": "y", "tui.select.confirm": "n" });
    h.input("x", "n");
    expect(h.text()).toContain("Stop cancelled.");
    h.input("x", "y");
    expect(h.control).toHaveBeenCalledExactlyOnceWith("stop", "root");
  });

  it("cancels confirmation when the captured state object is replaced", () => {
    const h = harness();
    h.input("x");
    Object.assign(h.engine, { getState: () => ({ ...h.state }) });
    h.input("y");
    expect(h.control).not.toHaveBeenCalled();
    expect(h.text()).toContain("stop confirmation cancelled");
  });

  it.each(["status", "generation"])("cancels stale %s confirmation", (change) => {
    const h = harness();
    h.input("x");
    if (change === "status") h.journal.status = "paused";
    else h.state.executionGeneration++;
    h.input("y");
    expect(h.control).not.toHaveBeenCalled();
    expect(h.text()).toContain("stop confirmation cancelled");
  });

  it.each([
    ["tab", "\t"],
    ["down", DOWN],
    ["home", HOME],
    ["end", END],
  ] as const)("configured confirm=%s wins over fixed/fallback keys", (binding, input) => {
    const h = harness();
    h.keys.setUserBindings({ "tui.select.down": "j", "tui.select.confirm": binding });
    h.input(input);
    expect(h.text()).toContain("Root description"); // Overview expanded, not movement/focus.
    h.input(ESC, "j");
    expect(h.text()).toContain("> - Phase");
    if (binding === "tab") expect(h.text()).toContain("Ctrl+O controls");
  });

  it("configured up=Home takes priority and shortcut help hides collisions", () => {
    const h = harness();
    h.keys.setUserBindings({ "tui.select.up": "home", "tui.select.down": "x", "tui.select.confirm": "p" });
    h.input(END, HOME);
    expect(h.text()).toContain("> > Call 0 · First call");
    expect(h.text()).not.toContain("Home/End");
    expect(h.text()).not.toContain("x then y");
    expect(h.text()).not.toContain("p pause");
    expect(h.control).not.toHaveBeenCalled();
  });

  it.each(["failed", "stopping"] as const)(
    "offers cleanup retry in %s only while authoritative cleanup remains",
    (status) => {
      const h = harness();
      h.journal.status = status;
      let pending = false;
      Object.assign(h.engine, { hasPendingCleanup: () => pending });
      expect(h.text()).not.toContain("Retry cleanup");
      pending = true;
      expect(h.text()).toContain("Retry cleanup");
      h.input("x");
      pending = false;
      h.input("y");
      expect(h.control).not.toHaveBeenCalled();
      pending = true;
      h.input("x", "y");
      expect(h.control).toHaveBeenCalledExactlyOnceWith("stop", "root");
      expect(h.journal.status).toBe(status); // Request does not claim cleanup settlement.
    },
  );

  it("retains legacy actions without inventing cleanup from failed/stopping status", () => {
    const h = harness();
    h.journal.status = "failed";
    h.input("x", "y");
    expect(h.control).not.toHaveBeenCalled();
    expect(h.text()).not.toContain("Retry cleanup");
  });
});

describe("navigator projection identity and disappearing selections", () => {
  it.each(["c", ENTER])("does not activate a neighbor after projected call eviction via %j", async (activation) => {
    const p = snapshot();
    const h = harness();
    h.projection = p;
    h.input(END);
    p.calls = p.calls.slice(0, 1); // The journal fallback still contains call 1.
    h.input(activation, ENTER, "c");
    await settled();
    expect(h.conversation).not.toHaveBeenCalled();
    expect(h.text()).toContain("Items 0/");
    h.input(END, "c");
    await settled();
    expect(h.conversation).toHaveBeenCalledExactlyOnceWith("root", "1");
  });

  it("clears an expanded evicted call even if render discovered removal before input", async () => {
    const p = snapshot();
    const h = harness();
    h.projection = p;
    h.input(END, ENTER);
    p.calls = [];
    expect(h.text()).toContain("Selected detail is gone");
    h.input("c", ENTER);
    await settled();
    expect(h.conversation).not.toHaveBeenCalled();
    expect(h.text()).not.toContain("Stored call result preview");
  });

  it("keeps journal declaration identity across reorder and clears it on removal", () => {
    const h = harness();
    h.projection = undefined;
    h.journal.meta.phases = [{ title: "First declaration" }, { title: "Second declaration" }];
    h.input(DOWN);
    h.journal.meta.phases.reverse();
    h.input(ENTER);
    expect(h.text()).toContain("Declared phase: First declaration");
    h.journal.meta.phases = [{ title: "Second declaration" }];
    h.input(ENTER, ENTER);
    expect(h.text()).toContain("Selected detail is gone");
    expect(h.text()).toContain("Items 0/");
    expect(h.text()).not.toContain("Declared phase: Second declaration");
  });

  it.each(["phase", "task"])("consumes Enter after selected %s removal", (kind) => {
    const p = snapshot();
    const h = harness();
    h.projection = p;
    h.input(HOME, DOWN);
    if (kind === "task") h.input(DOWN, DOWN, DOWN); // overview, phases, final, task-a
    if (kind === "phase") p.phases = p.phases.slice(1);
    else p.tasks = p.tasks.slice(1);
    h.input(ENTER, ENTER);
    expect(h.text()).toContain("Selected item is gone");
    expect(h.text()).toContain("Items 0/");
    expect(h.text()).not.toContain("Workflows / root / ");
  });

  it.each(["phase", "task"])("clears a removed scoped %s and never routes c to a root neighbor", async (kind) => {
    const p = snapshot();
    const h = harness();
    h.projection = p;
    h.input(HOME, DOWN);
    if (kind === "task") h.input(DOWN, DOWN, DOWN);
    h.input(ENTER, END, ENTER);
    if (kind === "phase") p.phases = [];
    else p.tasks = [];
    h.input("c", ENTER);
    await settled();
    expect(h.conversation).not.toHaveBeenCalled();
    expect(h.text()).toContain(`Selected ${kind} is gone`);
    expect(h.text()).toContain("Items 0/");
  });

  it.each(["executionId", "executionGeneration", "revision"] as const)(
    "rejects stale %s against the authoritative header",
    async (field) => {
      const p = snapshot();
      const h = harness(true);
      h.projection = p;
      h.input(END);
      Object.assign(p, { [field]: field === "executionId" ? "old-exec" : 0 });
      h.input("c", ENTER);
      await settled();
      expect(h.conversation).not.toHaveBeenCalled();
      expect(h.text()).toContain("stale or malformed");
      expect(h.text()).toContain("Journal phase");
      expect(h.text()).not.toContain("Neighbor call");
      expect(h.text()).toContain("Items 0/");
      h.input("p"); // Projection is never control authority.
      expect(h.control).toHaveBeenCalledExactlyOnceWith("pause", "root");
    },
  );

  it("clears selection on a valid new execution even when IDs are reused", async () => {
    const p = snapshot();
    const h = harness(true);
    h.projection = p;
    h.input(END);
    p.executionId = "exec-2";
    p.executionGeneration = 2;
    h.state.executionGeneration = 2;
    h.header = { executionId: "exec-2", executionGeneration: 2, revision: 1, restored: false };
    h.input("c", ENTER);
    await settled();
    expect(h.conversation).not.toHaveBeenCalled();
    expect(h.text()).toContain("Execution changed");
    h.input(END, "c");
    await settled();
    expect(h.conversation).toHaveBeenCalledExactlyOnceWith("root", "1");
  });

  it("rejects revision regression without an authoritative header and does not claim freshness", () => {
    const p = snapshot();
    const h = harness();
    h.projection = p;
    p.revision = 5;
    h.input(ENTER);
    expect(h.text()).toContain("Adapter freshness unverified");
    h.input(ESC, END);
    p.revision = 4;
    h.input(ENTER);
    expect(h.text()).toContain("stale or malformed");
    p.revision = 5;
    h.input(ENTER);
    expect(h.text()).toContain("Items 0/");
  });

  it("rejects an old same-run snapshot after the authoritative generation advances", async () => {
    const h = harness(true);
    h.input(END, ENTER);
    h.state.executionGeneration = 2;
    h.header = { executionId: "exec-2", executionGeneration: 2, revision: 10, restored: false };
    h.input("c", ENTER);
    await settled();
    expect(h.conversation).not.toHaveBeenCalled();
    expect(h.text()).toContain("stale or malformed");
    expect(h.text()).toContain("Items 0/");
  });

  it("leaves journal declarations navigable while a stale adapter remains rejected", () => {
    const h = harness(true);
    const p = snapshot();
    p.executionId = "old-execution";
    h.projection = p;
    h.input(HOME, DOWN, ENTER);
    expect(h.text()).toContain("Declared phase: Journal phase");
  });

  it("accepts optional legacy metadata only with exact execution identity when a header exists", () => {
    const h = harness(true);
    const p = snapshot();
    delete p.executionGeneration;
    delete p.revision;
    h.projection = p;
    expect(h.text()).toContain("First call");
    p.executionId = "different";
    expect(h.text()).toContain("stale or malformed");
    h.header = undefined;
    p.executionId = "exec-1";
    expect(h.text()).toContain("stale or malformed");
  });

  it.each(["revision", "executionGeneration", "currentPhaseKey"])(
    "validates optional %s metadata at the boundary",
    (field) => {
      expect(
        parsePresentation({ ...snapshot(), [field]: field === "currentPhaseKey" ? 5 : -1 }, "root"),
      ).toBeUndefined();
    },
  );
});

describe("navigator exact bounded drilldown and conversation hints", () => {
  it("filters colliding long phase prefixes using exact keys and retains phase overview", () => {
    const p = snapshot();
    const title = "prefix".repeat(80);
    p.phases = p.phases.map((phase) => ({ ...phase, title, detail: "Full phase detail" }));
    p.calls = p.calls.map((call) => ({ ...call, phase: title }));
    p.currentPhase = title;
    const h = harness();
    h.projection = p;
    const root = h.text();
    expect(root.match(/; current/gu)).toHaveLength(1);
    h.input(DOWN, ENTER);
    expect(h.text()).toContain("Phase overview / details");
    expect(h.text()).toContain("First call");
    expect(h.text()).not.toContain("Neighbor call");
    h.input(ENTER);
    expect(h.text()).toContain("Full phase detail");
    h.input(ESC, ESC);
    expect(h.text()).toContain("> - Phase");
  });

  it("never falls back to labels if only one side supplies a phase key", () => {
    const p = snapshot();
    p.calls = p.calls.map(({ phaseKey: _key, ...call }) => call);
    const h = harness();
    h.projection = p;
    h.input(DOWN, ENTER);
    expect(h.text()).not.toContain("First call");
    expect(h.text()).toContain("No observed calls attributed");
  });

  it("shows ambiguous attribution for colliding legacy titles instead of false exact calls/current", () => {
    const p = snapshot();
    const title = "a".repeat(512);
    delete p.currentPhaseKey;
    p.currentPhase = title;
    p.phases = p.phases.map(({ phaseKey: _key, ...phase }) => ({ ...phase, title }));
    p.calls = p.calls.map(({ phaseKey: _key, ...call }) => ({ ...call, phase: title }));
    const h = harness();
    h.projection = p;
    expect(h.text()).not.toContain("; current");
    h.input(DOWN, ENTER);
    expect(h.text()).toContain("Ambiguous phase attribution");
    expect(h.text()).not.toContain("First call");
    expect(h.text()).not.toContain("Neighbor call");
  });

  it("task scope links exact taskKey/frame/graph, shows errors/attempts and preserves parent ID", () => {
    const p = snapshot();
    p.calls = [
      ...p.calls,
      { ...p.calls[0], id: "wrong-frame:0", frameId: "wrong-frame", label: "Wrong frame" },
      { ...p.calls[0], id: "root:2", index: 2, graphId: "wrong-graph", label: "Wrong graph" },
      { ...p.calls[0], id: "root:3", index: 3, taskKey: "unlinked", label: "Wrong task key" },
    ];
    const h = harness();
    h.projection = p;
    expect(h.text()).toContain("Task same [#1]");
    expect(h.text()).toContain("Task same [#2]");
    h.input(HOME, DOWN, DOWN, DOWN, DOWN, ENTER);
    const scope = h.text();
    expect(scope).toContain("Task same");
    expect(scope).toContain("attempt 2");
    expect(scope).toContain("First call");
    for (const label of ["Neighbor call", "Wrong frame", "Wrong graph", "Wrong task key"])
      expect(scope).not.toContain(label);
    h.input(ENTER);
    expect(h.text()).toContain("Error: task error");
    expect(h.text()).toContain("Graph: graph-a");
    h.input(ESC, ESC);
    expect(h.text()).toContain("> ! Task same [#1]");
  });

  it("keeps duplicate task discriminators visible when their bounded key prefixes collide", () => {
    const p = snapshot();
    p.tasks = p.tasks.map((task, index) => ({
      ...task,
      id: `${"prefix".repeat(80)}-${index}`,
      graphId: "graph".repeat(100),
    }));
    const h = harness();
    h.projection = p;
    const text = h.component.render(80).join("\n");
    expect(text).toContain("Task same [#1] · failed · attempt 2");
    expect(text).toContain("Task same [#2] · completed · attempt 1");
  });

  it("allows phase to task to call drilldown, restoring each scoped selection by ID", async () => {
    const h = harness();
    h.input(DOWN, ENTER, DOWN, ENTER, END, "c");
    expect(h.text()).toContain("Workflows / root / Research / Task same");
    await settled();
    expect(h.conversation).toHaveBeenCalledExactlyOnceWith("root", "0");
    h.input(ESC);
    expect(h.text()).toContain("> ! Task same [#1]");
    h.input(ESC);
    expect(h.text()).toContain("> - Phase");
  });

  it.each(["checkpoint", "workflow", "unknown"] as const)(
    "hides conversation shortcut and explains %s calls",
    async (kind) => {
      const h = harness();
      const p = snapshot();
      p.calls = [{ ...p.calls[0], kind }];
      delete h.journal.callStatus["1"];
      h.projection = p;
      h.input(END);
      expect(h.text()).not.toContain("c conversation");
      expect(h.text()).toContain(`${kind} call is not an agent`);
      h.input("c");
      await settled();
      expect(h.conversation).not.toHaveBeenCalled();
    },
  );

  it("never passes a nested numeric index to the root adapter", async () => {
    const h = harness();
    const p = snapshot();
    p.calls = [...p.calls, { ...p.calls[0], id: "nested:0", frameId: "nested", label: "Nested" }];
    h.projection = p;
    h.input(END);
    expect(h.text()).toContain("Nested conversation unavailable here; use /agents.");
    expect(h.text()).not.toContain("c conversation");
    h.input(ENTER, "c");
    await settled();
    expect(h.conversation).not.toHaveBeenCalled();
  });

  it("shows a root-only conversation hint or an absent-hook reason for the selected agent", () => {
    const h = harness();
    expect(h.text()).not.toContain("c conversation");
    h.input(END);
    expect(h.text()).toContain("c conversation");
    const noHook = harness(false, false);
    noHook.input(END);
    expect(noHook.text()).not.toContain("c conversation");
    expect(noHook.text()).toContain("no host hook; use /agents");
  });
});
