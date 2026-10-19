import { describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import { WorkflowPresentation } from "../src/inspection.js";
import {
  buildResumeJournal,
  buildWorkflowGenerations,
  JOURNAL_ENTRY_TYPE,
  type JournalEvent,
  replayJournal,
} from "../src/journal.js";
import type { ManagedSpawnClient, WorkflowEventBus } from "../src/rpc-client.js";
import {
  type JournalEntry,
  MAX_RUNTIME_IDENTITY_LENGTH,
  runWorkflow,
  type WorkflowRuntimeEvent,
} from "../src/runtime.js";

const META = 'export const meta = {name:"boundaries",description:"test"};';
const session = (data: JournalEvent) => ({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data });
function bus(): WorkflowEventBus {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  return {
    on(name, handler) {
      const set = handlers.get(name) ?? new Set();
      set.add(handler);
      handlers.set(name, set);
      return () => set.delete(handler);
    },
    emit(name, value) {
      for (const handler of handlers.get(name) ?? []) handler(value);
    },
  };
}
function engineFixture() {
  const facts: JournalEvent[] = [];
  let sequence = 0;
  const spawn = vi.fn<ManagedSpawnClient["spawn"]>(async (task) => ({
    id: `agent-${++sequence}`,
    terminal: {
      status: task.prompt === "failed agent" ? "failed" : "completed",
      result: task.prompt === "failed agent" ? undefined : "answer",
      error: task.prompt === "failed agent" ? "failed" : undefined,
      compactionCount: 0,
      completedAt: Date.now(),
    },
  }));
  const client: ManagedSpawnClient = {
    spawn,
    stop: async () => {},
    stopOwned: async () => {},
    quiesceOwned: async () => ({ settled: true, pending: [] }),
    reconcileManaged: async () => undefined,
    checkProtocol: async () => ({ routingPolicyFingerprint: "test" }),
  };
  const engine = new WorkflowEngine(bus(), client, { append: (event) => facts.push(structuredClone(event)) });
  return { engine, facts, spawn, entries: () => facts.map(session) };
}

describe("nested runtime boundaries", () => {
  it("restores the actual child A → failed agent → child B engine chain without recycling its generation", async () => {
    const fixture = engineFixture();
    const { engine, facts, entries } = fixture;
    const loadSavedWorkflow = (name: string) =>
      `${META} await agent(${JSON.stringify(name)}); return ${JSON.stringify(name)};`;
    try {
      const first = await engine.start(`${META} await workflow("A"); throw new Error("later failure");`, {
        loadSavedWorkflow,
        args: { frozen: true },
      });
      expect(first.status).toBe("failed");
      expect(facts.find((event) => event.kind === "workflow_result")).toMatchObject({ generation: 1 });
      await engine.resume(
        first.runId,
        entries(),
        {},
        `${META} await agent("failed agent"); throw new Error("fail again");`,
      );
      expect(engine.getRun(first.runId)?.status).toBe("failed");
      expect(buildResumeJournal(entries()).has(`${first.runId}:0`)).toBe(false);
      await engine.resume(first.runId, entries(), { loadSavedWorkflow }, `${META} return await workflow("B");`);
      expect(engine.getRun(first.runId)?.status).toBe("completed");
      expect(replayJournal(entries()).get(first.runId)).toMatchObject({
        status: "completed",
        args: { frozen: true },
        workflowResultGenerations: { "0": 2 },
        callResults: { "0": { result: "B" } },
      });
      engine.restore(entries());
      expect(engine.getRun(first.runId)?.status).toBe("completed");
    } finally {
      engine.dispose();
    }
  });

  it("keeps nested verify/retry/gate events associated with inherited origin through real helper IPC", async () => {
    const events: WorkflowRuntimeEvent[] = [];
    const child = `${META}
      phase("child phase");
      await verify("claim",{reviewers:1});
      await retry(i => checkpoint("retry"),{attempts:2,until:() => false});
      await gate(() => checkpoint("gate"),() => ({ok:true}));
      return "done";`;
    await runWorkflow(
      `${META} return await parallel([0,1].map(i => () => orchestrate([
      {id:"origin",phase:"task phase",run:() => workflow("child")}
    ])));`,
      {
        runId: "root",
        loadSavedWorkflow: () => child,
        agent: { run: async () => '{"real":true}' },
        onRuntimeEvent: (event) => events.push(event),
      },
    );
    const starts = events.filter((event) => event.type === "workflow" && event.stage === "start");
    expect(new Set(starts.map((event) => event.graphId)).size).toBe(2);
    for (const start of starts) {
      const helpers = events.filter(
        (event) => event.frameId === start.childFrameId && ["verify", "retry", "gate"].includes(String(event.helper)),
      );
      expect(helpers).toHaveLength(5);
      for (const event of helpers)
        expect(event).toMatchObject({ graphId: start.graphId, taskKey: start.taskKey, taskId: "origin" });
    }
  });

  it("copies independent multi-index watermarks without replaying invalidated results or seeding child frames", async () => {
    const aggregate = { workflowResultGenerations: { "0": 3, "1": 7, "2": 9 } };
    const watermarks = buildWorkflowGenerations(aggregate);
    aggregate.workflowResultGenerations["0"] = 100;
    expect(watermarks.get(0)).toBe(3);
    const events: WorkflowRuntimeEvent[] = [];
    const journal: JournalEntry[] = [];
    const inputSeeds = new Map(watermarks);
    const run = vi.fn(async () => "live");
    await runWorkflow(`${META} return await parallel([() => workflow("A"),() => workflow("B"),() => workflow("C")]);`, {
      runId: "root",
      resumeWorkflowGenerations: inputSeeds,
      agent: { run },
      loadSavedWorkflow: () => `${META} await checkpoint("child"); return await agent("live");`,
      onRuntimeEvent: (event) => {
        events.push(event);
        inputSeeds.set(1, 999); // Runtime must already own a detached frame snapshot.
      },
      onWorkflowJournal: (entry) => journal.push(entry),
    });
    expect(run).toHaveBeenCalledTimes(3);
    expect(journal.map((entry) => [entry.index, entry.generation]).sort(([a], [b]) => Number(a) - Number(b))).toEqual([
      [0, 4],
      [1, 8],
      [2, 10],
    ]);
    expect(watermarks.get(0)).toBe(3);
    const children = events.filter((event) => event.type === "workflow" && event.stage === "start");
    expect(new Set(children.map((event) => event.childFrameId)).size).toBe(3);
    expect(
      events
        .filter((event) => event.helper === "checkpoint" && event.stage === "start")
        .every((event) => event.callIndex === 0),
    ).toBe(true);

    // An eligible replay is not a generation reset. A stale/lower candidate
    // cannot make a later live boundary reuse the aggregate's high watermark.
    const boundary = journal.find((entry) => entry.index === 0);
    if (!boundary) throw new Error("missing boundary");
    const replayDispatch = vi.fn(async () => "unexpected");
    const replay = await runWorkflow(`${META} return await workflow("A");`, {
      runId: "root",
      resumeWorkflowGenerations: new Map([[0, 11]]),
      resumeJournal: new Map([["root:0", boundary]]),
      agent: { run: replayDispatch },
      loadSavedWorkflow: () => `${META} await checkpoint("child"); return await agent("live");`,
    });
    expect(replay.result).toBe(boundary.result);
    expect(replayDispatch).not.toHaveBeenCalled();
    await runWorkflow(`${META} return await workflow("changed");`, {
      runId: "root",
      resumeWorkflowGenerations: new Map([[0, 11]]),
      resumeJournal: new Map([["root:0", boundary]]),
      loadSavedWorkflow: () => `${META} return "changed";`,
      onWorkflowJournal: (entry) => expect(entry.generation).toBe(12),
    });
  });

  it("fences interrupted sibling children with execution nonces while preserving accepted generations", async () => {
    const events: WorkflowRuntimeEvent[] = [];
    const seed = new Map([
      [0, 4],
      [1, 8],
    ]);
    const script = `${META} return await parallel([() => workflow("child"), () => workflow("child")]);`;
    const controller = new AbortController();
    await expect(
      runWorkflow(script, {
        runId: "root",
        resumeWorkflowGenerations: seed,
        executionNonce: "interrupted",
        signal: controller.signal,
        loadSavedWorkflow: () => `${META} return await checkpoint("wait");`,
        confirm: async () => {
          controller.abort();
          return true;
        },
        onRuntimeEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow();
    await runWorkflow(script, {
      runId: "root",
      resumeWorkflowGenerations: seed,
      executionNonce: "resumed",
      loadSavedWorkflow: () => `${META} return await checkpoint("wait");`,
      onRuntimeEvent: (event) => events.push(event),
    });
    const children = events.filter((event) => event.type === "workflow" && event.stage === "start");
    expect(children).toHaveLength(4);
    expect(new Set(children.map((event) => event.childFrameId)).size).toBe(4);
    expect(children.map((event) => event.childFrameId)).toEqual([
      "root-nested-call-0-g5-interrupted",
      "root-nested-call-1-g9-interrupted",
      "root-nested-call-0-g5-resumed",
      "root-nested-call-1-g9-resumed",
    ]);
  });

  it("does not let reentrant child graphs lose their own scope or replace the inherited origin", async () => {
    const events: WorkflowRuntimeEvent[] = [];
    await runWorkflow(`${META} return await orchestrate([{id:"parent",run:() => workflow("child")}]);`, {
      runId: "root",
      loadSavedWorkflow: () => `${META}
        await parallel([0,1].map(i => () => orchestrate([{id:"inner",run:() => retry(() => checkpoint("inner"))}])));
        return await gate(() => checkpoint("inherited"),() => ({ok:true}));`,
      onRuntimeEvent: (event) => events.push(event),
    });
    const retry = events.filter((event) => event.helper === "retry");
    expect(new Set(retry.map((event) => event.graphId)).size).toBe(2);
    for (const event of retry) expect(event).toMatchObject({ taskId: "inner", taskKey: `${event.graphId}:task-0` });
    expect(events.find((event) => event.helper === "gate")).toMatchObject({
      graphId: "root:graph-1",
      taskKey: "root:graph-1:task-0",
      taskId: "parent",
    });
  });

  it.each([
    new Map([[-1, 1]]),
    new Map([[1000, 1]]),
    new Map([[0, 0]]),
    new Map([[0, 1.5]]),
    new Map([[0, 1_000_001]]),
  ])("rejects invalid watermarks before execution (%s)", async (resumeWorkflowGenerations) => {
    const log = vi.fn();
    await expect(runWorkflow(`${META} log("ran");`, { resumeWorkflowGenerations, onLog: log })).rejects.toThrow(
      /watermark/,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects unsupported identity lengths before execution, rather than merging truncated keys", async () => {
    const log = vi.fn();
    await expect(runWorkflow(`${META} log("ran");`, { runId: "r".repeat(1025), onLog: log })).rejects.toThrow(/runId/);
    await expect(runWorkflow(`${META} log("ran");`, { executionNonce: "n".repeat(513), onLog: log })).rejects.toThrow(
      /executionNonce/,
    );
    expect(log).not.toHaveBeenCalled();
    const presentation = new WorkflowPresentation("root");
    expect(() =>
      presentation.runtime({
        type: "workflow",
        frameId: "root",
        childFrameId: "x".repeat(MAX_RUNTIME_IDENTITY_LENGTH + 1),
        stage: "start",
        callIndex: 0,
      }),
    ).toThrow(/identity/);
  });

  it("never aliases a 512-character parent with child checkpoint, graph, helper or phase identities", async () => {
    const root = "r".repeat(512);
    const presentation = new WorkflowPresentation(root);
    const events: WorkflowRuntimeEvent[] = [];
    const fixture = engineFixture();
    try {
      const started = await fixture.engine.start(META);
      const run = fixture.engine.getRun(started.runId);
      if (!run) throw new Error("missing fixture");
      run.runId = root;
      presentation.reset();
      await runWorkflow(
        `${META} phase("root phase"); return await orchestrate([{id:"root task",run:async () => {await checkpoint("root"); return await workflow("child");}}]);`,
        {
          runId: root,
          loadSavedWorkflow: () =>
            `${META} phase("child phase"); await checkpoint("child"); return await orchestrate([{id:"child task",run:() => verify("claim",{reviewers:1})}]);`,
          agent: { run: async () => '{"real":true}' },
          onRuntimeEvent: (event) => {
            events.push(event);
            presentation.runtime(event);
          },
          onAgentStart: (event) => presentation.agentStart(event),
          onAgentEnd: (event) => presentation.agentEnd(event),
        },
      );
      const snapshot = presentation.snapshot(run, 1);
      const child = events.find((event) => event.type === "workflow" && event.stage === "start")?.childFrameId;
      expect(typeof child).toBe("string");
      expect(child).not.toBe(root);
      expect(snapshot.currentPhase).toBe("root phase");
      expect(snapshot.calls).toHaveLength(4);
      expect(snapshot.logicalCalls).toBe(4);
      expect(new Set(snapshot.calls.map((call) => call.id)).size).toBe(4);
      expect(snapshot.calls.filter((call) => call.kind === "checkpoint").map((call) => call.frameId)).toEqual([
        root,
        child,
      ]);
      expect(snapshot.tasks.map((task) => task.frameId)).toEqual([root, child]);
      expect(snapshot.tasks.map((task) => task.graphId)).toEqual([`${root}:graph-1`, `${child}:graph-1`]);
      expect(new Set(snapshot.tasks.map((task) => task.id)).size).toBe(2);
      expect(snapshot.calls.find((call) => call.kind === "agent")).toMatchObject({
        graphId: `${child}:graph-1`,
        taskId: "child task",
      });
      expect(snapshot.events.find((event) => event.helper === "verify")?.helperId).toBe(`${child}:helper-1`);
      expect(snapshot.phases.map((phase) => phase.frameId)).toEqual([root, child]);
    } finally {
      fixture.engine.dispose();
    }
  });
});
