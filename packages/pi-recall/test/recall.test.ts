import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { formatRecallQuote, type MessageCandidate, type RecallMessageRecord } from "../src/messages.js";
import { createRecallExtension } from "../src/recall.js";
import { RecallStore, type RecallStoreSnapshot } from "../src/store.js";
import { createMockContext, createMockPi } from "./support.js";

function emptyStore(overrides: Partial<RecallStore> = {}): RecallStore {
  return {
    path: "/agent/pi-recall.jsonl",
    async load(): Promise<RecallStoreSnapshot> {
      return { path: this.path, records: [], bytes: 0 };
    },
    async save(candidate: MessageCandidate): Promise<RecallMessageRecord> {
      return {
        type: "recall_message",
        version: 1,
        id: "saved",
        savedAt: "2026-08-04T12:00:00.000Z",
        source: {
          sessionId: candidate.source.sessionId,
          entryId: candidate.entryId,
          cwd: candidate.source.cwd,
          messageTimestamp: candidate.messageTimestamp,
        },
        role: candidate.role,
        text: candidate.text,
      };
    },
    async delete() {
      return false;
    },
    ...overrides,
  } as RecallStore;
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const navigationCases = ["committed tree", "cancelled tree", "stale tree", "stale shutdown"] as const;

async function navigate(
  mock: ReturnType<typeof createMockPi>,
  navigation: (typeof navigationCases)[number],
  current: unknown,
  previous: unknown,
): Promise<void> {
  if (navigation === "stale tree" || navigation === "stale shutdown") {
    await emit(mock, navigation === "stale tree" ? "session_tree" : "session_shutdown", {}, previous);
    return;
  }
  await emit(mock, "session_before_tree", {}, current);
  // A cancelled navigation never emits the committed session_tree event.
  if (navigation === "committed tree") {
    await emit(mock, "session_tree", { oldLeafId: "old-message", newLeafId: "new-message" }, current);
  }
}

test("registers /recall and warns visibly on every started UI session", async () => {
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => emptyStore() })(mock.pi);
  assert.ok(mock.commands.has("recall"));
  const first = createMockContext({ hasUI: true, mode: "rpc" });
  const second = createMockContext({ hasUI: true, mode: "rpc" });
  await emit(mock, "session_start", { reason: "startup" }, first.ctx);
  await emit(mock, "session_start", { reason: "new" }, second.ctx);
  assert.match(first.notifications[0]?.message ?? "", /Pi Recall is experimental/i);
  assert.match(second.notifications[0]?.message ?? "", /Pi Recall is experimental/i);
});

test("rejects arguments and print/json modes before opening interactive UI", async () => {
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => emptyStore() })(mock.pi);
  const command = mock.commands.get("recall");
  assert.ok(command);
  const rpc = createMockContext({ hasUI: true, mode: "rpc" });
  await emit(mock, "session_start", { reason: "startup" }, rpc.ctx);
  await command?.handler("unexpected", rpc.ctx);
  assert.match(rpc.notifications.at(-1)?.message ?? "", /Usage: \/recall/);
  for (const mode of ["print", "json"] as const) {
    const headless = createMockContext({ hasUI: false, mode });
    await assert.rejects(Promise.resolve(command?.handler("trailing", headless.ctx)), /Usage: \/recall/);
    await assert.rejects(Promise.resolve(command?.handler("", headless.ctx)), /requires Pi TUI or RPC mode/);
  }
});

test("builds save candidates only from the current active branch with normalized source metadata", async () => {
  let observed: MessageCandidate | undefined;
  const store = emptyStore({
    async save(value: MessageCandidate) {
      observed = value;
      return emptyStore().save(value);
    },
  });
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => store })(mock.pi);
  let selects = 0;
  const sessionManager = {
    getSessionId: () => "session-current",
    getSessionName: () => "Current work",
    getLeafId: () => "branch-message",
    getBranch: () => [
      {
        type: "message",
        id: "branch-message",
        message: { role: "user", content: "save me", timestamp: 100 },
      },
    ],
  };
  const ctx = createMockContext({
    hasUI: true,
    mode: "rpc",
    cwd: "/work/./project",
    sessionManager,
    select: async (_title: string, options: string[]) => {
      selects += 1;
      if (selects <= 2) return options[0];
      return "Close";
    },
  });
  await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
  await mock.commands.get("recall")?.handler("", ctx.ctx);
  assert.equal(observed?.entryId, "branch-message");
  assert.equal(observed?.source.sessionId, "session-current");
  assert.equal(observed?.source.sessionName, "Current work");
  assert.equal(observed?.source.cwd, "/work/project");
});

