import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

for (const boundary of ["retry", "connect", "replacement", "quit", "quit-replacement"] as const) {
  test.skipIf(process.platform === "win32")(`default Herdr socket transport fences retired ${boundary}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "herdr-wire-"));
    const endpoint = join(cwd, "herdr.sock");
    const previous = {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
      PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    };
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: endpoint,
      HERDR_PANE_ID: "fixture",
      PI_SUBAGENT_CHILD: "0",
    });
    const received: string[] = [];
    const peers: net.Socket[] = [];
    const server = net.createServer((socket) => {
      peers.push(socket);
      socket.on("data", (data) => {
        received.push(data.toString());
        if (boundary === "retry") socket.end();
        else socket.write("ok\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    const sockets: net.Socket[] = [];
    const writes: Array<ReturnType<typeof spyOn>> = [];
    const nativeConnect = net.createConnection;
    let delayedConnect = () => {};
    let stale = false;
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const ctx = {
      mode: "tui",
      isIdle: () => true,
      get sessionManager() {
        if (stale) throw new Error("stale SDK scope");
        return { getSessionId: () => "old" };
      },
    };
    const connect = spyOn(net, "createConnection").mockImplementation(((...args: Parameters<typeof nativeConnect>) => {
      const socket = nativeConnect(...args);
      sockets.push(socket);
      writes.push(spyOn(socket, "write"));
      if (boundary === "retry")
        socket.on("end", () => {
          stale = true;
        });
      if (boundary !== "retry") {
        const emit = socket.emit.bind(socket);
        socket.emit = ((event: string, ...values: unknown[]) => {
          if (event === "connect") {
            delayedConnect = () => {
              emit("connect");
            };
            return true;
          }
          return emit(event, ...values);
        }) as typeof socket.emit;
      }
      return socket;
    }) as typeof nativeConnect);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const nativeTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
      const handle = nativeTimeout(callback, ms, ...args);
      if (ms === 500 || ms === 1500) timeouts.push(handle);
      return handle;
    });
    const clear = spyOn(globalThis, "clearTimeout");
    try {
      // A fresh physical module is needed: Bun ignores query strings in its
      // module cache, while the reporter intentionally snapshots its environment.
      const modulePath = join(cwd, "reporter.ts");
      writeFileSync(modulePath, readFileSync(new URL("../src/index.ts", import.meta.url)));
      const url = pathToFileURL(modulePath);
      const { createReporter } = (await import(url.href)) as typeof import("../src/index.js");
      createReporter({
        on: (name, handler) => {
          handlers.set(name, handler);
        },
      });
      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      for (let i = 0; i < 100 && (boundary === "retry" ? !stale : peers.length === 0); i++) await pause(5);
      assert.equal(sockets.length, 1);
      if (boundary === "retry") {
        await pause(30);
        assert.equal(sockets.length, 1, "invalid owner cannot connect for retry or queued state");
        assert.equal(received.length, 1, "only pre-retirement attempt wrote");
      } else {
        if (boundary === "replacement") {
          await handlers.get("session_start")?.({ reason: "startup" }, { mode: "rpc" });
        } else if (boundary === "quit" || boundary === "quit-replacement") {
          // Retire report socket, then hold the independent quit release connect.
          const quitting = handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
          for (let i = 0; i < 100 && sockets.length < 2; i++) await pause(5);
          assert.equal(sockets.length, 2);
          for (let i = 0; i < 100 && peers.length < 2; i++) await pause(5);
          stale = boundary === "quit-replacement";
          delayedConnect();
          await quitting;
        } else {
          stale = true;
        }
        delayedConnect();
        await pause(30);
        assert.ok(sockets.every((socket) => socket.destroyed));
        if (boundary === "quit") {
          assert.equal(received.length, 1, "quit release survives independent report retirement");
          assert.equal(JSON.parse(received[0]).method, "pane.release_agent");
          assert.equal(writes[0].mock.calls.length, 0);
          assert.equal(writes[1].mock.calls.length, 1);
        } else {
          assert.equal(received.length, 0, "no retired reports or quit release reach replacement authority");
          assert.ok(writes.every((write) => write.mock.calls.length === 0));
        }
      }
      for (const handle of timeouts) assert.equal(clear.mock.calls.filter(([value]) => value === handle).length, 1);
    } finally {
      await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
      connect.mockRestore();
      timer.mockRestore();
      clear.mockRestore();
      for (const socket of sockets) socket.destroy();
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
