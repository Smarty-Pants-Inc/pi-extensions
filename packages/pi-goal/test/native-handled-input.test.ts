import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { test } from "vitest";

for (const mode of ["handled", "nonempty"]) {
  test(`native ${mode} real input cannot grant wake authority to an extension follow-up`, async () => {
    const child = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, "support/native-handled-input.mjs"),
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
    assert.match(output, /"status": "PASS"/);
  }, 30_000);
}
