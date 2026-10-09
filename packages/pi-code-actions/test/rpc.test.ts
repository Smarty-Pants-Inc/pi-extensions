import { test } from "bun:test";
import assert from "node:assert/strict";
import extension from "../index.js";

test("RPC insertion confirms replacement without reading the client draft; cancel leaves it untouched", async () => {
  let handler: (args: string, ctx: never) => Promise<void> = async () => {};
  extension({
    on: () => () => {},
    exec: async () => ({ stdout: "ran successfully", stderr: "", code: 0 }),
    registerCommand: (_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    },
  } as never);
  const notices: string[] = [];
  let inserted = "client draft";
  let confirmed = false;
  let replacements = 0;
  const confirmations: string[] = [];
  const ctx = {
    mode: "rpc",
    hasUI: true,
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "a",
      getBranch: () => [
        {
          type: "message",
          id: "a",
          timestamp: "",
          message: { role: "assistant", content: "```ts\nconst a = 1;\n```" },
        },
      ],
    },
    ui: {
      custom: () => {
        throw new Error("Unsupported RPC custom UI");
      },
      notify: (message: string) => notices.push(message),
      confirm: async (title: string, message: string) => {
        confirmations.push(`${title}\n${message}`);
        return confirmed;
      },
      // Faithful RPC host: reads always return empty and writes replace, never append.
      getEditorText: () => "",
      setEditorText: (text: string) => {
        replacements += 1;
        inserted = text;
      },
    },
  };
  await handler("", ctx as never);
  assert.match(notices.at(-1) ?? "", /requires TUI/);
  await handler("last insert 1", ctx as never);
  assert.equal(inserted, "client draft");
  assert.equal(replacements, 0);
  assert.match(confirmations[0] ?? "", /replace the entire draft/i);
  assert.match(confirmations[0] ?? "", /cannot read or append/i);
  confirmed = true;
  await handler("last insert 1", ctx as never);
  assert.equal(inserted, "const a = 1;");
  assert.equal(replacements, 1);
  await handler("last run 1", ctx as never);
  assert.match(notices.at(-1) ?? "", /ran successfully/);
});
