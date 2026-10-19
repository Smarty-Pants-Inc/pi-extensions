import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { SUPERVISOR_SOURCE } from "../src/supervisor.js";

it("falls back to one close result when the shell cannot spawn", async () => {
  const child = spawn(process.execPath, ["-e", SUPERVISOR_SOURCE], {
    cwd: tmpdir(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: unknown[] = [];
  child.stdout?.resume();
  child.stderr?.resume();
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  const deadline = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
  }, 3000);
  try {
    child.on("message", (message: unknown) => {
      messages.push(message);
      if (!message || typeof message !== "object" || !("kind" in message)) return;
      if (message.kind === "ready")
        child.send({ kind: "run", command: "true", cwd: "/nonexistent-background-shell-cwd" });
      if (message.kind === "result") child.send({ kind: "release" });
    });
    await closed;
    expect(
      messages.filter(
        (message) => !!message && typeof message === "object" && "kind" in message && message.kind === "result",
      ),
    ).toEqual([expect.objectContaining({ kind: "result", failed: true, code: -2, signal: null })]);
    expect(messages).toContainEqual(
      expect.objectContaining({ kind: "failure", error: expect.stringContaining("ENOENT") }),
    );
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
    await closed;
  }
});
