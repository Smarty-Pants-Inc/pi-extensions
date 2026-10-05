// Defensive reliability variant: asynchronous native input hooks before enqueue.
// Own repository only; in-memory state, no provider networking, no deletion.
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

const repo = resolve(import.meta.dirname, "../../../..");
const source = process.argv[2] ?? join(repo, "packages/pi-goal/src/goal.ts");
const mode = process.argv[3] ?? "async-extension-before-handled";
const idleVariant = mode.startsWith("idle-");
const mixedVariant = mode.startsWith("mixed-");
const nativeRequire = createRequire(
  realpathSync(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")),
);
const { createJiti } = nativeRequire("jiti");
const goal = await createJiti(import.meta.url, { fsCache: false, moduleCache: false }).import(source, {
  default: true,
});
const root = mkdtempSync(join(tmpdir(), "goal-async-input-audit-"));
const settingsPath = join(root, "settings.json");
writeFileSync(settingsPath, JSON.stringify({ toolVisibility: "always" }));
const runtime = createExtensionRuntime(),
  bus = createEventBus();
const phases = [];
let releaseExtension, extensionEntered;
const extensionGate = new Promise((r) => {
  releaseExtension = r;
});
const extensionReady = new Promise((r) => {
  extensionEntered = r;
});
const extensions = [
  await loadExtensionFromFactory((pi) => goal(pi, { settingsPath }), root, bus, runtime),
  await loadExtensionFromFactory(
    (pi) => {
      pi.on("before_agent_start", (event) => {
        phases.push({ boundary: "before_agent_start", prompt: event.prompt });
      });
      pi.on("input", async (event) => {
        phases.push({
          boundary: "input",
          source: event.source,
          text: event.text,
          streamingBehavior: event.streamingBehavior,
        });
        if (event.source === "extension" && event.text === "queued extension observation") {
          extensionEntered();
          await extensionGate;
        }
        if (event.source === "rpc" && event.text === "handled real observation") return { action: "handled" };
      });
    },
    root,
    bus,
    runtime,
  ),
];
const loader = {
  getExtensions: () => ({ extensions, errors: [], runtime }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "Defensive local input-boundary audit",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources() {},
  async reload() {},
};
const manager = SessionManager.inMemory(root);
const saved = {
  id: "auditor-original-wait",
  text: "review completion",
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
  JSON.parse(
    JSON.stringify(
      manager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === "goal-state")
        .at(-1).data.goal,
    ),
  );
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  allowModelNetwork: false,
});
const faux = fauxProvider({ provider: "auditor-async-faux", api: "auditor-async-faux" });
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.refresh({ allowNetwork: false });
let releaseInitial, initialEntered;
const initialGate = new Promise((r) => {
    releaseInitial = r;
  }),
  initialReady = new Promise((r) => {
    initialEntered = r;
  });
let releaseIdle, idleEntered;
const idleGate = new Promise((r) => {
  releaseIdle = r;
});
const idleReady = new Promise((r) => {
  idleEntered = r;
});
const atRequests = [];
const deliveredExtension = () => {
  const current = last();
  atRequests.push(current);
  return current.status === "active"
    ? fauxAssistantMessage(
        fauxToolCall("goal_wait", { goal_id: current.id, reason: "probe-controlled replacement wait" }),
        { stopReason: "toolUse" },
      )
    : fauxAssistantMessage("extension-only response");
};
faux.setResponses(
  idleVariant
    ? [deliveredExtension]
    : [
        async () => {
          initialEntered();
          await initialGate;
          return fauxAssistantMessage("initial response");
        },
        ...(mixedVariant
          ? [
              async () => {
                idleEntered();
                await idleGate;
                return fauxAssistantMessage("unrelated idle response");
              },
            ]
          : []),
        deliveredExtension,
      ],
);
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
const errors = [],
  userMessages = [],
  acknowledgements = [];
session.subscribe((event) => {
  if (event.type === "message_start" && event.message.role === "user")
    userMessages.push(event.message.content.map((p) => p.text ?? "").join("\n"));
  if (event.type === "agent_start") acknowledgements.push(event.type);
});
await session.bindExtensions({ onError: (error) => errors.push(error), mode: "json" });
const before = last();
let running, attempted;
try {
  if (!idleVariant) {
    running = session.prompt("hold initial response", { source: "extension" });
    await initialReady;
  }
  attempted = session.prompt("queued extension observation", {
    source: "extension",
    ...(idleVariant ? {} : { streamingBehavior: "followUp" }),
  });
  await extensionReady;
  assert.equal(
    session.pendingMessageCount,
    0,
    "observed extension is still in its asynchronous input hook, not enqueued",
  );
  if (mixedVariant) {
    // Settlement does not acknowledge the extension still inside its input hook.
    releaseInitial();
    await running;
    running = session.prompt("unrelated idle boundary", { source: "extension" });
    await idleReady;
    assert.equal(session.pendingMessageCount, 0, "idle boundary cannot enqueue the held extension");
  }
  let disposition;
  if (!mode.endsWith("control")) {
    await session.prompt("handled real observation", {
      source: "rpc",
      streamingBehavior: mode === "mixed-handled-steer" ? "steer" : "followUp",
      preflightResult: (d) => {
        disposition = d;
      },
    });
    assert.equal(disposition, "handled");
    assert.equal(session.pendingMessageCount, 0, "handled real attempt does not queue");
  }
  releaseExtension();
  await attempted;
  if (!idleVariant) {
    assert.equal(session.pendingMessageCount, 1, "only the earlier extension input reaches the native queue");
    if (mixedVariant) releaseIdle();
    else releaseInitial();
    await running;
  }
  console.log(
    JSON.stringify(
      {
        mode,
        source,
        before,
        disposition,
        phases,
        userMessages,
        atRequests,
        final: last(),
        errors,
        nativeRequests: faux.state.callCount,
      },
      null,
      2,
    ),
  );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.deepEqual(
    userMessages,
    idleVariant
      ? ["queued extension observation"]
      : mixedVariant
        ? ["hold initial response", "unrelated idle boundary", "queued extension observation"]
        : ["hold initial response", "queued extension observation"],
  );
  assert.equal(faux.state.callCount, idleVariant ? 1 : mixedVariant ? 3 : 2);
  assert.equal(atRequests[0].status, "paused", "an extension-only delivered item must not wake the recorded wait");
  assert.equal(atRequests[0].id, before.id, "handled attempt cannot grant identity rotation");
  assert.equal(atRequests[0].automaticModelTurns, 4, "handled attempt cannot grant a fresh safety epoch");
  assert.deepEqual(atRequests[0].wait, before.wait);
  if (mixedVariant) {
    assert.equal(atRequests.length, 1, "exactly one delivered extension request follows the two local holds");
    assert.equal(atRequests[0].tokensUsed, before.tokensUsed);
    assert.equal(atRequests[0].timeUsedSeconds, before.timeUsedSeconds);
    assert.equal(atRequests[0].iteration, before.iteration);
    assert.deepEqual(last(), before, "extension-only settlement preserves the entire recorded wait");
  }
  console.log(JSON.stringify({ mode, status: "PASS" }));
} finally {
  releaseExtension();
  releaseInitial();
  releaseIdle();
  if (attempted) await attempted;
  if (running) await running;
  await emitSessionShutdownEvent(session._extensionRunner, { type: "session_shutdown", reason: "exit" });
}
