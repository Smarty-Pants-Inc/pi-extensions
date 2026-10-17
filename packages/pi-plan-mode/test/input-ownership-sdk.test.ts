import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { formatImplementationHandoff } from "../src/fresh-implementation.js";
import planMode from "../src/plan-mode.js";

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "plan-input-sdk-"));
  const faux = fauxProvider({ provider: "plan-input-faux", models: [{ id: "test", contextWindow: 200_000 }] });
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);
  const manager = SessionManager.inMemory(cwd);
  let api!: ExtensionAPI;
  const sent: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      {
        name: "plan",
        factory: (pi) => {
          api = pi;
          planMode(pi, { readSettings: async () => ({ kind: "missing" }) });
          pi.sendUserMessage = (text) => {
            sent.push(typeof text === "string" ? text : JSON.stringify(text));
          };
        },
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    modelRegistry: registry,
    model: registry.find("plan-input-faux", "test"),
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      images: { autoResize: false },
    }),
  });
  await session.bindExtensions({});
  const command = (args: string) =>
    session.extensionRunner.getCommand("plan")?.handler(args, session.extensionRunner.createCommandContext());
  const state = () =>
    manager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state")
      .at(-1)?.data;
  return {
    session,
    command,
    manager,
    get api() {
      return api;
    },
    faux,
    state,
    sent,
    async close() {
      await session.dispose();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
test("a later tool_call handler cannot transfer an old completion into a restarted workflow", async () => {
  const f = await fixture();
  try {
    await f.command("start");
    let restarted = false;
    f.api.on("tool_call", async (event) => {
      if (event.toolName === "plan_mode_complete" && !restarted) {
        restarted = true;
        await f.command("exit");
        await f.command("start");
      }
    });
    f.faux.setResponses([completion("# Old workflow"), fauxAssistantMessage("done")]);
    await f.session.prompt("Plan this", { source: "rpc" });
    expect(restarted).toBe(true);
    expect((f.state() as { latestPlan?: string }).latestPlan).toBeUndefined();
  } finally {
    await f.close();
  }
});

const completion = (plan: string) =>
  fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan }), { stopReason: "toolUse" });

test("background wakes preserve ready plans and cannot own completion; accepted user revisions clear readiness", async () => {
  const f = await fixture();
  try {
    await f.command("start");
    f.faux.setResponses([completion("# Ready")]);
    await f.session.prompt("Plan this", { source: "rpc" });
    expect(f.state()).toMatchObject({ latestPlan: "# Ready", awaitingAction: true });
    f.faux.setResponses([
      completion("# Not owned"),
      fauxAssistantMessage("<proposed_plan>\n# Also not owned\n</proposed_plan>"),
    ]);
    await f.session.prompt("Background job exited", { source: "extension" });
    expect(f.state()).toMatchObject({ latestPlan: "# Ready", awaitingAction: true });
    expect(
      f.session.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId !== undefined && message.isError,
      ),
    ).toBeDefined();
    f.faux.setResponses([fauxAssistantMessage("Revision in progress")]);
    await f.session.prompt("Please change the plan", { source: "rpc" });
    expect(f.state()).toMatchObject({ awaitingAction: false });
    expect(f.state()).not.toHaveProperty("latestPlan", "# Ready");
  } finally {
    await f.close();
  }
});

test("native prefix/exact-handoff collisions and images are verbatim, only owned handoffs retire", async () => {
  const f = await fixture();
  try {
    const literal = formatImplementationHandoff("# User-authored literal");
    const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
    let context!: TranscriptContext;
    f.faux.setResponses([
      (ctx) => {
        context = ctx;
        return fauxAssistantMessage("ordinary");
      },
    ]);
    await f.session.prompt(literal, { source: "rpc", images });
    expect(f.session.messages.find((message) => message.role === "user")?.content).toEqual([
      { type: "text", text: literal },
      ...images,
    ]);
    expect(
      context.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes(literal.replaceAll("\n", "\\n")),
      ),
    ).toBe(true);
    await f.command("start");
    f.faux.setResponses([completion("# Approved")]);
    await f.session.prompt("Plan it", { source: "rpc" });
    await f.command("implement");
    const owned = f.sent.at(-1);
    if (!owned) throw new Error("owned handoff was not sent");
    f.faux.setResponses([
      (ctx) => {
        context = ctx;
        return fauxAssistantMessage("Implementing");
      },
    ]);
    await f.session.prompt(owned, { source: "extension" });
    expect(JSON.stringify(context.messages)).toContain("# Approved");
    await f.command("exit");
    f.faux.setResponses([
      (ctx) => {
        context = ctx;
        return fauxAssistantMessage("ordinary");
      },
    ]);
    await f.session.prompt(literal, { source: "rpc", images });
    expect(JSON.stringify(context.messages)).not.toContain("# Approved");
    expect(f.session.messages.filter((message) => message.role === "user").at(-1)?.content).toEqual([
      { type: "text", text: literal },
      ...images,
    ]);
  } finally {
    await f.close();
  }
});

