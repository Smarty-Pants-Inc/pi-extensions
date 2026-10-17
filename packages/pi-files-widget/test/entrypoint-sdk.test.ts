import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionCommandContext,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayText } from "@signalridge/pi-ui";
import type { BrowserController } from "../browser.js";
import { POLL_INTERVAL_MS } from "../constants.js";
import editorExtension from "../index.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

for (const boundary of [
  "comment-idle",
  "comment-queued",
  "dispose",
  "async-dispose",
  "print",
  "rpc",
  "print-barrier",
  "rpc-barrier",
] as const) {
  test.skipIf(process.platform === "win32")(`files entrypoint owns ${boundary} with a retained SDK UI`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "files-entry-"));
    const agentDir = join(cwd, "agent");
    const bin = join(agentDir, "bin");
    mkdirSync(bin, { recursive: true });
    for (const command of ["bat", "delta", "glow"])
      writeFileSync(join(bin, command), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const name = "file-\u001b]52;c;secret\u0007-雪\\tail .txt";
    writeFileSync(join(cwd, name), "source unchanged\nsecond");
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const previousPath = process.env.PATH;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let ctx: ExtensionContext | undefined;
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    let browser: BrowserController | undefined;
    let renders = 0;
    let uiWrites = 0;
    let shutdowns = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blockStart = false;
    let enteredStart = false;
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let rebinding: Promise<void> | undefined;
    let reading = false;
    const nativeRead = fsPromises.readFile;
    const read = spyOn(fsPromises, "readFile").mockImplementation((async (...args: Parameters<typeof nativeRead>) => {
      const result = await nativeRead(...args);
      if (boundary === "async-dispose" && args[0] === join(cwd, name)) {
        reading = true;
        await gate;
      }
      return result;
    }) as typeof nativeRead);
    const exec = spyOn(childProcess, "execFileSync");
    const intervalCallbacks: Array<() => void> = [];
    const intervalHandles: ReturnType<typeof setInterval>[] = [];
    const nativeInterval = globalThis.setInterval;
    const intervals = spyOn(globalThis, "setInterval").mockImplementation((callback, ms, ...args) => {
      if (ms === POLL_INTERVAL_MS && typeof callback === "function") intervalCallbacks.push(() => callback(...args));
      const timer = nativeInterval(callback, ms, ...args);
      intervalHandles.push(timer);
      return timer;
    });
    const clears = spyOn(globalThis, "clearInterval");
    const messages: string[] = [];
    const notices: string[] = [];
    const errors: unknown[] = [];
    try {
      if (boundary.endsWith("-barrier")) {
        childProcess.execFileSync("git", ["init", "-q"], { cwd });
        childProcess.execFileSync("git", ["add", "--", name], { cwd });
      }
      const faux = fauxProvider({ provider: "files-entry", models: [{ id: "test" }] });
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
            // Public SDK mode changes before awaited handlers reach this package.
            pi.on("session_start", async () => {
              if (!blockStart) return;
              enteredStart = true;
              await startGate;
            });
            const register = pi.registerCommand.bind(pi);
            pi.registerCommand = (name, command) => {
              if (name === "readfiles") handler = command.handler;
              register(name, command);
            };
            pi.sendUserMessage = (message) => {
              messages.push(message);
            };
            editorExtension(pi);
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
        model: registry.find("files-entry", "test"),
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [],
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      }));
      await session.bindExtensions({
        mode: "tui",
        uiContext: {
          notify: (text: string) => {
            notices.push(text);
            uiWrites++;
          },
          custom: async (factory: (...args: unknown[]) => BrowserController) => {
            uiWrites++;
            browser = factory(
              {
                requestRender: () => {
                  renders++;
                },
              },
              theme,
              {},
              () => {
                uiWrites++;
              },
            );
          },
        } as never,
        onError: (error) => errors.push(error),
      });
      assert.ok(ctx && handler);
      // Force both delivery branches while preserving all public SDK ownership getters.
      const commandCtx = Object.create(ctx) as ExtensionCommandContext;
      Object.defineProperty(commandCtx, "isIdle", { value: () => boundary !== "comment-queued" });
      await handler("", commandCtx);
      assert.ok(browser);
      for (
        let i = 0;
        i < 100 &&
        !(boundary === "async-dispose"
          ? reading
          : browser.render(200).some((line) => line.includes(sanitizeDisplayText(name))));
        i++
      )
        await pause(10);
      if (boundary.startsWith("comment")) {
        browser.handleInput("/");
        browser.handleInput("file-");
        browser.handleInput("\r");
        browser.handleInput("\r");
        browser.handleInput("v");
        browser.handleInput("c");
        browser.handleInput("comment");
        browser.handleInput("\u0004");
        assert.equal(messages.length, 1);
        assert.ok(messages[0].includes(name), "model message preserves original path bytes");
        assert.ok(messages[0].includes("source unchanged"));
        assert.equal(notices.length, 1);
        assert.ok(notices[0].includes(sanitizeDisplayText(name)));
        assert.ok(!notices[0].includes("\u001b") && !notices[0].includes("\u0007"));
      } else {
        const before = { renders, uiWrites, exec: exec.mock.calls.length };
        if (boundary.endsWith("-barrier")) {
          const manager = commandCtx.sessionManager;
          blockStart = true;
          rebinding = session.bindExtensions({ mode: boundary === "print-barrier" ? "print" : "rpc" });
          for (let i = 0; i < 100 && !enteredStart; i++) await pause(5);
          assert.equal(enteredStart, true);
          assert.equal(commandCtx.mode, boundary === "print-barrier" ? "print" : "rpc");
          assert.equal(commandCtx.sessionManager, manager, "identity is unchanged before our lifecycle handler");
        } else if (boundary === "print" || boundary === "rpc") await session.bindExtensions({ mode: boundary });
        else session.dispose();
        assert.equal(shutdowns, 0);
        if (boundary === "dispose" || boundary === "async-dispose")
          assert.throws(() => commandCtx.sessionManager, /stale/);
        release();
        if (boundary === "async-dispose") {
          // Completion itself must detect disposal, with no poll/render helping.
          await pause(120);
        } else {
          for (const callback of intervalCallbacks) callback();
          await pause(120);
        }
        assert.deepEqual(browser.render(200), []);
        const readsBefore = read.mock.calls.length;
        for (const input of ["u", "\r", "v", "c", "comment", "\u0004", "q"]) browser.handleInput(input);
        await pause(30);
        assert.equal(read.mock.calls.length, readsBefore, "retained callbacks do not start file work");
        assert.equal(messages.length, 0);
        assert.equal(notices.length, 0);
        assert.deepEqual(
          { renders, uiWrites, exec: exec.mock.calls.length },
          before,
          "no ambient render or Git effects through retained host",
        );
        assert.equal(clears.mock.calls.filter(([timer]) => timer === intervalHandles[0]).length, 1);
      }
      assert.deepEqual(errors, []);
    } finally {
      releaseStart();
      await rebinding;
      release();
      browser?.dispose();
      session?.dispose();
      for (const timer of intervalHandles) clearInterval(timer);
      read.mockRestore();
      exec.mockRestore();
      intervals.mockRestore();
      clears.mockRestore();
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