test("session shutdown aborts an in-flight save and suppresses stale success UI", async () => {
  let saveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  const store = emptyStore({
    async save(candidate: MessageCandidate, signal?: AbortSignal) {
      saveStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return emptyStore().save(candidate);
    },
  });
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => store })(mock.pi);
  const sessionManager = {
    getSessionId: () => "session",
    getSessionName: () => undefined,
    getLeafId: () => "message",
    getBranch: () => [
      {
        type: "message",
        id: "message",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 1 },
      },
    ],
  };
  let selects = 0;
  const ctx = createMockContext({
    hasUI: true,
    mode: "rpc",
    sessionManager,
    select: async (_title: string, options: string[]) => (selects++ < 2 ? options[0] : undefined),
  });
  await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
  const running = Promise.resolve(mock.commands.get("recall")?.handler("", ctx.ctx));
  await started;
  await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  await running;
  assert.equal(ctx.notifications.filter(({ message }) => /Saved message/.test(message)).length, 0);
});

test("a completed publication after replacement does not touch the stale UI", async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = emptyStore({
    async save(candidate: MessageCandidate) {
      started();
      await gate;
      return emptyStore().save(candidate);
    },
  });
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => store })(mock.pi);
  const sessionManager = {
    getSessionId: () => "session",
    getSessionName: () => undefined,
    getLeafId: () => "message",
    getBranch: () => [
      {
        type: "message",
        id: "message",
        message: { role: "user", content: "save", timestamp: 1 },
      },
    ],
  };
  let selects = 0;
  const first = createMockContext({
    hasUI: true,
    mode: "rpc",
    sessionManager,
    select: async (_title: string, options: string[]) => (selects++ < 2 ? options[0] : undefined),
  });
  await emit(mock, "session_start", { reason: "startup" }, first.ctx);
  const running = mock.commands.get("recall")?.handler("", first.ctx);
  await waiting;
  const replacement = createMockContext({ hasUI: true, mode: "rpc" });
  await emit(mock, "session_start", { reason: "new" }, replacement.ctx);
  release();
  await running;
  assert.equal(first.notifications.filter(({ message }) => /Saved message/.test(message)).length, 0);
});