test("handled/overlapping and transformed input candidates cannot authorize an extension response", async () => {
  const f = await fixture();
  try {
    await f.command("start");
    f.api.on("input", (event) => {
      if (event.text === "handled" && event.source === "rpc") return { action: "handled" };
      if (event.text === "transform") return { action: "transform", text: "different text" };
    });
    await f.session.prompt("handled", { source: "rpc" });
    f.faux.setResponses([completion("# Overlap"), fauxAssistantMessage("No completion")]);
    await f.session.prompt("handled", { source: "extension" });
    expect(f.state()).not.toHaveProperty("latestPlan");
    f.faux.setResponses([completion("# Transformed"), fauxAssistantMessage("No completion")]);
    await f.session.prompt("transform", { source: "rpc" });
    expect(f.state()).not.toHaveProperty("latestPlan");
    f.faux.setResponses([completion("# Genuine")]);
    await f.session.prompt("Fresh real revision", { source: "rpc" });
    expect(f.state()).toMatchObject({ latestPlan: "# Genuine" });
  } finally {
    await f.close();
  }
});

test("native handoff metadata survives SDK reload, inactive clear and branch changes without claiming user images", async () => {
  const f = await fixture();
  let context!: TranscriptContext;
  try {
    const root = f.manager.appendCustomEntry("root", {});
    await f.command("start");
    f.faux.setResponses([completion("# Durable owned plan")]);
    await f.session.prompt("Plan it", { source: "rpc" });
    await f.command("implement");
    const owned = f.sent.at(-1);
    if (!owned) throw new Error("handoff was not sent");
    f.faux.setResponses([fauxAssistantMessage("implementing")]);
    await f.session.prompt(owned, { source: "extension" });
    const metadata = f.manager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-handoff-identity");
    expect(metadata).toHaveLength(1);
    expect(JSON.stringify(metadata)).not.toContain("Durable owned plan");
    const handoffLeaf = f.manager.getLeafId();
    if (!handoffLeaf) throw new Error("handoff branch is missing");
    await f.session.reload();
    await f.command("exit");
    f.faux.setResponses([
      (ctx) => {
        context = ctx;
        return fauxAssistantMessage("ordinary");
      },
    ]);
    await f.session.prompt("continue", { source: "rpc" });
    expect(JSON.stringify(context.messages)).not.toContain("Durable owned plan");
    // The native handoff is preserved in storage, but not revived as an instruction.
    expect(JSON.stringify(f.session.messages)).toContain("Durable owned plan");
    await f.session.navigateTree(handoffLeaf);
    await f.command("exit");
    await f.session.reload();
    const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
    f.faux.setResponses([
      (ctx) => {
        context = ctx;
        return fauxAssistantMessage("literal");
      },
    ]);
    await f.session.prompt(owned, { source: "rpc", images });
    expect(context.messages.filter((message) => message.role === "user").at(-1)?.content).toEqual([
      { type: "text", text: owned },
      ...images,
    ]);
    await f.session.navigateTree(root);
    f.faux.setResponses([
      (ctx) => {
        context = ctx;
        return fauxAssistantMessage("different branch");
      },
    ]);
    await f.session.prompt("continue", { source: "rpc" });
    expect(JSON.stringify(context.messages)).not.toContain("Durable owned plan");
  } finally {
    await f.close();
  }
});

