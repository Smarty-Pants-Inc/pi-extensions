import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
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
const agentDist = join(realpathSync(resolve(import.meta.dirname, "../../../../node_modules/@earendil-works/pi-coding-agent")), "dist");
const { loadExtensionFromFactory } = await import(pathToFileURL(join(agentDist, "core/extensions/loader.js")).href);
const { runRpcMode } = await import(pathToFileURL(join(agentDist, "modes/rpc/rpc-mode.js")).href);

// Explicit resources, in-memory persistence, no disk cache, no model or provider calls.
const root = mkdtempSync(join(tmpdir(), "pi-goal-native-rejection-"));
const nativeRequire = createRequire(
  realpathSync(resolve(import.meta.dirname, "../../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js")),
);
const { createJiti } = nativeRequire("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const goal = await jiti.import(resolve(import.meta.dirname, "../../src/goal.ts"), { default: true });
const settingsPath = join(root, "pi-goal.json");
writeFileSync(settingsPath, JSON.stringify({ toolVisibility: "always" }));
const runtime = createExtensionRuntime();
const eventBus = createEventBus();
const extensions = [];
extensions.push(await loadExtensionFromFactory((pi) => goal(pi, { settingsPath }), root, eventBus, runtime));
extensions.push(
  await loadExtensionFromFactory(
    (pi) => {
      pi.registerCommand("wait-state", {
        description: "Read test state",
        handler: async (_args, ctx) => {
          const entry = ctx.sessionManager
            .getBranch()
            .filter((item) => item.type === "custom" && item.customType === "goal-state")
            .at(-1);
          pi.sendMessage({ customType: "wait-state", content: JSON.stringify(entry?.data), display: false });
        },
      });
      pi.on("session_start", () => {
        setTimeout(() => process.stderr.write("RPC_READY\n"), 20);
      });
    },
    root,
    eventBus,
    runtime,
  ),
);
const loader = {
  getExtensions: () => ({ extensions, errors: [], runtime }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "Local rejection regression",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources() {},
  async reload() {},
};
const sessionManager = SessionManager.inMemory(root);
const saved = {
  id: "original-wait-id",
  text: "finish review",
  status: "paused",
  startedAt: 1,
  updatedAt: 2,
  iteration: 3,
  tokensUsed: 7,
  timeUsedSeconds: 9,
  baselineTokens: 0,
  automaticModelTurns: 4,
  toolFreeRepeatCount: 0,
  wait: { reason: "awaiting review", resumeAt: Date.now() + (process.argv[2] === "real-input" ? 60_000 : -1) },
};
sessionManager.appendCustomEntry("goal-state", { goal: saved });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
// Supplying a model avoids startup model selection; it is removed before RPC binds.
const model = {
  id: "local-unused",
  name: "Unused",
  provider: "local-unused",
  api: "local-unused",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};
const { session } = await createAgentSession({
  cwd: root,
  agentDir: root,
  modelRuntime,
  model,
  resourceLoader: loader,
  sessionManager,
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  noTools: "builtin",
});
session.agent.state.model = undefined;
// No provider resources exist; RPC exits the isolated child after stdin closes.
await runRpcMode({ session, setRebindSession() {}, async dispose() {} });
