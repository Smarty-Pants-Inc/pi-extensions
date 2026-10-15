import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeCwd, ensureOutputFile, streamToOutputFile, writeInitialEntry } from "../src/output-file.js";

describe("encodeCwd", () => {
  it("encodes a POSIX absolute path by stripping the leading slash and replacing separators", () => {
    expect(encodeCwd("/home/user/project")).toBe("home-user-project");
  });

  it("handles a POSIX root path", () => {
    expect(encodeCwd("/")).toBe("");
  });

  it("encodes a Windows drive-letter path by stripping the drive prefix", () => {
    expect(encodeCwd("C:\\Users\\foo\\project")).toBe("Users-foo-project");
  });

  it("handles lowercase Windows drives", () => {
    expect(encodeCwd("c:\\foo")).toBe("foo");
  });

  it("handles a Windows path written with forward slashes", () => {
    expect(encodeCwd("C:/Users/foo/project")).toBe("Users-foo-project");
  });

  it("preserves server and share for UNC paths", () => {
    expect(encodeCwd("\\\\server\\share\\project")).toBe("server-share-project");
  });

  it("handles mixed separators", () => {
    expect(encodeCwd("/home\\user/project")).toBe("home-user-project");
  });

  it("collapses runs of leading dashes after separator replacement", () => {
    expect(encodeCwd("///foo")).toBe("foo");
  });

  it("returns an empty string for an empty cwd", () => {
    expect(encodeCwd("")).toBe("");
  });

  it("leaves a relative-looking path with no leading separator alone", () => {
    expect(encodeCwd("foo/bar")).toBe("foo-bar");
  });
});

/**
 * Minimal AgentSession fake. streamToOutputFile only reads `session.messages`
 * and calls `session.subscribe(cb)`, so we provide just those — plus test-only
 * helpers to mutate state and fire events deterministically.
 */
function makeFakeSession(initialMessages: unknown[] = []) {
  let messages: unknown[] = [...initialMessages];
  let cb: ((event: unknown) => void) | null = null;
  let unsubscribeCalls = 0;
  let messageReads = 0;
  return {
    get messages() {
      messageReads++;
      return messages;
    },
    subscribe(fn: (event: unknown) => void) {
      cb = fn;
      return () => {
        unsubscribeCalls++;
        cb = null;
      };
    },
    push(...msgs: unknown[]) {
      messages.push(...msgs);
    },
    /** Swap the whole array, like pi's compaction (`agent.state.messages = ...`). */
    replaceAll(msgs: unknown[]) {
      messages = msgs;
    },
    fire(event: unknown) {
      cb?.(event);
    },
    isSubscribed() {
      return cb !== null;
    },
    listener() {
      return cb;
    },
    unsubscribeCalls() {
      return unsubscribeCalls;
    },
    messageReads() {
      return messageReads;
    },
  };
}

/** Drain the microtask queue (the compaction re-anchor is deferred one tick). */
const microtask = () => Promise.resolve();

