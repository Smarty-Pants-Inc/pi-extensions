import { spawn } from "node:child_process";
import * as path from "node:path";
import { CapturedOutput } from "./captured-output.js";
import type { ActionOwnership } from "./owned-custom.js";

const TERM_GRACE_MS = 250;
const WAIT_MS = 1000;
const STARTUP_MS = 5000;

// A separate, detached runtime pins the group ID until escalation. Killing just the
// shell lets TERM-resistant children survive and makes a later negative-PID kill unsafe.
// The snippet cannot write the private IPC channel: it inherits only stdout/stderr.
const supervisor = `
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
const report = (value) => process.send(value);
report('ready');
const child = spawn(COMMAND, ARGS, { stdio: ['ignore', 1, 2] });
child.once('error', () => report(1));
// Match pi.exec's code ?? 0 convention for a shell that exits by signal.
child.once('exit', (code) => report(code === null ? 0 : code));
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function boundedWait(pending: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Own one full-shell invocation, including ordinary background children, until cleanup. */
export async function executeSnippet(
  command: string,
  args: string[],
  cwd: string,
  ownership: ActionOwnership,
  runtime: Pick<NodeJS.Process, "versions" | "execPath"> = process,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
  if (!ownership.isCurrent() || ownership.signal.aborted) return { stdout: "", stderr: "", code: 1, killed: true };
  const windows = process.platform === "win32";
  const source = `const COMMAND = ${JSON.stringify(command)}; const ARGS = ${JSON.stringify(args)};\n${supervisor}`;
  // A compiled Bun executable may be Pi itself, not an eval-capable runtime.
  // Node hosts can reuse execPath; Bun (compiled or not) requires Node on PATH.
  const executable = runtime.versions.bun ? "node" : runtime.execPath;
  const child = spawn(executable, ["-e", source], {
    cwd,
    detached: !windows,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let exited = false;
  let ready = false;
  const stdout = new CapturedOutput("stdout");
  const stderr = new CapturedOutput("stderr");
  let killed = false;
  let settled = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let settle!: (code: number) => void;
  const result = new Promise<number>((resolve) => {
    settle = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
  });
  const fail = (message: string) => {
    if (settled) return;
    stderr.append(Buffer.from(`${stderr.hasOutput && !stderr.endsWithNewline ? "\n" : ""}${message}\n`));
    settle(1);
  };
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      fail("Snippet supervisor exited before completion.");
      resolve();
    });
    child.once("error", (error) => {
      exited = true;
      fail(
        `Could not start snippet supervisor with ${executable}: ${error.message}.${
          runtime.versions.bun ? " Running snippets under Bun requires a Node.js executable (node) on PATH." : ""
        }`,
      );
      resolve();
    });
  });
  const close = new Promise<void>((resolve) => child.once("close", () => resolve()));
  // Keep draining both streams after overflow; backpressure must not stall the
  // shell or prevent cancellation. Each capture retains only a bounded prefix.
  child.stdout?.on("data", (data: Buffer) => stdout.append(data));
  child.stderr?.on("data", (data: Buffer) => stderr.append(data));
  child.on("message", (message: unknown) => {
    if (settled) return;
    if (message === "ready") {
      ready = true;
      clearTimeout(startupTimer);
    } else if (ready && typeof message === "number" && Number.isInteger(message) && message >= 0) settle(message);
  });
  child.once("disconnect", () => fail("Snippet supervisor IPC disconnected before completion."));
  // This deadline bounds helper startup only, not legitimate long-running snippets.
  // Preserve NODE_OPTIONS and the snippet environment, including security options.
  startupTimer = setTimeout(() => {
    fail(
      `Snippet supervisor did not become ready within ${STARTUP_MS} ms. Check the runtime and NODE_OPTIONS (e.g. --inspect-brk).`,
    );
  }, STARTUP_MS);
  const abort = () => {
    killed = true;
    settle(1);
  };
  ownership.signal.addEventListener("abort", abort, { once: true });
  if (ownership.signal.aborted || !ownership.isCurrent()) abort();

  // Never inspect ancestry or signal a historical PID. The detached supervisor is
  // our live group leader, keeps running after the shell exits, and ignores TERM.
  const livePid = () =>
    !exited && child.pid !== undefined && child.pid > 1 && child.pid !== process.pid ? child.pid : undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    const pid = livePid();
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let code: number;
  try {
    code = await result;
  } finally {
    clearTimeout(startupTimer);
    ownership.signal.removeEventListener("abort", abort);
    await cleanup();
  }
  return { stdout: stdout.text(), stderr: stderr.text(), code, killed };

  async function cleanup() {
    try {
      if (windows) {
        const pid = livePid();
        if (pid !== undefined) {
          // Windows has no POSIX groups; pin the parent while taskkill walks its tree.
          try {
            const killer = spawn(
              path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
              ["/PID", String(pid), "/T", "/F"],
              { stdio: "ignore" },
            );
            await boundedWait(
              new Promise<void>((resolve) => {
                killer.once("error", () => resolve());
                killer.once("close", () => resolve());
              }),
            );
            if (killer.exitCode === null) killer.kill();
            killer.unref();
          } catch {
            // Missing/restricted taskkill still permits a direct-parent fallback.
          } finally {
            if (livePid() !== undefined) child.kill("SIGKILL");
          }
        }
      } else {
        if (ready && livePid() !== undefined) {
          signalGroup("SIGTERM");
          await delay(TERM_GRACE_MS);
        }
        // Before ready, only KILL is safe: the TERM handler may not be installed yet.
        signalGroup("SIGKILL");
      }
      await boundedWait(exit);
      await boundedWait(close);
    } finally {
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.connected) child.disconnect();
      child.unref();
    }
  }
}
