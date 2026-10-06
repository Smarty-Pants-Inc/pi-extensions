import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { getCurrentTools, InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import type { JsonObject } from "../src/protocol.js";
import { createCodexCompactSettingsRuntime } from "../src/settings.js";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6",
  name: "Offline Codex test",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64")}.x`;

function sseResponse(compact: boolean): Response {
  const item = compact
    ? { type: "compaction", encrypted_content: "offline-opaque" }
    : { type: "message", id: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] };
  const events = compact
    ? [{ type: "response.output_item.done", output_index: 0, item }]
    : [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "" },
        },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Done." },
        { type: "response.output_item.done", output_index: 0, item },
      ];
  return new Response(
    [...events, { type: "response.completed", response: { status: "completed", output: [item] } }]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Real SDK and Codex serializer, isolated credentials, and a fully stubbed transport. */
async function sdkFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-codex-compact-loadout-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected live HTTP request"));
  vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
    throw new Error("Unexpected live WebSocket request");
  });
  const requests: JsonObject[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = init?.body;
    assert.ok(typeof body === "string" || body instanceof Uint8Array);
    const payload = JSON.parse(
      typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8"),
    ) as JsonObject;
    requests.push(payload);
    assert.ok(Array.isArray(payload.input));
    return sseResponse(payload.input.some((item: JsonObject) => item.type === "compaction_trigger"));
  };
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(directory, "models-cache.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const actual = openaiCodexProvider();
    const provider: Provider = {
      ...actual,
      auth: { apiKey: { name: "Offline test", resolve: async () => ({ auth: { apiKey } }) } },
      getModels: () => [model],
      stream: (requestModel, context, options) =>
        actual.stream(requestModel, context, { ...options, transport: "sse", fetch: options?.fetch ?? fetch }),
      streamSimple: (requestModel, context, options) =>
        actual.streamSimple(requestModel, context, { ...options, transport: "sse", fetch: options?.fetch ?? fetch }),
    };
    modelRuntime.registerNativeProvider(provider);
    const open = async (manager: SessionManager) => {
      const settingsManager = SettingsManager.inMemory({
        defaultTools: ["read", "codemode"],
        compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 6 },
        retry: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          createCodemodeExtension({ mode: "on" }),
          createCodexCompactExtension({
            settingsRuntime: createCodexCompactSettingsRuntime(join(directory, "pi-codex-compact.json")),
            fetch,
          }),
        ],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const { session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        model,
        thinkingLevel: "off",
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: manager,
      });
      try {
        await session.bindExtensions({});
        return session;
      } catch (error) {
        session.dispose();
        throw error;
      }
    };
    return { directory, requests, open, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test("SDK codemode request → remote compaction → persisted reload → opaque replay", async () => {
  const fixture = await sdkFixture();
  const manager = SessionManager.create(fixture.directory, fixture.directory);
  let session: AgentSession | undefined;
  try {
    session = await fixture.open(manager);
    await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
    await session.prompt("Second task.");
    assert.equal(
      session.getLastAssistantText(),
      "Done.",
      JSON.stringify(session.messages.filter((message) => message.role === "assistant")),
    );
    assert.equal(fixture.requests.length, 2);
    const recordedRead = getCurrentTools(manager.buildSessionContext().messages).find((tool) => tool.name === "read");
    const rawRead = session.getAllTools().find((tool) => tool.name === "read");
    assert.ok(recordedRead && rawRead);
    assert.notEqual(recordedRead.description, rawRead.description);
    const result = await session.compact();
    const details = parseCheckpointDetails(result.details);
    assert.ok(details, "SDK must select Remote V2, not native summary fallback");
    const compactPayload = fixture.requests.at(-1);
    assert.ok(compactPayload && Array.isArray(compactPayload.input));
    assert.equal(compactPayload.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 1);
    assert.ok(Array.isArray(compactPayload.tools));
    assert.equal(
      compactPayload.tools.find((tool: JsonObject) => tool.name === "read")?.description,
      recordedRead.description,
    );
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    session.dispose();
    session = await fixture.open(SessionManager.open(sessionFile));
    await session.prompt("Continue after reload.");
    assert.equal(session.getLastAssistantText(), "Done.");
    const replay = fixture.requests.at(-1);
    assert.ok(replay && Array.isArray(replay.input));
    assert.equal(replay.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    assert.equal(replay.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 0);
    assert.doesNotMatch(JSON.stringify(replay.input), /PI_CODEX_REMOTE_CHECKPOINT/);
    assert.match(JSON.stringify(replay.input), /Continue after reload/);

    // The resumed ordinary request establishes fresh evidence for repeated
    // compaction; the older opaque item must not be resurrected as another item.
    const repeated = await session.compact();
    assert.ok(parseCheckpointDetails(repeated.details));
    const repeatedPayload = fixture.requests.at(-1);
    assert.ok(repeatedPayload && Array.isArray(repeatedPayload.input));
    assert.equal(repeatedPayload.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    assert.equal(repeatedPayload.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 1);
    await session.prompt("Continue after repeated compaction.");
    const repeatedReplay = fixture.requests.at(-1);
    assert.ok(repeatedReplay && Array.isArray(repeatedReplay.input));
    assert.equal(repeatedReplay.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    assert.doesNotMatch(JSON.stringify(repeatedReplay.input), /PI_CODEX_REMOTE_CHECKPOINT/);
  } finally {
    session?.dispose();
    fixture.cleanup();
  }
});
