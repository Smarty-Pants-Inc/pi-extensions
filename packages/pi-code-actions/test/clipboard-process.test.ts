import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "../src/actions.js";

// Capture the installed implementation through Pi's public extension API.
async function installedExec(cwd: string) {
  let exec: ExtensionAPI["exec"] | undefined;
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    extensionFactories: [
      {
        name: "clipboard-exec-oracle",
        factory: (pi) => {
          exec = pi.exec;
        },
      },
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    noTools: "all",
  });
  assert.ok(exec);
  return { exec, session };
}

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(process.platform === "win32")(
  "installed Pi cancellation of the old pipeline leaves its utility alive",
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "clipboard-pipeline-control-"));
    const utility = path.join(directory, "harmless-utility");
    const log = path.join(directory, "pid.txt");
    const input = path.join(directory, "input.txt");
    const controller = new AbortController();
    let host: Awaited<ReturnType<typeof installedExec>> | undefined;
    let pending: ReturnType<ExtensionAPI["exec"]> | undefined;
    let pid: number | undefined;
    try {
      host = await installedExec(directory);
      writeFileSync(input, "harmless input", { mode: 0o600 });
      writeFileSync(
        utility,
        `#!/usr/bin/env node\n` +
          `const fs = require('node:fs');\n` +
          `fs.readFileSync(0, 'utf8');\n` +
          `fs.writeFileSync(${JSON.stringify(log)}, String(process.pid));\n` +
          `setInterval(() => {}, 1000);\n`,
        { mode: 0o700 },
      );
      pending = host.exec("sh", ["-c", 'cat "$1" | "$2"', "pipeline-control", input, utility], {
        cwd: directory,
        signal: controller.signal,
      });
      await waitFor(() => existsSync(log), "pipeline utility did not start");
      pid = Number(readFileSync(log, "utf8"));
      assert.ok(alive(pid));
      controller.abort();
      const result = await pending;
      assert.equal(result.killed, true);
      assert.ok(alive(pid), "control must reproduce the descendant surviving shell cancellation");
    } finally {
      controller.abort();
      if (pid === undefined && existsSync(log)) pid = Number(readFileSync(log, "utf8"));
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      await pending;
      if (pid !== undefined) await waitFor(() => !alive(pid as number), "control utility survived cleanup");
      host?.session.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

for (const platform of ["darwin", "linux"]) {
  test.skipIf(process.platform === "win32")(
    `${platform} clipboard exec cancellation kills the actual utility, handles quoted paths, and skips fallbacks`,
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "clipboard-process-"));
      const privateRoot = path.join(directory, "private 'quoted' \"double\" space");
      const log = path.join(directory, "utility.jsonl");
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      assert.ok(platformDescriptor);
      const previousPath = process.env.PATH;
      const previousTmpdir = process.env.TMPDIR;
      const controller = new AbortController();
      let pending: Promise<boolean> | undefined;
      let privateFile = "";
      let calls = 0;
      let host: Awaited<ReturnType<typeof installedExec>> | undefined;
      let result: Awaited<ReturnType<ExtensionAPI["exec"]>> | undefined;
      const records = () =>
        existsSync(log)
          ? (readFileSync(log, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)) as Array<{
              pid: number;
              utility: string;
              input?: string;
            }>)
          : [];
      try {
        host = await installedExec(directory);
        const exec = host.exec;
        // Every clipboard name resolves to a harmless temporary utility, never the system clipboard.
        for (const utility of ["pbcopy", "wl-copy", "xclip", "xsel"]) {
          writeFileSync(
            path.join(directory, utility),
            `#!/usr/bin/env node\n` +
              `const fs = require('node:fs');\n` +
              `const log = ${JSON.stringify(log)};\n` +
              `const utility = ${JSON.stringify(utility)};\n` +
              `fs.appendFileSync(log, JSON.stringify({ pid: process.pid, utility }) + '\\n');\n` +
              `const input = fs.readFileSync(0, 'utf8');\n` +
              `fs.appendFileSync(log, JSON.stringify({ pid: process.pid, utility, input }) + '\\n');\n` +
              `setInterval(() => {}, 1000);\n`,
            { mode: 0o700, flag: "wx" },
          );
        }
        // mkdtemp needs an existing parent; this includes spaces and both kinds of quotes.
        mkdirSync(privateRoot, { mode: 0o700 });
        Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
        process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
        process.env.TMPDIR = privateRoot;
        pending = copyToClipboard(
          {
            exec: (command: string, args: string[], options: { signal: AbortSignal }) => {
              calls++;
              privateFile = args.at(-1) ?? "";
              assert.equal(command, "sh");
              assert.equal(args[2], "pi-clipboard");
              assert.equal(args[3], privateFile);
              assert.equal(statSync(path.dirname(privateFile)).mode & 0o777, 0o700);
              assert.equal(statSync(privateFile).mode & 0o777, 0o600);
              return exec(command, args, { ...options, cwd: directory }).then((value) => {
                result = value;
                return value;
              });
            },
          } as never,
          "private transcript; $(not shell code) ' \"",
          { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
        );
        // spawn and private-file creation are synchronous; don't leak fixture environment to other tests.
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        Object.defineProperty(process, "platform", platformDescriptor);
        await waitFor(() => records().some((record) => record.input !== undefined), "utility did not read stdin");
        const record = records().find((entry) => entry.input !== undefined);
        assert.ok(record);
        assert.equal(record.utility, platform === "darwin" ? "pbcopy" : "wl-copy");
        assert.equal(record.input, "private transcript; $(not shell code) ' \"");
        assert.ok(privateFile.startsWith(privateRoot));
        assert.ok(alive(record.pid), "utility must really be stalled before cancellation");
        controller.abort();
        assert.equal(await pending, false);
        assert.equal(result?.killed, true);
        await waitFor(() => !alive(record.pid), "Pi killed only the shell, leaving the clipboard utility alive");
        assert.equal(calls, 1, "cancellation must not start a fallback");
        assert.equal(new Set(records().map(({ utility }) => utility)).size, 1);
        assert.equal(existsSync(path.dirname(privateFile)), false);
      } finally {
        controller.abort();
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        Object.defineProperty(process, "platform", platformDescriptor);
        // Also clean survivors when the regression fails against the old pipeline implementation.
        const pids = new Set(records().map(({ pid }) => pid));
        for (const pid of pids) {
          if (alive(pid)) process.kill(pid, "SIGKILL");
        }
        await pending;
        for (const pid of pids) await waitFor(() => !alive(pid), `fixture process ${pid} survived cleanup`);
        host?.session.dispose();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
}
