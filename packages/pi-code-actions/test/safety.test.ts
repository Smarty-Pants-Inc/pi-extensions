import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "../src/actions.js";
import type { Snippet } from "../src/snippets.js";
import { pickSnippet } from "../src/ui.js";

function ownership() {
  const controller = new AbortController();
  return { controller, signal: controller.signal, isCurrent: () => !controller.signal.aborted };
}

function clipboardPath(args: string[]): string {
  const file = process.platform === "win32" ? args.at(-1)?.match(/"([^"]+)"/)?.[1] : args.at(-1);
  assert.ok(file);
  return file;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("concurrent clipboard copies use isolated private files and clean up after success", async () => {
  const first = gate();
  const second = gate();
  const files: string[] = [];
  const contents: string[] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      const file = clipboardPath(args);
      files.push(file);
      contents.push(readFileSync(file, "utf8"));
      if (process.platform !== "win32") {
        assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
        assert.equal(statSync(file).mode & 0o777, 0o600);
      }
      await (files.length === 1 ? first.promise : second.promise);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const copyingFirst = copyToClipboard(pi as never, "private transcript one", ownership());
  const copyingSecond = copyToClipboard(pi as never, "private transcript two", ownership());
  assert.equal(files.length, 2);
  assert.notEqual(path.dirname(files[0] ?? ""), path.dirname(files[1] ?? ""));
  assert.deepEqual(contents, ["private transcript one", "private transcript two"]);
  first.release();
  assert.equal(await copyingFirst, true);
  assert.equal(existsSync(path.dirname(files[0] ?? "")), false);
  assert.equal(existsSync(files[1] ?? ""), true);
  second.release();
  assert.equal(await copyingSecond, true);
  assert.equal(existsSync(path.dirname(files[1] ?? "")), false);
});

test("clipboard rejection, nonzero exit, and killed zero exit clean up without reporting success", async () => {
  for (const { rejects, code, killed } of [
    { rejects: true, code: 1, killed: false },
    { rejects: false, code: 1, killed: false },
    { rejects: false, code: 0, killed: true },
  ]) {
    const files: string[] = [];
    const ok = await copyToClipboard(
      {
        exec: async (_command: string, args: string[]) => {
          const file = clipboardPath(args);
          files.push(file);
          assert.equal(readFileSync(file, "utf8"), "private transcript");
          if (rejects) throw new Error("clipboard unavailable");
          return { code, stdout: "", stderr: "", killed };
        },
      } as never,
      "private transcript",
      ownership(),
    );
    assert.equal(ok, false);
    assert.ok(files.length > 0);
    for (const file of files) assert.equal(existsSync(path.dirname(file)), false);
  }
});

test("Linux clipboard fallback utilities use fixed exec code with the private path as an argument", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  try {
    for (const successAt of [1, 2]) {
      const scripts = [
        'exec wl-copy < "$1"',
        'exec xclip -selection clipboard < "$1"',
        'exec xsel --clipboard --input < "$1"',
      ];
      let calls = 0;
      let file = "";
      const result = await copyToClipboard(
        {
          exec: async (command: string, args: string[]) => {
            file = clipboardPath(args);
            assert.equal(command, "sh");
            assert.deepEqual(args, ["-c", scripts[calls], "pi-clipboard", file]);
            const code = calls++ === successAt ? 0 : 1;
            return { code, stdout: "", stderr: "", killed: false };
          },
        } as never,
        "private transcript",
        ownership(),
      );
      assert.equal(result, true);
      assert.equal(calls, successAt + 1);
      assert.equal(existsSync(path.dirname(file)), false);
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("raw, CSI-u, and shifted Kitty printable keys apply the same snippet filter", async () => {
  const snippets = [
    { id: 0, type: "block", language: "ts", content: "zulu", sourceLabel: "now", messageId: "a" },
    { id: 1, type: "block", language: "ts", content: "Abacus", sourceLabel: "now", messageId: "b" },
  ] as Snippet[];
  for (const input of ["A", "\u001b[65u", "\u001b[97:65;2u"]) {
    const renders: string[] = [];
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
          let result: unknown;
          const component = await factory(
            { requestRender() {} } as never,
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
            {} as never,
            (value) => {
              result = value;
            },
          );
          component.handleInput?.(input);
          renders.push(component.render(140).join("\n"));
          component.handleInput?.("\r");
          return result;
        },
      },
    };
    const picked = await pickSnippet(ctx as never, snippets, ownership());
    assert.equal(picked?.snippet.content, "Abacus");
    assert.match(renders[0] ?? "", /Filter: A/);
    assert.doesNotMatch(renders[0] ?? "", /zulu/);
  }
});

for (const rejects of [true, false]) {
  test(`clipboard cancellation settles a stalled utility and skips Linux fallbacks (${rejects ? "reject" : "exit"})`, async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(platform);
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    const owner = ownership();
    let file = "";
    let calls = 0;
    try {
      const pending = copyToClipboard(
        {
          exec: (_command: string, args: string[], options: { signal: AbortSignal }) => {
            calls++;
            assert.equal(options.signal, owner.signal);
            file = clipboardPath(args);
            assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
            assert.equal(statSync(file).mode & 0o777, 0o600);
            return new Promise((resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => {
                  if (rejects) reject(new Error("cancelled clipboard utility"));
                  else resolve({ code: 1, stdout: "", stderr: "", killed: true });
                },
                { once: true },
              );
            });
          },
        } as never,
        "private transcript",
        owner,
      );
      assert.equal(calls, 1);
      assert.equal(existsSync(file), true);
      owner.controller.abort();
      assert.equal(await pending, false);
      assert.equal(existsSync(path.dirname(file)), false);
      assert.equal(calls, 1, "never start xclip or xsel after cancellation");
    } finally {
      owner.controller.abort();
      Object.defineProperty(process, "platform", platform);
    }
  }, 1000);
}

test("a delayed clipboard failure after retirement cannot start a fallback", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const owner = ownership();
  const delayed = gate();
  let file = "";
  let calls = 0;
  try {
    const pending = copyToClipboard(
      {
        exec: async (_command: string, args: string[], options: { signal: AbortSignal }) => {
          calls++;
          assert.equal(options.signal, owner.signal);
          file = clipboardPath(args);
          await delayed.promise;
          throw new Error("late utility failure");
        },
      } as never,
      "private transcript",
      owner,
    );
    owner.controller.abort();
    delayed.release();
    assert.equal(await pending, false);
    assert.equal(calls, 1);
    assert.equal(existsSync(path.dirname(file)), false);
  } finally {
    delayed.release();
    owner.controller.abort();
    Object.defineProperty(process, "platform", platform);
  }
});

test("already retired clipboard ownership never creates a process", async () => {
  const owner = ownership();
  owner.controller.abort();
  assert.equal(
    await copyToClipboard({ exec: () => assert.fail("unexpected clipboard process") } as never, "old", owner),
    false,
  );
});
