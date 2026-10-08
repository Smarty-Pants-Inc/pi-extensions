import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { executableAvailable } from "../src/executable.js";
import githubPr, { runGhPrView } from "../src/github-pr.js";
import { createMockContext, createMockPi } from "./support.js";

for (const host of ["", "git.example.com"]) {
  for (const available of [false, true]) {
    test(`empty failure with GH_HOST=${host || "unset"}, gh available=${available}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "pi-github-pr-path-"));
      const windows = process.platform === "win32";
      const binary = (name: string) => join(root, windows ? `${name}.exe` : name);
      writeFileSync(binary(windows ? "cmd" : "env"), "launcher fixture", { mode: 0o755 });
      if (available) writeFileSync(binary("gh"), "gh fixture", { mode: 0o755 });
      vi.stubEnv("PATH", root);
      vi.stubEnv("GH_HOST", host);
      if (windows) vi.stubEnv("ComSpec", binary("cmd"));
      const mock = createMockPi();
      const exec: ExtensionAPI["exec"] = async (command) => {
        if (command === "git") return new Promise(() => {});
        return { stdout: "", stderr: "", code: 1, killed: false };
      };
      Object.assign(mock.rawPi, { exec });
      githubPr(mock.pi);
      const context = createMockContext({ cwd: root });
      const emit = async (name: string) => {
        for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
      };
      try {
        assert.equal(await executableAvailable("gh", root), available);
        await assert.rejects(
          runGhPrView({ exec }, root),
          available ? /failed \(1\): no output/ : /GitHub CLI not found/,
        );
        await emit("session_start");
        await emit("agent_end");
        assert.equal(context.statuses.get("github-pr"), available ? undefined : "PR gh missing");
        assert.equal(context.notifications.length, 0);
      } finally {
        await emit("session_shutdown");
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("an unavailable GH_HOST launcher is not mistaken for absent gh", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-github-pr-launcher-"));
  vi.stubEnv("PATH", root);
  vi.stubEnv("GH_HOST", "git.example.com");
  vi.stubEnv("ComSpec", join(root, "missing-cmd.exe"));
  try {
    await assert.rejects(
      runGhPrView(
        {
          exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
        },
        root,
      ),
      /failed \(1\): no output/,
    );
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

test("relative PATH entries are resolved against the execution cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-github-pr-relative-"));
  const binary = join(root, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(binary, "fixture", { mode: 0o755 });
  vi.stubEnv("PATH", ".");
  try {
    assert.equal(await executableAvailable("gh", root), true);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
