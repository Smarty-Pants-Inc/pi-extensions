import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { environmentValue, mergeEnvironment, resolveCommandPath } from "./command.js";
import { LspClient } from "./lsp-client.js";
import type { LspServerAdapter } from "./types.js";

// Ownership records only, not a pool: every invocation still creates its own client.
// Concurrent active calls are allowed; terminating/unconfirmed children guard the
// same actual launcher, adapter and workspace across diagnostics and fix calls.
const leases = new Map<string, Set<LspClient>>();

export async function acquireClient(adapter: LspServerAdapter, root: string, timeoutMs: number) {
  const cwd = canonicalPath(root);
  const environment = mergeEnvironment(adapter.env);
  const configured = adapter.defaultCommand;
  const launcher = resolveCommandPath(
    configured.command,
    cwd,
    process.platform,
    environmentValue(environment, "PATH", process.platform) ?? "",
  );
  const command = {
    command: launcher ? canonicalPath(launcher) : configured.command,
    args: [...configured.args],
  };
  // Do not retain plaintext environment secrets in the ownership index. Identity
  // and spawn use the same effective snapshot, including inherited variables.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        cwd,
        adapter.name,
        command.command,
        command.args,
        Object.entries(environment)
          .map(([name, value]) => [process.platform === "win32" ? name.toUpperCase() : name, value])
          .sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
  for (;;) {
    // No await between checking ALL current owners and registering a new lease.
    // Active siblings do not block admission. After any wait, restart the scan:
    // an earlier active owner may have begun (or failed) cleanup meanwhile.
    const pending: Promise<void>[] = [];
    for (const owner of leases.get(key) ?? []) {
      const termination = owner.waitForTermination();
      if (termination) pending.push(termination);
    }
    if (pending.length === 0) break;
    await Promise.all(pending);
  }
  const client = new LspClient(adapter, command, cwd, timeoutMs, environment);
  const owners = leases.get(key) ?? new Set<LspClient>();
  owners.add(client);
  leases.set(key, owners);
  const releaseWhenClosed = () => {
    // Capture this child's close promise, never a PID or a cleanup-failure promise.
    void client.whenClosed().then(() => {
      owners.delete(client);
      if (owners.size === 0 && leases.get(key) === owners) leases.delete(key);
    });
  };
  return { client, releaseWhenClosed };
}

function canonicalPath(file: string) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}
