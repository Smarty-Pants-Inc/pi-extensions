import type { EventBus, WorkflowUiSnapshot } from "@signalridge/pi-subagents-protocol";
import { replyChannel, WORKFLOW_UI_CHANNELS } from "@signalridge/pi-subagents-protocol";
import { describe, expect, it, vi } from "vitest";
import { WorkflowUiBridge, type WorkflowUiSurface } from "../src/ui-bus.js";

class Bus implements EventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => set.delete(handler);
  }
  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

function snapshot(surfaceId = "surface"): WorkflowUiSnapshot {
  return {
    version: 1,
    surfaceId,
    runs: [
      {
        version: 1,
        surfaceId,
        runId: "run",
        name: "Research",
        status: "running",
        callCount: 3,
        runningCalls: 1,
        completedCalls: 1,
        failedCalls: 0,
        elapsedMs: 12,
        restored: false,
      },
    ],
  };
}
function surface(surfaceId = "surface"): WorkflowUiSurface {
  return { snapshot: snapshot(surfaceId), open: vi.fn(async () => {}), notifyError: vi.fn() };
}

async function drain(): Promise<void> {
  for (let count = 0; count < 8; count++) await Promise.resolve();
}

describe("optional workflow UI event bridge", () => {
  it("queries detached authoritative data, publishes updates, and retires display rows", () => {
    const events = new Bus();
    const source = surface();
    const bridge = new WorkflowUiBridge(events, () => source);
    const replies: unknown[] = [];
    const updates: unknown[] = [];
    events.on(replyChannel(WORKFLOW_UI_CHANNELS.query, "query"), (reply) => replies.push(reply));
    events.on(WORKFLOW_UI_CHANNELS.changed, (value) => updates.push(value));
    events.emit(WORKFLOW_UI_CHANNELS.query, { requestId: "query" });
    expect(replies).toEqual([{ success: true, data: source.snapshot }]);
    expect((replies[0] as { data: unknown }).data).not.toBe(source.snapshot);
    bridge.publish();
    expect(updates).toEqual([source.snapshot]);
    bridge.retire("surface");
    expect(updates.at(-1)).toEqual({ version: 1, surfaceId: "surface", runs: [] });
    bridge.dispose();
    events.emit(WORKFLOW_UI_CHANNELS.query, { requestId: "query" });
    bridge.publish();
    expect(replies).toHaveLength(1);
    expect(updates).toHaveLength(2);
  });

  it("denies absent/headless surfaces and ignores malformed uncorrelated requests", () => {
    const events = new Bus();
    const bridge = new WorkflowUiBridge(events, () => undefined);
    const reply = vi.fn();
    events.on(replyChannel(WORKFLOW_UI_CHANNELS.query, "query"), reply);
    events.emit(WORKFLOW_UI_CHANNELS.query, { requestId: "query", unexpected: true });
    expect(reply).not.toHaveBeenCalled();
    events.emit(WORKFLOW_UI_CHANNELS.query, { requestId: "query" });
    expect(reply).toHaveBeenCalledWith({ success: false, error: "Workflow TUI is not active." });
    bridge.dispose();
  });

  it("admits only current explicit selection, acknowledges before close, and prevents duplicate opens", async () => {
    const events = new Bus();
    const source = surface();
    let close: (() => void) | undefined;
    source.open = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          close = resolve;
        }),
    );
    const bridge = new WorkflowUiBridge(events, () => source);
    const replies: unknown[] = [];
    events.on(replyChannel(WORKFLOW_UI_CHANNELS.open, "open"), (reply) => replies.push(reply));
    const request = { requestId: "open", surfaceId: "surface", runId: "run" };
    events.emit(WORKFLOW_UI_CHANNELS.open, { ...request, surfaceId: "old" });
    events.emit(WORKFLOW_UI_CHANNELS.open, { ...request, runId: "gone" });
    expect(source.open).not.toHaveBeenCalled();
    events.emit(WORKFLOW_UI_CHANNELS.open, request);
    expect(replies.at(-1)).toEqual({ success: true, data: { accepted: true } });
    events.emit(WORKFLOW_UI_CHANNELS.open, request);
    expect(replies.at(-1)).toEqual({ success: false, error: "Workflow inspector is already open." });
    await drain();
    expect(source.open).toHaveBeenCalledExactlyOnceWith("run");
    close?.();
    await drain();
    events.emit(WORKFLOW_UI_CHANNELS.open, request);
    await drain();
    expect(source.open).toHaveBeenCalledTimes(2);
    close?.();
    bridge.dispose();
    await drain();
  });

  it("fences retirement, replacement and removal between admission and async mounting", async () => {
    for (const scenario of ["replacement", "removal", "dispose"]) {
      const events = new Bus();
      const original = surface();
      let current = original;
      const bridge = new WorkflowUiBridge(events, () => current);
      events.emit(WORKFLOW_UI_CHANNELS.open, { requestId: "open", surfaceId: "surface", runId: "run" });
      if (scenario === "replacement") current = surface("replacement");
      else if (scenario === "removal") current.snapshot.runs = [];
      else bridge.dispose();
      await drain();
      expect(original.open).not.toHaveBeenCalled();
      expect(current.open).not.toHaveBeenCalled();
      bridge.dispose();
    }
  });

  it("contains opener failures and never notifies a replacement surface", async () => {
    const events = new Bus();
    const original = surface();
    let reject: ((error: Error) => void) | undefined;
    original.open = vi.fn(
      () =>
        new Promise<void>((_resolve, failure) => {
          reject = failure;
        }),
    );
    let current = original;
    const bridge = new WorkflowUiBridge(events, () => current);
    const request = { requestId: "open", surfaceId: "surface", runId: "run" };
    events.emit(WORKFLOW_UI_CHANNELS.open, request);
    await drain();
    reject?.(new Error("private details"));
    await drain();
    expect(original.notifyError).toHaveBeenCalledExactlyOnceWith("Cannot open workflow inspector; try again.");
    events.emit(WORKFLOW_UI_CHANNELS.open, request);
    await drain();
    current = surface("new");
    reject?.(new Error("private details"));
    await drain();
    expect(original.notifyError).toHaveBeenCalledOnce();
    expect(current.notifyError).not.toHaveBeenCalled();
    bridge.dispose();
  });
});