describe("streamToOutputFile", () => {
  let tmp: string;
  let outPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "stream-out-test-"));
    outPath = join(tmp, "agent.output");
    writeInitialEntry(outPath, "agent-1", "do the thing", "/work");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function readEntries(): Array<Record<string, unknown>> {
    return readFileSync(outPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("writes nothing past the initial entry until turn_end fires", () => {
    const session = makeFakeSession([{ role: "user", content: "do the thing" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    expect(readEntries()).toHaveLength(1); // only the initial entry

    session.fire({ type: "turn_end" });
    expect(readEntries()).toHaveLength(2);
  });

  it("skips leading system records and exactly the first user already present at mount", () => {
    const session = makeFakeSession([
      { role: "system", content: "native prompt" },
      { role: "system", toolsAdded: [], content: "native tool update" },
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "follow-up" },
    ]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
    session.fire({ type: "turn_end" });
    cleanup();

    expect(readEntries().map((e) => e.type)).toEqual(["user", "assistant", "user"]);
    expect(readEntries().map((e) => e.message)).toEqual([
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "follow-up" },
    ]);
  });

  it.each([
    { initialMessages: [] },
    { initialMessages: [{ role: "system", content: "native prompt" }] },
  ])(
    "waits for the initial user arriving after mount ($initialMessages)",
    ({ initialMessages }) => {
      const session = makeFakeSession(initialMessages);
      const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
      session.fire({ type: "turn_end" });
      session.push({ role: "system", content: "tools update" });
      session.fire({ type: "turn_end" });
      expect(readEntries()).toHaveLength(1);

      session.push(
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: "follow-up" },
      );
      session.fire({ type: "turn_end" });
      cleanup();
      expect(readEntries().map((e) => e.type)).toEqual(["user", "assistant", "user"]);
      expect(readEntries().at(-1)?.message).toEqual({ role: "user", content: "follow-up" });
    },
  );

  it("streams pre-user custom guidance without consuming the late initial-user dedup", () => {
    const session = makeFakeSession([{ role: "system", content: "native prompt" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
    const guidance = { role: "custom", customType: "guidance", content: "context only", display: false, details: { original: true } };
    session.push(guidance);
    session.fire({ type: "turn_end" }); // no completed assistant turn
    expect(readEntries().slice(1).map((e) => e.message)).toEqual([guidance]);
    session.push(
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "follow-up" },
    );
    session.fire({ type: "turn_end" });
    cleanup();
    expect(readEntries().map((e) => e.message)).toEqual([
      { role: "user", content: "do the thing" }, guidance,
      { role: "assistant", content: "answer" }, { role: "user", content: "follow-up" },
    ]);
  });

  it("retains late initial-user dedup when compaction only replaces pre-user guidance", async () => {
    const session = makeFakeSession([{ role: "system", content: "native prompt" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
    const guidance = { role: "custom", customType: "guidance", content: "context only", display: false };
    session.push(guidance);
    session.fire({ type: "compaction_start", reason: "manual" });
    session.replaceAll([{ role: "system", content: "rebuilt prompt" }, { role: "compactionSummary", summary: "guidance summary" }]);
    session.fire({ type: "compaction_end", reason: "manual", aborted: false, result: { summary: "guidance summary" } });
    await microtask();
    session.push({ role: "user", content: "do the thing" }, { role: "assistant", content: "answer" }, { role: "user", content: "follow-up" });
    cleanup();
    expect(readEntries().map((e) => e.message)).toEqual([
      { role: "user", content: "do the thing" }, guidance,
      { role: "assistant", content: "answer" }, { role: "user", content: "follow-up" },
    ]);
  });

  it.each(["turn_end", "cleanup"])("flushes a userless custom/assistant/tool transcript on %s without rewriting payloads", (boundary) => {
    const session = makeFakeSession([{ role: "system", content: "native prompt" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
    const messages = [
      { role: "custom", customType: "handled-input", content: "replacement", display: false, details: { raw: "\u001b[31m" } },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "file" } }] },
      { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }], isError: false },
    ];
    session.push(...messages);
    if (boundary === "turn_end") session.fire({ type: "turn_end", message: messages[1], toolResults: [messages[2]] });
    else cleanup();
    expect(readEntries().slice(1).map((e) => e.message)).toEqual(messages);
    cleanup();
    expect(session.unsubscribeCalls()).toBe(1);
  });

  it("keeps a follow-up user after a userless assistant even when both reach the first flush", () => {
    const session = makeFakeSession([
      { role: "system", content: "native prompt" },
      { role: "custom", customType: "handled-input", content: "replacement" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow-up" },
      { role: "assistant", content: "second answer" },
    ]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
    cleanup();
    expect(readEntries().slice(1).map((e) => e.message)).toEqual(session.messages.slice(1));
  });

  it("keeps userless-turn dedup resolved across compaction and late disposal callbacks", async () => {
    const session = makeFakeSession([{ role: "system", content: "native prompt" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
    const listener = session.listener();
    session.push({ role: "custom", customType: "handled-input", content: "replacement" }, { role: "assistant", content: "first answer" });
    session.fire({ type: "compaction_start", reason: "manual" });
    expect(readEntries().map((e) => e.type)).toEqual(["user", "toolResult", "assistant"]);
    session.replaceAll([{ role: "system", content: "rebuilt prompt" }, { role: "compactionSummary", summary: "summary" }]);
    session.fire({ type: "compaction_end", reason: "manual", aborted: false, result: { summary: "summary" } });
    await microtask();
    session.push({ role: "user", content: "follow-up" });
    cleanup();
    const before = readFileSync(outPath, "utf-8");
    session.push({ role: "assistant", content: "ghost" });
    listener?.({ type: "turn_end" });
    listener?.({ type: "compaction_end", aborted: false, result: { summary: "late" } });
    await microtask();
    cleanup();
    expect(readFileSync(outPath, "utf-8")).toBe(before);
    expect(readEntries().at(-1)?.message).toEqual({ role: "user", content: "follow-up" });
    expect(session.unsubscribeCalls()).toBe(1);
  });

  it("does not emit anything when disposed before any initial user arrives", () => {
    const session = makeFakeSession([{ role: "system", content: "native prompt" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
    session.fire({ type: "turn_end" });
    cleanup();
    session.push({ role: "user", content: "too late" });
    cleanup();
    expect(readEntries()).toHaveLength(1);
    expect(session.unsubscribeCalls()).toBe(1);
  });

  it("filters later native system records but stores conversation payloads without display transformations", () => {
    const session = makeFakeSession([{ role: "user", content: "do the thing" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
    const raw = "\u001b[31m<untrusted>\u001b]52;c;payload\u0007\r\n";
    const messages = [
      { role: "user", content: [{ type: "text", text: raw }, { type: "image", data: "AA==", mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: raw, thinkingSignature: "opaque" }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: raw }], details: { raw }, isError: false },
      { role: "bashExecution", command: "printf", output: raw, exitCode: 0, cancelled: false, truncated: false },
      { role: "custom", customType: "notice", content: raw, display: false, details: { raw } },
    ];
    session.push({ role: "system", content: "tools changed", toolsAdded: [] }, ...messages);
    session.fire({ type: "turn_end" });
    session.push({ role: "system", content: "last update" });
    cleanup();
    const entries = readEntries().slice(1);
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "toolResult", "toolResult", "toolResult"]);
    expect(entries.map((e) => e.message)).toEqual(messages);
  });

  it("tags assistant, user, and tool messages with the correct type field", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push(
      { role: "assistant", content: [{ type: "text", text: "thinking" }] },
      { role: "user", content: "follow-up" },
      { role: "tool", content: [{ type: "tool_result", content: "x" }] },
    );
    session.fire({ type: "turn_end" });

    const entries = readEntries();
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "toolResult"]);
    expect(entries.every((e) => e.agentId === "agent-1" && e.isSidechain === true)).toBe(true);
    expect(entries.every((e) => e.cwd === "/work")).toBe(true);
  });

  it("never re-emits messages already flushed on a previous turn_end", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "one" }] });
    session.fire({ type: "turn_end" });

    session.push({ role: "assistant", content: [{ type: "text", text: "two" }] });
    session.fire({ type: "turn_end" });

    // Fire a redundant turn_end with no new messages — must not duplicate
    session.fire({ type: "turn_end" });

    expect(readEntries()).toHaveLength(3);
  });

  it("ignores session events other than turn_end", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "x" }] });
    session.fire({ type: "message_start" });
    session.fire({ type: "tool_call" });
    session.fire({ type: "message_end" });

    expect(readEntries()).toHaveLength(1);
  });

  // ---- Compaction (#145): pi replaces session.messages with a shorter,
  // summarized array; streaming must survive it. Event sequences below mirror
  // pi's real order of operations (verified against agent-session 0.80.6).

  it("resumes streaming after compaction shrinks the message array (#145)", async () => {
    const session = makeFakeSession([
      { role: "system", content: "native prompt" },
      { role: "user", content: "go" },
    ]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push(
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "user", content: "q2" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    );
    session.fire({ type: "turn_end" }); // initial + 3 conversation messages on disk

    // Compaction: summary + kept tail, much shorter than what was written.
    session.fire({ type: "compaction_start", reason: "manual" });
    session.replaceAll([
      { role: "system", content: "rebuilt native prompt" },
      { role: "compactionSummary", summary: "summary of earlier turns" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    ]);
    session.fire({ type: "compaction_end", reason: "manual", aborted: false, result: { summary: "s" } });
    await microtask();

    session.push({ role: "assistant", content: [{ type: "text", text: "AFTER" }] });
    session.fire({ type: "turn_end" });

    const entries = readEntries();
    // initial + one + q2 + two + AFTER — the kept tail is NOT re-written.
    expect(entries).toHaveLength(5);
    expect(JSON.stringify(entries.at(-1))).toContain("AFTER");
    expect(JSON.stringify(entries)).not.toContain("rebuilt native prompt");
    expect(JSON.stringify(entries)).not.toContain("summary of earlier turns");
  });

  it("flushes the not-yet-written tail before compaction discards it (#145)", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    // A message lands with no turn_end yet (e.g. overflow mid-turn)...
    session.push({ role: "assistant", content: [{ type: "text", text: "tail-before-compact" }] });
    expect(readEntries()).toHaveLength(1);

    // ...then compaction starts: the tail must reach the file before the array is replaced.
    session.fire({ type: "compaction_start", reason: "overflow" });
    expect(JSON.stringify(readEntries().at(-1))).toContain("tail-before-compact");
  });

  it("re-anchors after the overflow-retry trim, not at compaction_end (#145)", async () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "big" }] });
    session.fire({ type: "turn_end" });

    // pi's overflow-retry order: compaction_end fires, THEN the trailing error
    // assistant message is sliced off. A synchronous anchor would sit one past
    // the trimmed array and skip the first post-compaction message.
    session.fire({ type: "compaction_start", reason: "overflow" });
    session.replaceAll([
      { role: "user", content: "summary" },
      { role: "assistant", content: [{ type: "text", text: "err" }], stopReason: "error" },
    ]);
    session.fire({ type: "compaction_end", reason: "overflow", aborted: false, result: { summary: "s" }, willRetry: true });
    session.replaceAll([{ role: "user", content: "summary" }]); // the post-emit trim
    await microtask();

    session.push({ role: "assistant", content: [{ type: "text", text: "RETRY-ANSWER" }] });
    session.fire({ type: "turn_end" });

    expect(JSON.stringify(readEntries().at(-1))).toContain("RETRY-ANSWER");
  });

  it("does not re-anchor on aborted or failed compaction (#145)", async () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.fire({ type: "compaction_start", reason: "manual" });
    // Aborted/failed: session.messages is left untouched by pi.
    session.fire({ type: "compaction_end", reason: "manual", aborted: true, result: undefined });
    session.fire({ type: "compaction_end", reason: "manual", aborted: false, result: undefined, errorMessage: "boom" });
    await microtask();

    session.push({ role: "assistant", content: [{ type: "text", text: "still-streaming" }] });
    session.fire({ type: "turn_end" });

    const entries = readEntries();
    expect(entries).toHaveLength(2); // nothing skipped, nothing duplicated
    expect(JSON.stringify(entries.at(-1))).toContain("still-streaming");
  });

  it("cleanup() does a final flush and detaches the subscription", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");

    // Trailing message arrives with no turn_end before shutdown
    session.push({ role: "assistant", content: [{ type: "text", text: "tail" }] });
    expect(readEntries()).toHaveLength(1);

    cleanup();
    expect(readEntries()).toHaveLength(2);
    expect(session.isSubscribed()).toBe(false);

    // Post-cleanup messages must not be written, even if events would otherwise fire
    session.push({ role: "assistant", content: [{ type: "text", text: "ghost" }] });
    session.fire({ type: "turn_end" });
    cleanup();
    cleanup();
    expect(readEntries()).toHaveLength(2);
    expect(session.unsubscribeCalls()).toBe(1);
  });

  it("a late successful compaction microtask and captured listener cannot reactivate a disposed stream", async () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");
    const listener = session.listener();
    session.push({ role: "assistant", content: [{ type: "text", text: "tail" }] });
    session.fire({ type: "compaction_start", reason: "manual" });
    session.replaceAll([{ role: "compactionSummary", summary: "s" }]);
    session.fire({ type: "compaction_end", reason: "manual", aborted: false, result: { summary: "s" } });
    cleanup();
    const readsAtDisposal = session.messageReads();
    await microtask();
    session.push({ role: "assistant", content: [{ type: "text", text: "ghost" }] });
    listener?.({ type: "turn_end" });
    listener?.({ type: "compaction_start", reason: "manual" });
    listener?.({ type: "compaction_end", reason: "manual", aborted: false, result: { summary: "late" } });
    await microtask();
    cleanup();

    expect(session.messageReads()).toBe(readsAtDisposal);
    expect(session.unsubscribeCalls()).toBe(1);
    expect(readEntries()).toHaveLength(2);
    expect(JSON.stringify(readEntries().at(-1))).toContain("tail");
  });

  // ---- Resume / re-anchor (#145, resume): a resume reuses the deterministic
  // per-agent transcript path. `ensureOutputFile` must create it without
  // truncating, and `startIndex` must anchor the stream past turns already on
  // disk so re-running an agent never duplicates or destroys history.

  it("ensureOutputFile creates a missing file without truncating an existing one", () => {
    const fresh = join(tmp, "never-existed.output");
    expect(() => ensureOutputFile(fresh)).not.toThrow();
    expect(readFileSync(fresh, "utf-8")).toBe("");

    // Existing file with prior turns stays byte-identical.
    const before = readFileSync(outPath);
    ensureOutputFile(outPath);
    expect(readFileSync(outPath)).toEqual(before);
  });

  it("startIndex anchors streaming past messages already written to the file", () => {
    const session = makeFakeSession([
      { role: "user", content: "first run prompt" },
      { role: "assistant", content: [{ type: "text", text: "first run answer" }] },
    ]);
    // Simulate a resumed agent: the file already holds the first run, and the
    // stream must not re-emit it — startIndex = session length at resume time.
    streamToOutputFile(session as never, outPath, "agent-1", "/work", 2);

    session.push({ role: "assistant", content: [{ type: "text", text: "second run answer" }] });
    session.fire({ type: "turn_end" });

    const entries = readEntries();
    expect(entries).toHaveLength(2); // initial entry + second-run answer only
    expect(JSON.stringify(entries.at(-1))).toContain("second run answer");
    expect(JSON.stringify(entries.join("\n"))).not.toContain("first run answer");
  });

  it("honors resume indices across old systems/history and preserves the new user", () => {
    const history = [
      { role: "system", content: "old native prompt" },
      { role: "user", content: "old prompt" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "system", content: "old tool update" },
    ];
    const session = makeFakeSession(history);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work", history.length);
    session.fire({ type: "turn_end" });
    session.push(
      { role: "system", content: "new tool update" },
      { role: "user", content: "resumed prompt" },
      { role: "assistant", content: [{ type: "text", text: "resumed answer" }] },
    );
    session.fire({ type: "turn_end" });
    cleanup();
    expect(readEntries().slice(1).map((e) => e.message)).toEqual([
      { role: "user", content: "resumed prompt" },
      { role: "assistant", content: [{ type: "text", text: "resumed answer" }] },
    ]);
  });

  it("explicit zero does not skip the first user", () => {
    const session = makeFakeSession([
      { role: "system", content: "native prompt" },
      { role: "user", content: "resume without old history" },
    ]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work", 0);
    cleanup();
    expect(readEntries().at(-1)?.message).toEqual({ role: "user", content: "resume without old history" });
    expect(readEntries()).toHaveLength(2);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid startIndex %s before subscribing or writing",
    (startIndex) => {
      const session = makeFakeSession();
      const before = readFileSync(outPath);
      expect(() => streamToOutputFile(session as never, outPath, "agent-1", "/work", startIndex))
        .toThrow("startIndex must be a nonnegative safe integer");
      expect(session.isSubscribed()).toBe(false);
      expect(readFileSync(outPath)).toEqual(before);
    },
  );

  it("an anchor beyond current messages holds until the array grows past it", () => {
    const session = makeFakeSession([{ role: "user", content: "old prompt" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work", 3);
    session.push({ role: "assistant", content: "old answer" });
    session.fire({ type: "turn_end" });
    expect(readEntries()).toHaveLength(1);
    session.push({ role: "system", content: "old system record" }, { role: "user", content: "new prompt" });
    cleanup();
    expect(readEntries().at(-1)?.message).toEqual({ role: "user", content: "new prompt" });
    expect(readEntries()).toHaveLength(2);
  });

  it("an anchor at current length writes the resumed prompt and answer", () => {
    // A resumed run's prompt lands at index = session length at resume time
    // (the anchor). History below the anchor is already on disk.
    const history = [
      { role: "user", content: "previous run prompt" },
      { role: "assistant", content: [{ type: "text", text: "previous run answer" }] },
    ];
    const session = makeFakeSession(history);
    streamToOutputFile(session as never, outPath, "agent-1", "/work", history.length);

    session.fire({ type: "turn_end" }); // nothing past the anchor yet
    expect(readEntries()).toHaveLength(1);

    session.push({ role: "user", content: "resumed prompt" }); // index 2 = anchor
    session.push({ role: "assistant", content: [{ type: "text", text: "after resume" }] });
    session.fire({ type: "turn_end" });

    const combined = JSON.stringify(readEntries());
    expect(combined).toContain("resumed prompt");
    expect(combined).toContain("after resume");
    expect(combined).not.toContain("previous run answer");
  });
});
