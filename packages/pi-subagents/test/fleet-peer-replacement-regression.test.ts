import type { EventBus, WorkflowUiSnapshot } from "@signalridge/pi-subagents-protocol";
import { replyChannel, WORKFLOW_UI_CHANNELS } from "@signalridge/pi-subagents-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowUiClient } from "../src/ui/workflow-ui-client.js";

class Bus implements EventBus {
  listeners = new Map<string, Set<(raw: unknown) => void>>();
  on(channel: string, handler: (raw: unknown) => void) {
    const handlers = this.listeners.get(channel) ?? new Set(); handlers.add(handler); this.listeners.set(channel, handlers);
    return () => { handlers.delete(handler); if (!handlers.size) this.listeners.delete(channel); };
  }
  emit(channel: string, raw: unknown) { for (const handler of [...this.listeners.get(channel) ?? []]) handler(raw); }
}
function snapshot(surfaceId: string, name = surfaceId): WorkflowUiSnapshot {
  return { version: 1, surfaceId, runs: [{ version: 1, surfaceId, runId: "run", name, status: "running", callCount: 0,
    runningCalls: 0, completedCalls: 0, failedCalls: 0, elapsedMs: 0, restored: false }] };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const clients: WorkflowUiClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); });
function setup() {
  const bus = new Bus(); const requests: string[] = []; let active = snapshot("A"); let delay = false;
  const query = vi.fn((raw: unknown) => {
    const id = (raw as { requestId: string }).requestId; requests.push(id);
    if (!delay) bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.query, id), { success: true, data: active });
  });
  bus.on(WORKFLOW_UI_CHANNELS.query, query);
  const retired = new Set<string>(); let current = true;
  const client = new WorkflowUiClient(bus, () => current, vi.fn(), retired); clients.push(client);
  return { bus, client, query, requests, retired, active: (next: WorkflowUiSnapshot) => { active = next; },
    delay: () => { delay = true; }, retire: () => { current = false; client.dispose(); },
    publish: (next: WorkflowUiSnapshot) => bus.emit(WORKFLOW_UI_CHANNELS.changed, next),
    reply: (id: string, data: WorkflowUiSnapshot) => bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.query, id), { success: true, data }) };
}

