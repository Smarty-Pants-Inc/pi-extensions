import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, getCurrentTools, type Model, type Provider, Type } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

const model = {
  id: "gpt-5.6",
  name: "GPT-5.6",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
} as Model<"openai-codex-responses">;

const runtime: CodexCompactSettingsRuntime = {
  get: () => ({
    kind: "loaded",
    path: "unused",
    settings: DEFAULT_CODEX_COMPACT_SETTINGS,
    document: {},
  }),
  async reload() {
    return this.get();
  },
  async update() {
    throw new Error("Not used");
  },
  async flush() {},
};

function inspectTool(parameters = Type.Object({ path: Type.String({ description: "Path to inspect" }) })) {
  return {
    name: "inspect",
    label: "Inspect",
    description: "Inspect a path",
    parameters,
    async execute() {
      return { content: [{ type: "text" as const, text: "file" }], details: {} };
    },
  };
}

async function withPreparedLoadout(
  loadout: "prepared" | "codemode on",
  run: (host: {
    session: AgentSession;
    pi: ExtensionAPI;
    remoteContexts: Context[];
    fetches: () => number;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "pi-codex-prepared-loadout-"));
  let session: AgentSession | undefined;
  try {
    let pi!: ExtensionAPI;
    let fetches = 0;
    const remoteContexts: Context[] = [];
    const provider = openaiCodexProvider();
    // Real provider serialization/remote streaming, but no network or stored credentials.
    const testProvider: Provider = {
      ...provider,
      auth: {
        apiKey: {
          name: "Fixture",
          resolve: async () => ({
            auth: {
              apiKey: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.x`,
            },
          }),
        },
      },
      getModels: () => [model],
      stream(requestModel, context, options) {
        remoteContexts.push(context);
        return provider.stream(requestModel, context, options);
      },
      streamSimple(requestModel, context, options) {
        // Use the real serializer and provider callback so normal turns establish
        // fresh wire evidence; an event-stream stub bypasses that safety boundary.
        return provider.streamSimple(requestModel, context, {
          ...options,
          transport: "sse",
          fetch: async () => {
            const item = {
              type: "message",
              id: "fixture-answer",
              role: "assistant",
              content: [{ type: "output_text", text: "Fixture answer or native summary" }],
            };
            return new Response(
              `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          },
        });
      },
    };
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, "unused-auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(testProvider);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1 },
      defaultTools: ["inspect", loadout === "codemode on" ? "codemode" : "prepare"],
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      extensionFactories: [
        ...(loadout === "codemode on" ? [createCodemodeExtension({ mode: "on" })] : []),
        (api) => {
          pi = api;
          api.registerTool(inspectTool());
          if (loadout === "prepared") {
            api.registerTool({
              name: "prepare",
              label: "Prepare",
              description: "Prepare the declaration",
              parameters: Type.Object({}),
              prepareLoadout: () => ({ descriptions: { inspect: "Inspect a path (prepared instructions)" } }),
              async execute() {
                return { content: [], details: {} };
              },
            });
          }
          createCodexCompactExtension({
            settingsRuntime: runtime,
            fetch: async () => {
              fetches++;
              const item = { type: "compaction", encrypted_content: "opaque" };
              return new Response(
                `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
                { status: 200, headers: { "content-type": "text/event-stream" } },
              );
            },
          })(api);
        },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      model,
      modelRuntime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(directory),
      noTools: "builtin",
    }));
    await session.bindExtensions({});
    pi.setActiveTools(["inspect", loadout === "codemode on" ? "codemode" : "prepare"]);
    assert.deepEqual(pi.getActiveTools(), ["inspect", loadout === "codemode on" ? "codemode" : "prepare"]);
    await session.prompt("First fixture turn");
    await session.prompt("Second fixture turn");
    const recorded = getCurrentTools(session.sessionManager.buildSessionContext().messages);
    assert.notEqual(
      recorded.find((tool) => tool.name === "inspect")?.description,
      pi.getAllTools().find((tool) => tool.name === "inspect")?.description,
      "real Pi prepareLoadout must alter the persisted declaration",
    );
    await run({ session, pi, remoteContexts, fetches: () => fetches });
  } finally {
    session?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const loadout of ["prepared", "codemode on"] as const) {
  test(`real Pi unchanged ${loadout} descriptions allow remote compaction`, async () => {
    await withPreparedLoadout(loadout, async ({ session, remoteContexts, fetches }) => {
      const declarations = getCurrentTools(session.sessionManager.buildSessionContext().messages);
      const result = await session.compact();
      assert.equal(fetches(), 1, "unchanged prepared tools must reach remote dispatch");
      assert.ok(parseCheckpointDetails(result.details), "remote checkpoint must be accepted");
      assert.deepEqual(getCurrentTools(remoteContexts[0].messages), declarations);
      assert.equal(remoteContexts[0].tools, undefined, "modern providers use only transcript declarations");
    });
  });

  for (const change of ["added tool", "removed tool", "parameter schema", "parameter description"] as const) {
    test(`real Pi ${loadout} rejects pending ${change}`, async () => {
      await withPreparedLoadout(loadout, async ({ session, pi, remoteContexts, fetches }) => {
        const original = getCurrentTools(session.sessionManager.buildSessionContext().messages);
        if (change === "added tool") {
          pi.registerTool({ ...inspectTool(), name: "search", label: "Search" });
        } else if (change === "removed tool") {
          pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "inspect"));
        } else {
          pi.registerTool(
            inspectTool(
              change === "parameter schema"
                ? Type.Object({ path: Type.Number() })
                : Type.Object({ path: Type.String({ description: "Different parameter meaning" }) }),
            ),
          );
        }
        assert.deepEqual(getCurrentTools(session.sessionManager.buildSessionContext().messages), original);
        if (change === "added tool") assert.ok(pi.getActiveTools().includes("search"));
        if (change === "removed tool") assert.ok(!pi.getActiveTools().includes("inspect"));
        if (change === "parameter schema") {
          assert.equal(
            pi.getAllTools().find((tool) => tool.name === "inspect")?.parameters.properties.path.type,
            "number",
          );
        }
        const result = await session.compact();
        assert.equal(fetches(), 0, "pending changes must not reach remote dispatch");
        assert.equal(remoteContexts.length, 0);
        assert.equal(parseCheckpointDetails(result.details), undefined, "Pi must retain native compaction");
      });
    });
  }
}
