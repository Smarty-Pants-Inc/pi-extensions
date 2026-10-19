import { describe, expect, it, vi } from "vitest";
import { type OrchestrationTaskContext, type OrchestrationTaskEvent, runOrchestration } from "../src/orchestrator.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("orchestration layer snapshots", () => {
  it("gives retries identical context and agent prompts with reversed sibling completion order", async () => {
    const run = async (siblingFirst: boolean) => {
      const siblingRelease = deferred();
      const siblingEnded = deferred();
      const retryEnded = deferred();
      const observations: OrchestrationTaskContext[] = [];
      const events: OrchestrationTaskEvent[] = [];
      const agent = vi.fn(async (prompt: string) => `answer:${prompt}`);
      const running = runOrchestration(
        [
          { id: "source", run: () => ({ nested: { value: "stable" } }) },
          {
            id: "retrying",
            dependsOn: ["source"],
            retries: 1,
            run: async (context: OrchestrationTaskContext) => {
              observations.push(context);
              if (context.attempt === 1) {
                if (siblingFirst) await siblingEnded.promise;
                throw new Error("transient");
              }
              return agent(JSON.stringify({ results: context.results, statuses: context.statuses }));
            },
          },
          {
            id: "sibling",
            dependsOn: ["source"],
            run: async () => {
              await siblingRelease.promise;
              return "sibling value";
            },
          },
          {
            id: "next",
            dependsOn: ["retrying", "sibling"],
            run: (context: OrchestrationTaskContext) => context,
          },
        ],
        undefined,
        {
          onEvent: (event) => {
            events.push(event);
            if (event.taskId === "sibling" && event.stage === "end") siblingEnded.resolve();
            if (event.taskId === "retrying" && event.stage === "end") retryEnded.resolve();
          },
        },
      );
      if (siblingFirst) siblingRelease.resolve();
      else {
        await retryEnded.promise;
        siblingRelease.resolve();
      }
      const output = await running;
      expect(observations.map((context) => context.attempt)).toEqual([1, 2]);
      for (const context of observations) {
        expect(context.results).toEqual({ source: { nested: { value: "stable" } } });
        expect(context.statuses).toEqual({
          source: "completed",
          retrying: "running",
          sibling: "running",
          next: "pending",
        });
      }
      expect(output.results.next).toEqual({
        id: "next",
        attempt: 1,
        results: {
          source: { nested: { value: "stable" } },
          retrying: output.results.retrying,
          sibling: "sibling value",
        },
        statuses: { source: "completed", retrying: "completed", sibling: "completed", next: "running" },
      });
      expect(Object.keys(output.tasks)).toEqual(["source", "retrying", "sibling", "next"]);
      expect(output.tasks.retrying).toMatchObject({ status: "completed", attempts: 2 });
      expect(events.filter((event) => event.taskId === "retrying")).toEqual([
        { type: "task", stage: "start", taskId: "retrying", attempt: 1 },
        { type: "task", stage: "retry", taskId: "retrying", attempt: 1, error: "transient" },
        { type: "task", stage: "end", taskId: "retrying", attempt: 2, status: "completed" },
      ]);
      const completed = events.filter((event) => event.stage === "end").map((event) => event.taskId);
      expect(completed).toEqual(
        siblingFirst ? ["source", "sibling", "retrying", "next"] : ["source", "retrying", "sibling", "next"],
      );
      return { observations, prompts: agent.mock.calls, output };
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it("detaches the baseline and every callback attempt from mutable result objects", async () => {
    const source = { nested: { value: "stable" } };
    const contexts: OrchestrationTaskContext[] = [];
    const output = await runOrchestration(
      [
        { id: "source", run: () => source },
        {
          id: "mutator",
          dependsOn: ["source"],
          retries: 1,
          run: (context: OrchestrationTaskContext) => {
            contexts.push(context);
            const value = context.results.source as typeof source;
            expect(value.nested.value).toBe("stable");
            value.nested.value = `attempt ${context.attempt}`;
            // Even a retained reference to the original result cannot alter
            // the layer baseline used for retries and sibling callbacks.
            source.nested.value = "original changed";
            if (context.attempt === 1) throw new Error("retry");
            return value;
          },
        },
        {
          id: "sibling",
          dependsOn: ["source"],
          run: (context: OrchestrationTaskContext) => {
            contexts.push(context);
            return context.results.source;
          },
        },
        {
          id: "next",
          dependsOn: ["mutator", "sibling"],
          run: (context: OrchestrationTaskContext) => context.results,
        },
      ],
      undefined,
    );
    expect(contexts.map((context) => context.id)).toEqual(["mutator", "mutator", "sibling"]);
    expect(contexts[0]?.results.source).not.toBe(contexts[1]?.results.source);
    expect(contexts[1]?.results.source).not.toBe(contexts[2]?.results.source);
    for (const context of contexts) {
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.results)).toBe(true);
      expect(Object.isFrozen(context.statuses)).toBe(true);
      expect(Reflect.set(context.statuses, "sibling", "failed")).toBe(false);
      expect(Reflect.set(context.results, "injected", "value")).toBe(false);
    }
    expect(output.results).toMatchObject({
      source: { nested: { value: "original changed" } },
      mutator: { nested: { value: "attempt 2" } },
      sibling: { nested: { value: "stable" } },
      next: {
        source: { nested: { value: "original changed" } },
        mutator: { nested: { value: "attempt 2" } },
        sibling: { nested: { value: "stable" } },
      },
    });
  });

  it.each(["skip-dependents", "continue", "fail-fast"] as const)(
    "preserves %s policy and settles the full failed layer before advancing or rejecting",
    async (onError) => {
      const release = deferred();
      const failed = deferred();
      const later = vi.fn((context: OrchestrationTaskContext) => ({
        value: context.results.bad,
        status: context.statuses.bad,
        sibling: context.results.sibling,
      }));
      const events: OrchestrationTaskEvent[] = [];
      const failure = new Error("broken");
      let settled = false;
      const running = runOrchestration(
        [
          {
            id: "bad",
            retries: 1,
            run: () => {
              throw failure;
            },
          },
          {
            id: "sibling",
            run: async () => {
              await release.promise;
              return "ok";
            },
          },
          { id: "later", dependsOn: ["bad"], run: later },
          { id: "descendant", dependsOn: ["later"], run: () => "descendant" },
        ],
        { onError },
        {
          onEvent: (event) => {
            events.push(event);
            if (event.taskId === "bad" && event.stage === "end") failed.resolve();
          },
        },
      );
      const completion = running.then(
        (output) => {
          settled = true;
          return { output };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      await failed.promise;
      expect(settled).toBe(false);
      expect(later).not.toHaveBeenCalled();
      release.resolve();
      const outcome = await completion;
      expect(events.filter((event) => event.stage === "end").slice(0, 2)).toMatchObject([
        { taskId: "bad", attempt: 2, status: "failed" },
        { taskId: "sibling", attempt: 1, status: "completed" },
      ]);
      if (onError === "fail-fast") {
        expect(outcome).toEqual({ error: failure });
        expect(later).not.toHaveBeenCalled();
        expect(events.some((event) => event.taskId === "later")).toBe(false);
      } else {
        if (!("output" in outcome)) throw new Error("expected graph result");
        expect(outcome.output.tasks.bad).toMatchObject({ status: "failed", attempts: 2, value: null });
        expect(outcome.output.results.sibling).toBe("ok");
        if (onError === "continue") {
          expect(later).toHaveBeenCalledOnce();
          expect(outcome.output.results.later).toEqual({ value: null, status: "failed", sibling: "ok" });
          expect(outcome.output.tasks.descendant.status).toBe("completed");
        } else {
          expect(later).not.toHaveBeenCalled();
          expect(outcome.output.tasks.later).toMatchObject({ status: "skipped", attempts: 0, value: null });
          expect(outcome.output.tasks.descendant).toMatchObject({ status: "skipped", attempts: 0, value: null });
        }
      }
    },
  );

  it("waits for siblings and does not retry or advance after a fatal error", async () => {
    const release = deferred();
    const failed = deferred();
    const failure = new Error("fatal");
    const fatalTask = vi.fn(() => {
      throw failure;
    });
    const later = vi.fn();
    const events: OrchestrationTaskEvent[] = [];
    let settled = false;
    const completion = runOrchestration(
      [
        { id: "fatal", retries: 3, run: fatalTask },
        {
          id: "sibling",
          run: async () => {
            await release.promise;
            return "ok";
          },
        },
        { id: "later", dependsOn: ["sibling"], run: later },
      ],
      { onError: "continue" },
      {
        isFatal: (error) => error === failure,
        onEvent: (event) => {
          events.push(event);
          if (event.taskId === "fatal" && event.stage === "end") failed.resolve();
        },
      },
    ).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await failed.promise;
    expect(settled).toBe(false);
    release.resolve();
    expect(await completion).toBe(failure);
    expect(fatalTask).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
    expect(events.filter((event) => event.stage === "end")).toMatchObject([
      { taskId: "fatal", status: "failed", attempt: 1 },
      { taskId: "sibling", status: "completed", attempt: 1 },
    ]);
  });

  it.each(["skip-dependents", "continue", "fail-fast"] as const)(
    "keeps undetachable results inside the task retry/error policy with %s",
    async (onError) => {
      const consumer = vi.fn();
      const events: OrchestrationTaskEvent[] = [];
      const running = runOrchestration(
        [
          { id: "source", run: () => () => "not cloneable" },
          { id: "first", dependsOn: ["source"], retries: 1, run: consumer },
          { id: "second", dependsOn: ["source"], run: consumer },
        ],
        { onError },
        {
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      if (onError === "fail-fast") await expect(running).rejects.toThrow(/task "first" results cannot be detached/);
      else {
        const output = await running;
        expect(output.tasks.first).toMatchObject({ status: "failed", attempts: 2 });
        expect(output.tasks.second).toMatchObject({ status: "failed", attempts: 1 });
        expect(output.tasks.second.error).toMatch(/task "second" results cannot be detached/);
      }
      expect(consumer).not.toHaveBeenCalled();
      expect(events.filter((event) => event.stage === "retry")).toMatchObject([{ taskId: "first", attempt: 1 }]);
      expect(events.filter((event) => event.stage === "end" && event.status === "failed")).toHaveLength(2);
    },
  );
});
