import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionUIContext,
  InteractiveMode,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { startFreshImplementationSession } from "../src/fresh-implementation.js";
import planMode from "../src/plan-mode.js";
import type { PlanModeSettings } from "../src/settings.js";

const questions = [
  {
    id: "scope",
    header: "Scope",
    question: "Which scope?",
    options: [
      { label: "Small", description: "Only this path." },
      { label: "Large", description: "All paths." },
    ],
  },
];

async function fixture(settings: PlanModeSettings = { thinkingLevel: "inherit" }) {
  const cwd = await mkdtemp(join(tmpdir(), "plan-host-"));
  await writeFile(join(cwd, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-only" } }));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let api!: ExtensionAPI;
  let saved: ((settings: PlanModeSettings) => void) | undefined;
  let uiLoads = 0;
  const statuses = new Map<string, string | undefined>();
  const ui = {
    notify() {},
    setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
    setWidget() {},
    select: async () => undefined,
  } as unknown as ExtensionUIContext;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "plan-host",
        factory: (pi) => {
          api = pi;
          planMode(pi, {
            readSettings: async () => ({ kind: "loaded", settings }),
            loadInteractiveUi: async () => {
              uiLoads += 1;
              return {
                showPlanLaunchMenu: async (
                  _ctx: unknown,
                  options: { settings(signal: AbortSignal): Promise<boolean> },
                ) => {
                  await options.settings(new AbortController().signal);
                },
                showPlanModeSettings: async (_ctx: unknown, options: { onSaved(settings: PlanModeSettings): void }) => {
                  saved = options.onSaved;
                  return { kind: "closed", reason: "close" };
                },
              } as never;
            },
          });
        },
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    thinkingLevel: "low",
  });
  await session.bindExtensions({ mode: "rpc", uiContext: ui });
  const runner = session.extensionRunner;
  const command = async (args: string) => {
    const command = runner.getCommand("plan");
    assert.ok(command);
    return command.handler(args, runner.createCommandContext());
  };
  const tool = (name: string) => {
    const tool = runner.getToolDefinition(name);
    assert.ok(tool);
    return tool;
  };
  return {
    api,
    tool,
    uiLoads: () => uiLoads,
    session,
    runner,
    ui,
    statuses,
    command,
    save: (next: PlanModeSettings) => {
      assert.ok(saved);
      saved(next);
    },
    dispose: async () => {
      await session.dispose();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("real Pi late registration refresh is excluded from the next response and denied for nested calls", async () => {
  const f = await fixture({ thinkingLevel: "inherit", defaultPlanTools: ["read", "orchestrator", "late_mutate"] });
  let mutations = 0;
  const outcomes: unknown[] = [];
  try {
    f.api.registerTool({
      name: "orchestrator",
      label: "Orchestrator",
      description: "Inspect",
      parameters: { type: "object", properties: {} },
      execute: async (_id, _args, _signal, _update, ctx) => {
        f.api.registerTool({
          name: "late_mutate",
          label: "Late",
          description: "Mutate",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            mutations++;
            return { content: [], details: undefined };
          },
        });
        assert.ok(
          f.session.getActiveToolNames().includes("late_mutate"),
          "actual host auto-activates a late direct tool",
        );
        outcomes.push(await ctx.executeTool("late_mutate", {}));
        outcomes.push(await ctx.executeTool("plan_mode_complete", { plan: "# Not a standalone call" }));
        return { content: [{ type: "text", text: "done" }], details: undefined };
      },
    });
    await f.command("start");
    let requests = 0;
    f.session.agent.streamFunction = (_model, context) => {
      assert.equal(
        getCurrentTools(context.messages).some((tool) => tool.name === "late_mutate"),
        false,
      );
      const stream = createAssistantMessageEventStream();
      const message =
        requests++ === 0
          ? response([{ type: "toolCall", id: "outer", name: "orchestrator", arguments: {} }], "toolUse")
          : response([{ type: "text", text: "inspection complete" }], "stop");
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end(message);
      return stream;
    };
    await f.session.prompt("Inspect only");
    assert.equal(requests, 2);
    assert.equal(mutations, 0);
    assert.equal((outcomes[0] as { isError: boolean }).isError, true);
    assert.match(JSON.stringify(outcomes[0]), /frozen planning tool selection/);
    assert.equal((outcomes[1] as { isError: boolean }).isError, true);
    assert.equal(f.tool("plan_mode_complete").exposure, "model-only");
    assert.equal(f.session.getActiveToolNames().includes("late_mutate"), false);
  } finally {
    await f.dispose();
  }
});

test("committed tree A -> earlier inactive -> A restores state without writing A on the target", async () => {
  const f = await fixture({ thinkingLevel: "high" });
  try {
    const manager = f.session.sessionManager;
    const inactive = manager.appendCustomEntry("plan-mode-state", { enabled: false, awaitingAction: false });
    await f.command("start");
    const completed = f.tool("plan_mode_complete");
    const result = await completed.execute(
      "complete",
      { plan: "# Branch A" },
      undefined,
      undefined,
      f.runner.createToolContext("complete", undefined),
    );
    assert.equal(result.terminate, true);
    const leafA = manager.getLeafId();
    assert.ok(leafA);
    const stateCount = () =>
      manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state").length;
    const count = stateCount();
    const uiBeforeTree = f.uiLoads();
    assert.equal(f.statuses.get("plan-mode"), "plan ready");
    await f.session.navigateTree(inactive);
    assert.ok(manager.getBranch().some((entry) => entry.id === inactive));
    assert.equal(stateCount(), count, "no outgoing state persisted on target");
    assert.equal(f.statuses.get("plan-mode"), undefined);
    assert.equal(f.session.getActiveToolNames().includes("write"), true);
    assert.equal(f.session.thinkingLevel, "low");
    await f.session.navigateTree(leafA);
    assert.equal(stateCount(), count);
    assert.equal(f.statuses.get("plan-mode"), "plan ready");
    assert.equal(f.session.thinkingLevel, "high");
    assert.equal(f.session.getActiveToolNames().includes("write"), false);
    // The outgoing ready intent must not reopen a menu with the old command context.
    await f.runner.emit({ type: "agent_settled", reason: "completed" } as never);
    assert.equal(f.uiLoads(), uiBeforeTree);
    assert.equal(stateCount(), count);
  } finally {
    await f.dispose();
  }
});

test.each(
  ["read-only", "empty", "removed-all", "compacted-empty"].flatMap((declaration) =>
    [false, true].map((enabled) => ({ declaration, enabled })),
  ),
)(
  "committed tree preserves $declaration target declarations with planning=$enabled",
  async ({ declaration, enabled }) => {
    const f = await fixture();
    try {
      const manager = f.session.sessionManager;
      const root = manager.appendCustomEntry("branch-root", {});
      const declarations = f.session.agent.state.tools
        .filter((tool) => tool.name === "read" || tool.name === "write")
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
      assert.equal(declarations.length, 2);
      manager.appendMessage({
        role: "system",
        content: "Target tools",
        toolsAdded: declaration === "empty" ? [] : declarations,
        timestamp: 1,
      });
      if (declaration !== "empty") {
        manager.appendMessage({
          role: "system",
          content: "",
          toolsRemoved: declaration === "read-only" ? [{ name: "write" }] : [{ name: "read" }, { name: "write" }],
          timestamp: 2,
        });
      }
      if (declaration === "compacted-empty") manager.appendCompaction("Target checkpoint", null, 0);
      const expected = declaration === "read-only" ? ["read"] : [];
      const target = manager.appendCustomEntry("plan-mode-state", {
        enabled,
        awaitingAction: false,
        selectedToolNames: expected.length ? ["read", "write"] : [],
      });
      assert.deepEqual(
        getCurrentTools(manager.buildSessionProjection().messages).map((tool) => tool.name),
        expected,
      );
      await f.session.navigateTree(root);
      f.api.setActiveTools(["read", "bash", "edit", "write"]);
      await f.command("start");
      const sourceLeaf = manager.getLeafId();
      const entryCount = manager.getEntries().length;
      await f.session.navigateTree(target);
      assert.equal(manager.getLeafId(), target);
      assert.equal(manager.getEntries().length, entryCount, "no outgoing state written onto target");
      assert.notEqual(manager.getLeafId(), sourceLeaf);
      assert.equal(f.statuses.get("plan-mode"), enabled ? "plan active" : undefined);
      assert.deepEqual(
        f.session.getActiveToolNames().sort(),
        [...expected, ...(enabled ? ["plan_mode_question", "plan_mode_complete"] : [])].sort(),
      );
      if (enabled) {
        const blocked = await f.runner.emitToolCall({
          type: "tool_call",
          toolName: "bash",
          toolCallId: "outside-target",
          input: { command: "pwd" },
        });
        assert.equal(blocked?.block, true, "target selection is frozen, not inherited from A");
        await f.command("exit");
        assert.deepEqual(f.session.getActiveToolNames(), expected, "exit restores B, never A's broad loadout");
      }
    } finally {
      await f.dispose();
    }
  },
);

test("committed tree restores implementation retention without arming cleanup before context", async () => {
  const f = await fixture();
  try {
    const manager = f.session.sessionManager;
    const implementation = {
      id: "target-implementation",
      plan: "# Target plan",
      source: "plan_mode_complete",
      startedAt: 1,
      retention: "clear-after-first-run",
    };
    const target = manager.appendCustomEntry("plan-mode-state", {
      enabled: false,
      awaitingAction: false,
      activeImplementation: implementation,
    });
    await f.command("start");
    await f.session.navigateTree(target);
    await f.runner.emit({ type: "agent_settled", reason: "completed" } as never);
    assert.equal(manager.getLeafId(), target, "no outgoing or prematurely settled state written onto the target");
    const context = await f.runner.emitContext([{ role: "user", content: "Continue", timestamp: 1 }]);
    assert.match(JSON.stringify(context), /Target plan/);
    await f.runner.emit({ type: "agent_settled", reason: "completed" } as never);
    const state = manager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state")
      .at(-1);
    assert.ok(state?.type === "custom");
    assert.equal((state.data as { activeImplementation?: unknown }).activeImplementation, undefined);
  } finally {
    await f.dispose();
  }
});

test.each(["tool", "exit", "tree", "shutdown"] as const)(
  "unresolved RPC question select settles on %s cancellation without a response",
  async (cause) => {
    const f = await fixture();
    try {
      const inactive = f.session.sessionManager.appendCustomEntry("plan-mode-state", {
        enabled: false,
        awaitingAction: false,
      });
      await f.command("start");
      let opened!: () => void;
      const opening = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let signal: AbortSignal | undefined;
      // RPC's dialog contract: a request has no response, and abort resolves undefined.
      f.runner.setUIContext(
        {
          ...f.ui,
          select: (_title, _choices, options) =>
            new Promise((resolve) => {
              signal = options?.signal;
              assert.ok(signal);
              signal.addEventListener("abort", () => resolve(undefined), { once: true });
              opened();
            }),
        },
        "rpc",
      );
      const owner = new AbortController();
      const question = f.tool("plan_mode_question");
      const pending = question.execute(
        "question",
        { questions },
        owner.signal,
        undefined,
        f.runner.createToolContext("question", owner.signal),
      );
      await opening;
      if (cause === "tool") owner.abort();
      else if (cause === "exit") await f.command("exit");
      else if (cause === "tree") await f.session.navigateTree(inactive);
      else await f.runner.emit({ type: "session_shutdown", reason: "exit" });
      const result = await pending;
      assert.equal(signal?.aborted, true);
      assert.equal((result.details as { cancelled: boolean }).cancelled, true);
    } finally {
      await f.dispose();
    }
  },
);

test("RPC freeform uses a signal-capable input and abort never returns an answer", async () => {
  const f = await fixture();
  try {
    await f.command("start");
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    f.runner.setUIContext(
      {
        ...f.ui,
        select: async (_title, choices, options) => {
          assert.ok(options?.signal);
          return choices.find((choice) => choice.endsWith("Other (free-form)"));
        },
        input: (_title, _placeholder, options) =>
          new Promise((resolve) => {
            assert.ok(options?.signal);
            options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
            opened();
          }),
        editor: async () => {
          throw new Error("non-cancellable editor used");
        },
      },
      "rpc",
    );
    const owner = new AbortController();
    const pending = f
      .tool("plan_mode_question")
      .execute(
        "question",
        { questions },
        owner.signal,
        undefined,
        f.runner.createToolContext("question", owner.signal),
      );
    await opening;
    owner.abort();
    assert.equal(((await pending).details as { cancelled: boolean }).cancelled, true);
  } finally {
    await f.dispose();
  }
});

test.each(["veto", "throw"] as const)(
  "fresh handoff %s leaves the live source unchanged and removes its snapshot",
  async (failure) => {
    const f = await fixture();
    let snapshot: string | undefined;
    try {
      await f.command("start");
      const source = structuredClone(f.session.sessionManager.getBranch());
      const leaf = f.session.sessionManager.getLeafId();
      const runtime = new AgentSessionRuntime(
        f.session,
        {
          cwd: f.session.cwd,
          agentDir: f.session.cwd,
          modelRuntime: f.session.modelRuntime,
          settingsManager: f.session.settingsManager,
          resourceLoader: f.session.resourceLoader,
          diagnostics: [],
        },
        async () => {
          throw new Error("veto must not create a destination");
        },
      );
      f.api.on("session_before_switch", () => ({ cancel: true }));
      const ctx = {
        ...f.runner.createCommandContext(),
        newSession: async (options: Parameters<typeof runtime.newSession>[0]) => {
          snapshot = options?.parentSession;
          assert.ok(snapshot);
          assert.ok(readFileSync(snapshot, "utf8").includes("plan-mode-state"));
          if (failure === "throw") throw new Error("failed before replacement");
          return runtime.newSession(options);
        },
      };
      const result = await startFreshImplementationSession(ctx, {
        plan: "# Approved",
        source: "plan_mode_complete",
        retention: "keep",
        stateEntryType: "plan-mode-state",
        isCurrent: () => true,
      });
      assert.equal(result.kind, failure === "veto" ? "cancelled" : "rejected");
      assert.deepEqual(f.session.sessionManager.getBranch(), source);
      assert.equal(f.session.sessionManager.getLeafId(), leaf);
      assert.equal(f.statuses.get("plan-mode"), "plan active");
      assert.ok(snapshot);
      assert.equal(existsSync(dirname(snapshot)), false);
    } finally {
      await f.dispose();
    }
  },
);

test.each(["pre-apply", "rebind", "withSession"] as const)(
  "fresh parent snapshot ownership follows the host commit boundary on %s failure",
  async (failure) => {
    const f = await fixture();
    let snapshot: string | undefined;
    let destination: typeof f.session | undefined;
    let setupCalls = 0;
    let withSessionCalls = 0;
    try {
      await f.command("start");
      const source = structuredClone(f.session.sessionManager.getBranch());
      const services = {
        cwd: f.session.cwd,
        agentDir: f.session.cwd,
        modelRuntime: f.session.modelRuntime,
        settingsManager: f.session.settingsManager,
        resourceLoader: f.session.resourceLoader,
        diagnostics: [],
      };
      const runtime = new AgentSessionRuntime(f.session, services, async (options) => {
        if (failure === "pre-apply") throw new Error("destination creation failed before apply");
        const created = await createAgentSession({
          ...options,
          settingsManager: services.settingsManager,
          resourceLoader: services.resourceLoader,
          modelRuntime: services.modelRuntime,
        });
        destination = created.session;
        return { ...created, services, diagnostics: [] };
      });
      runtime.setRebindSession(async (session) => {
        assert.equal(runtime.session, destination, "destination was applied before rebind");
        assert.equal(setupCalls, 1, "setup ran after apply and before rebind");
        assert.equal(session.sessionManager.getHeader()?.parentSession, snapshot);
        assert.ok(
          session.sessionManager
            .getBranch()
            .some((entry) => entry.type === "custom" && entry.customType === "plan-mode-state"),
        );
        if (failure === "rebind") throw new Error("host rebind failed after committed setup");
      });
      const ctx = {
        ...f.runner.createCommandContext(),
        newSession: async (options: Parameters<typeof runtime.newSession>[0]) => {
          snapshot = options?.parentSession;
          assert.ok(snapshot);
          return runtime.newSession({
            ...options,
            setup: async (manager) => {
              assert.equal(runtime.session, destination, "setup begins only after apply");
              setupCalls += 1;
              await options?.setup?.(manager);
            },
            withSession: async () => {
              withSessionCalls += 1;
              throw new Error("replacement callback failed");
            },
          });
        },
      };
      const result = await startFreshImplementationSession(ctx, {
        plan: "# Approved",
        source: "plan_mode_complete",
        retention: "keep",
        stateEntryType: "plan-mode-state",
        isCurrent: () => true,
      });
      assert.equal(result.kind, failure === "pre-apply" ? "rejected" : "partial");
      assert.equal(setupCalls, failure === "pre-apply" ? 0 : 1);
      assert.equal(withSessionCalls, failure === "withSession" ? 1 : 0);
      assert.ok(snapshot);
      assert.equal(existsSync(snapshot), failure !== "pre-apply");
      if (failure !== "pre-apply") {
        const parent = SessionManager.open(snapshot);
        assert.equal(
          JSON.stringify(parent.getBranch()),
          JSON.stringify(source),
          "committed destination can still resume the live in-memory parent",
        );
      }
    } finally {
      await destination?.dispose();
      if (snapshot) await rm(dirname(snapshot), { recursive: true, force: true });
      await f.dispose();
    }
  },
);

test("Pi editor's captured shortcut handler honors set/change/clear settings until reload", async () => {
  const f = await fixture();
  try {
    await f.command(""); // Capture the Settings save callback using the public menu path.
    const defaultEditor: { onExtensionShortcut?: (data: string) => boolean } = {};
    const host = Object.assign(Object.create(InteractiveMode.prototype), {
      runtimeHost: { session: f.session },
      keybindings: { getEffectiveConfig: () => ({}) },
      defaultEditor,
      createExtensionUIContext: () => f.ui,
      showError: (message: string) => {
        throw new Error(message);
      },
    }) as { setupExtensionShortcuts(runner: typeof f.runner): void };
    host.setupExtensionShortcuts(f.runner);
    assert.equal(defaultEditor.onExtensionShortcut, undefined);
    f.save({ thinkingLevel: "inherit", toggleShortcut: "ctrl+alt+p" });
    assert.equal(defaultEditor.onExtensionShortcut, undefined, "new registration needs reload");
    host.setupExtensionShortcuts(f.runner); // Host's reload-time snapshot.
    const captured = defaultEditor.onExtensionShortcut;
    assert.ok(captured);
    captured("\u001b\u0010");
    assert.equal(f.statuses.get("plan-mode"), "plan active");
    await f.command("exit");
    await f.command("");
    f.save({ thinkingLevel: "inherit", toggleShortcut: "ctrl+alt+o" });
    captured("\u001b\u0010");
    assert.equal(f.statuses.get("plan-mode"), undefined, "old captured key cannot toggle after change");
    assert.equal(captured("\u001b\u000f"), false, "new key is not in the old editor snapshot");
    host.setupExtensionShortcuts(f.runner);
    defaultEditor.onExtensionShortcut?.("\u001b\u000f");
    assert.equal(f.statuses.get("plan-mode"), "plan active");
    await f.command("exit");
    await f.command("");
    const secondSnapshot = defaultEditor.onExtensionShortcut;
    assert.ok(secondSnapshot);
    f.save({ thinkingLevel: "inherit" });
    secondSnapshot("\u001b\u000f");
    assert.equal(f.statuses.get("plan-mode"), undefined, "cleared captured key cannot toggle");
  } finally {
    await f.dispose();
  }
});
