import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { AnalyticsRunFiles } from "../src/storage/files.js";
import type { SettledRun } from "../src/types.js";

const record = (id: string): SettledRun => ({
  id,
  startedAtMs: 1,
  finishedAtMs: 2,
  durationMs: 1,
  triggerSource: "interactive",
  outcome: "success",
  attemptCount: 1,
  generations: [],
  tools: [],
  skills: [],
  providerErrors: [],
  toolErrorCount: 0,
  providerErrorCount: 0,
  recoveredErrorCount: 0,
});

for (const crash of [false, true]) {
  test(`two processes initialize without exposing an empty marker${crash ? ", including a crashed publisher" : ""}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "analytics-publication-"));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const modulePath = fileURLToPath(new URL("../src/storage/files.ts", import.meta.url));
    const start = (id: string, blocked: boolean) => {
      const child = spawn("bun", [
        "--eval",
        `import { AnalyticsRunFiles } from ${JSON.stringify(modulePath)};
         const files = new AnalyticsRunFiles(${JSON.stringify(root)}, ${
           blocked
             ? `{ beforeInitialMarkerWrite: async () => {
           process.stdout.write("ready\\n");
           await new Promise(resolve => process.stdin.once("data", resolve));
           process.stdin.pause();
         } }`
             : "{}"
});
         await files.append(${JSON.stringify(record(id))});
         await files.close();`,
      ]);
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const done = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => {
          if (code === 0 || (crash && id === "left" && signal === "SIGKILL")) resolve();
          else reject(new Error(`writer ${id} failed: ${code}/${signal}: ${stderr}`));
        });
      });
      return { child, done };
    };
    const left = start("left", true);
    t.onTestFinished(() => {
      left.child.kill("SIGKILL");
    });
    await Promise.race([
      new Promise<void>((resolve) => left.child.stdout.once("data", () => resolve())),
      left.done.then(() => {
        throw new Error("publisher exited before fixture gate");
      }),
    ]);
    const temporary = (await readdir(root)).find((name) => name.startsWith(".current."));
    assert.ok(temporary);
    assert.equal(await readFile(path.join(root, temporary), "utf8"), "", "gate pauses before writing private temp");
    await assert.rejects(stat(path.join(root, "current")), { code: "ENOENT" });
    if (crash) {
      left.child.kill("SIGKILL");
      await left.done;
    }
    const right = start("right", false);
    t.onTestFinished(() => {
      right.child.kill("SIGKILL");
    });
    await right.done;
    const marker = await readFile(path.join(root, "current"), "utf8");
    assert.match(marker, /^[0-9a-f-]{36}\n$/);
    if (!crash) {
      left.child.stdin.write("continue");
      await left.done;
    }
    const reader = new AnalyticsRunFiles(root);
    const ids: string[] = [];
    for await (const run of reader.read()) ids.push(run.id);
    await reader.close();
    assert.deepEqual(ids.sort(), crash ? ["right"] : ["left", "right"]);
    assert.equal(await readFile(path.join(root, "current"), "utf8"), marker, "late publisher never replaces winner");
    assert.equal((await stat(path.join(root, "current"))).mode & 0o777, 0o600);
    assert.equal((await readdir(root)).filter((name) => name.endsWith(".tmp")).length, crash ? 1 : 0);
    // A private crash residue is ignored; an actually malformed canonical marker isn't.
    await writeFile(path.join(root, "current"), "");
    await assert.rejects(new AnalyticsRunFiles(root).append(record("bad")), /generation marker is invalid/);
  }, 10_000);
}

test("failed private marker initialization cleans only its temporary file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "analytics-publication-failure-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const files = new AnalyticsRunFiles(root, {
    async beforeInitialMarkerWrite() {
      throw new Error("interrupted initialization");
    },
  });
  await assert.rejects(files.append(record("failed")), /interrupted initialization/);
  assert.deepEqual(await readdir(root), ["generations"]);
  const healthy = new AnalyticsRunFiles(root);
  await healthy.append(record("recovered"));
  await files.close();
  await healthy.close();
});