for (const navigation of navigationCases) {
  test(`delayed RPC save selection respects ${navigation} ownership`, async () => {
    const opened = deferred<void>();
    const selection = deferred<string>();
    const saved: string[] = [];
    const store = emptyStore({
      async save(candidate: MessageCandidate) {
        saved.push(candidate.entryId);
        return emptyStore().save(candidate);
      },
    });
    const mock = createMockPi();
    createRecallExtension({ getAgentDir: () => "/agent", createStore: () => store })(mock.pi);
    let entryId = "old-message";
    let selects = 0;
    let delayedChoice = "";
    let dialogSignal: AbortSignal | undefined;
    const current = createMockContext({
      hasUI: true,
      mode: "rpc",
      editorText: "existing client draft",
      sessionManager: {
        getSessionId: () => "session",
        getSessionName: () => undefined,
        getLeafId: () => entryId,
        getBranch: () => [{ type: "message", id: entryId, message: { role: "user", content: entryId, timestamp: 1 } }],
      },
      select: async (_title: string, options: string[], dialog?: { signal?: AbortSignal }) => {
        selects += 1;
        if (selects === 1) return options[0];
        if (selects === 2) {
          delayedChoice = options[0] ?? "";
          dialogSignal = dialog?.signal;
          assert.equal(dialogSignal?.aborted, false);
          opened.resolve();
          // Deliberately ignore abort: RPC clients can reply after navigation.
          return selection.promise;
        }
        return "Close";
      },
    });
    const previous = createMockContext({ hasUI: true, mode: "rpc" });
    await emit(mock, "session_start", { reason: "startup" }, previous.ctx);
    await emit(mock, "session_start", { reason: "new" }, current.ctx);
    const running = mock.commands.get("recall")?.handler("", current.ctx);
    await opened.promise;
    if (navigation === "committed tree") entryId = "new-message";
    await navigate(mock, navigation, current.ctx, previous.ctx);
    assert.equal(dialogSignal?.aborted, navigation === "committed tree");
    selection.resolve(delayedChoice);
    await running;
    assert.deepEqual(saved, navigation === "committed tree" ? [] : ["old-message"]);
    assert.equal(current.editorText, "existing client draft");
    assert.equal(
      current.notifications.filter(({ message }) => /Saved message/.test(message)).length,
      navigation === "committed tree" ? 0 : 1,
    );

    if (navigation === "committed tree") {
      // The same manager remains active, with fresh candidates and a renewed controller.
      selects = 0;
      await mock.commands.get("recall")?.handler("", current.ctx);
      assert.deepEqual(saved, ["new-message"]);
    }
  });

  test(`delayed RPC quote confirmation respects ${navigation} ownership`, async () => {
    const opened = deferred<void>();
    const confirmation = deferred<boolean>();
    const record = await emptyStore().save({
      entryId: "saved-message",
      role: "assistant",
      text: "saved answer",
      messageTimestamp: 1,
      source: { sessionId: "session", cwd: "/work/project" },
    });
    let storeWrites = 0;
    const store = emptyStore({
      async load() {
        return { path: this.path, records: [record], bytes: 1 };
      },
      async save(candidate: MessageCandidate) {
        storeWrites += 1;
        return emptyStore().save(candidate);
      },
      async delete() {
        storeWrites += 1;
        return true;
      },
    });
    const mock = createMockPi();
    createRecallExtension({ getAgentDir: () => "/agent", createStore: () => store })(mock.pi);
    let dialogSignal: AbortSignal | undefined;
    let selects = 0;
    const current = createMockContext({
      hasUI: true,
      mode: "rpc",
      cwd: "/work/project",
      select: async (title: string, options: string[]) => {
        assert.ok(++selects <= 4, `Unexpected dialog: ${title}`);
        if (title.startsWith("Pi Recall")) return "Recall a saved message";
        if (title.startsWith("Saved message")) return "Replace client draft with quote";
        return options[0];
      },
      confirm: async (_title: string, _message: string, dialog?: { signal?: AbortSignal }) => {
        dialogSignal = dialog?.signal;
        opened.resolve();
        // Deliberately accept even when this dialog's signal has been aborted.
        return confirmation.promise;
      },
    });
    let clientDraft = "existing client draft";
    let editorWrites = 0;
    Object.assign((current.ctx as unknown as { ui: Record<string, unknown> }).ui, {
      setEditorText: (value: string) => {
        clientDraft = value;
        editorWrites += 1;
      },
    });
    const previous = createMockContext({ hasUI: true, mode: "rpc" });
    await emit(mock, "session_start", { reason: "startup" }, previous.ctx);
    await emit(mock, "session_start", { reason: "new" }, current.ctx);
    const running = mock.commands.get("recall")?.handler("", current.ctx);
    await opened.promise;
    await navigate(mock, navigation, current.ctx, previous.ctx);
    assert.equal(dialogSignal?.aborted, navigation === "committed tree");
    confirmation.resolve(true);
    await running;
    assert.equal(storeWrites, 0);
    assert.equal(editorWrites, navigation === "committed tree" ? 0 : 1);
    assert.equal(clientDraft, navigation === "committed tree" ? "existing client draft" : formatRecallQuote(record));
  });
}

function branchFixture() {
  const manager = SessionManager.inMemory("/work/project");
  const rootId = manager.appendMessage({ role: "user", content: "shared source message", timestamp: 1 });
  // Ownership follows the entire raw branch, not just eligible message candidates.
  const originLeafId = manager.appendCustomEntry("origin-metadata");
  return { manager, rootId, originLeafId };
}

