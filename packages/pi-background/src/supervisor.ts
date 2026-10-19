/**
 * The detached leader stays alive until release or group SIGKILL. This closes
 * the shell-exits-on-TERM race without signaling a PGID after its leader exits.
 * Descendants that create another session/process group are outside this scope.
 * Kept as plain JavaScript so the helper needs no TypeScript loader at runtime.
 */
export const SUPERVISOR_SOURCE = `
const { spawn } = require("node:child_process");
let launched = false;
let releasing = false;
process.on("SIGTERM", () => {});
process.on("disconnect", () => {
  if (!releasing) process.kill(-process.pid, "SIGKILL");
});
function send(message) {
  if (process.connected) process.send(message);
}
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.kind === "release") {
    if (releasing) return;
    releasing = true;
    // The shell can finish while same-group children with redirected IO remain.
    // Keep the owned leader alive through TERM grace, then kill the entire
    // group. The parent already has the shell result and preserves it.
    process.kill(-process.pid, "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), 300);
    return;
  }
  if (message.kind !== "run" || launched || typeof message.command !== "string") return;
  launched = true;
  let failed = false;
  const shell = spawn("/bin/bash", ["-c", message.command], {
    cwd: message.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  shell.stdout.pipe(process.stdout, { end: false });
  shell.stderr.pipe(process.stderr, { end: false });
  shell.on("spawn", () => send({ kind: "spawned" }));
  shell.on("error", (error) => {
    failed = true;
    send({ kind: "failure", error: error.message });
  });
  let reported = false;
  function result(code, signal) {
    if (reported) return;
    reported = true;
    send({ kind: "result", code, signal, failed });
  }
  // Inherited pipes can outlive the shell indefinitely. Report its exit now,
  // but keep both pipes draining through the pinned leader's group cleanup.
  shell.on("exit", result);
  // A spawn failure has no exit event; close is its sole result fallback.
  shell.on("close", result);
});
send({ kind: "ready" });
`;
