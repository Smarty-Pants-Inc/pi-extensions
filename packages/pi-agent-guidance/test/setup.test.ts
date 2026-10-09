import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const profile of ["default", "overridden", "tilde", "home-tilde"] as const) {
  test(`setup uses the ${profile} agent directory for guidance and the extension link`, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-guidance-setup-"));
    try {
      const agentDir =
        profile === "default" ? join(root, ".pi/agent") : profile === "home-tilde" ? root : join(root, "profile");
      const env = { ...process.env, HOME: root };
      delete env.PI_CODING_AGENT_DIR;
      if (profile === "overridden") env.PI_CODING_AGENT_DIR = agentDir;
      if (profile === "tilde") env.PI_CODING_AGENT_DIR = "~/profile";
      if (profile === "home-tilde") env.PI_CODING_AGENT_DIR = "~";
      const script = fileURLToPath(new URL("../setup.sh", import.meta.url));
      const result = spawnSync("bash", [script], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(join(agentDir, "AGENTS.md"), "utf8"), /Universal guidelines/);
      assert.equal(
        readlinkSync(join(agentDir, "extensions/agent-guidance.ts")),
        fileURLToPath(new URL("../agent-guidance.ts", import.meta.url)),
      );
      if (profile !== "default") assert.equal(existsSync(join(root, ".pi/agent")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
