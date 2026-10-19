import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { INSPECTION_LIMITS, WorkflowPresentation } from "../src/inspection.js";
import type { ScriptRun } from "../src/journal.js";
import {
  type AgentUsage,
  type JournalEntry,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowRunOptions,
  type WorkflowRuntimeEvent,
} from "../src/runtime.js";

const META = 'export const meta = {name:"projection",description:"test"};';
const ZERO: AgentUsage = { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };
const key = (frameId: string, title: string) =>
  createHash("sha256")
    .update(JSON.stringify([frameId, title]))
    .digest("hex");
function fixture(script = META): ScriptRun {
  return {
    runId: "root",
    schemaVersion: 4,
    script,
    scriptHash: "test",
    meta: parseWorkflowScript(script).meta,
    frozenArgsPresent: false,
    status: "running",
    callStatus: {},
    agentIds: {},
    attempts: {},
    attemptIds: {},
    callResults: {},
    callTiers: {},
    workflowResultGenerations: {},
    compactions: {},
    startedAt: 0,
    updatedAt: 0,
  };
}
function observation(script = META) {
  const run = fixture(script);
  const presentation = new WorkflowPresentation("root");
  presentation.reset();
  const events: WorkflowRuntimeEvent[] = [];
  const journal: JournalEntry[] = [];
  const onJournal = (entry: JournalEntry) => {
    journal.push(entry);
    presentation.journalResult(entry.runId ?? "root", entry.index, entry.result);
  };
  const options: WorkflowRunOptions = {
    runId: "root",
    onRuntimeEvent: (event) => {
      events.push(event);
      presentation.runtime(event);
    },
    onAgentStart: (event) => presentation.agentStart(event),
    onAgentEnd: (event) => presentation.agentEnd(event),
    onAgentJournal: onJournal,
    onWorkflowJournal: onJournal,
  };
  return { presentation, run, events, journal, options, snapshot: () => presentation.snapshot(run, 1) };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("source-verified runtime projection", () => {
  it.each([
    'export\nconst meta = {name:"child",description:"test"};',
    '/* private source comment */ export /* comment */ const meta = {name:"child",description:"test"};',
    "export\nconst meta = {name:`child`,description:`private template description`};",
  ])("never uses inline source as metadata, including replay (%s)", async (childMeta) => {
    const child = `${childMeta} await agent("PRIVATE_AGENT_PROMPT"); return args.value;`;
    const script = `${META} return await workflow(${JSON.stringify(child)}, {value:"child value"});`;
    const observed = observation(script);
    const dispatch = vi.fn(async () => "answer");
    const result = await runWorkflow(script, { ...observed.options, agent: { run: dispatch } });
    expect(result.result).toBe("child value");
    const boundary = observed.snapshot().calls.find((call) => call.kind === "workflow");
    expect(boundary).toMatchObject({ id: "root:0", label: "nested workflow", status: "completed" });
    const workflowEvents = observed.events.filter((event) => event.type === "workflow");
    expect(workflowEvents).toMatchObject([
      { sourceKind: "inline", name: "nested workflow", stage: "start" },
      { sourceKind: "inline", name: "nested workflow", stage: "end" },
    ]);
    expect(JSON.stringify(workflowEvents)).not.toContain(child);
    expect(JSON.stringify(observed.snapshot())).not.toContain("PRIVATE_AGENT_PROMPT");
    expect(JSON.stringify(observed.snapshot())).not.toContain(childMeta);
    // The observation fix must not change the saved/inline execution or boundary hash.
    const expectedHash = createHash("sha256")
      .update(
        JSON.stringify({
          kind: "workflow",
          name: child,
          script: child,
          argsPresent: true,
          args: { value: "child value" },
          strengths: null,
          routingPolicyFingerprint: null,
        }),
      )
      .digest("hex");
    const entry = observed.journal.find((item) => item.runId === "root");
    expect(entry?.hash).toBe(expectedHash);
    observed.presentation.reset();
    const replay = await runWorkflow(script, {
      ...observed.options,
      agent: { run: dispatch },
      resumeJournal: new Map(observed.journal.map((item) => [`${item.runId}:${item.index}`, item])),
    });
    expect(replay.result).toBe("child value");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(observed.snapshot()).toMatchObject({ logicalCalls: 1, replayedCalls: 1, physicalDispatches: 0 });
    expect(observed.snapshot().calls[0]).toMatchObject({ label: "nested workflow", replayed: true });
    expect(observed.events.at(-1)).toMatchObject({ sourceKind: "inline", name: "nested workflow", stage: "replay" });
  });

  it.each(["saved-child", "saved export const meta name"])(
    "uses the actual resolver result for saved name %s",
    async (name) => {
      const observed = observation();
      const load = vi.fn((requested: string) => (requested === name ? `${META} return "saved value";` : undefined));
      const result = await runWorkflow(`${META} return await workflow(${JSON.stringify(name)});`, {
        ...observed.options,
        loadSavedWorkflow: load,
      });
      expect(result.result).toBe("saved value");
      expect(load).toHaveBeenCalledWith(name);
      expect(observed.snapshot().calls[0]).toMatchObject({ label: name, kind: "workflow" });
      expect(observed.events.filter((event) => event.type === "workflow")).toMatchObject([
        { name, sourceKind: "saved", stage: "start" },
        { name, sourceKind: "saved", stage: "end" },
      ]);
      observed.presentation.reset();
      const replay = await runWorkflow(`${META} return await workflow(${JSON.stringify(name)});`, {
        ...observed.options,
        loadSavedWorkflow: load,
        resumeJournal: new Map(observed.journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
      });
      expect(replay.result).toBe("saved value");
      expect(observed.snapshot().calls[0]).toMatchObject({ label: name, kind: "workflow", replayed: true });
      expect(observed.events.at(-1)).toMatchObject({ name, sourceKind: "saved", stage: "replay" });
    },
  );

  it("classifies an empty resolver result as saved, not a missing result", async () => {
    const observed = observation();
    await expect(
      runWorkflow(`${META} return await workflow("empty child");`, {
        ...observed.options,
        loadSavedWorkflow: () => "",
      }),
    ).rejects.toThrow(/first statement/);
    expect(observed.events.filter((event) => event.type === "workflow")).toMatchObject([
      { sourceKind: "saved", name: "empty child", stage: "start" },
      { sourceKind: "saved", name: "empty child", stage: "end", outcome: "failed" },
    ]);
  });

  it("fails closed for old nested metadata rather than parsing script prefixes", () => {
    const observed = observation();
    observed.presentation.runtime({
      type: "workflow",
      frameId: "root",
      callIndex: 0,
      stage: "start",
      name: "export\nconst meta = PRIVATE_SOURCE",
    });
    expect(observed.snapshot().calls[0].label).toBe("nested workflow");
    expect(JSON.stringify(observed.snapshot())).not.toContain("PRIVATE_SOURCE");
  });

  it("joins colliding long titles exactly, keeps current markers and repeated IDs stable, and isolates child frames", async () => {
    const first = `${"same prefix ".repeat(70)}first`;
    const second = `${"same prefix ".repeat(70)}second`;
    const child = `${META} phase(args.title); return await agent("private child",{label:"child agent"});`;
    const script = `${META}
      phase(args.first);
      const pending = checkpoint("private checkpoint");
      phase(args.second);
      await agent("private second",{label:"second agent"});
      await workflow("child",{title:args.first});
      await pending;
      phase(args.second);
      return "done";`;
    const observed = observation(script);
    const reply = deferred();
    const options = observed.options;
    await runWorkflow(script, {
      ...options,
      args: { first, second },
      loadSavedWorkflow: () => child,
      agent: { run: async () => "answer" },
      confirm: () => reply.promise,
      onRuntimeEvent: (event) => {
        options.onRuntimeEvent?.(event);
        if (event.type === "phase" && event.frameId === "root" && event.title === second) reply.resolve(true);
      },
    });
    const snapshot = observed.snapshot();
    const rootPhases = snapshot.phases.filter((phase) => phase.frameId === "root");
    expect(rootPhases).toHaveLength(2);
    expect(rootPhases[0].title).toBe(rootPhases[1].title);
    expect(rootPhases.map((phase) => phase.phaseKey)).toEqual([key("root", first), key("root", second)]);
    expect(new Set(snapshot.phases.map((phase) => phase.id)).size).toBe(3);
    expect(snapshot.currentPhaseKey).toBe(key("root", second));
    expect(observed.presentation.header(1).currentPhaseKey).toBe(snapshot.currentPhaseKey);
    const checkpoint = snapshot.calls.find((call) => call.kind === "checkpoint");
    const agent = snapshot.calls.find((call) => call.label === "second agent");
    const boundary = snapshot.calls.find((call) => call.kind === "workflow");
    const nested = snapshot.calls.find((call) => call.label === "child agent");
    expect(checkpoint?.phaseKey).toBe(rootPhases[0].phaseKey);
    expect(agent?.phaseKey).toBe(rootPhases[1].phaseKey);
    expect(boundary?.phaseKey).toBe(rootPhases[1].phaseKey);
    const childPhase = snapshot.phases.find((phase) => phase.frameId === boundary?.childFrameId);
    expect(nested?.phaseKey).toBe(childPhase?.phaseKey);
    expect(nested?.phaseKey).not.toBe(rootPhases[0].phaseKey);
    expect(snapshot.calls.filter((call) => call.phaseKey === rootPhases[0].phaseKey)).toHaveLength(1);
    expect(snapshot.calls.filter((call) => call.phaseKey === rootPhases[1].phaseKey)).toHaveLength(2);
    observed.presentation.runtime({ type: "phase", frameId: "root", title: second });
    expect(observed.snapshot().phases).toEqual(snapshot.phases);
  });

  it("captures task checkpoints and helper IPC associations across sibling phase mutations, nested frames and replay", async () => {
    const child = `${META} phase("child local"); return await checkpoint("nested checkpoint");`;
    const script = `${META} phase("root initial");
      return await orchestrate([
        {id:"scoped",phase:"assigned task",run:async () => {
          const answer = await checkpoint("root checkpoint");
          await retry(() => checkpoint("retry checkpoint"));
          await gate(() => checkpoint("gate checkpoint"), () => ({ok:true}));
          await verify("private claim", {reviewers:1});
          await workflow("child");
          return answer;
        }},
        {id:"mutator",run:async () => {phase("root changed"); return await agent("release", {label:"release"});}}
      ]);`;
    const observed = observation(script);
    const reply = deferred();
    const confirm = vi.fn((prompt: string) => (prompt === "root checkpoint" ? reply.promise : Promise.resolve(true)));
    const agent = vi.fn(async (prompt: string) => {
      if (prompt === "release") reply.resolve("accepted");
      return '{"real":true}';
    });
    const options = { ...observed.options, confirm, agent: { run: agent }, loadSavedWorkflow: () => child };
    const result = await runWorkflow(script, options);
    expect(result.result).toMatchObject({ results: { scoped: "accepted" } });
    const snapshot = observed.snapshot();
    expect(snapshot.currentPhase).toBe("root changed");
    expect(snapshot.currentPhaseKey).toBe(key("root", "root changed"));
    const scoped = snapshot.tasks.find((task) => task.taskId === "scoped");
    expect(scoped).toBeDefined();
    const calls = snapshot.calls.filter((call) => call.taskKey === scoped?.id);
    expect(calls.filter((call) => call.kind === "checkpoint")).toHaveLength(4);
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(call).toMatchObject({
        graphId: scoped?.graphId,
        taskId: "scoped",
        phase: "assigned task",
        status: "completed",
      });
      expect(call.phaseKey).toBe(key(call.frameId, "assigned task"));
    }
    const events = observed.events.filter((event) => event.helper === "checkpoint");
    for (const start of events.filter((event) => event.stage === "start")) {
      const end = events.find(
        (event) => event.stage === "end" && event.frameId === start.frameId && event.callIndex === start.callIndex,
      );
      expect(end).toMatchObject({
        phase: start.phase,
        phaseKey: start.phaseKey,
        graphId: start.graphId,
        taskKey: start.taskKey,
        taskId: start.taskId,
        outcome: "completed",
      });
    }
    for (const event of observed.events.filter((event) => ["verify", "retry", "gate"].includes(String(event.helper))))
      expect(event).toMatchObject({ graphId: scoped?.graphId, taskKey: scoped?.id, taskId: "scoped" });
    // Parent replay boundaries skip physical child execution but preserve captured root task facts.
    const journal = new Map(observed.journal.map((entry) => [`${entry.runId}:${entry.index}`, entry]));
    observed.presentation.reset();
    await runWorkflow(script, { ...options, resumeJournal: journal });
    expect(confirm).toHaveBeenCalledTimes(4);
    expect(agent).toHaveBeenCalledTimes(2);
    const replay = observed.snapshot();
    expect(replay.calls.every((call) => call.replayed)).toBe(true);
    for (const call of replay.calls.filter((item) => item.taskKey === scoped?.id))
      expect(call).toMatchObject({
        phase: "assigned task",
        phaseKey: key("root", "assigned task"),
        graphId: scoped?.graphId,
        taskId: "scoped",
      });
  });

  it.each(["failed", "cancelled"] as const)(
    "pairs checkpoint %s observations with the originating scope",
    async (outcome) => {
      const observed = observation();
      const controller = new AbortController();
      const script = `${META} phase("initial"); return await orchestrate([
      {id:"wait",phase:"task phase",run:() => checkpoint("private")},
      {id:"mutate",run:() => {phase("changed"); return "changed";}}
    ]);`;
      const reply = deferred();
      const execution = runWorkflow(script, {
        ...observed.options,
        signal: controller.signal,
        confirm: () => reply.promise,
        onRuntimeEvent: (event) => {
          observed.options.onRuntimeEvent?.(event);
          if (event.type === "phase" && event.title === "changed") {
            if (outcome === "cancelled") controller.abort();
            else reply.reject(new Error("private failure"));
          }
        },
      });
      if (outcome === "cancelled") await expect(execution).rejects.toThrow();
      else await execution;
      const events = observed.events.filter((event) => event.helper === "checkpoint");
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        stage: "end",
        outcome,
        phase: "task phase",
        phaseKey: key("root", "task phase"),
        graphId: events[0].graphId,
        taskKey: events[0].taskKey,
        taskId: "wait",
      });
      expect(observed.snapshot().calls[0].status).toBe(outcome === "failed" ? "failed" : "interrupted");
    },
  );

  it("deduplicates literal phases, bounds exact identities, and leaves restored/legacy call attribution unknown", () => {
    const observed = observation(
      'export const meta = {name:"projection",description:"test",phases:[{title:"same"},{title:"same"},{title:"other"}]};',
    );
    observed.presentation.runtime({ type: "phase", frameId: "root", title: "same" });
    expect(observed.snapshot().phases).toMatchObject([
      { id: "root:declared-0", phaseKey: key("root", "same"), entered: true },
      { id: "root:declared-2", phaseKey: key("root", "other"), entered: false },
    ]);
    observed.presentation.agentStart({ id: "root:0", label: "legacy", phase: "same", prompt: "not retained" });
    expect(observed.snapshot().calls[0].phaseKey).toBeUndefined();
    for (let i = 0; i < 300; i++)
      observed.presentation.runtime({ type: "phase", frameId: "root", title: `${"x".repeat(600)}${i}` });
    for (let i = 1; i <= 2_100; i++)
      observed.presentation.agentStart({
        id: `root:${i}`,
        label: "bounded",
        phaseKey: key("root", "same"),
        prompt: "not retained",
      });
    const bounded = observed.snapshot();
    expect(bounded.phases).toHaveLength(INSPECTION_LIMITS.phases);
    expect(bounded.calls).toHaveLength(INSPECTION_LIMITS.calls);
    expect(bounded.events).toHaveLength(INSPECTION_LIMITS.events);
    expect(bounded.truncated).toBe(true);
    expect(
      bounded.phases.every((phase) => phase.title.length <= INSPECTION_LIMITS.text && phase.phaseKey?.length === 64),
    ).toBe(true);
    observed.run.callStatus["0"] = "completed";
    observed.run.callResults["0"] = {
      status: "completed",
      result: "durable",
      tokenCount: 0,
      compactionCount: 0,
      updatedAt: 0,
    };
    const restored = new WorkflowPresentation("root", true).snapshot(observed.run, 2);
    expect(restored).toMatchObject({ restored: true, observationSource: "journal-only" });
    expect(restored.currentPhaseKey).toBeUndefined();
    expect(restored.calls[0]).toMatchObject({
      kind: "unknown",
      journalOnly: true,
      resultPreview: "durable",
      tokenCount: 0,
    });
    expect(restored.calls[0].phaseKey).toBeUndefined();
    expect(restored.phases.every((phase) => !phase.entered)).toBe(true);
    observed.presentation.reset();
    expect(observed.presentation.header(2).currentPhaseKey).toBeUndefined();
  });
});

