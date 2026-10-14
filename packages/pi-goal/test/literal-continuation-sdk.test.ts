import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { expect, test } from "vitest";
import goal from "../src/goal.js";

for (const status of ["none", "active", "waiting"] as const) {
  test(`unknown continuation comments remain ordinary native input with ${status} Goal`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "goal-literal-sdk-"));
    const settingsPath = join(cwd, "goal.json");
    writeFileSync(settingsPath, JSON.stringify({ toolVisibility: "always" }));
    const faux = fauxProvider({ provider: "goal-literal-faux", models: [{ id: "test", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const registry = new ModelRegistry(runtime);
    const manager = SessionManager.inMemory(cwd);
    if (status !== "none")
      manager.appendCustomEntry("goal-state", {
        goal: {
          id: "owned",
          text: "Finish work",
          status: status === "active" ? "active" : "paused",
          startedAt: Date.now(),
          updatedAt: Date.now(),
          iteration: 0,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          baselineTokens: 0,
          automaticModelTurns: 0,
          toolFreeRepeatCount: 0,
          ...(status === "waiting" ? { wait: { reason: "external review" } } : {}),
        },
      });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      noExtensions: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [{ name: "goal", factory: (pi) => goal(pi, { settingsPath }) }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      modelRegistry: registry,
      model: registry.find("goal-literal-faux", "test"),
      sessionManager: manager,
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        images: { autoResize: false },
      }),
    });
    try {
      await session.bindExtensions({});
      let requests = 0;
      faux.setResponses([
        () => {
          requests++;
          return status === "active"
            ? fauxAssistantMessage(fauxToolCall("goal_complete", { goal_id: "owned", summary: "Verified" }), {
                stopReason: "toolUse",
              })
            : fauxAssistantMessage("This is an ordinary literal comment.");
        },
      ]);
      const text = "Explain <!-- pi-goal-continuation:example --> verbatim";
      const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
      await session.prompt(text, { source: "extension", images });
      expect(requests).toBe(1);
      expect(session.messages.find((message) => message.role === "user")?.content).toEqual([
        { type: "text", text },
        ...images,
      ]);
      if (status === "waiting") {
        const entry = manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "goal-state")
          .at(-1);
        expect(entry && "data" in entry ? entry.data : undefined).toMatchObject({
          goal: { status: "paused", wait: { reason: "external review" } },
        });
      }
    } finally {
      await session.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