for (const action of ["save", "quote"] as const) {
  for (const target of ["sibling", "ancestor", "empty", "unreadable branch", "inconsistent leaf"] as const) {
    test(`live ownership fences delayed RPC ${action} on ${target} before Recall receives session_tree`, async () => {
      const opened = deferred<void>();
      const reply = deferred<string | boolean>();
      const earlierHandler = deferred<void>();
      const releaseTree = deferred<void>();
      const mock = createMockPi();
      mock.rawPi.on("session_tree", async () => {
        earlierHandler.resolve();
        await releaseTree.promise;
      });
      const { manager, rootId, originLeafId } = branchFixture();
      const record = await emptyStore().save({
        entryId: rootId,
        role: "user",
        text: "saved shared source",
        messageTimestamp: 1,
        source: { sessionId: manager.getSessionId(), cwd: "/work/project" },
      });
      const saved: string[] = [];
      const store = emptyStore({
        async load() {
          return { path: this.path, records: action === "quote" ? [record] : [], bytes: 0 };
        },
        async save(candidate: MessageCandidate) {
          saved.push(candidate.entryId);
          return emptyStore().save(candidate);
        },
      });
      createRecallExtension({ getAgentDir: () => "/agent", createStore: () => store })(mock.pi);
      let recallSawTree = false;
      mock.rawPi.on("session_tree", () => {
        recallSawTree = true;
      });
      let selects = 0;
      let choice = "";
      let dialogSignal: AbortSignal | undefined;
      const current = createMockContext({
        mode: "rpc",
        hasUI: true,
        cwd: "/work/project",
        editorText: "current draft",
        sessionManager: manager,
        select: async (title: string, options: string[], dialog?: { signal?: AbortSignal }) => {
          if (action === "quote") {
            if (title.startsWith("Pi Recall")) return "Recall a saved message";
            if (title.startsWith("Saved message")) return "Replace client draft with quote";
            return options[0];
          }
          selects += 1;
          if (selects === 1) return options[0];
          if (selects === 2) {
            choice = options[0] ?? "";
            dialogSignal = dialog?.signal;
            opened.resolve();
            return reply.promise as Promise<string>;
          }
          return "Close";
        },
        confirm: async (_title: string, _message: string, dialog?: { signal?: AbortSignal }) => {
          dialogSignal = dialog?.signal;
          opened.resolve();
          return reply.promise as Promise<boolean>;
        },
      });
      await emit(mock, "session_start", { reason: "startup" }, current.ctx);
      const running = mock.commands.get("recall")?.handler("", current.ctx);
      await opened.promise;
      if (target === "empty") manager.resetLeaf();
      else if (target === "ancestor" || target === "sibling") {
        manager.branch(rootId);
        if (target === "sibling") manager.appendCustomEntry("sibling-metadata");
      }
      const tree = emit(mock, "session_tree", { oldLeafId: originLeafId, newLeafId: manager.getLeafId() }, current.ctx);
      await earlierHandler.promise;
      const originalGetBranch = manager.getBranch;
      const originalGetLeafId = manager.getLeafId;
      if (target === "unreadable branch") {
        manager.getBranch = () => {
          throw new Error("branch unavailable");
        };
      }
      if (target === "inconsistent leaf") manager.getLeafId = () => "unavailable-leaf";
      try {
        assert.equal(recallSawTree, false);
        assert.equal(dialogSignal?.aborted, false, "Recall's generation/controller have not changed yet");
        reply.resolve(action === "save" ? choice : true);
        await running;
        assert.equal(recallSawTree, false, "The earlier handler remains blocked during callback completion");
        assert.deepEqual(saved, []);
        assert.equal(current.editorText, "current draft");
        assert.equal(
          current.notifications.some(({ message }) => /Saved message/.test(message)),
          false,
        );
      } finally {
        manager.getBranch = originalGetBranch;
        manager.getLeafId = originalGetLeafId;
        releaseTree.resolve();
        await tree;
      }
      assert.equal(recallSawTree, true);
      if (action === "save" && target !== "empty") {
        selects = 0;
        await mock.commands.get("recall")?.handler("", current.ctx);
        assert.deepEqual(saved, [rootId], "Fresh flow uses the renewed same-manager controller");
      }
    });
  }

  for (const append of ["message", "metadata", "empty origin", "committed descendant"] as const) {
    const navigation = append === "committed descendant";
    const policy = navigation ? "committed descendant navigation retires" : `ordinary ${append} append preserves`;
    test(`${policy} a pending RPC ${action}`, async () => {
      const { manager, rootId, originLeafId } = branchFixture();
      if (append === "empty origin") manager.resetLeaf();
      const record = await emptyStore().save({
        entryId: rootId,
        role: "user",
        text: "saved answer",
        messageTimestamp: 1,
        source: { sessionId: manager.getSessionId(), cwd: "/work/project" },
      });
      const opened = deferred<void>();
      const reply = deferred<string | boolean>();
      const saved: string[] = [];
      const mock = createMockPi();
      createRecallExtension({
        getAgentDir: () => "/agent",
        createStore: () =>
          emptyStore({
            async load() {
              return { path: this.path, records: action === "quote" ? [record] : [], bytes: 0 };
            },
            async save(candidate: MessageCandidate) {
              saved.push(candidate.entryId);
              return emptyStore().save(candidate);
            },
          }),
      })(mock.pi);
      let selects = 0;
      let choice = "";
      const current = createMockContext({
        mode: "rpc",
        hasUI: true,
        cwd: "/work/project",
        editorText: "existing draft",
        sessionManager: manager,
        select: async (title: string, options: string[]) => {
          if (action === "quote") {
            if (title.startsWith("Pi Recall")) return "Recall a saved message";
            if (title.startsWith("Saved message")) return "Replace client draft with quote";
            return options[0];
          }
          selects += 1;
          if (selects === 1) {
            // An empty origin has no save choices; pause on main instead.
            if (append !== "empty origin") return options[0];
            choice = "Close";
          } else if (selects === 2) choice = options[0] ?? "";
          else return "Close";
          opened.resolve();
          return reply.promise as Promise<string>;
        },
        confirm: async () => {
          opened.resolve();
          return reply.promise as Promise<boolean>;
        },
      });
      await emit(mock, "session_start", { reason: "startup" }, current.ctx);
      const running = mock.commands.get("recall")?.handler("", current.ctx);
      await opened.promise;
      if (append === "metadata") manager.appendCustomEntry("ordinary-metadata");
      else manager.appendMessage({ role: "user", content: "ordinary appended message", timestamp: 2 });
      if (navigation) {
        // A committed navigation event retires the flow even when the opening path survives.
        await emit(mock, "session_tree", { oldLeafId: originLeafId, newLeafId: manager.getLeafId() }, current.ctx);
      }
      reply.resolve(action === "save" ? choice : true);
      await running;
      assert.deepEqual(saved, action === "save" && append !== "empty origin" && !navigation ? [rootId] : []);
      assert.equal(
        current.editorText,
        action === "quote" && !navigation ? formatRecallQuote(record) : "existing draft",
      );
    });
  }
}

