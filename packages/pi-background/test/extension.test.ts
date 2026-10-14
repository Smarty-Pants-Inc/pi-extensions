import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEvent, JobManager, JobSnapshot, StartOptions } from "../src/contracts.js";
import extension from "../src/extension.js";
import { MESSAGE_TYPE } from "../src/notifications.js";

const fake = vi.hoisted(() => ({ managers: [] as Array<{ manager: JobManager; emit: (event: JobEvent) => void }> }));
vi.mock("../src/manager.js", () => ({
  createJobManager: (emit: (event: JobEvent) => void): JobManager => {
    const jobs: JobSnapshot[] = [];
    const manager: JobManager = {
      start: vi.fn(async (options: StartOptions) => {
        const job: JobSnapshot = {
          id: `job-${jobs.length}`,
          command: options.command,
          cwd: options.cwd,
          description: options.description ?? "job",
          status: "running",
          startedAt: 1,
          attention: options.attention ?? "turn",
          droppedBytes: 0,
        };
        jobs.push(job);
        return job;
      }),
      watch: vi.fn((id, watch) => {
        const job = manager.get(id);
        job.watch = watch;
        return job;
      }),
      list: vi.fn(() => jobs),
      get: (id) => {
        const job = jobs.find((entry) => entry.id === id);
        if (!job) throw new Error("unknown job");
        return job;
      },
      logs: () => ({ text: "hello", droppedBytes: 0 }),
      stop: vi.fn(async (id) => {
        const job = manager.get(id);
        job.status = "stopped";
        return job;
      }),
      clear: vi.fn(() => 0),
      shutdown: vi.fn(async () => {
        jobs.length = 0;
      }),
    };
    fake.managers.push({ manager, emit });
    return manager;
  },
}));

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
interface Tool {
  name: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  outputSchema?: unknown;
  execute(
    id: string,
    input: unknown,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ): Promise<{
    details: { jobs: JobSnapshot[]; pendingNotifications: number };
    structuredContent?: unknown;
  }>;
}

function harness(mode = "tui") {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  let idle = true;
  let pending = false;
  let sessionId = "session-a";
  let acceptWake = true;
  let branch: string[] = ["root"];
  let waitForIdle: () => Promise<void> = async () => {};
  let onMessage: () => void = () => {};
  const userMessages: string[] = [];
  const status = vi.fn();
  const notify = vi.fn();
  const messages: Array<{
    customType: string;
    content: string;
    details: { wakeId: string };
    options: { triggerTurn: boolean };
  }> = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: process.cwd(),
    model: {},
    ui: { setStatus: status, notify },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [
        ...branch.map((id) => ({ id, type: "custom" })),
        ...messages.map((message, index) => ({
          id: `message-${index}`,
          type: "custom_message",
          customType: message.customType,
          details: message.details,
        })),
      ],
    },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    waitForIdle: () => waitForIdle(),
  } as unknown as ExtensionContext;
  const pi = {
    getAllTools: () => [],
    getCommands: () => [],
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) =>
      commands.set(name, command),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    sendUserMessage: (text: string) => {
      userMessages.push(text);
      if (acceptWake) handlers.get("message_end")?.({ message: { role: "user", content: text } }, ctx);
    },
    sendMessage: (
      message: { customType: string; content: string; details: { wakeId: string } },
      options: { triggerTurn: boolean },
    ) => {
      messages.push({ ...message, options });
      onMessage();
      // Prompt delivery reaches extension message_end; idle context appends do not.
      if (options.triggerTurn) handlers.get("message_end")?.({ message: { ...message, role: "custom" } }, ctx);
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  return {
    pi,
    ctx,
    tools,
    commands,
    messages,
    userMessages,
    setBranch: (ids: string[]) => {
      branch = ids;
    },
    setWaitForIdle: (wait: () => Promise<void>) => {
      waitForIdle = wait;
    },
    setOnMessage: (callback: () => void) => {
      onMessage = callback;
    },
    setAcceptWake: (value: boolean) => {
      acceptWake = value;
    },
    status,
    notify,
    emit: async (name: string, data: Record<string, unknown> = {}) => handlers.get(name)?.(data, ctx),
    setIdle: (value: boolean) => {
      idle = value;
    },
    setPending: (value: boolean) => {
      pending = value;
    },
    setSession: (value: string) => {
      sessionId = value;
    },
  };
}

