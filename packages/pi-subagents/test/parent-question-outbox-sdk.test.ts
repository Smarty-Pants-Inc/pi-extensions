import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionContext, type InputEvent, type InputEventResult, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARENT_QUESTION_WAKE_ACK_MS, registerParentQuestions } from "../src/parent-questions.js";
import { captureQuestionOrigin } from "../src/question-origin.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";

function pngImage(size: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6; // RGBA, one unfiltered white row per scanline.
  const rowSize = size * 4 + 1;
  const pixels = Buffer.alloc(rowSize * size, 255);
  for (let row = 0; row < size; row++) pixels[row * rowSize] = 0;
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  return { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("question outbox on native SDK INPUT and preparation", () => {
  let root: string;
  let session: AgentSession;
  let runtime: ModelRuntime;
  let provider: ReturnType<typeof fauxProvider>;
  let questions: ReturnType<typeof registerParentQuestions>;
  let current: ExtensionContext | undefined;
  let pi: ExtensionAPI;
  let input: ReturnType<typeof vi.fn<(event: InputEvent) => Promise<InputEventResult | undefined>>>;
  let before: ReturnType<typeof vi.fn>;
  let laterBefore: ReturnType<typeof vi.fn>;
  let ownedInput: ReturnType<typeof vi.fn<(event: InputEvent) => Promise<InputEventResult>>>;
  let nativeErrors: ReturnType<typeof vi.fn>;
  let tokens: string[];
  let laterMessage: ReturnType<typeof vi.fn>;
  let settlements: ReturnType<typeof vi.fn>;
  let disableGuard: () => void;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "question-outbox-sdk-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    provider = fauxProvider({ provider: "outbox-native", models: [{ id: "main", contextWindow: 200_000 }] });
    runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(provider.provider);
    await runtime.refresh({ allowNetwork: false });
    tokens = [];
    input = vi.fn(async () => undefined);
    before = vi.fn();
    laterBefore = vi.fn();
    ownedInput = vi.fn(async () => ({ action: "continue" }));
    nativeErrors = vi.fn();
    laterMessage = vi.fn();
    settlements = vi.fn();

    const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [
      { name: "earlier-native-hooks", factory: api => {
        api.on("input", async event => {
          if (event.source === "extension") tokens.push(event.text);
          return input(event);
        });
        api.on("before_agent_start", before);
      } },
      { name: "outbox", factory: api => {
        pi = api;
        const subscriptions: (() => void)[] = [];
        const on: ExtensionAPI["on"] = (event, handler) => {
          const off = api.on(event, handler);
          subscriptions.push(off);
          return off;
        };
        questions = registerParentQuestions({ ...api, on }, () => current);
        disableGuard = () => { for (const off of subscriptions) off(); };
        api.on("input", questions.observeHandledInput(ownedInput));
        api.on("before_agent_start", laterBefore);
        api.on("message_start", async (event, ctx) => laterMessage("start", event, ctx));
        api.on("message_end", async (event, ctx) => laterMessage("end", event, ctx));
        api.on("agent_settled", (_event, ctx) => settlements(ctx.signal));
        api.on("session_start", (_event, ctx) => { current = ctx; });
        api.on("session_shutdown", () => { questions.retire(); current = undefined; });
      } },
    ] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, model: provider.getModel(), modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) }));
    await session.bindExtensions({ onError: nativeErrors });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await shutdownAndDisposeSession(session);
    provider.setResponses([]);
    rmSync(root, { recursive: true, force: true });
  });
  function ask(agentId = "child", signal?: AbortSignal) {
    const isCurrent = captureQuestionOrigin(current!);
    return questions.broker.request({ agentId, isCurrent: () => isCurrent(current) }, "PRIVATE_QUESTION", undefined, signal);
  }

  it.each(["cancel", "timeout", "retire", "replacement"])("consumes authenticated %s wakes after an earlier native INPUT await without persisting or calling a provider", async reason => {
    vi.useFakeTimers();
    const gate = barrier();
    input.mockImplementation(async event => { if (event.source === "extension") await gate.promise; return undefined; });
    const controller = new AbortController();
    const reply = ask("child", controller.signal);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokens).toHaveLength(1);
    const token = tokens[0];
    if (reason === "cancel") controller.abort();
    else if (reason === "timeout") await vi.advanceTimersByTimeAsync(120_000);
    else if (reason === "retire") questions.retire();
    else {
      // Same ID, distinct public manager identity; no lifecycle notification needed.
      const replacement = SessionManager.inMemory(root);
      replacement.newSession({ id: current!.sessionManager.getSessionId() });
      current = { ...current!, sessionManager: replacement };
    }
    gate.release();
    await vi.advanceTimersByTimeAsync(1);
    expect(await reply).toMatchObject({ status: "unanswered" });
    expect(provider.state.callCount).toBe(0);
    expect(session.messages.some(message => JSON.stringify(message).includes(token))).toBe(false);
    expect(before).not.toHaveBeenCalled();
    // Historical recognition is authenticated, not an unbounded token set.
    input.mockResolvedValue(undefined);
    await session.sendUserMessage(token);
    expect(provider.state.callCount).toBe(0);
  });

  it("leaves a foreign exact literal, forged MAC, and interactive own literal as genuine inputs", async () => {
    vi.useFakeTimers();
    input.mockResolvedValue({ action: "handled" });
    const reply = ask();
    await vi.advanceTimersByTimeAsync(1);
    const token = tokens[0];
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
    input.mockResolvedValue(undefined);
    const literal = "Check current opted-in subagent clarifications in the extension context. If none remain, no answer is needed.";
    const forged = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain(literal);
      return fauxAssistantMessage(fauxText("ordinary"));
    }, context => {
      expect(JSON.stringify(context)).toContain(forged);
      return fauxAssistantMessage(fauxText("ordinary"));
    }, context => {
      expect(JSON.stringify(context)).toContain(token);
      return fauxAssistantMessage(fauxText("ordinary"));
    }]);
    await session.sendUserMessage(literal);
    await session.sendUserMessage(forged);
    await session.prompt(token);
    expect(provider.state.callCount).toBe(3);
  });

  it("does not overlap an observed genuine prompt preparing in an earlier before_agent_start await", async () => {
    const gate = barrier();
    before.mockImplementation(async event => { if (event.prompt === "GENUINE_TEXT") await gate.promise; });
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain("GENUINE_TEXT");
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("genuine preserved"));
    }]);
    const genuine = session.prompt("GENUINE_TEXT");
    await vi.waitFor(() => expect(before).toHaveBeenCalledOnce());
    expect(session.isIdle).toBe(true); // SDK has not started the agent yet.
    const reply = ask();
    // Flush the outbox timer, not a speculative model poll.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(tokens).toEqual([]);
    expect(provider.state.callCount).toBe(0);
    gate.release();
    await genuine;
    expect(provider.state.callCount).toBe(1);
    expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it.each(["handled", "native-auth-rejection"])("bounds an unacknowledged %s attempt to 30s and lets later questions recover without model polling", async failure => {
    vi.useFakeTimers();
    if (failure === "handled") input.mockResolvedValue({ action: "handled" });
    else {
      runtime.registerNativeProvider({ ...provider.provider, auth: { apiKey: { name: "Unavailable fixture credential", resolve: async () => undefined } } });
      await runtime.refresh({ allowNetwork: false });
    }
    const reply = ask();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokens).toHaveLength(1);
    expect(before).not.toHaveBeenCalled();
    expect(provider.state.callCount).toBe(0);
    await vi.advanceTimersByTimeAsync(PARENT_QUESTION_WAKE_ACK_MS);
    expect(await reply).toMatchObject({ status: "unanswered", reason: expect.stringContaining("acknowledged") });
    expect(tokens).toHaveLength(1); // explicit no-answer recovery, no retries
    input.mockResolvedValue(undefined);
    runtime.registerNativeProvider(provider.provider);
    await runtime.refresh({ allowNetwork: false });
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("current question"));
    }]);
    const recovered = ask("new-child");
    await vi.advanceTimersByTimeAsync(1);
    await session.waitForIdle();
    expect(provider.state.callCount).toBe(1);
    expect(before).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PARENT_QUESTION_WAKE_ACK_MS);
    expect(tokens).toHaveLength(2); // acknowledged question never gets another turn
    questions.retire();
    expect(await recovered).toMatchObject({ status: "unanswered" });
    expect(pi).toBeDefined();
  });

  it("refuses the answering capability even when a child registers the root definition under an alias", async () => {
    const reply = ask();
    const id = JSON.parse(questions.broker.context()!.split("\n").at(-1)!)[0].questionId;
    const original = session.getToolDefinition("answer_subagent_question")!;
    const childProvider = fauxProvider({ provider: "answer-alias-child", models: [{ id: "child", contextWindow: 200_000 }] });
    runtime.registerNativeProvider(childProvider.provider);
    await runtime.refresh({ allowNetwork: false });
    childProvider.setResponses([
      () => fauxAssistantMessage(fauxToolCall("alias_answer", { questionId: id, answer: "approved" }), { stopReason: "toolUse" }),
      context => { expect(JSON.stringify(context)).toContain("No current root question owner"); return fauxAssistantMessage(fauxText("refused")); },
    ]);
    const agentDir = join(root, "agent");
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noContextFiles: true, noThemes: true, extensionFactories: [api => { api.registerTool({ ...original, name: "alias_answer" }); }] });
    await loader.reload();
    const manager = SessionManager.inMemory(root);
    manager.newSession({ id: current!.sessionManager.getSessionId() });
    const { session: child } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: childProvider.getModel(), resourceLoader: loader, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
    try {
      await child.bindExtensions({});
      await child.prompt("try alias");
      expect(childProvider.state.callCount).toBe(2);
      expect(provider.state.callCount).toBe(0);
      questions.retire();
      expect(await reply).toMatchObject({ status: "unanswered" });
    } finally { await shutdownAndDisposeSession(child); }
  });

  it("suppresses provider dispatch when a question is cancelled during native preparation", async () => {
    const gate = barrier();
    before.mockImplementation(async () => { await gate.promise; });
    const controller = new AbortController();
    const reply = ask("child", controller.signal);
    await vi.waitFor(() => expect(before).toHaveBeenCalledOnce());
    controller.abort();
    expect(await reply).toMatchObject({ status: "unanswered" });
    await new Promise(resolve => setTimeout(resolve, 10));
    gate.release();
    await session.waitForIdle();
    expect(provider.state.callCount).toBe(0);
  });

  it.each(["wake-first", "genuine-first"])("keeps an accepted wake inert across later native double preparation (%s), preserving genuine text and images", async order => {
    const wakeGate = barrier();
    const genuineGate = barrier();
    const wakes = vi.fn();
    const genuineReady = vi.fn();
    laterBefore.mockImplementation(async event => {
      if (event.prompt === "GENUINE_TEXT") { genuineReady(); await genuineGate.promise; }
      else { wakes(); await wakeGate.promise; }
    });
    const image = pngImage(1);
    provider.setResponses([context => {
      const text = JSON.stringify(context);
      expect(text).toContain("GENUINE_TEXT");
      expect(text).toContain("PRIVATE_QUESTION");
      expect(text).not.toContain("pi-subagents-question-wake:");
      expect(text).not.toContain("subagent-question-frame:");
      return fauxAssistantMessage(fauxText("genuine preserved"));
    }]);
    const reply = ask();
    await vi.waitFor(() => expect(wakes).toHaveBeenCalledOnce());
    const genuine = session.prompt("GENUINE_TEXT", { images: [image] });
    await vi.waitFor(() => expect(genuineReady).toHaveBeenCalledOnce());
    if (order === "wake-first") {
      wakeGate.release();
      await vi.waitFor(() => expect(session.messages.some(message => message.role === "custom" && message.customType.startsWith("subagent-question-frame:"))).toBe(true));
      await session.waitForIdle();
      expect(provider.state.callCount).toBe(0);
      expect(questions.broker.hasUnannounced()).toBe(true);
      genuineGate.release();
      await genuine;
    } else {
      genuineGate.release();
      await genuine;
      wakeGate.release();
      await vi.waitFor(() => expect(session.messages.some(message => message.role === "custom" && message.customType.startsWith("subagent-question-frame:"))).toBe(true));
      await session.waitForIdle();
    }
    expect(provider.state.callCount).toBe(1);
    // Native provider errors are message data: assert the response too so an
    // assertion inside the provider callback cannot pass as a swallowed error.
    expect(session.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "genuine preserved" }] }));
    const users = session.messages.filter(message => message.role === "user");
    expect(users).toContainEqual({ role: "user", content: [{ type: "text", text: "GENUINE_TEXT" }, image], timestamp: expect.any(Number) });
    expect(questions.broker.context()).toBeUndefined();
    // Verbatim original control token is still a genuine prompt, with no proof.
    laterBefore.mockReset();
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain(tokens[0]);
      expect(JSON.stringify(context)).not.toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("literal preserved"));
    }]);
    await session.prompt(tokens[0]);
    expect(provider.state.callCount).toBe(2);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "literal preserved" }] });
    const proof = session.messages.find(message => message.role === "custom" && message.customType.startsWith("subagent-question-frame:"));
    const frameToken = proof?.role === "custom" ? (proof.details as { token: string }).token : undefined;
    expect(frameToken).toBeDefined();
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain(frameToken);
      expect(JSON.stringify(context)).not.toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("historical frame literal preserved"));
    }]);
    await session.prompt(frameToken!);
    expect(provider.state.callCount).toBe(3);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "historical frame literal preserved" }] });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(tokens).toHaveLength(1);
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it("never aborts the genuine native run when the later wake preparation releases during genuine streaming", async () => {
    const wakeGate = barrier();
    const genuineGate = barrier();
    const responseGate = barrier();
    const wakeReady = vi.fn();
    const genuineReady = vi.fn();
    laterBefore.mockImplementation(async event => {
      if (event.prompt === "GENUINE_TEXT") { genuineReady(); await genuineGate.promise; }
      else { wakeReady(); await wakeGate.promise; }
    });
    provider.setResponses([async (context, options) => {
      expect(JSON.stringify(context)).toContain("GENUINE_TEXT");
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      await responseGate.promise;
      expect(options.signal?.aborted).toBe(false);
      return fauxAssistantMessage(fauxText("genuine survived stale wake"));
    }]);
    const reply = ask();
    await vi.waitFor(() => expect(wakeReady).toHaveBeenCalledOnce());
    const genuine = session.prompt("GENUINE_TEXT");
    await vi.waitFor(() => expect(genuineReady).toHaveBeenCalledOnce());
    genuineGate.release();
    await vi.waitFor(() => expect(provider.state.callCount).toBe(1));
    wakeGate.release();
    await vi.waitFor(() => expect(nativeErrors).toHaveBeenCalledWith(expect.objectContaining({ event: "send_user_message", error: expect.stringContaining("already processing") })));
    responseGate.release();
    await genuine;
    expect(provider.state.callCount).toBe(1);
    expect(session.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "genuine survived stale wake" }] }));
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it.each([true, false].flatMap(guard => ["start-user", "end-user", "start-proof", "end-proof", "genuine-first"].map(boundary => ({ guard, boundary }))))("retains the executing native owner through a competing busy settlement ($boundary, guard=$guard)", async ({ boundary, guard }) => {
    const wakeGate = barrier();
    const genuineGate = barrier();
    const messageGate = barrier();
    const reached = vi.fn();
    const wakeReady = vi.fn();
    const genuineReady = vi.fn();
    let ownerSignal: AbortSignal | undefined;
    laterBefore.mockImplementation(async event => {
      if (event.prompt === "GENUINE_TEXT") { genuineReady(); await genuineGate.promise; }
      else { wakeReady(); await wakeGate.promise; }
    });
    laterMessage.mockImplementation(async (phase, event, ctx) => {
      const kind = event.message.role === "user" ? "user" : event.message.role === "custom" && event.message.customType.startsWith("subagent-question-frame:") ? "proof" : "other";
      if (`${phase}-${kind}` !== boundary) return;
      ownerSignal = ctx.signal;
      reached();
      await messageGate.promise;
    });
    provider.setResponses([() => fauxAssistantMessage(fauxText("genuine survived"))]);
    const reply = ask();
    await vi.waitFor(() => expect(wakeReady).toHaveBeenCalledOnce());
    if (!guard) disableGuard();
    const genuine = session.prompt("GENUINE_TEXT").then(() => "completed", error => String(error));
    await vi.waitFor(() => expect(genuineReady).toHaveBeenCalledOnce());
    if (boundary === "genuine-first") {
      genuineGate.release();
      expect(await genuine).toBe("completed");
      wakeGate.release();
      await vi.waitFor(() => expect(settlements).toHaveBeenCalledTimes(2));
      expect(provider.state.callCount).toBe(guard ? 1 : 2);
      expect(session.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "genuine survived" }] }));
    } else {
      wakeGate.release();
      await vi.waitFor(() => expect(reached).toHaveBeenCalledOnce());
      expect(ownerSignal).toBeDefined();
      genuineGate.release();
      expect(await genuine).toContain("already processing");
      expect(settlements).toHaveBeenCalledWith(ownerSignal);
      messageGate.release();
      await vi.waitFor(() => expect(settlements).toHaveBeenCalledTimes(2));
      expect(provider.state.callCount).toBe(guard ? 0 : 1);
      expect(questions.broker.hasUnannounced()).toBe(true);
    }
    expect(nativeErrors).not.toHaveBeenCalled();
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it.each([true, false].flatMap(guard => [true, false].flatMap(images => ["wake-first", "literal-first"].map(order => ({ guard, images, order })))))("fails closed when an interactive input copies an unprepared frame token ($order, images=$images, guard=$guard)", async ({ order, images, guard }) => {
    const wakeGate = barrier();
    const literalGate = barrier();
    let frameToken: string | undefined;
    let first = true;
    before.mockImplementation(async event => {
      if (first) { first = false; frameToken = event.prompt; await wakeGate.promise; }
    });
    let literalPreparing = true;
    laterBefore.mockImplementation(async () => {
      if (literalPreparing) { literalPreparing = false; await literalGate.promise; }
    });
    const image = pngImage(1);
    const contexts: string[] = [];
    provider.setResponses(Array.from({ length: 3 }, () => context => {
      contexts.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText("literal survived"));
    }));
    const reply = ask();
    await vi.waitFor(() => expect(frameToken).toBeDefined());
    if (!guard) disableGuard();
    const content = [{ type: "text", text: frameToken }, ...(images ? [image] : [])];
    const genuine = session.prompt(frameToken!, { images: images ? [image] : undefined });
    await vi.waitFor(() => expect(laterBefore).toHaveBeenCalledOnce());
    if (order === "wake-first") {
      wakeGate.release();
      await vi.waitFor(() => expect(settlements).toHaveBeenCalledOnce());
      literalGate.release();
      await genuine;
    } else {
      literalGate.release();
      await genuine;
      wakeGate.release();
      await vi.waitFor(() => expect(settlements).toHaveBeenCalledTimes(2));
    }
    expect(provider.state.callCount).toBe(2);
    expect(contexts.every(context => !context.includes("PRIVATE_QUESTION"))).toBe(true);
    // The disabled control still has W's earlier native dispatch snapshot;
    // only W can receive that proof, never the copied interactive input.
    const proofs = session.messages.filter(message => message.role === "custom" && message.customType.startsWith("subagent-question-frame:"));
    expect(proofs).toHaveLength(guard ? 0 : 1);
    const userIndices = session.messages.flatMap((message, index) => message.role === "user" ? [index] : []);
    const genuineIndex = userIndices[order === "literal-first" ? 0 : 1];
    expect(session.messages[genuineIndex + 1]).not.toMatchObject({ role: "custom", customType: expect.stringMatching(/^subagent-question-frame:/) });
    expect(session.messages).toContainEqual({ role: "user", content, timestamp: expect.any(Number) });
    expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(2);
    expect(nativeErrors).not.toHaveBeenCalled();
    if (!guard) {
      questions.retire();
      expect(await reply).toMatchObject({ status: "unanswered" });
      return;
    }
    expect(await reply).toMatchObject({ status: "unanswered", reason: expect.stringContaining("ambiguous") });
    before.mockReset();
    laterBefore.mockReset();
    const recovered = ask("new-child");
    await session.prompt("ordinary recovery");
    expect(contexts.at(-1)).toContain("PRIVATE_QUESTION");
    questions.retire();
    expect(await recovered).toMatchObject({ status: "unanswered" });
  });

  it.each(["wake-first", "literal-first"])("keeps a copied ambiguous frame question-inert after default AUTO 4096 PNG normalization (%s)", async order => {
    expect(session.settingsManager.getImageAutoResize()).toBe(true);
    const image = pngImage(4096);
    const original = structuredClone(image);
    // A plain native turn supplies the real SDK normalization reference. No
    // normalizer, Photon, resize profile, worker, or image path is mocked.
    provider.setResponses([() => fauxAssistantMessage(fauxText("image reference"))]);
    await session.prompt("IMAGE_REFERENCE", { images: [image] });
    const reference = session.messages.find(message => message.role === "user");
    if (reference?.role !== "user" || typeof reference.content === "string") throw new Error("Missing image reference");
    const referenceText = reference.content[0];
    expect(referenceText).toMatchObject({ type: "text", text: expect.stringContaining("original 4096x4096, displayed at 2000x2000") });
    const normalizedImage = reference.content[1];
    expect(normalizedImage?.type).toBe("image");
    if (normalizedImage?.type !== "image" || referenceText.type !== "text") throw new Error("SDK omitted image");
    expect(normalizedImage.data === image.data).toBe(false);
    const resized = Buffer.from(normalizedImage.data, "base64");
    expect(resized.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([resized.readUInt32BE(16), resized.readUInt32BE(20)]).toEqual([2000, 2000]);
    const hint = referenceText.text.slice("IMAGE_REFERENCE".length);
    before.mockClear();
    laterBefore.mockClear();

    const wakeGate = barrier();
    const literalGate = barrier();
    let frameToken: string | undefined;
    before.mockImplementation(async event => {
      if (frameToken === undefined) { frameToken = event.prompt; await wakeGate.promise; }
    });
    let literalPreparing = true;
    laterBefore.mockImplementation(async () => {
      if (literalPreparing) { literalPreparing = false; await literalGate.promise; }
    });
    const contexts: string[] = [];
    const modelUsers: unknown[] = [];
    const signals: AbortSignal[] = [];
    provider.setResponses(Array.from({ length: 3 }, () => (context, options) => {
      contexts.push(JSON.stringify(context));
      modelUsers.push(...context.messages.filter(message => message.role === "user"));
      if (options.signal) signals.push(options.signal);
      return fauxAssistantMessage(fauxText("copied image survived"));
    }));
    const reply = ask();
    await vi.waitFor(() => expect(frameToken).toBeDefined());
    const next = ask("another-child"); // Q must stay pending through both frames.
    const genuine = session.prompt(frameToken!, { images: [image] });
    await vi.waitFor(() => expect(laterBefore).toHaveBeenCalledOnce());
    expect(await reply).toMatchObject({ status: "unanswered", reason: expect.stringContaining("ambiguous") });
    const baselineSettlements = settlements.mock.calls.length;
    try {
      if (order === "wake-first") {
        wakeGate.release();
        await vi.waitFor(() => expect(settlements).toHaveBeenCalledTimes(baselineSettlements + 1));
        expect(questions.broker.hasUnannounced()).toBe(true);
        literalGate.release();
        await genuine;
      } else {
        literalGate.release();
        await genuine;
        expect(questions.broker.hasUnannounced()).toBe(true);
        wakeGate.release();
        await vi.waitFor(() => expect(settlements).toHaveBeenCalledTimes(baselineSettlements + 2));
      }
      expect(provider.state.callCount).toBe(3); // reference, W, G; no abort.
      expect(contexts).toHaveLength(2);
      expect(contexts.every(context => !context.includes("PRIVATE_QUESTION"))).toBe(true);
      expect(questions.broker.hasUnannounced()).toBe(true);
      expect(signals).toHaveLength(2);
      expect(signals.every(signal => !signal.aborted)).toBe(true);
      expect(session.messages.filter(message => message.role === "custom" && message.customType.startsWith("subagent-question-frame:"))).toHaveLength(0);
      expect(session.messages.filter(message => message.role === "assistant" && message.stopReason === "aborted")).toHaveLength(0);
      const genuineUser = session.messages.find(message => message.role === "user" && typeof message.content !== "string" && message.content[0]?.type === "text" && message.content[0].text === `${frameToken}${hint}`);
      expect(genuineUser).toBeDefined();
      const expectedContent = [{ type: "text", text: `${frameToken}${hint}` }, normalizedImage];
      expect(genuineUser?.role === "user" && genuineUser.content).toEqual(expectedContent);
      expect(modelUsers).toContainEqual(expect.objectContaining({ role: "user", content: expectedContent }));
      expect(image).toEqual(original);
      expect(nativeErrors).not.toHaveBeenCalled();
      before.mockReset();
      laterBefore.mockReset();
      await session.prompt("ordinary recovery");
      expect(contexts.at(-1)).toContain("PRIVATE_QUESTION");
      expect(questions.broker.hasUnannounced()).toBe(false);
    } finally {
      wakeGate.release();
      literalGate.release();
      await genuine;
      questions.retire();
    }
    expect(await next).toMatchObject({ status: "unanswered" });
  });

  it.each(["handled", "throw"])("uses native %s semantics for input-scoped own readiness without releasing another preparing prompt", async outcome => {
    const mentionGate = barrier();
    const genuineGate = barrier();
    const genuineReady = vi.fn();
    ownedInput.mockImplementation(async event => {
      if (event.text !== "@child mention") return { action: "continue" };
      await mentionGate.promise;
      if (outcome === "throw") throw new Error("owned input fixture failed");
      return { action: "handled" };
    });
    laterBefore.mockImplementation(async event => {
      if (event.prompt === "GENUINE_TEXT") { genuineReady(); await genuineGate.promise; }
      if (event.prompt === "@child mention") await genuineGate.promise;
    });
    provider.setResponses([
      () => fauxAssistantMessage(fauxText("first")),
      () => fauxAssistantMessage(fauxText("second")),
    ]);
    const mention = session.prompt("@child mention");
    await vi.waitFor(() => expect(ownedInput).toHaveBeenCalledOnce());
    const genuine = session.prompt("GENUINE_TEXT");
    await vi.waitFor(() => expect(genuineReady).toHaveBeenCalledOnce());
    const reply = ask();
    mentionGate.release();
    if (outcome === "handled") await mention;
    else await vi.waitFor(() => expect(laterBefore).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(tokens).toEqual([]);
    expect(provider.state.callCount).toBe(0);
    genuineGate.release();
    await genuine;
    if (outcome === "throw") await mention.catch(error => expect(String(error)).toContain("already processing"));
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it("releases a native own handled input so the next child question can wake immediately", async () => {
    ownedInput.mockResolvedValue({ action: "handled" });
    await session.prompt("@child mention");
    expect(before).not.toHaveBeenCalled();
    ownedInput.mockResolvedValue({ action: "continue" });
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("awake"));
    }]);
    const reply = ask();
    await vi.waitFor(() => expect(provider.state.callCount).toBe(1));
    await session.waitForIdle();
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it("recovers after a native model response promise rejects, without redelivering an acknowledged question", async () => {
    provider.setResponses([async () => { throw new Error("native response failed"); }]);
    const first = ask();
    await vi.waitFor(() => expect(provider.state.callCount).toBe(1));
    await session.waitForIdle();
    expect(questions.broker.context()).toBeUndefined();
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("recovered"));
    }]);
    const second = ask("new-child");
    await vi.waitFor(() => expect(provider.state.callCount).toBe(2));
    await session.waitForIdle();
    expect(tokens).toHaveLength(2);
    questions.retire();
    expect(await first).toMatchObject({ status: "unanswered" });
    expect(await second).toMatchObject({ status: "unanswered" });
  });

  it("refuses an idle wake when an earlier native INPUT await starts genuine work", async () => {
    const gate = barrier();
    const answer = vi.fn(context => {
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("followup"));
    });
    provider.setResponses([async () => { await gate.promise; return fauxAssistantMessage(fauxText("first")); }, answer]);
    const reply = ask();
    input.mockImplementation(async event => {
      if (event.source === "extension") {
        // A different extension starts work during its earlier INPUT hook.
        input.mockResolvedValue(undefined);
        void session.prompt("genuine");
        await vi.waitFor(() => expect(provider.state.callCount).toBe(1));
      }
      return undefined;
    });
    await vi.waitFor(() => expect(tokens).toHaveLength(1));
    // Our input fence refuses to queue an obsolete idle wake. The question
    // instead joins the current genuine model context/next observed turn.
    gate.release();
    await session.waitForIdle();
    expect(tokens).toHaveLength(1);
    expect(before).toHaveBeenCalledOnce();
    expect(provider.state.callCount).toBe(1);
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });
});
