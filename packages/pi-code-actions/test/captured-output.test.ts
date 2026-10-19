import { test } from "bun:test";
import assert from "node:assert/strict";
import { CAPTURE_BYTES_PER_STREAM, CapturedOutput } from "../src/captured-output.js";

test("exactly the per-stream byte limit is not overflow", () => {
  const output = new CapturedOutput("stdout");
  output.append(Buffer.alloc(CAPTURE_BYTES_PER_STREAM, "x"));
  output.append(Buffer.alloc(0));
  assert.equal(output.text(), "x".repeat(CAPTURE_BYTES_PER_STREAM));
});

test("streams decode fragmented UTF-8 independently without a loss notice", () => {
  const stdout = new CapturedOutput("stdout");
  const stderr = new CapturedOutput("stderr");
  const out = Buffer.from("α🙂");
  const err = Buffer.from("β界");
  for (let i = 0; i < Math.max(out.length, err.length); i++) {
    stdout.append(out.subarray(i, i + 1));
    stderr.append(err.subarray(i, i + 1));
  }
  assert.equal(stdout.text(), "α🙂");
  assert.equal(stderr.text(), "β界");
});

test("ordinary incomplete UTF-8 at EOF retains normal decoder behavior", () => {
  const stderr = new CapturedOutput("stderr");
  stderr.append(Buffer.from([0x61, 0xf0, 0x9f]));
  assert.equal(stderr.text(), "a�");
});

test("invalid UTF-8 replacement expansion also stays within the decoded byte budget", () => {
  const stderr = new CapturedOutput("stderr");
  stderr.append(Buffer.alloc(CAPTURE_BYTES_PER_STREAM, 0xff));
  const text = stderr.text();
  const [preview, notice] = text.split("\n");
  assert.ok(Buffer.byteLength(preview) <= CAPTURE_BYTES_PER_STREAM);
  assert.equal(preview, "�".repeat(Math.floor(CAPTURE_BYTES_PER_STREAM / 3)));
  assert.match(notice, /stderr truncated/);
});