for (const owned of [false, true])
  for (const order of ["A-first", "B-first"] as const) {
    for (const lanes of [
      ["steer", "steer"],
      ["followUp", "followUp"],
      ["steer", "followUp"],
      ["followUp", "steer"],
    ] as const) {
      test(`unique ${owned ? "owned" : "real"} revision survives unrelated queued input: ${order} ${lanes.join("/")}`, async () => {
        const f = await fixture();
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        try {
          await f.command("start");
          f.faux.setResponses([completion("# Ready")]);
          await f.session.prompt("Plan it", { source: "rpc" });
          f.session.setSteeringMode("all");
          f.session.setFollowUpMode("all");
          let revision = "A: actual revision";
          if (owned) {
            await f.command("finalize");
            const sent = f.sent.at(-1);
            if (!sent) throw new Error("revision was not sent");
            revision = sent;
          }
          let accepted = false;
          let acceptanceState: unknown;
          f.api.on("message_start", (event) => {
            if (
              event.message.role === "user" &&
              JSON.stringify(event.message.content).includes(JSON.stringify(revision).slice(1, -1))
            ) {
              accepted = true;
              acceptanceState = f.state();
            }
          });
          const respond = (ctx: TranscriptContext) => {
            const latest = ctx.messages.filter((message) => message.role === "user").at(-1);
            return JSON.stringify(latest?.content).includes(JSON.stringify(revision).slice(1, -1))
              ? completion("# Revision")
              : fauxAssistantMessage("<proposed_plan>\n# Not owned\n</proposed_plan>");
          };
          f.faux.setResponses([
            async () => {
              entered();
              await held;
              return fauxAssistantMessage("holding");
            },
            respond,
            respond,
            respond,
          ]);
          const running = f.session.prompt("Hold background run", { source: "extension" });
          await started;
          const A = () =>
            f.session.prompt(revision, { source: owned ? "extension" : "rpc", streamingBehavior: lanes[0] });
          const B = () =>
            f.session.prompt("B: unrelated notification", {
              source: "extension",
              streamingBehavior: lanes[1],
              images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
            });
          if (order === "A-first") {
            await A();
            await B();
          } else {
            await B();
            await A();
          }
          release();
          await running;
          expect(accepted).toBe(true);
          expect(acceptanceState).toMatchObject({ awaitingAction: false });
          expect((f.state() as { latestPlan?: string }).latestPlan).not.toBe("# Not owned");
        } finally {
          release?.();
          await f.close();
        }
      });
    }
  }

for (const realFirst of [false, true]) {
  test(`same-content queued source collisions never invalidate or complete a ready plan: realFirst=${realFirst}`, async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await f.command("start");
      f.faux.setResponses([completion("# Ready")]);
      await f.session.prompt("Plan it", { source: "rpc" });
      f.faux.setResponses([
        async () => {
          entered();
          await held;
          return fauxAssistantMessage("holding");
        },
        completion("# Collision"),
        fauxAssistantMessage("<proposed_plan>\n# Collision\n</proposed_plan>"),
        fauxAssistantMessage("<proposed_plan>\n# Collision\n</proposed_plan>"),
      ]);
      const running = f.session.prompt("Hold a background run", { source: "extension" });
      await started;
      const sources = realFirst ? (["rpc", "extension"] as const) : (["extension", "rpc"] as const);
      for (const [index, source] of sources.entries()) {
        await f.session.prompt("identical content", { source, streamingBehavior: index ? "followUp" : "steer" });
      }
      release();
      await running;
      expect(f.state()).toMatchObject({ latestPlan: "# Ready", awaitingAction: true });
    } finally {
      release?.();
      await f.close();
    }
  });
}

for (const streamingBehavior of ["followUp", "steer"] as const) {
  test(`accepted queued ${streamingBehavior} revision binds at native delivery without needing a fresh start hook`, async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await f.command("start");
      f.faux.setResponses([
        async () => {
          entered();
          await held;
          return fauxAssistantMessage("Exploration in progress");
        },
        completion("# Queued revision"),
      ]);
      const original = f.session.prompt("Initial request", { source: "rpc" });
      await started;
      await f.session.prompt("Revise this now", { source: "rpc", streamingBehavior });
      release();
      await original;
      expect(f.state()).toMatchObject({ latestPlan: "# Queued revision", awaitingAction: true });
    } finally {
      release?.();
      await f.close();
    }
  });
}