function event(jobId = "job-0"): JobEvent {
  return { jobId, description: "job", kind: "exit", attention: "turn", text: "exited 0" };
}

afterEach(() => {
  fake.managers.length = 0;
  vi.useRealTimers();
});

describe("extension lifecycle", () => {
  it("registers tools without starting resources in the factory", () => {
    const h = harness();
    expect(fake.managers).toHaveLength(0);
    expect([...h.tools.keys()]).toEqual([
      "bash_background",
      "monitor",
      "background_list",
      "background_logs",
      "background_stop",
      "background_clear",
    ]);
    expect(h.tools.get("bash_background")?.annotations.readOnlyHint).toBe(false);
    expect(h.tools.get("background_logs")?.annotations.readOnlyHint).toBe(true);
    expect([...h.tools.values()].every((tool) => tool.outputSchema)).toBe(true);
  });

  it("coalesces notifications until fully settled and queues are drained", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    await h.emit("agent_start");
    h.setIdle(false);
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    h.setIdle(true);
    h.setPending(true);
    await h.emit("agent_settled");
    vi.advanceTimersByTime(0);
    expect(h.messages).toHaveLength(0);
    h.setPending(false);
    await h.emit("agent_settled");
    vi.advanceTimersByTime(0);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].customType).toBe(MESSAGE_TYPE);
    await h.emit("agent_settled");
    expect(h.messages).toHaveLength(1);
    await h.emit("session_shutdown");
  });

  it("does not race pre-prompt or manual compaction", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    await h.emit("input");
    await h.emit("session_before_compact");
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    await h.emit("session_compact");
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    await h.emit("agent_start");
    await h.emit("agent_settled");
    vi.advanceTimersByTime(0);
    expect(h.messages).toHaveLength(1);
    await h.emit("session_shutdown");
  });

  it("kills jobs and drops stale callbacks across tree navigation or reload", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    const old = fake.managers[0];
    old.emit(event());
    await h.emit("session_tree");
    expect(old.manager.shutdown).toHaveBeenCalledTimes(1);
    old.emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    await h.emit("session_shutdown");
    await h.emit("session_start");
    const listed = await h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx);
    expect(listed?.details.jobs).toEqual([]);
    await h.emit("session_shutdown");
  });

  it("does not hand off a settled wake before a later navigation handler", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    h.setIdle(false);
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    h.setIdle(true);
    await h.emit("agent_settled");
    expect(h.messages).toHaveLength(0);
    await h.emit("session_before_tree");
    await h.emit("session_tree");
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    await h.emit("session_shutdown");
  });

  it("acknowledges persisted idle context events without message_end", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    for (let index = 0; index < 2; index++) {
      fake.managers[0].emit({ ...event(`job-${index}`), attention: "context" });
      vi.advanceTimersByTime(2000);
    }
    expect(h.messages).toHaveLength(2);
    expect(h.messages.every((message) => !message.options.triggerTurn)).toBe(true);
    const result = await h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx);
    expect(result?.details.pendingNotifications).toBe(0);
    await h.emit("session_shutdown");
  });

  it("keeps persisted events pending until the exact user wake is acknowledged", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setAcceptWake(false);
    await h.emit("session_start");
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].options.triggerTurn).toBe(false);
    expect(h.userMessages).toHaveLength(1);
    await h.emit("message_end", {
      message: { role: "user", content: "Background process wake [unrelated]\nignored" },
    });
    const list = () => h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx);
    expect((await list())?.details.pendingNotifications).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect((await list())?.details).toMatchObject({ pendingNotifications: 1, deliveryPaused: true });
    expect(h.userMessages).toHaveLength(1);
    await h.emit("message_end", { message: { role: "user", content: h.userMessages[0] } });
    expect((await list())?.details).toMatchObject({ pendingNotifications: 0, deliveryPaused: false });
    await h.emit("session_shutdown");
  });

  it("consumes a host-queued wake after its branch owner retires, not real user input", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setAcceptWake(false);
    await h.emit("session_start");
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    const text = h.userMessages[0];
    expect(await h.emit("input", { text, source: "extension" })).toBeUndefined();
    await h.emit("session_tree");
    expect(await h.emit("input", { text, source: "extension" })).toEqual({ action: "handled" });
    expect(await h.emit("input", { text, source: "interactive" })).toBeUndefined();
    expect(
      await h.emit("input", { text: "Background process wake [foreign]\\nkeep", source: "extension" }),
    ).toBeUndefined();
    await h.emit("session_shutdown");
    expect(await h.emit("input", { text, source: "extension" })).toEqual({ action: "handled" });
  });

  it("preserves appends but retires monotonically on live divergence before tree callbacks", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    const old = fake.managers[0];
    const tool = h.tools.get("background_list");
    h.setBranch(["root", "append"]);
    await expect(tool?.execute("call", {}, undefined, undefined, h.ctx)).resolves.toBeDefined();
    h.setAcceptWake(false);
    old.emit(event());
    vi.advanceTimersByTime(2000);
    const wake = h.userMessages[0];
    h.setBranch(["root", "different"]);
    h.status.mockClear();
    expect(await h.emit("input", { text: wake, source: "extension" })).toEqual({ action: "handled" });
    expect(old.manager.shutdown).toHaveBeenCalledOnce();
    vi.mocked(old.manager.list).mockClear();
    old.emit(event());
    await h.emit("message_end", { message: { role: "user", content: wake } });
    await h.emit("agent_settled");
    h.setBranch(["root", "append"]); // Returning cannot resurrect the old owner.
    await expect(tool?.execute("call", {}, undefined, undefined, h.ctx)).rejects.toThrow("No active");
    expect(old.manager.list).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("rechecks delivery and UI ownership after a synchronous transcript listener navigates", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    h.setOnMessage(() => {
      h.setBranch(["new-root"]);
      h.status.mockClear();
    });
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(1); // Already persisted messages cannot be retracted.
    expect(h.userMessages).toHaveLength(0);
    expect(h.status).not.toHaveBeenCalled();
    expect(fake.managers[0].manager.shutdown).toHaveBeenCalledOnce();
    await h.emit("session_shutdown");
  });

  it("captures the session manager object, not only its ID and branch IDs", async () => {
    const h = harness();
    await h.emit("session_start");
    Object.defineProperty(h.ctx, "sessionManager", { value: { ...h.ctx.sessionManager } });
    await expect(h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx)).rejects.toThrow(
      "No active",
    );
    expect(fake.managers[0].manager.shutdown).toHaveBeenCalledOnce();
    await h.emit("session_shutdown");
  });

  it("rejects async tool results and retry updates after their captured owner diverges", async () => {
    const h = harness();
    await h.emit("session_start");
    const old = fake.managers[0];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job: JobSnapshot = {
      id: "late",
      command: "true",
      cwd: process.cwd(),
      description: "late",
      status: "running",
      startedAt: 1,
      attention: "off",
      droppedBytes: 0,
    };
    vi.mocked(old.manager.start).mockImplementationOnce(async () => {
      await gate;
      return job;
    });
    h.setWaitForIdle(() => gate);
    const tool = h.tools.get("bash_background")?.execute("call", { command: "true" }, undefined, undefined, h.ctx);
    const retry = h.commands.get("background")?.handler("retry", h.ctx);
    h.setBranch(["other"]);
    h.status.mockClear();
    release();
    await expect(tool).rejects.toThrow("No active");
    await expect(retry).rejects.toThrow("No active");
    expect(h.status).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("does not reopen an older intent after awaiting cleanup", async () => {
    const h = harness();
    await h.emit("session_start");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fake.managers[0].manager.shutdown).mockImplementationOnce(() => gate);
    const opening = h.emit("session_tree");
    const closing = h.emit("session_shutdown");
    release();
    await Promise.all([opening, closing]);
    expect(fake.managers).toHaveLength(1);
    await expect(h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx)).rejects.toThrow(
      "No active",
    );
    await h.emit("session_start");
    expect(fake.managers).toHaveLength(2);
    await h.emit("session_shutdown");
  });

  it("keeps only the latest opening intent and rejects divergence during its cleanup await", async () => {
    const h = harness();
    await h.emit("session_start");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fake.managers[0].manager.shutdown).mockImplementationOnce(() => gate);
    const older = h.emit("session_tree");
    h.setBranch(["new-root"]);
    const newer = h.emit("session_tree");
    release();
    await Promise.all([older, newer]);
    expect(fake.managers).toHaveLength(2);
    await expect(
      h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx),
    ).resolves.toBeDefined();
    let releaseAgain!: () => void;
    const gateAgain = new Promise<void>((resolve) => {
      releaseAgain = resolve;
    });
    vi.mocked(fake.managers[1].manager.shutdown).mockImplementationOnce(() => gateAgain);
    const opening = h.emit("session_tree");
    h.setBranch(["diverged-during-await"]);
    releaseAgain();
    await opening;
    expect(fake.managers).toHaveLength(2);
    await expect(h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx)).rejects.toThrow(
      "No active",
    );
    await h.emit("session_shutdown");
  });

  it("gates cancelled fork preflight without dropping jobs or the outbox; retry resumes once", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    await h.tools.get("bash_background")?.execute("call", { command: "true" }, undefined, undefined, h.ctx);
    await h.emit("session_before_fork");
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    expect(fake.managers[0].manager.shutdown).not.toHaveBeenCalled();
    const before = await h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx);
    expect(before?.details).toMatchObject({
      jobs: [expect.objectContaining({ id: "job-0" })],
      pendingNotifications: 1,
    });
    await h.commands.get("background")?.handler("retry", h.ctx);
    expect(h.userMessages).toHaveLength(1);
    await h.commands.get("background")?.handler("retry", h.ctx);
    expect(h.userMessages).toHaveLength(1);
    await h.emit("session_shutdown");
  });

  it("never draws terminal status in RPC/headless modes", async () => {
    for (const mode of ["rpc", "json", "print"]) {
      const h = harness(mode);
      await h.emit("session_start");
      fake.managers.at(-1)?.emit(event());
      expect(h.status).not.toHaveBeenCalled();
      await h.emit("session_shutdown");
    }
  });

  it("isolates extension factories and rejects foreign session access", async () => {
    const a = harness();
    const b = harness();
    await a.emit("session_start");
    await b.emit("session_start");
    expect(fake.managers[0].manager).not.toBe(fake.managers[1].manager);
    await a.tools.get("bash_background")?.execute("call", { command: "sleep 1" }, undefined, undefined, a.ctx);
    expect(fake.managers[0].manager.list()).toHaveLength(1);
    expect(fake.managers[1].manager.list()).toHaveLength(0);
    a.setSession("another");
    await expect(a.tools.get("background_list")?.execute("call", {}, undefined, undefined, a.ctx)).rejects.toThrow(
      "No active",
    );
    await a.emit("session_shutdown");
    await b.emit("session_shutdown");
  });

  it("validates monitor ownership before doing work", async () => {
    const h = harness();
    await h.emit("session_start");
    const tool = h.tools.get("monitor");
    await expect(tool?.execute("call", { patterns: ["ready"] }, undefined, undefined, h.ctx)).rejects.toThrow(
      "exactly one",
    );
    await expect(
      tool?.execute("call", { id: "job", command: "sleep 1", patterns: ["ready"] }, undefined, undefined, h.ctx),
    ).rejects.toThrow("exactly one");
    await expect(
      tool?.execute("call", { id: "job", cwd: ".", patterns: ["ready"] }, undefined, undefined, h.ctx),
    ).rejects.toThrow("apply only");
    expect(fake.managers[0].manager.start).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("clears pending notices when the model intentionally stops a job", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    await h.tools.get("bash_background")?.execute("call", { command: "sleep 1" }, undefined, undefined, h.ctx);
    fake.managers[0].emit(event());
    await h.tools.get("background_stop")?.execute("call", { id: "job-0" }, undefined, undefined, h.ctx);
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    await h.emit("session_shutdown");
  });
});