for (const action of ["save", "delete"] as const) {
  test(`live ownership prevents queued ${action} publication before the tree handler runs`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-recall-ownership-"));
    const path = join(root, "pi-recall.jsonl");
    const ready = deferred<void>();
    const publication = deferred<void>();
    const earlierHandler = deferred<void>();
    const releaseTree = deferred<void>();
    const { manager, rootId, originLeafId } = branchFixture();
    const record = await new RecallStore(path).save({
      entryId: "already-saved",
      role: "user",
      text: "existing saved text",
      messageTimestamp: 1,
      source: { sessionId: manager.getSessionId(), cwd: "/work/project" },
    });
    const original = await readFile(path, "utf8");
    const store = new RecallStore(path, {
      beforeRename: async () => {
        ready.resolve();
        await publication.promise;
      },
    });
    const mock = createMockPi();
    mock.rawPi.on("session_tree", async () => {
      earlierHandler.resolve();
      await releaseTree.promise;
    });
    createRecallExtension({ getAgentDir: () => root, createStore: () => store })(mock.pi);
    let selects = 0;
    const current = createMockContext({
      mode: "rpc",
      hasUI: true,
      cwd: "/work/project",
      sessionManager: manager,
      select: async (title: string, options: string[]) => {
        if (action === "save") return selects++ < 2 ? options[0] : "Close";
        if (title.startsWith("Pi Recall")) return "Recall a saved message";
        if (title.startsWith("Saved message")) return "Delete…";
        return options[0];
      },
    });
    await emit(mock, "session_start", { reason: "startup" }, current.ctx);
    const running = mock.commands.get("recall")?.handler("", current.ctx);
    await ready.promise;
    manager.branch(rootId);
    const tree = emit(mock, "session_tree", { oldLeafId: originLeafId, newLeafId: rootId }, current.ctx);
    await earlierHandler.promise;
    try {
      publication.resolve();
      await running;
      assert.equal(await readFile(path, "utf8"), original);
      assert.deepEqual(
        (await store.load()).records.map(({ id }) => id),
        [record.id],
      );
      assert.deepEqual((await readdir(root)).sort(), ["pi-recall.jsonl"]);
      assert.equal(
        current.notifications.some(({ message }) => /Saved message|Deleted saved message/.test(message)),
        false,
      );
    } finally {
      releaseTree.resolve();
      await tree;
      await rm(root, { recursive: true, force: true });
    }
  });
}
