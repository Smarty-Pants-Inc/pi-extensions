import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { formatRecallQuote, type MessageCandidate, type RecallMessageRecord } from "../src/messages.js";
import { createRecallExtension } from "../src/recall.js";
import type { RecallStore, RecallStoreSnapshot } from "../src/store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const EXISTING: RecallMessageRecord = {
  type: "recall_message",
  version: 1,
  id: "existing-record",
  savedAt: "2026-08-04T12:00:00.000Z",
  source: { sessionId: "other", entryId: "other-entry", cwd: "/elsewhere", messageTimestamp: 1 },
  role: "user",
  text: "existing saved text",
};

type Action = "save" | "delete" | "quote";

/**
 * Injected fake store: never touches a real Recall file. save/delete hold at a publication gate,
 * then publish (record the call) only if the isCurrent closure Recall passed still holds —
 * the same final check RecallStore performs before its atomic rename.
 */
function gatedStore(published: string[], gate: { opened: () => void; release: Promise<void> }): RecallStore {
  const publish = async (label: string, isCurrent?: () => boolean) => {
    gate.opened();
    await gate.release;
    if (isCurrent && !isCurrent()) throw new DOMException("stale", "AbortError");
    published.push(label);
  };
  return {
    path: "/fake-agent/pi-recall.jsonl",
    async load(): Promise<RecallStoreSnapshot> {
      return { path: this.path, records: [EXISTING], bytes: 0 };
    },
    async save(candidate: MessageCandidate, _signal?: AbortSignal, isCurrent?: () => boolean) {
      await publish(`save:${candidate.entryId}`, isCurrent);
      return { ...EXISTING, id: "new-record", source: { ...EXISTING.source, entryId: candidate.entryId } };
    },
    async delete(id: string, _signal?: AbortSignal, isCurrent?: () => boolean) {
      await publish(`delete:${id}`, isCurrent);
      return true;
    },
  } as unknown as RecallStore;
}

for (const action of ["save", "delete", "quote"] as Action[]) {
  for (const scenario of ["navigate existing descendant", "new append"] as const) {
    test(`SDK: delayed ${action} after ${scenario} from captured ancestor`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "recall-nav-sdk-"));
      let session: AgentSession | undefined;
      const published: string[] = [];
      const earlierHandler = deferred<void>();
      const releaseTree = deferred<void>();
      const opened = deferred<void>();
      const release = deferred<void>();
      let recallSawTree = false;
      let editorText = "destination draft";
      const notifications: string[] = [];
      try {
        const settingsManager = SettingsManager.inMemory();
        const holder = {
          name: "earlier-tree-holder",
          factory: (pi: Parameters<ReturnType<typeof createRecallExtension>>[0]) => {
            pi.on("session_tree", async () => {
              earlierHandler.resolve();
              await releaseTree.promise;
            });
          },
        };
        const recall = {
          name: "recall",
          factory: createRecallExtension({
            getAgentDir: () => cwd,
            createStore: () => gatedStore(published, { opened: () => opened.resolve(), release: release.promise }),
          }),
        };
        const observer = {
          name: "after-recall-observer",
          factory: (pi: Parameters<ReturnType<typeof createRecallExtension>>[0]) => {
            pi.on("session_tree", () => {
              recallSawTree = true;
            });
          },
        };
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir: cwd,
          settingsManager,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [holder, recall, observer],
        });
        await loader.reload();
        const manager = SessionManager.inMemory(cwd);
        const ancestorId = manager.appendMessage({ role: "user", content: "ancestor source", timestamp: 1 });
        const descendantId = manager.appendCustomEntry("existing-descendant");
        ({ session } = await createAgentSession({
          cwd,
          agentDir: cwd,
          settingsManager,
          resourceLoader: loader,
          sessionManager: manager,
          noTools: "all",
        }));
        // Capture at the ancestor; the descendant already exists. (Session setup may append entries.)
        manager.branch(ancestorId);
        let done = false;
        let saveSelects = 0;
        let selections = 0;
        await session.bindExtensions({
          mode: "rpc",
          uiContext: {
            select: async (title: string, options: string[]) => {
              if (done) return undefined;
              if (++selections > 20) throw new Error("Unexpected fixture menu loop");
              if (title.startsWith("Pi Recall")) return action === "save" ? "Save a message" : "Recall a saved message";
              if (title === "Choose scope") return "All";
              if (title.startsWith("Saved message"))
                return action === "quote" ? "Replace client draft with quote" : "Delete…";
              if (action === "save") return saveSelects++ < 1 ? options[0] : undefined;
              return options[0];
            },
            confirm: async (title: string) => {
              if (action === "quote" && title.startsWith("Replace client draft")) {
                opened.resolve();
                await release.promise;
              }
              return true;
            },
            notify(message: string) {
              notifications.push(message);
            },
            getEditorText: () => editorText,
            setEditorText(value: string) {
              editorText = value;
            },
          } as never,
        });
        const command = session.extensionRunner.getCommand("recall");
        assert.ok(command);
        const pending = command.handler("", session.extensionRunner.createCommandContext());
        await opened.promise;
        assert.equal(manager.getLeafId(), ancestorId);
        const expected =
          action === "save" ? `save:${ancestorId}` : action === "delete" ? `delete:${EXISTING.id}` : undefined;

        if (scenario === "new append") {
          manager.appendMessage({ role: "user", content: "genuinely new", timestamp: 2 });
          done = true;
          release.resolve();
          await pending;
          assert.deepEqual(published, expected ? [expected] : [], "Ordinary new append keeps the interaction current");
          if (action === "quote") assert.equal(editorText, formatRecallQuote(EXISTING));
          return;
        }

        const tree = session.navigateTree(descendantId);
        await earlierHandler.promise;
        assert.equal(manager.getLeafId(), descendantId, "SDK commits navigation before session_tree handlers");
        assert.equal(recallSawTree, false);
        try {
          done = true;
          release.resolve();
          await pending;
          assert.equal(recallSawTree, false, "earlier handler still holds Recall's session_tree");
          assert.deepEqual(published, [], `Existing-descendant navigation must drop ${action}`);
          assert.equal(editorText, "destination draft", "Destination editor must not receive the quote");
          assert.equal(
            notifications.some((message) => /Saved message to|Deleted saved message/.test(message)),
            false,
          );
        } finally {
          releaseTree.resolve();
          await tree;
        }
      } finally {
        releaseTree.resolve();
        release.resolve();
        session?.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    }, 10_000);
  }
}
