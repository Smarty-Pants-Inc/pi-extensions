// Defensive native queue-provenance acceptance probe: all resources in memory/private TMPDIR.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  createEventBus,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { emitSessionShutdownEvent } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";

const source = process.argv[2] ?? resolve(import.meta.dirname, "../../src/goal.ts");
const nativeRequire = createRequire(
  realpathSync(resolve(import.meta.dirname, "../../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js")),
);
const { createJiti } = nativeRequire("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const goal = await jiti.import(source, { default: true });
const evidence = [];
for (const mode of [process.argv[3] ?? "handled"]) {
  const earlierCount = mode === "nonempty" ? 1 : 0;
  const root = mkdtempSync(join(tmpdir(), "goal-native-auditor-"));
  const settingsPath = join(root, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ toolVisibility: "always" }));
  const runtime = createExtensionRuntime(),
    bus = createEventBus();
  let sibling;
  const extensions = [
    await loadExtensionFromFactory((pi) => goal(pi, { settingsPath }), root, bus, runtime),
    await loadExtensionFromFactory(
      (pi) => {
        sibling = pi;
        pi.on("input", (e) => (e.source === "rpc" && e.text === "/notice green" ? { action: "handled" } : undefined));
      },
      root,
      bus,
      runtime,
    ),
  ];
  const loader = {
    getExtensions: () => ({ extensions, errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({
      prompts: [
        {
          name: "notice",
          description: "audit notice",
          content: "Recorded outcome: $1",
          source: "test",
          filePath: join(root, "notice.md"),
        },
      ],
      diagnostics: [],
    }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Local defensive provenance test",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  };
  const manager = SessionManager.inMemory(root);
  const saved = {
    id: "native-original-wait",
    text: "finish local acceptance review",
    status: "paused",
    startedAt: 1,
    updatedAt: 2,
    iteration: 3,
    tokensUsed: 7,
    timeUsedSeconds: 9,
    baselineTokens: 0,
    automaticModelTurns: 4,
    toolFreeRepeatCount: 1,
    wait: { reason: "original condition" },
  };
  manager.appendCustomEntry("goal-state", { goal: saved });
  const last = () =>
    structuredClone(
      manager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === "goal-state")
        .at(-1).data.goal,
    );
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: "audit-faux", api: "audit-faux" });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let entered;
  const ready = new Promise((r) => {
    entered = r;
  });
  const atRequests = [];
  const contexts = [];
  faux.setResponses([
    async () => {
      entered();
      await gate;
      return fauxAssistantMessage("initial local response");
    },
    (context) => {
      atRequests.push(last());
      contexts.push(context);
      const current = last();
      if (current.status === "active")
        return fauxAssistantMessage(
          fauxToolCall("goal_wait", { goal_id: current.id, reason: "replacement condition" }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("first queued delivery acknowledged");
    },
    (context) => {
      atRequests.push(last());
      contexts.push(context);
      const current = last();
      if (current.status === "active")
        return fauxAssistantMessage(
          fauxToolCall("goal_wait", { goal_id: current.id, reason: "replacement condition" }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("second queued delivery acknowledged");
    },
  ]);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
    noTools: "builtin",
  });
  const errors = [];
  const userMessages = [];
  session.subscribe((e) => {
    if (e.type === "message_start" && e.message.role === "user")
      userMessages.push(e.message.content.map((c) => c.text ?? "").join("\n"));
  });
  await session.bindExtensions({ onError: (e) => errors.push(e), mode: "json" });
  let running;
  try {
    running = session.prompt("hold initial local response", { source: "extension" });
    await Promise.race([
      ready,
      running.then(() => {
        throw new Error("initial native prompt settled before the local gate");
      }),
    ]);
    if (earlierCount) {
      sibling.sendUserMessage("Earlier extension input", { deliverAs: "followUp" });
      const deadline = Date.now() + 5000;
      while (session.pendingMessageCount < earlierCount) {
        assert.ok(Date.now() < deadline, "earlier extension input did not queue");
        await new Promise((done) => setTimeout(done, 5));
      }
    }
    let disposition;
    await session.prompt("/notice green", {
      source: "rpc",
      streamingBehavior: "followUp",
      preflightResult: (d) => {
        disposition = d;
      },
    });
    assert.equal(disposition, "handled");
    assert.equal(session.pendingMessageCount, earlierCount, "handled input never adds a native queue item");
    sibling.sendUserMessage("Recorded outcome: green", { deliverAs: "followUp" });
    // Native extension binding is void: observe actual queue state before releasing local response.
    const deadline = Date.now() + 5000;
    while (session.pendingMessageCount < earlierCount + 1) {
      assert.ok(Date.now() < deadline, "extension input did not queue");
      await new Promise((r) => setTimeout(r, 5));
    }
    release();
    await running;
    const first = atRequests[earlierCount];
    console.log(JSON.stringify({ mode, source, disposition, userMessages, atRequests, final: last() }, null, 2));
    assert.equal(userMessages.length, 2 + earlierCount, "handled real input must not produce a native user message");
    assert.deepEqual(
      userMessages.slice(1),
      earlierCount ? ["Earlier extension input", "Recorded outcome: green"] : ["Recorded outcome: green"],
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(faux.state.callCount, 2 + earlierCount, "only initial and delivered extension responses");
    assert.equal(first.status, "paused", "delivered extension input cannot inherit authority from handled real input");
    assert.equal(first.id, saved.id, "handled input cannot authorize identity rotation");
    assert.equal(first.automaticModelTurns, 4, "handled input cannot authorize a fresh safety epoch");
    assert.equal(last().status, "paused");
    assert.equal(last().wait.reason, "original condition");
    evidence.push({
      mode,
      status: "PASS",
      nativeRequests: faux.state.callCount,
      userMessages,
      atRequests,
      final: last(),
    });
  } finally {
    release();
    if (running) await running;
    await emitSessionShutdownEvent(session._extensionRunner, { type: "session_shutdown", reason: "exit" });
    // No resource-disposal hook is invoked; all request/timer work was awaited or cancelled by session_shutdown.
  }
}
console.log(JSON.stringify({ source, nativePeer: "1.0.0", checks: evidence }, null, 2));
