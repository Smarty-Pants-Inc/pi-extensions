import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { test } from "vitest";

for (const mode of [
  "async-extension-before-handled",
  "idle-extension-before-handled",
  "async-extension-control",
  "idle-extension-control",
]) {
  test(`native asynchronous input hooks preserve wait authority: ${mode}`, async () => {
    const child = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, "support/native-async-input.mjs"),
        resolve(import.meta.dirname, "../src/goal.ts"),
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    assert.equal(code, 0, output);
    assert.match(output, /"status":"PASS"/);
  }, 30_000);
}