describe("Fleet peer replacement admission", () => {
  it.each([false, true])("resumes and opens A after rejecting stale B (coalesced retry: %s)", async coalesced => {
    const h = setup(); await flush(); h.delay();
    h.publish({ version: 1, surfaceId: "A", runs: [] }); h.publish(snapshot("B"));
    const id = h.requests.at(-1)!;
    // Returning to B coalesces a retry; rejection must clear that retry too.
    if (coalesced) { h.publish(snapshot("C")); h.publish(snapshot("B", "newer stale B")); }
    h.reply(id, { version: 1, surfaceId: "A", runs: [] }); await flush();
    const resumed = snapshot("A", "resumed A"); h.publish(resumed);
    expect(h.client.runs(new Set())).toEqual(resumed.runs);
    expect(h.query).toHaveBeenCalledTimes(2); expect(h.retired.has("A")).toBe(false);
    const opens = vi.fn((raw: unknown) => {
      const request = raw as { requestId: string; surfaceId: string }; expect(request.surfaceId).toBe("A");
      h.bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.open, request.requestId), { success: true, data: { accepted: true } });
    });
    h.bus.on(WORKFLOW_UI_CHANNELS.open, opens);
    await h.client.open(resumed.runs[0]); expect(opens).toHaveBeenCalledOnce();
    await expect(h.client.open(snapshot("B").runs[0])).rejects.toThrow("no longer active");
    h.reply(id, snapshot("B")); await flush(); expect(h.client.runs(new Set())).toEqual(resumed.runs);
  });

  it("keeps newer C and its revisions when the pending B query instead replies with A", async () => {
    const h = setup(); await flush(); h.delay();
    h.publish({ version: 1, surfaceId: "A", runs: [] }); h.publish(snapshot("B")); const old = h.requests.at(-1)!;
    h.publish(snapshot("C", "first C")); h.publish(snapshot("C", "latest C"));
    h.reply(old, snapshot("A", "old A")); await flush();
    expect(h.requests).toHaveLength(3); expect(h.client.runs(new Set())).toEqual([]);
    h.reply(old, snapshot("B")); h.publish(snapshot("A", "late A"));
    h.reply(h.requests.at(-1)!, snapshot("C", "stale C reply")); await flush();
    expect(h.client.runs(new Set())).toEqual(snapshot("C", "latest C").runs);
    expect(h.retired.has("A")).toBe(true); expect(h.query).toHaveBeenCalledTimes(3);
  });

  it("ignores retired-source query replies and delayed replies from a disposed client after reload", async () => {
    const h = setup(); await flush(); h.active(snapshot("B")); h.publish(snapshot("B")); await flush(); h.delay();
    h.publish({ version: 1, surfaceId: "B", runs: [] }); h.publish(snapshot("C"));
    h.reply(h.requests.at(-1)!, snapshot("A")); await flush();
    h.publish(snapshot("B", "late B")); expect(h.client.runs(new Set())).toEqual([]);
    h.publish(snapshot("C", "latest C")); const old = h.requests.at(-1)!; h.retire();
    const replacement = new WorkflowUiClient(h.bus, () => true, vi.fn(), h.retired); clients.push(replacement);
    h.reply(h.requests.at(-1)!, snapshot("D")); await flush();
    h.reply(old, snapshot("C")); h.publish(snapshot("B")); await flush();
    expect(replacement.runs(new Set())).toEqual(snapshot("D").runs);
    expect(h.client.runs(new Set())).toEqual([]); expect(h.retired.has("B")).toBe(true);
  });

  it("cleans absent and replacement query timeouts without polling and disposes pending listeners", async () => {
    vi.useFakeTimers(); const h = setup(); await flush(); h.delay();
    h.publish({ version: 1, surfaceId: "A", runs: [] }); h.publish(snapshot("B")); const old = h.requests.at(-1)!;
    expect(h.bus.listeners.has(replyChannel(WORKFLOW_UI_CHANNELS.query, old))).toBe(true);
    vi.advanceTimersByTime(2001); await flush();
    expect(h.bus.listeners.has(replyChannel(WORKFLOW_UI_CHANNELS.query, old))).toBe(false);
    h.reply(old, snapshot("B")); vi.advanceTimersByTime(60_000); await flush();
    expect(h.query).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    h.publish(snapshot("C")); h.reply(h.requests.at(-1)!, snapshot("A")); await flush();
    h.publish(snapshot("A", "resumed A")); expect(h.client.runs(new Set())).toEqual(snapshot("A", "resumed A").runs);
    h.publish(snapshot("D")); h.retire(); await flush();
    expect([...h.bus.listeners.keys()]).toEqual([WORKFLOW_UI_CHANNELS.query]); expect(vi.getTimerCount()).toBe(0);

    const bus = new Bus(); const query = vi.fn(); bus.on(WORKFLOW_UI_CHANNELS.query, query);
    const absent = new WorkflowUiClient(bus, () => true, vi.fn()); clients.push(absent);
    vi.advanceTimersByTime(2001); await flush(); vi.advanceTimersByTime(60_000); await flush();
    expect(query).toHaveBeenCalledOnce(); expect(absent.runs(new Set())).toEqual([]);
    absent.dispose(); expect([...bus.listeners.keys()]).toEqual([WORKFLOW_UI_CHANNELS.query]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("verifies A -> empty retirement A -> B on the same client, opens B and rejects stale A", async () => {
    const h = setup(); await flush();
    h.publish({ version: 1, surfaceId: "A", runs: [] }); h.active(snapshot("B")); h.publish(snapshot("B"));
    await flush(); expect(h.client.runs(new Set())).toEqual(snapshot("B").runs); expect(h.retired.has("A")).toBe(true);
    const opens = vi.fn((raw: unknown) => {
      const request = raw as { requestId: string; surfaceId: string }; expect(request.surfaceId).toBe("B");
      h.bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.open, request.requestId), { success: true, data: { accepted: true } });
    });
    h.bus.on(WORKFLOW_UI_CHANNELS.open, opens);
    await h.client.open(snapshot("B").runs[0]); h.publish(snapshot("A")); await flush();
    expect(h.client.runs(new Set())).toEqual(snapshot("B").runs); expect(opens).toHaveBeenCalledOnce();
    await expect(h.client.open(snapshot("A").runs[0])).rejects.toThrow("no longer active");
  });

  it("ignores late A publications after empty retirement while B verification is delayed", async () => {
    const h = setup(); await flush(); h.delay();
    h.publish({ version: 1, surfaceId: "A", runs: [] }); h.publish(snapshot("B")); const id = h.requests.at(-1)!;
    h.publish(snapshot("A", "stale A")); h.reply(id, snapshot("B")); await flush();
    expect(h.client.runs(new Set())).toEqual(snapshot("B").runs);
    expect(h.query).toHaveBeenCalledTimes(2);
  });

  it("coalesces in-flight verification and retains newer B revisions instead of stale query data", async () => {
    const h = setup(); await flush(); h.delay();
    h.publish(snapshot("B", "first")); const id = h.requests.at(-1)!;
    for (let i = 0; i < 50; i++) h.publish(snapshot("B", `revision-${i}`));
    expect(h.query).toHaveBeenCalledTimes(2); expect(h.client.runs(new Set())[0].surfaceId).toBe("A");
    h.reply(id, snapshot("B", "old reply")); await flush();
    expect(h.client.runs(new Set())[0].name).toBe("revision-49"); expect(h.query).toHaveBeenCalledTimes(2);
  });

  it("does not blindly adopt a fake source, nor revive B after newer A ownership/publication", async () => {
    const h = setup(); await flush(); h.delay(); h.publish(snapshot("fake"));
    h.reply(h.requests.at(-1)!, snapshot("A")); await flush(); expect(h.client.runs(new Set())[0].surfaceId).toBe("A");
    h.publish(snapshot("B")); const id = h.requests.at(-1)!;
    h.publish(snapshot("A", "later A")); h.reply(id, snapshot("B")); await flush();
    expect(h.client.runs(new Set())[0].name).toBe("later A");
  });

  it("requeries once after a publication overtakes the initial delayed query, and never polls absent peers", async () => {
    vi.useFakeTimers(); const bus = new Bus(); const ids: string[] = [];
    bus.on(WORKFLOW_UI_CHANNELS.query, raw => ids.push((raw as { requestId: string }).requestId));
    const client = new WorkflowUiClient(bus, () => true, vi.fn()); clients.push(client);
    bus.emit(WORKFLOW_UI_CHANNELS.changed, { version: 1, surfaceId: "A", runs: [] });
    bus.emit(WORKFLOW_UI_CHANNELS.changed, snapshot("B")); bus.emit(WORKFLOW_UI_CHANNELS.changed, snapshot("B", "newest"));
    expect(ids).toHaveLength(1);
    bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.query, ids[0]), { success: true, data: snapshot("A") }); await flush();
    expect(ids).toHaveLength(2); expect(client.runs(new Set())).toEqual([]);
    bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.query, ids[1]), { success: true, data: snapshot("B") }); await flush();
    expect(client.runs(new Set())[0].name).toBe("newest");
    bus.emit(WORKFLOW_UI_CHANNELS.changed, snapshot("absent")); vi.advanceTimersByTime(2001); await flush();
    vi.advanceTimersByTime(60_000); await flush(); expect(ids).toHaveLength(3);
    const opening = expect(client.open(snapshot("B").runs[0])).rejects.toThrow("retired"); client.dispose(); await opening;
    expect([...bus.listeners.keys()]).toEqual([WORKFLOW_UI_CHANNELS.query]); expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a delayed different-source reply after a newer candidate and retires bounded identities", async () => {
    const h = setup(); await flush(); h.delay(); h.publish(snapshot("B")); const old = h.requests.at(-1)!;
    h.publish(snapshot("C")); h.reply(old, snapshot("B")); await flush();
    expect(h.client.runs(new Set())[0].surfaceId).toBe("A"); expect(h.requests).toHaveLength(3);
    h.reply(h.requests.at(-1)!, snapshot("C")); await flush(); expect(h.client.runs(new Set())[0].surfaceId).toBe("C");
    for (let i = 0; i < 260; i++) {
      const next = snapshot(`surface-${i}`); h.publish(next); h.reply(h.requests.at(-1)!, next); await flush();
    }
    expect(h.retired.size).toBe(256);
    h.publish(snapshot("pending")); h.retire(); h.reply(h.requests.at(-1)!, snapshot("pending")); await flush();
    expect(h.client.runs(new Set())).toEqual([]); expect([...h.bus.listeners.keys()]).toEqual([WORKFLOW_UI_CHANNELS.query]);
  });
});
