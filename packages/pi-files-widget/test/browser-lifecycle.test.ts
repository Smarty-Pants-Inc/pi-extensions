import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type BrowserController, createFileBrowser } from "../browser.js";
import extension from "../index.js";
import * as utils from "../utils.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const nativeTimeout = globalThis.setTimeout;
const pause = (ms: number) => new Promise<void>((resolve) => nativeTimeout(resolve, ms));

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await pause(10);
  assert.equal(check(), true);
}

test("all browser rows fit long no-results queries and narrow position/status rows", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "browser-width-"));
  writeFileSync(join(cwd, "wide-file-name.ts"), "one\ntwo");
  let renders = 0;
  const browser = createFileBrowser(
    cwd,
    new Set(),
    theme as never,
    () => {},
    () => {},
    () => {
      renders++;
    },
  );
  try {
    await until(() => renders > 0);
    for (const width of [80, 20, 8, 1]) {
      assert.ok(browser.render(width).every((line) => visibleWidth(line) <= width));
    }
    browser.handleInput("/");
    browser.handleInput("no-results-".repeat(100));
    for (const width of [80, 20, 8, 1]) {
      const lines = browser.render(width);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `width ${width}`,
      );
    }
  } finally {
    browser.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const phase of ["readdir", "stat", "readFile"] as const) {
  test(`q fences deferred ${phase}, disposes queues, and never schedules or renders again`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "browser-dispose-"));
    mkdirSync(join(cwd, "nested"));
    const path = join(cwd, "file.ts");
    writeFileSync(path, "one\ntwo");
    let entered = false;
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = phase === "readdir" ? fsPromises.readdir : phase === "stat" ? fsPromises.stat : fsPromises.readFile;
    // Each phase uses the same public async boundary and preserves its native
    // signature. Only the root scan or this file's line-count work is deferred.
    const deferred = spyOn(fsPromises, phase).mockImplementation((async (...args: Parameters<typeof native>) => {
      const result = await (native as (...input: Parameters<typeof native>) => Promise<unknown>)(...args);
      if (args[0] === (phase === "readdir" ? cwd : path)) {
        entered = true;
        await pending;
      }
      return result;
    }) as never);
    const filesystem = [
      phase === "readdir" ? deferred : spyOn(fsPromises, "readdir"),
      phase === "stat" ? deferred : spyOn(fsPromises, "stat"),
      phase === "readFile" ? deferred : spyOn(fsPromises, "readFile"),
      spyOn(fsPromises, "realpath"),
    ];
    const timers = spyOn(globalThis, "setTimeout");
    let renders = 0;
    let closes = 0;
    const browser = createFileBrowser(
      cwd,
      new Set(),
      theme as never,
      () => {
        closes++;
      },
      () => {},
      () => {
        renders++;
      },
    );
    try {
      await until(() => entered);
      browser.handleInput("q");
      const rendered = renders;
      const scheduled = timers.mock.calls.length;
      const filesystemCalls = filesystem.map((spy) => spy.mock.calls.length);
      browser.dispose();
      release();
      await pause(200);
      browser.handleInput("u");
      browser.handleInput("q");
      assert.deepEqual(browser.render(80), []);
      assert.equal(closes, 1);
      assert.equal(renders, rendered);
      assert.equal(timers.mock.calls.length, scheduled);
      assert.deepEqual(
        filesystem.map((spy) => spy.mock.calls.length),
        filesystemCalls,
      );
    } finally {
      browser.dispose();
      release();
      for (const spy of filesystem) spy.mockRestore();
      timers.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("shutdown completes owned open browser and clears polling before context invalidation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "browser-shutdown-"));
  writeFileSync(join(cwd, "file.ts"), "one");
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const events = new Map<string, (event: never, ctx: never) => unknown>();
  const deps = spyOn(utils, "hasCommand").mockReturnValue(true);
  const nativeInterval = globalThis.setInterval;
  const intervals = spyOn(globalThis, "setInterval").mockImplementation((fn) => nativeInterval(fn, 5));
  let component: BrowserController | undefined;
  let complete: (() => void) | undefined;
  let doneCalls = 0;
  let renders = 0;
  let valid = true;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      custom: (factory: (...args: unknown[]) => BrowserController) =>
        new Promise<void>((resolve) => {
          complete = () => {
            assert.equal(valid, true);
            doneCalls++;
            resolve();
          };
          component = factory(
            {
              requestRender: () => {
                assert.equal(valid, true);
                renders++;
              },
            },
            theme,
            {},
            complete,
          );
        }),
    },
  };
  try {
    extension({
      registerCommand: (name: string, command: never) => commands.set(name, command),
      on: (name: string, handler: never) => events.set(name, handler),
    } as never);
    const command = commands.get("readfiles");
    assert.ok(command);
    const interaction = command.handler("", ctx as never);
    await until(() => renders > 0);
    await events.get("session_shutdown")?.({} as never, ctx as never);
    await interaction;
    assert.equal(doneCalls, 1);
    valid = false;
    const rendered = renders;
    component?.dispose();
    component?.handleInput("q");
    await events.get("session_shutdown")?.({} as never, ctx as never);
    await pause(200);
    assert.equal(renders, rendered);
    assert.equal(doneCalls, 1);
    assert.deepEqual(component?.render(80), []);
  } finally {
    component?.dispose();
    deps.mockRestore();
    intervals.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
  }
});
