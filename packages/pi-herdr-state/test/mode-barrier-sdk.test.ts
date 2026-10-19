import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const boundary of ["print-connect", "rpc-connect", "print-retry", "rpc-poll", "print-quit", "rpc-quit"] as const) {
  test.skipIf(process.platform === "win32")(
    `live SDK ${boundary} retires actual sockets before our lifecycle`,
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "herdr-mode-sdk-"));
      const agentDir = join(cwd, "agent");
      mkdirSync(agentDir);
      const endpoint = join(cwd, "herdr.sock");
      const previous = {
        HERDR_ENV: process.env.HERDR_ENV,
        HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
        HERDR_PANE_ID: process.env.HERDR_PANE_ID,
        PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      };
      Object.assign(process.env, {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: endpoint,
        HERDR_PANE_ID: "fixture",
        PI_SUBAGENT_CHILD: "0",
        PI_CODING_AGENT_DIR: agentDir,
      });
      const received: string[] = [];
      const peers: net.Socket[] = [];
      const server = net.createServer((socket) => {
        peers.push(socket);
        socket.on("data", (data) => {
          received.push(data.toString());
          if (boundary !== "print-retry") socket.write("ok\n");
        });
      });
      await new Promise<void>((resolve) => server.listen(endpoint, resolve));
      const sockets: net.Socket[] = [];
      const writes: Array<ReturnType<typeof spyOn>> = [];
      const delayedConnects: Array<() => void> = [];
      const nativeConnect = net.createConnection;
      const connect = spyOn(net, "createConnection").mockImplementation(((
        ...args: Parameters<typeof nativeConnect>
      ) => {
        const socket = nativeConnect(...args);
        sockets.push(socket);
        writes.push(spyOn(socket, "write"));
        if (boundary.endsWith("connect") || boundary.endsWith("quit")) {
          const emit = socket.emit.bind(socket);
          socket.emit = ((event: string, ...values: unknown[]) => {
            if (event === "connect") {
              delayedConnects.push(() => emit("connect"));
              return true;
            }
            return emit(event, ...values);
          }) as typeof socket.emit;
        }
        return socket;
      }) as typeof nativeConnect);
      const timeoutHandles: ReturnType<typeof setTimeout>[] = [];
      const attemptCallbacks: Array<() => void> = [];
      const nativeTimeout = globalThis.setTimeout;
      const timeouts = spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
        const handle = nativeTimeout(callback, ms, ...args);
        if (ms === 500 || ms === 1500) {
          timeoutHandles.push(handle);
          if (typeof callback === "function") attemptCallbacks.push(() => callback(...args));
        }
        return handle;
      });
      const clearTimeouts = spyOn(globalThis, "clearTimeout");
      const intervalHandles: ReturnType<typeof setInterval>[] = [];
      const pollCallbacks: Array<() => void> = [];
      const nativeInterval = globalThis.setInterval;
      const intervals = spyOn(globalThis, "setInterval").mockImplementation((callback, ms, ...args) => {
        const handle = nativeInterval(callback, ms, ...args);
        intervalHandles.push(handle);
        if (typeof callback === "function") pollCallbacks.push(() => callback(...args));
        return handle;
      });
      const clearIntervals = spyOn(globalThis, "clearInterval");
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      let ctx: ExtensionContext | undefined;
      let shutdown: ((...args: unknown[]) => void | Promise<void>) | undefined;
      let blockStart = false;
      let enteredStart = false;
      let releaseStart = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      let rebinding: Promise<void> | undefined;
      let quitting: void | Promise<void>;
      const errors: unknown[] = [];
      try {
        // The production transport snapshots environment; load a physical copy.
        const modulePath = join(cwd, "reporter.ts");
        writeFileSync(modulePath, readFileSync(new URL("../src/index.ts", import.meta.url)));
        const { createReporter } = (await import(pathToFileURL(modulePath).href)) as typeof import("../src/index.js");
        const faux = fauxProvider({ provider: "herdr-mode", models: [{ id: "test" }] });
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
              pi.on("session_start", async () => {
                if (!blockStart) return;
                enteredStart = true;
                await gate;
              });
              createReporter({
                on: (name, handler) => {
                  if (name === "session_shutdown") shutdown = handler;
                  pi.on(name as never, handler as never);
                },
              });
              pi.on("session_start", (_event, context) => {
                ctx = context;
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
          model: registry.find("herdr-mode", "test"),
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd),
          tools: [],
          settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        }));
        await session.bindExtensions({ mode: "tui", uiContext: {} as never, onError: (error) => errors.push(error) });
        for (
          let i = 0;
          i < 100 &&
          (boundary.endsWith("connect") || boundary.endsWith("quit")
            ? delayedConnects.length === 0
            : received.length < (boundary === "rpc-poll" ? 2 : 1));
          i++
        )
          await pause(5);
        assert.ok(ctx);
        const manager = ctx.sessionManager;
        if (boundary.endsWith("quit")) {
          quitting = shutdown?.({ reason: "quit" }, ctx);
          for (let i = 0; i < 100 && delayedConnects.length < 2; i++) await pause(5);
          assert.equal(sockets.length, 2, "quit release owns a separate actual socket");
          assert.equal(sockets[0].destroyed, true, "report retirement cannot own the release socket");
        }
        const before = {
          connections: sockets.length,
          writes: writes.map((write) => write.mock.calls.length),
          reports: received.length,
        };
        blockStart = true;
        const mode = boundary.startsWith("print") ? "print" : "rpc";
        rebinding = session.bindExtensions({ mode });
        await flush();
        assert.equal(enteredStart, true);
        assert.equal(ctx.mode, mode, "public mode is live while an earlier handler is awaited");
        assert.equal(ctx.sessionManager, manager, "identity has not changed or thrown");
        // No reporter lifecycle handler has run. A retained socket callback,
        // attempt deadline/retry continuation or heartbeat must retire the owner.
        if (boundary.endsWith("connect") || boundary.endsWith("quit"))
          for (const callback of delayedConnects) callback();
        else if (boundary === "print-retry") attemptCallbacks[0]();
        else pollCallbacks[0]();
        await quitting;
        for (const callback of pollCallbacks) {
          callback();
          callback();
        }
        await flush();
        await pause(20);
        assert.ok(sockets.every((socket) => socket.destroyed));
        assert.deepEqual(
          {
            connections: sockets.length,
            writes: writes.map((write) => write.mock.calls.length),
            reports: received.length,
          },
          before,
          "no late write, retry connection, queued state or heartbeat",
        );
        for (const handle of timeoutHandles)
          assert.equal(clearTimeouts.mock.calls.filter(([value]) => value === handle).length, 1);
        for (const handle of intervalHandles)
          assert.equal(clearIntervals.mock.calls.filter(([value]) => value === handle).length, 1);
        assert.deepEqual(errors, []);
      } finally {
        releaseStart();
        await rebinding;
        await shutdown?.({ reason: "reload" }, ctx);
        session?.dispose();
        for (const socket of sockets) socket.destroy();
        for (const socket of peers) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const handle of timeoutHandles) clearTimeout(handle);
        for (const handle of intervalHandles) clearInterval(handle);
        connect.mockRestore();
        timeouts.mockRestore();
        clearTimeouts.mockRestore();
        intervals.mockRestore();
        clearIntervals.mockRestore();
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
}
