import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ralph from "../index.ts";
import { hasCompletionMarker } from "../ownership.ts";
import { publishLoopState, readLoopState, validateLoopState } from "../state-store.ts";

const valid = {
  name: "valid",
  taskFile: ".ralph/valid.md",
  iteration: 1,
  maxIterations: 5,
  itemsPerIteration: 0,
  reflectEvery: 0,
  reflectInstructions: "Reflect",
  active: true,
  status: "active",
  startedAt: "2026-01-01T00:00:00Z",
  lastReflectionAt: 0,
  ownerSessionId: "owner",
  ownerBranchIds: ["root"],
};

test("invalid state files warn by filename, stay byte-identical, and cannot disable a valid neighbor", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-state-"));
  const events = new Map();
  const commands = new Map();
  const warnings = [];
  const ctx = {
    cwd,
    hasUI: true,
    sessionManager: { getSessionId: () => "owner", getBranch: () => [{ id: "root", type: "custom" }] },
    ui: {
      notify(message, level) {
        if (level === "warning") warnings.push(message);
      },
      setStatus() {},
      setWidget() {},
      theme: { fg: (_color, text) => text, bold: (text) => text },
    },
  };
  const invalidUtf8 = Buffer.from(JSON.stringify({ ...valid, name: "utf8", reflectInstructions: "BROKEN" }));
  invalidUtf8[invalidUtf8.indexOf("BROKEN")] = 0xff;
  const broken = new Map([
    ["truncated", '{"name":'],
    ["null", "null"],
    ["status", JSON.stringify({ ...valid, name: "status", status: "unsafe" })],
    ["empty", ""],
    ["utf8", invalidUtf8],
  ]);
  try {
    const dir = path.join(cwd, ".ralph");
    fs.mkdirSync(dir);
    publishLoopState(path.join(dir, "valid.state.json"), valid);
    for (const [name, text] of broken) fs.writeFileSync(path.join(dir, `${name}.state.json`), text);
    ralph({
      on: (name, handler) => events.set(name, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool() {},
      sendUserMessage() {},
    });
    await events.get("session_start")({}, ctx);
    await commands.get("ralph").handler("list", ctx);
    await commands.get("ralph").handler("start null", ctx);
    for (const [name, text] of broken) {
      const file = path.join(dir, `${name}.state.json`);
      assert.deepEqual(fs.readFileSync(file), Buffer.from(text));
      assert.ok(warnings.some((message) => message.includes(file)));
    }
    assert.equal(readLoopState(path.join(dir, "valid.state.json"), assert.fail).status, "active");
    const next = { ...valid, iteration: 2 };
    publishLoopState(path.join(dir, "valid.state.json"), next);
    assert.equal(readLoopState(path.join(dir, "valid.state.json"), assert.fail).iteration, 2);
    assert.equal(fs.statSync(path.join(dir, "valid.state.json")).mode & 0o777, 0o600);
    assert.equal(
      fs.readdirSync(dir).some((file) => file.endsWith(".tmp")),
      false,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("runtime validation rejects malformed counters/owners without repairing records", () => {
  for (const value of [
    null,
    [],
    { ...valid, iteration: -1 },
    { ...valid, maxIterations: "5" },
    { ...valid, ownerBranchIds: [null] },
    { ...valid, status: "invalid" },
  ])
    assert.equal(validateLoopState(value), undefined);
});

test("only standalone unquoted completion lines outside fenced code are accepted", () => {
  const marker = "<promise>COMPLETE</promise>";
  for (const text of [
    `quoted ${marker}`,
    `> ${marker}`,
    `\`${marker}\``,
    `"${marker}"`,
    ` ${marker}`,
    `\`\`\`xml\n${marker}\n\`\`\``,
    `~~~\n${marker}\n~~~`,
    `\`\`\`\n${marker}`,
  ])
    assert.equal(hasCompletionMarker(text), false, text);
  assert.equal(hasCompletionMarker(`Verified.\n\n${marker}`), true);
});
