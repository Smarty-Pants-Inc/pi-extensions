import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobManager, JobSnapshot, StartOptions } from "../src/contracts.js";
import background from "../src/extension.js";

// Controlled in-memory manager: existing jobs are seeded directly and no process is ever launched.
const fake = vi.hoisted(() => ({ managers: [] as JobManager[] }));
vi.mock("../src/manager.js", () => ({
  createJobManager: (): JobManager => {
    const jobs: JobSnapshot[] = [];
    const get = (id: string) => {
      const job = jobs.find((entry) => entry.id === id);
      if (!job) throw new Error(`unknown job ${id}`);
      return job;
    };
    const manager: JobManager = {
      start: vi.fn(async (options: StartOptions) => {
        const job: JobSnapshot = {
          id: `seed-${jobs.length}`,
          command: options.command,
          cwd: options.cwd,
          description: options.description ?? "seeded",
          status: "running",
          startedAt: 1,
          attention: "off",
          droppedBytes: 0,
        };
        jobs.push(job);
        return job;
      }),
      watch: vi.fn((id, watch) => Object.assign(get(id), { watch })),
      list: () => jobs,
      get,
      logs: (id) => {
        get(id);
        return { text: "seeded-log-line", droppedBytes: 0 };
      },
      stop: async (id) => Object.assign(get(id), { status: "stopped" as const }),
      clear: () => 0,
      shutdown: async () => {
        jobs.length = 0;
      },
    };
    fake.managers.push(manager);
    return manager;
  },
}));

// Real host loader, lifecycle, provider dispatch and tool pipeline. No paid model, no shell launch.
describe.skipIf(!["1.0.4", "1.1.0"].includes(VERSION) || process.platform === "win32")(
  "background on supported installed Pi",
  () => {
    const cleanup: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const dispose of cleanup.splice(0).reverse()) await dispose();
      fake.managers.length = 0;
    });

    // null leaves the retired setting missing; true is the legacy opt-in that must not override.
    async function fixture(
      inputGate?: (pi: ExtensionAPI) => void,
      laterGate?: (pi: ExtensionAPI) => void,
      allowShellTools: boolean | null = null,
    ) {
      const cwd = mkdtempSync(join(tmpdir(), "background-host-"));
      const agentDir = join(cwd, "agent");
      mkdirSync(agentDir);
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      cleanup.push(async () => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(cwd, { recursive: true, force: true });
      });
      const faux = fauxProvider({ provider: "background-faux", models: [{ id: "background" }] });
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      const registry = new ModelRegistry(runtime);
      const model = registry.find("background-faux", "background");
      if (!model) throw new Error("missing faux model");
      const errors: string[] = [];
      const prompts: string[] = [];
      const inputs: string[] = [];
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          ...(inputGate ? [{ name: "input-gate", factory: inputGate }] : []),
          { name: "background", factory: background },
          ...(laterGate ? [{ name: "later-gate", factory: laterGate }] : []),
          {
            name: "probes",
            factory: (pi) => {
              pi.on("before_agent_start", (event) => {
                prompts.push(event.prompt);
              });
              pi.on("input", (event) => {
                inputs.push(event.source);
              });
            },
          },
        ],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      // A structural variable (not a literal) carries the extension-owned key through Pi's Settings type.
      const settings = {
        compaction: { enabled: false },
        retry: { enabled: false },
        ...(allowShellTools === null ? {} : { piBackground: { allowShellTools } }),
      };
      const settingsManager = SettingsManager.inMemory(settings);
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        modelRuntime: runtime,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        // Allowlisting the retired name must not resurrect it.
        tools: ["bash_background", "monitor", "background_list", "background_logs"],
        settingsManager,
      });
      cleanup.push(async () => {
        await session.abort();
        await session.reload(); // Public reload tears down any remaining jobs.
        session.dispose();
        faux.setResponses([]);
      });
      await session.bindExtensions({ onError: (error) => errors.push(String(error)) });
      const host = new AgentSessionRuntime(
        session,
        { cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoader: loader, diagnostics: [] },
        async () => {
          throw new Error("Cancelled fork must not replace the runtime");
        },
      );
      return { session, host, faux, errors, prompts, inputs };
    }

    const registered = (session: Awaited<ReturnType<typeof fixture>>["session"]) => ({
      all: session.getAllTools().map((tool) => tool.name),
      runner: session.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name),
      active: session.getActiveToolNames(),
    });

    for (const [label, value] of [
      ["legacy opt-in true", true],
      ["missing", null],
      ["false", false],
    ] as const) {
      it(`never registers bash_background or runs forged commands when the retired setting is ${label}`, async () => {
        const { session, faux, errors } = await fixture(undefined, undefined, value);
        const tools = registered(session);
        for (const list of [tools.all, tools.runner, tools.active]) {
          expect(list).not.toContain("bash_background");
          expect(list).toEqual(expect.arrayContaining(["monitor", "background_list", "background_logs"]));
        }
        const monitor = session.getAllTools().find((tool) => tool.name === "monitor");
        expect(JSON.stringify(monitor?.parameters)).not.toMatch(/"(command|cwd|timeout_ms)"/);
        faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall("bash_background", { command: "printf should-not-run" }),
              fauxToolCall("monitor", { command: "printf should-not-run", patterns: ["x"] }),
              fauxToolCall("monitor", { id: "seed-0", command: "printf should-not-run", patterns: ["x"] }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Refused."),
          fauxAssistantMessage(fauxToolCall("background_list", {}), { stopReason: "toolUse" }),
          fauxAssistantMessage("Listed."),
        ]);
        await session.prompt("Try forged commands.");
        const refused = session.messages.filter(
          (message) => message.role === "toolResult" && ["bash_background", "monitor"].includes(message.toolName),
        );
        expect(refused).toHaveLength(3);
        expect(refused.every((message) => message.role === "toolResult" && message.isError)).toBe(true);
        expect(fake.managers.every((manager) => vi.mocked(manager.start).mock.calls.length === 0)).toBe(true);
        await session.prompt("Inspect jobs.");
        const list = [...session.messages]
          .reverse()
          .find((message) => message.role === "toolResult" && message.toolName === "background_list");
        expect(list).toMatchObject({ isError: false, details: { jobs: [], pendingNotifications: 0 } });
        expect(errors).toEqual([]);
      });
    }

    it("monitors and reads logs of an existing job through the real tool pipeline with the legacy opt-in", async () => {
      const { session, faux, errors } = await fixture(undefined, undefined, true);
      const manager = fake.managers.at(-1);
      if (!manager) throw new Error("missing background manager");
      await manager.start({ command: "seeded fixture, never executed", cwd: "." });
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("monitor", { id: "seed-0", patterns: ["ready"] }),
            fauxToolCall("background_logs", { id: "seed-0" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Observed."),
      ]);
      await session.prompt("Watch the existing job.");
      const result = (name: string) =>
        session.messages.find((message) => message.role === "toolResult" && message.toolName === name);
      expect(result("monitor")).toMatchObject({
        isError: false,
        details: {
          jobs: [expect.objectContaining({ id: "seed-0", watch: expect.objectContaining({ patterns: ["ready"] }) })],
        },
      });
      expect(result("background_logs")).toMatchObject({ isError: false, details: { output: "seeded-log-line" } });
      expect(manager.start).toHaveBeenCalledTimes(1); // Only the fixture seed.
      expect(errors).toEqual([]);
    });
  },
);
