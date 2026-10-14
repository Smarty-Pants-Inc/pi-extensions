import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecordSnapshot } from "../src/types.js";
import { ConversationViewer, type SteerHandler } from "../src/ui/conversation-viewer.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function fixture(onSteer: SteerHandler) {
  const record = { id: "a", type: "Explore", description: "run", status: "running", startedAt: Date.now(), toolUses: 0,
    lifetimeUsage: { input: 1000, output: 0, cacheWrite: 0 }, compactionCount: 2 } as AgentRecordSnapshot;
  const session = { subscribe: () => () => {}, get messages() { throw new Error("disposed"); }, getSessionStats() { throw new Error("disposed"); } } as unknown as AgentSession;
  const viewer = new ConversationViewer({ terminal: { rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
    session, record, undefined, theme, vi.fn(), undefined, undefined, onSteer, () => record);
  return { viewer, record };
}
function draft(viewer: ConversationViewer) {
  viewer.handleInput("\r");
  for (const character of "draft") viewer.handleInput(character);
}

describe("conversation steering recovery", () => {
  it("retains a draft when the record finishes before submission and shows record lifetime/compactions without live activity", () => {
    const steer = vi.fn();
    const { viewer, record } = fixture(steer);
    draft(viewer);
    // Live source changes independently of the overlay.
    Object.assign(record, { status: "completed" });
    viewer.handleInput("\r");
    const output = viewer.render(160).join("\n");
    expect(output).toContain("draft"); expect(output).toContain("Agent finished");
    expect(output).toContain("1.0k tokens"); expect(output).toContain("compactions 2");
    expect(steer).not.toHaveBeenCalled();
    viewer.dispose();
  });

  it.each(["false", "async-false", "throw", "reject"] as const)("retains the draft on %s and permits retry", async failure => {
    let accepted = false;
    const steer = vi.fn(() => {
      if (accepted) return true;
      if (failure === "false") return false;
      if (failure === "async-false") return Promise.resolve(false);
      if (failure === "throw") throw new Error("not available");
      return Promise.reject(new Error("not available"));
    });
    const { viewer } = fixture(steer);
    draft(viewer); viewer.handleInput("\r");
    await Promise.resolve();
    expect(viewer.render(100).join("\n")).toContain("draft retained");
    accepted = true; viewer.handleInput("\r");
    expect(steer).toHaveBeenLastCalledWith("draft");
    expect(viewer.render(100).join("\n")).not.toContain("draft retained");
    viewer.dispose();
  });

  it("keeps the legacy void callback contract and ignores delayed completions after disposal", async () => {
    const legacy = fixture(() => {});
    draft(legacy.viewer); legacy.viewer.handleInput("\r");
    expect(legacy.viewer.render(100).join("\n")).not.toContain("Enter send");
    legacy.viewer.dispose();
    let resolve: ((result: boolean) => void) | undefined;
    const pending = fixture(() => new Promise<boolean>(done => { resolve = done; }));
    draft(pending.viewer); pending.viewer.handleInput("\r"); pending.viewer.dispose();
    resolve!(false); await Promise.resolve();
    expect(() => pending.viewer.handleInput("\r")).not.toThrow();
  });
});