describe("explicit zero managed usage", () => {
  it("spends nothing for supplied zero, distinguishes agent zero from checkpoint unknown, and leaves budget available", async () => {
    const observed = observation();
    const result = await runWorkflow(
      `${META}
      await checkpoint("private checkpoint");
      const afterCheckpoint = [budget.spent(),budget.remaining()];
      await agent("large private prompt");
      await agent("another large prompt");
      return {afterCheckpoint,afterAgents:[budget.spent(),budget.remaining()]};`,
      {
        ...observed.options,
        tokenBudget: 1,
        agent: {
          run: async (_prompt, options) => {
            options?.onUsage?.({ ...ZERO });
            return "large answer";
          },
        },
      },
    );
    expect(result.result).toEqual({ afterCheckpoint: [0, 1], afterAgents: [0, 1] });
    expect(result.tokenUsage).toEqual(ZERO);
    expect(
      observed
        .snapshot()
        .calls.filter((call) => call.kind === "agent")
        .map((call) => call.tokenCount),
    ).toEqual([0, 0]);
    expect(observed.snapshot().calls.find((call) => call.kind === "checkpoint")?.tokenCount).toBeUndefined();
  });

  it("keeps zero retry spend and schema repair accounting without estimating a supplied zero", async () => {
    let attempt = 0;
    const retrySpend = vi.fn();
    const result = await runWorkflow(
      `${META}
      await agent("schema prompt",{retries:1,schema:{type:"object",required:["ok"]}});
      return [budget.spent(),budget.remaining()];`,
      {
        tokenBudget: 1,
        onRetrySpend: retrySpend,
        agent: {
          run: async (_prompt, options) => {
            options?.onUsage?.({ ...ZERO });
            return ++attempt === 1 ? "invalid" : '{"ok":true}';
          },
        },
      },
    );
    expect(attempt).toBe(2);
    expect(retrySpend).toHaveBeenCalledExactlyOnceWith(0);
    expect(result.result).toEqual([0, 1]);
    expect(result.tokenUsage).toEqual(ZERO);
  });

  it("still estimates unknown usage and resets the supplied usage between attempts", async () => {
    const unknown = await runWorkflow(`${META} await agent("prompt"); return [budget.spent(),budget.remaining()];`, {
      tokenBudget: 100,
      agent: { run: async () => "answer" },
    });
    expect(unknown.result).toEqual([4, 96]);
    expect(unknown.tokenUsage?.total).toBe(4);
    let attempt = 0;
    const retried = await runWorkflow(
      `${META} await agent("prompt",{retries:1,schema:{type:"object",required:["ok"]}}); return budget.spent();`,
      {
        agent: {
          run: async (_prompt, options) => {
            if (++attempt === 1) {
              options?.onUsage?.({ ...ZERO });
              return "invalid";
            }
            return '{"ok":true}';
          },
        },
      },
    );
    expect(retried.result).toBeGreaterThan(0);
    expect(retried.tokenUsage?.total).toBe(retried.result);
    await expect(
      runWorkflow(`${META} await agent("prompt"); return await agent("blocked");`, {
        tokenBudget: 1,
        agent: { run: async () => "answer" },
      }),
    ).rejects.toThrow(/budget exhausted/);
  });
});
