import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ParentQuestionBroker } from "../src/parent-questions.js";
import { captureQuestionOrigin } from "../src/question-origin.js";

const context = (sessionManager: SessionManager) => ({ sessionManager }) as ExtensionContext;
describe("native question branch origin", () => {
  it("retains ordinary appends but retires metadata-distinct branches with identical model projections", async () => {
    const manager = SessionManager.inMemory();
    const ancestor = manager.appendMessage({ role: "user", content: "same", timestamp: 1 });
    const old = manager.appendCustomEntry("metadata", { owner: "old" });
    const ctx = context(manager);
    const isCurrent = captureQuestionOrigin(ctx);
    const originalProjection = manager.buildSessionProjection().messages;
    manager.appendCustomEntry("ordinary_append", { value: 1 });
    expect(isCurrent(ctx)).toBe(true);
    const broker = new ParentQuestionBroker(vi.fn());
    const reply = broker.request({ agentId: "child", isCurrent: () => isCurrent(ctx) }, "old question");
    const id = JSON.parse(broker.context()!.split("\n").at(-1)!)[0].questionId;
    manager.branch(ancestor);
    manager.appendCustomEntry("metadata", { owner: "new" });
    expect(manager.buildSessionProjection().messages).toEqual(originalProjection);
    expect(isCurrent(ctx)).toBe(false);
    expect(() => broker.answer(id, "answer")).toThrow("Unknown");
    expect(await reply).toMatchObject({ status: "unanswered" });
    expect(broker.context()).toBeUndefined();
    manager.branch(old);
    expect(isCurrent(ctx)).toBe(false); // irreversible after live divergence
    expect(await broker.request({ agentId: "late", isCurrent: () => isCurrent(ctx) }, "late question")).toMatchObject({ status: "unanswered" });
  });
  it("checks manager identity even with the same session ID and complete entry prefix", () => {
    const manager = SessionManager.inMemory();
    const ctx = context(manager);
    const isCurrent = captureQuestionOrigin(ctx);
    const replacement = SessionManager.inMemory();
    replacement.newSession({ id: manager.getSessionId() });
    expect(isCurrent(context(replacement))).toBe(false);
  });
});
