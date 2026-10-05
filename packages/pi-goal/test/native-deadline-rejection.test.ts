import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { test } from "vitest";

for (const mode of ["deadline", "real-input"] as const) {
  test(`native RPC ${mode} preflight rejection preserves the restored wait`, async () => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "support/native-rejection-rpc.mjs"), mode], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Record<string, unknown>[] = [];
    let stdout = "";
    let stderr = "";
    let wake: (() => void) | undefined;
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    child.stdout.on("data", (data) => {
      stdout += String(data);
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          messages.push(JSON.parse(line));
        } catch {
          /* Non-protocol startup output is retained below. */
        }
        newline = stdout.indexOf("\n");
      }
      wake?.();
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
      wake?.();
    });
    child.once("exit", () => wake?.());
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 15_000;
      while (!predicate()) {
        assert.equal(child.exitCode, null, stderr);
        assert.ok(Date.now() < deadline, `native RPC timed out: ${stderr}; ${JSON.stringify(messages)}`);
        await new Promise<void>((done) => {
          wake = done;
          setTimeout(done, 20);
        });
      }
    };
    const command = async (id: string, message: string) => {
      child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
      await until(() => messages.some((item) => item.id === id && item.type === "response"));
      return messages.find((item) => item.id === id && item.type === "response");
    };
    const snapshot = async (id: string) => {
      await command(id, "/wait-state");
      const event = messages
        .filter(
          (item) =>
            item.type === "message_end" && (item.message as { customType?: string })?.customType === "wait-state",
        )
        .at(-1);
      assert.ok(event);
      return JSON.parse((event.message as { content: string }).content).goal;
    };
    try {
      await until(() => stderr.includes("RPC_READY"));
      if (mode === "deadline") {
        await until(() =>
          messages.some((item) => item.type === "extension_error" && item.event === "send_user_message"),
        );
      }
      const before = await snapshot("snapshot-before");
      assert.equal(before.id, "original-wait-id");
      assert.equal(before.status, "paused");
      assert.equal(before.wait.reason, "awaiting review");
      assert.equal(before.wait.resumeAt < Date.now(), mode === "deadline");
      assert.equal(before.tokensUsed, 7);
      assert.equal(before.timeUsedSeconds, 9);
      assert.equal(before.iteration, 3);
      assert.equal(before.automaticModelTurns, 4);
      const rejected = await command("rejected-real-input", "review ready");
      assert.equal(rejected?.success, false, "real RPC prompt must fail native no-model preflight");
      assert.match(String(rejected?.error), /model/i);
      assert.deepEqual(await snapshot("snapshot-after"), before, "original ID, exact deadline and accounting survive");
      assert.equal(messages.filter((item) => item.type === "agent_start").length, 0);
    } finally {
      child.stdin.end();
      assert.equal(await exited, 0, stderr);
    }
  }, 30_000);
}
