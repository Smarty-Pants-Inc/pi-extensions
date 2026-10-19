import { describe, expect, it } from "vitest";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { runWorkflow, type WorkflowRuntimeEvent } from "../src/runtime.js";

const META = 'export const meta = {name:"quality",description:"test"};';
const HELPERS = [
  { name: "verify", expression: 'verify("claim",{reviewers:1})', answer: '{"real":true}' },
  { name: "judgePanel", expression: 'judgePanel(["candidate"],{judges:1})', answer: '{"score":0.9}' },
  { name: "completenessCheck", expression: 'completenessCheck("task",[])', answer: '{"complete":true}' },
];
describe("inspection runtime observations", () => {
  it.each(HELPERS)(
    "pairs $name helper instances on success and preserves returned values",
    async ({ name, expression, answer }) => {
      const events: WorkflowRuntimeEvent[] = [];
      const result = await runWorkflow(`${META} return await parallel([() => ${expression}, () => ${expression}]);`, {
        runId: "root",
        agent: { run: async () => answer },
        onRuntimeEvent: (event) => events.push(event),
      });
      const quality = events.filter((event) => event.type === "quality");
      expect(quality).toHaveLength(4);
      const starts = quality.filter((event) => event.stage === "start");
      expect(new Set(starts.map((event) => event.helperId)).size).toBe(2);
      for (const start of starts)
        expect(quality.find((event) => event.stage === "end" && event.helperId === start.helperId)).toMatchObject({
          helper: name,
          frameId: "root",
          runId: "root",
          outcome: "completed",
        });
      expect(result.result).toHaveLength(2);
    },
  );

  it.each(HELPERS)("pairs $name helper instances on fatal failure without raw error data", async ({ expression }) => {
    const events: WorkflowRuntimeEvent[] = [];
    await expect(
      runWorkflow(`${META} return await ${expression};`, {
        runId: "root",
        agent: {
          run: async () => {
            throw new WorkflowError("secret provider data", WorkflowErrorCode.MODEL_NOT_FOUND);
          },
        },
        onRuntimeEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("secret provider data");
    const quality = events.filter((event) => event.type === "quality");
    expect(quality).toHaveLength(2);
    expect(quality[1]).toMatchObject({ helperId: quality[0].helperId, stage: "end", outcome: "failed" });
    expect(JSON.stringify(quality)).not.toContain("secret provider data");
  });

  it.each(HELPERS)("pairs $name helper instances on cancellation", async ({ expression }) => {
    const events: WorkflowRuntimeEvent[] = [];
    const controller = new AbortController();
    await expect(
      runWorkflow(`${META} return await ${expression};`, {
        runId: "root",
        signal: controller.signal,
        agent: {
          run: async () => {
            controller.abort();
            throw new WorkflowError("cancelled", WorkflowErrorCode.WORKFLOW_ABORTED);
          },
        },
        onRuntimeEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow();
    const quality = events.filter((event) => event.type === "quality");
    expect(quality).toHaveLength(2);
    expect(quality[1]).toMatchObject({ helperId: quality[0].helperId, stage: "end", outcome: "cancelled" });
  });

  it("detaches runtime event payloads so observers cannot mutate nested arguments", async () => {
    const result = await runWorkflow(`${META} return await workflow("child",{value:"original"});`, {
      runId: "root",
      loadSavedWorkflow: () => `${META} return args.value;`,
      onRuntimeEvent: (event) => {
        if (event.type === "workflow" && event.args && typeof event.args === "object")
          (event.args as { value: string }).value = "mutated";
      },
    });
    expect(result.result).toBe("original");
  });

  it("pairs empty judge panels and contains runtime event observer throws", async () => {
    const events: WorkflowRuntimeEvent[] = [];
    const result = await runWorkflow(`${META} return await judgePanel([]);`, {
      runId: "root",
      onRuntimeEvent: (event) => {
        events.push(event);
        throw new Error("observer");
      },
    });
    expect(result.result).toBeUndefined();
    expect(events).toMatchObject([
      { stage: "start", helper: "judgePanel" },
      { stage: "end", helper: "judgePanel", outcome: "completed" },
    ]);
    expect(events[0].helperId).toBe(events[1].helperId);
  });
});
