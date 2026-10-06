// Defensive capacity regression: local faux requests, in-memory sessions, no network or deletion.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

// ponytail: these internals are not in pi-coding-agent's exports map; load them from the installed
// package's real dist path instead of a cross-package relative import (check:boundaries).
const agentDist = join(
  realpathSync(resolve(import.meta.dirname, "../../../../node_modules/@earendil-works/pi-coding-agent")),
  "dist",
);
const { loadExtensionFromFactory } = await import(pathToFileURL(join(agentDist, "core/extensions/loader.js")).href);
const { emitSessionShutdownEvent } = await import(pathToFileURL(join(agentDist, "core/extensions/runner.js")).href);

const repo = resolve(import.meta.dirname, "../../../..");
const source = process.argv[2] ?? join(repo, "packages/pi-goal/src/goal.ts");
const mode = process.argv[3] ?? "handled-steer";
assert.ok(["handled-steer", "handled-followup", "control"].includes(mode));
const nativeRequire = createRequire(
  realpathSync(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")),
);
const { createJiti } = nativeRequire("jiti");
const goal = await createJiti(import.meta.url, { fsCache: false, moduleCache: false }).import(source, {
  default: true,
});
const root = mkdtempSync(join(tmpdir(), "goal-capacity-input-"));
const settingsPath = join(root, "settings.json");
writeFileSync(settingsPath, JSON.stringify({ toolVisibility: "always" }));
function latch() {
  let open, entered;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  return { gate, ready, open, entered };
}
const initial = latch(),
  idle = latch(),
  hooks = Array.from({ length: 21 }, () => latch());
const labels = Array.from({ length: 21 }, (_, index) => `queued ${index}`);
const phases = [],
  bus = createEventBus(),
  runtime = createExtensionRuntime();
const extensions = [
  await loadExtensionFromFactory((pi) => goal(pi, { settingsPath }), root, bus, runtime),
  await loadExtensionFromFactory(
    (pi) => {
      pi.on("before_agent_start", (event) => {
        phases.push({ boundary: "before_agent_start", text: event.prompt, goal: last() });
      });
      pi.on("agent_settled", () => {
        phases.push({ boundary: "agent_settled", goal: last() });
      });
      pi.on("message_start", (event) => {
        if (event.message.role === "user") phases.push({ boundary: "message_start", goal: last() });
      });
      pi.on("input", async (event) => {
        phases.push({ boundary: "input", source: event.source, text: event.text, goal: last() });
        const index = labels.indexOf(event.text);
        if (index >= 0) {
          hooks[index].entered();
          await hooks[index].gate;
        }
        if (event.source === "rpc") return { action: "handled" };
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
  getSystemPrompt: () => "Defensive bounded input-provenance regression",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources() {},
  async reload() {},
};
const manager = SessionManager.inMemory(root);
const saved = {
  id: "capacity-original-wait",
  text: "bounded input provenance",
  status: "paused",
  startedAt: 1,
  updatedAt: 2,
  iteration: 3,
  tokensUsed: 7,
  timeUsedSeconds: 9,
  baselineTokens: 0,
  automaticModelTurns: 4,
  toolFreeRepeatCount: 1,
  wait: { reason: "original recorded wait" },
};
manager.appendCustomEntry("goal-state", { goal: saved });
const last = () =>
  JSON.parse(
    JSON.stringify(
      manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "goal-state")
        .at(-1).data.goal,
    ),
  );
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  allowModelNetwork: false,
});
const faux = fauxProvider({ provider: "capacity-private-faux", api: "capacity-private-faux" });
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.refresh({ allowNetwork: false });
const atRequests = [];
const response = () => {
  const current = last();
  atRequests.push(current);
  return current.status === "active"
    ? fauxAssistantMessage(fauxToolCall("goal_wait", { goal_id: current.id, reason: "unexpected replacement wait" }), {
        stopReason: "toolUse",
      })
    : fauxAssistantMessage("no authority from ambiguous input");
};
faux.setResponses([
  async () => {
    initial.entered();
    await initial.gate;
    return fauxAssistantMessage("initial capacity hold");
  },
  ...Array(20).fill(response),
  async () => {
    idle.entered();
    await idle.gate;
    return fauxAssistantMessage("later idle hold");
  },
  response,
]);
const { session } = await createAgentSession({
  cwd: root,
  agentDir: root,
  resourceLoader: loader,
  sessionManager: manager,
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  }),
  modelRuntime,
  model: faux.getModel(),
  noTools: "builtin",
});
const errors = [],
  users = [];
session.subscribe((event) => {
  if (event.type === "message_start" && event.message.role === "user")
    users.push(event.message.content.map((part) => part.text ?? "").join("\n"));
});
await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
const before = last();
let running, disposition;
const pending = [];
try {
  running = session.prompt("initial extension hold", { source: "extension" });
  await initial.ready;
  for (let index = 0; index < labels.length; index++) {
    pending[index] = session.prompt(labels[index], { source: "extension", streamingBehavior: "followUp" });
    await hooks[index].ready;
  }
  assert.equal(session.pendingMessageCount, 0, "all 21 observations remain inside async input hooks");
  assert.deepEqual(last(), before);
  for (let index = 1; index < labels.length; index++) {
    hooks[index].open();
    await pending[index];
  }
  assert.equal(session.pendingMessageCount, 20);
  initial.open();
  await running;
  assert.deepEqual(last(), before, "twenty accepted deliveries preserve the original wait");
  running = session.prompt("later unrelated idle hold", { source: "extension" });
  await idle.ready;
  if (mode !== "control") {
    await session.prompt("handled real after retained items retire", {
      source: "rpc",
      streamingBehavior: mode === "handled-steer" ? "steer" : "followUp",
      preflightResult: (result) => {
        disposition = result;
      },
    });
    assert.equal(disposition, "handled");
  }
  assert.equal(session.pendingMessageCount, 0);
  assert.deepEqual(last(), before);
  hooks[0].open();
  await pending[0];
  assert.equal(session.pendingMessageCount, 1, "only the evicted extension delivery is enqueued");
  idle.open();
  await running;
  console.log(
    JSON.stringify({ mode, source, before, disposition, phases, users, atRequests, final: last(), errors }, null, 2),
  );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(faux.state.callCount, 23, "no extra model request");
  assert.equal(atRequests.length, 21);
  assert.deepEqual(users, ["initial extension hold", ...labels.slice(1), "later unrelated idle hold", labels[0]]);
  for (const actual of atRequests) {
    assert.equal(actual.status, "paused", "an evicted extension observation cannot grant wake authority");
    assert.equal(actual.id, before.id);
    assert.deepEqual(actual.wait, before.wait);
    assert.equal(actual.automaticModelTurns, 4);
    assert.equal(actual.tokensUsed, before.tokensUsed);
    assert.equal(actual.timeUsedSeconds, before.timeUsedSeconds);
    assert.equal(actual.iteration, before.iteration);
    assert.deepEqual(actual, before);
  }
  for (const phase of phases) assert.deepEqual(phase.goal, before, `state at ${phase.boundary}`);
  assert.deepEqual(last(), before, "settlement preserves the entire original recorded wait");
  console.log(JSON.stringify({ mode, status: "PASS" }));
} finally {
  initial.open();
  idle.open();
  for (const hook of hooks) hook.open();
  for (const promise of pending) if (promise) await promise;
  if (running) await running;
  await emitSessionShutdownEvent(session._extensionRunner, { type: "session_shutdown", reason: "exit" });
}
