import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { createReporter } from "../src/index.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const boundary of ["poll", "queued", "timers"] as const) {
  test(`actual SDK dispose fences Herdr ${boundary} publication and all owner timers`, async () => {
    assert.equal(VERSION, "1.0.4");
    const cwd = mkdtempSync(join(tmpdir(), "herdr-dispose-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let ctx: ExtensionContext | undefined;
    const requests: unknown[] = [];
    const callbacks: Array<() => void> = [];
    const intervalHandles: ReturnType<typeof setInterval>[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nativeInterval = globalThis.setInterval;
    const intervals = spyOn(globalThis, "setInterval").mockImplementation((handler, ms, ...args) => {
      assert.equal(typeof handler, "function");
      callbacks.push(() => (handler as (...values: unknown[]) => void)(...args));
      const timer = nativeInterval(handler, ms, ...args);
      intervalHandles.push(timer);
      return timer;
    });
    const clears = spyOn(globalThis, "clearInterval");
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const timeoutHandles: ReturnType<typeof setTimeout>[] = [];
    const nativeTimeout = globalThis.setTimeout;
    const timeouts = spyOn(globalThis, "setTimeout").mockImplementation((handler, ms, ...args) => {
      const timer = nativeTimeout(handler, ms, ...args);
      if ([250, 1200, 2800, 4800, 7000].includes(ms ?? 0)) timeoutHandles.push(timer);
      return timer;
    });
    const clearTimeouts = spyOn(globalThis, "clearTimeout");
    let shutdowns = 0;
    const errors: unknown[] = [];
    try {
      const faux = fauxProvider({ provider: "herdr-disposal", models: [{ id: "test" }] });
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          (pi) => {
            createReporter(
              {
                on: (name, handler) => {
                  handlers.set(name, handler);
                  pi.on(name as never, handler as never);
                },
              },
              async (request) => {
                requests.push(request);
                if (boundary === "queued" && requests.length === 1) await gate;
              },
            );
            pi.on("session_start", (_event, context) => {
              ctx = context;
            });
            pi.on("session_shutdown", () => {
              shutdowns++;
            });
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const registry = new ModelRegistry(runtime);
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime,
        modelRegistry: registry,
        model: registry.find("herdr-disposal", "test"),
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [],
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      }));
      await session.bindExtensions({ mode: "tui", uiContext: {} as never, onError: (error) => errors.push(error) });
      await flush();
      assert.equal(requests.length, boundary === "queued" ? 1 : 2);
      assert.equal(intervalHandles.length, 1);
      if (boundary === "timers") {
        await handlers.get("session_start")?.({ reason: "resume" }, ctx);
        await handlers.get("agent_settled")?.({}, ctx);
        await flush();
        assert.equal(timeoutHandles.length, 5, "four session reassertions and one idle debounce");
      }
      const before = requests.length;
      session.dispose();
      assert.equal(shutdowns, 0);
      assert.throws(() => ctx?.sessionManager, /stale/);
      // Exercise the actual captured poll callback, including forced heartbeat.
      if (boundary === "queued") {
        // The serialized transport continuation itself must detect invalidation,
        // without relying on a poll/shutdown handler running first.
        release();
        await flush();
      } else {
        callbacks.at(-1)?.();
        callbacks.at(-1)?.();
        release();
        await flush();
      }
      for (const callback of callbacks) for (let i = 0; i < 10; i++) callback();
      await flush();
      assert.equal(requests.length, before, "no cached heartbeat or queued state after disposal");
      for (const handle of intervalHandles)
        assert.equal(clears.mock.calls.filter(([timer]) => timer === handle).length, 1);
      for (const handle of timeoutHandles)
        assert.equal(clearTimeouts.mock.calls.filter(([timer]) => timer === handle).length, 1);
      assert.deepEqual(errors, []);
    } finally {
      release();
      session?.dispose();
      for (const timer of intervalHandles) clearInterval(timer);
      intervals.mockRestore();
      clears.mockRestore();
      for (const timer of timeoutHandles) clearTimeout(timer);
      timeouts.mockRestore();
      clearTimeouts.mockRestore();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
