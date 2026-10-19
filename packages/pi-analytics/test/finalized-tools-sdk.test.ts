import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test } from "vitest";
import { type AnalyticsStorePort, createAnalyticsExtension } from "../src/analytics.js";
import { decodeStoredRun, encodeStoredRun } from "../src/storage/format.js";
import type { SettledRun } from "../src/types.js";

for (const executionError of [false, true]) {
  test(`SDK final tool message rewrites ${executionError ? "error to success" : "success to error"} reconcile only top-level flags`, async () => {
    const root = mkdtempSync(join(tmpdir(), "analytics-final-tool-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const runs: SettledRun[] = [];
    const store: AnalyticsStorePort = {
      path: join(agentDir, "analytics"),
      async recordRun(run) {
        runs.push(decodeStoredRun(encodeStoredRun(run)));
      },
      async getSnapshot() {
        throw new Error("not used");
      },
      async clearAll() {
        return { cleanupIncomplete: false };
      },
      async close() {},
    };
    let clock = 0;
    const timings = new Map<string, { start: number; end?: number; isError?: boolean }>();
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(agentDir, "models-cache.json"),
        allowModelNetwork: false,
      });
      const faux = fauxProvider({ provider: "analytics-final-tool", models: [{ id: "physical" }] });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("outer", {}, { id: "outer-call" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("finished"),
      ]);
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      const registry = new ModelRegistry(runtime);
      const model = registry.find("analytics-final-tool", "physical");
      assert.ok(model);
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          {
            name: "analytics",
            factory: createAnalyticsExtension({
              createStore: () => store,
              getAgentDir: () => agentDir,
              now: () => clock,
            }),
          },
          {
            name: "rewrite",
            factory: (pi) => {
              pi.registerTool({
                name: "inner",
                label: "Inner",
                description: "Nested error",
                parameters: Type.Object({}),
                async execute() {
                  throw new Error("nested failure stays an error");
                },
              });
              pi.registerTool({
                name: "outer",
                label: "Outer",
                description: "Rewritten tool",
                parameters: Type.Object({}),
                async execute(_id, _params, _signal, _update, ctx) {
                  const nested = await ctx.executeTool("inner", {});
                  assert.equal(nested.isError, true);
                  if (executionError) throw new Error("original outer error");
                  return { content: [{ type: "text", text: "original success" }], details: undefined };
                },
              });
              pi.on("tool_execution_start", (event) => {
                timings.set(event.toolCallId, { start: clock });
                clock += 10;
              });
              pi.on("tool_execution_end", (event) => {
                const timing = timings.get(event.toolCallId);
                assert.ok(timing);
                timing.end = clock;
                timing.isError = event.isError;
                clock += 20;
              });
              pi.on("message_end", (event) => {
                if (event.message.role === "toolResult") {
                  assert.equal(event.message.toolCallId, "outer-call", "nested results never enter the transcript");
                  return { message: { ...event.message, isError: !executionError } };
                }
              });
              pi.on("turn_end", (event) => {
                for (const result of event.toolResults) assert.equal(result.isError, !executionError);
              });
            },
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir,
        model,
        modelRuntime: runtime,
        modelRegistry: registry,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
        tools: ["outer", "inner"],
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
          cacheWarming: "off",
        }),
      }));
      const errors: string[] = [];
      await session.bindExtensions({ onError: (error) => errors.push(error.error) });
      await session.prompt("execute outer once");
      assert.deepEqual(errors, []);
      const transcript = session.messages.find((message) => message.role === "toolResult");
      assert.ok(transcript && transcript.role === "toolResult");
      assert.equal(transcript.isError, !executionError);
      assert.equal(runs.length, 1);
      const run = runs[0];
      assert.ok(run);
      assert.equal(run.tools.length, 2);
      assert.equal(run.tools[0]?.isError, transcript.isError);
      assert.equal(run.tools[1]?.isError, true, "nested execution outcome remains authoritative");
      assert.equal(run.toolErrorCount, executionError ? 1 : 2);
      for (const [index, id] of ["outer-call", "outer-call/1"].entries()) {
        const timing = timings.get(id);
        assert.ok(timing && timing.end !== undefined);
        assert.equal(run.tools[index]?.durationMs, timing.end - timing.start);
      }
      assert.equal(timings.get("outer-call")?.isError, executionError);
    } finally {
      session?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
