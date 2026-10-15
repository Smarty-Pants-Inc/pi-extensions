import type { EventBus } from "@signalridge/pi-subagents-protocol";
import { replyChannel, WORKFLOW_UI_CHANNELS } from "@signalridge/pi-subagents-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEngine } from "../src/engine.js";
import type { ScriptRun } from "../src/journal.js";
import { buildWorkflowUiSnapshot, openOwnedConversation } from "../src/ui-bus.js";

class Bus implements EventBus {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => set.delete(handler);
  }
  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
  get listenerCount(): number {
    return [...this.handlers.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}
const owner = { extension: "pi-workflows" as const, runId: "run", nodeId: "call-0", attemptId: "attempt-1" };

function run(id = "run"): ScriptRun {
  return {
    runId: id,
    status: "completed",
    meta: { name: "name\u001b[2J", description: "description", phases: [{ title: "declared but not entered" }] },
    startedAt: 10,
    updatedAt: 30,
    callStatus: { "0": "running", "1": "completed", "2": "failed", "3": "stopped" },
    callResults: { "1": { status: "completed", tokenCount: 12 }, "4": { status: "completed", tokenCount: 13 } },
  } as unknown as ScriptRun;
}
function engine(runs: ScriptRun[], phase?: string): WorkflowEngine {
  return {
    list: () => runs.map((record) => ({ runId: record.runId })),
    getRun: (id: string) => runs.find((record) => record.runId === id),
    getInspectionHeader: () => ({ restored: false, currentPhase: phase }),
    getInspection: () => {
      throw new Error("must not deep-clone the full inspection for each peer update");
    },
  } as unknown as WorkflowEngine;
}

afterEach(() => vi.useRealTimers());

describe("compact workflow peer projection", () => {
  it("keeps an older resumed run visible ahead of the bounded terminal history", () => {
    const records = Array.from({ length: 256 }, (_, index) => ({ ...run(`recent-${index}`), startedAt: 100 + index }));
    const older = { ...run("older-running"), status: "running" as const, startedAt: 1 };
    const projected = buildWorkflowUiSnapshot(engine([...records, older]), "surface");
    expect(projected.runs).toHaveLength(256);
    expect(projected.runs[0].runId).toBe("older-running");
    expect(projected.runs.filter((value) => value.status === "running")).toHaveLength(1);
  });

  it("reports authoritative status, exact call counts, entered phase only, and inert raw display data", () => {
    const original = run();
    const before = JSON.stringify(original);
    const projected = buildWorkflowUiSnapshot(engine([original], "Observed\u001b phase"), "surface");
    expect(projected.runs[0]).toEqual({
      version: 1,
      surfaceId: "surface",
      runId: "run",
      name: original.meta.name,
      status: "completed", // A running child observation never reclassifies the run.
      currentPhase: "Observed\u001b phase",
      callCount: 5,
      runningCalls: 1,
      completedCalls: 2,
      failedCalls: 1,
      tokenCount: 25,
      elapsedMs: 20,
      restored: false,
    });
    expect(JSON.stringify(original)).toBe(before);
    expect(buildWorkflowUiSnapshot(engine([original]), "surface").runs[0].currentPhase).toBeUndefined();
    expect(projected.runs[0]).not.toHaveProperty("script");
    expect(projected.runs[0]).not.toHaveProperty("result");
  });

  it("caps history at 256 runs and distinguishes unknown token usage from zero", () => {
    const records = Array.from({ length: 300 }, (_, index) => run(String(index)));
    records[0].callResults = {};
    records[1].callResults = { "0": { status: "completed", compactionCount: 0, updatedAt: 1, tokenCount: 0 } };
    const projected = buildWorkflowUiSnapshot(engine(records), "surface");
    expect(projected.runs).toHaveLength(256);
    expect(projected.runs[0]).not.toHaveProperty("tokenCount");
    expect(projected.runs[1].tokenCount).toBe(0);
  });
});

describe("exact owned-conversation admission", () => {
  it("uses the complete immutable managed tuple, acknowledges admission, and releases listener/timer", async () => {
    vi.useFakeTimers();
    const events = new Bus();
    let received: unknown;
    events.on(WORKFLOW_UI_CHANNELS.openConversation, (raw) => {
      received = raw;
      const request = raw as { requestId: string };
      events.emit(replyChannel(WORKFLOW_UI_CHANNELS.openConversation, request.requestId), {
        success: true,
        data: { accepted: true },
      });
    });
    await openOwnedConversation(events, "agent", owner, () => true);
    expect(received).toMatchObject({ requestId: expect.any(String), agentId: "agent", owner });
    expect(events.listenerCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not emit when selection is stale and rejects a delayed reply after ownership retires", async () => {
    const events = new Bus();
    const requests: Array<{ requestId: string }> = [];
    events.on(WORKFLOW_UI_CHANNELS.openConversation, (raw) => requests.push(raw as { requestId: string }));
    await expect(openOwnedConversation(events, "agent", owner, () => false)).rejects.toThrow("no longer active");
    expect(requests).toHaveLength(0);
    let current = true;
    const pending = openOwnedConversation(events, "agent", owner, () => current);
    current = false;
    events.emit(replyChannel(WORKFLOW_UI_CHANNELS.openConversation, requests[0].requestId), {
      success: true,
      data: { accepted: true },
    });
    await expect(pending).rejects.toThrow("no longer active");
    expect(events.listenerCount).toBe(1);
  });

  it.each([
    null,
    [],
    { success: true },
    { success: false, error: "private hostile\u001b details" },
    { success: true, data: { accepted: false } },
  ])("rejects malformed or refused admission without forwarding arbitrary peer errors: %j", async (reply) => {
    const events = new Bus();
    events.on(WORKFLOW_UI_CHANNELS.openConversation, (raw) => {
      const request = raw as { requestId: string };
      events.emit(replyChannel(WORKFLOW_UI_CHANNELS.openConversation, request.requestId), reply);
    });
    await expect(openOwnedConversation(events, "agent", owner, () => true)).rejects.not.toThrow("private hostile");
    expect(events.listenerCount).toBe(1);
  });

  it("times out an absent optional peer without leaving a listener or reissuing the request", async () => {
    vi.useFakeTimers();
    const events = new Bus();
    const request = vi.fn();
    events.on(WORKFLOW_UI_CHANNELS.openConversation, request);
    const pending = openOwnedConversation(events, "agent", owner, () => true);
    const assertion = expect(pending).rejects.toThrow("UI is unavailable");
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(request).toHaveBeenCalledOnce();
    expect(events.listenerCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
