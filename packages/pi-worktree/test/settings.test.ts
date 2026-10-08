import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { test } from "vitest";
import {
  createWorktreeSettingsRuntime,
  defaultWorktreeRoot,
  loadWorktreeSettings,
  resolveWorktreeRoot,
  saveWorktreeSettings,
} from "../src/settings.js";

test("worktree root defaults to a home-scoped .worktrees directory on each platform", () => {
  assert.equal(defaultWorktreeRoot("/home/alice", "linux"), "/home/alice/.worktrees");
  assert.equal(defaultWorktreeRoot("C:\\Users\\Alice", "win32"), "C:\\Users\\Alice\\.worktrees");
});

test("worktree root accepts native absolute and home paths without shell expansion", () => {
  assert.equal(resolveWorktreeRoot("~", "/home/alice", "linux"), "/home/alice");
  assert.equal(resolveWorktreeRoot("~/worktrees", "/home/alice", "linux"), "/home/alice/worktrees");
  assert.equal(resolveWorktreeRoot("/srv/worktrees", "/home/alice", "linux"), "/srv/worktrees");
  assert.equal(resolveWorktreeRoot("~\\worktrees", "C:\\Users\\Alice", "win32"), "C:\\Users\\Alice\\worktrees");
  assert.equal(resolveWorktreeRoot("D:\\worktrees", "C:\\Users\\Alice", "win32"), "D:\\worktrees");
  assert.equal(
    resolveWorktreeRoot("\\\\server\\share\\worktrees", "C:\\Users\\Alice", "win32"),
    "\\\\server\\share\\worktrees",
  );

  for (const value of [
    "",
    "relative/path",
    "../worktrees",
    "~/bad\0path",
    "$ROOT/worktrees",
    ["$", "{ROOT}/worktrees"].join(""),
    "$(pwd)/worktrees",
    "/srv/$9/worktrees",
  ]) {
    assert.throws(() => resolveWorktreeRoot(value, "/home/alice", "linux"), /worktreeRoot/i);
  }
  for (const value of ["relative\\path", "%ROOT%\\worktrees", "C:worktrees"]) {
    assert.throws(() => resolveWorktreeRoot(value, "C:\\Users\\Alice", "win32"), /worktreeRoot/i);
  }
});

test("settings loading distinguishes missing, user, malformed, and invalid documents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worktree-settings-"));
  const settingsPath = join(directory, "pi-worktree.json");
  try {
    const missing = await loadWorktreeSettings(settingsPath, "/home/alice", "linux");
    assert.equal(missing.kind, "missing");
    assert.equal(missing.effectiveRoot, "/home/alice/.worktrees");
    assert.equal(missing.source, "default");
    assert.deepEqual(missing.document, {});

    await writeFile(settingsPath, '{"worktreeRoot":"~/trees","future":true}\n');
    const loaded = await loadWorktreeSettings(settingsPath, "/home/alice", "linux");
    assert.equal(loaded.kind, "loaded");
    assert.equal(loaded.effectiveRoot, "/home/alice/trees");
    assert.equal(loaded.source, "user");
    assert.equal(loaded.configuredRoot, "~/trees");
    assert.deepEqual(loaded.document, { worktreeRoot: "~/trees", future: true });

    await writeFile(settingsPath, "{broken\n");
    const malformed = await loadWorktreeSettings(settingsPath, "/home/alice", "linux");
    assert.equal(malformed.kind, "invalid");
    assert.match(malformed.warning ?? "", /ignored.*without overwriting/i);

    for (const document of [{ worktreeRoot: "" }, { worktreeRoot: "relative" }, { worktreeRoot: 42 }, []]) {
      await writeFile(settingsPath, `${JSON.stringify(document)}\n`);
      const invalid = await loadWorktreeSettings(settingsPath, "/home/alice", "linux");
      assert.equal(invalid.kind, "invalid");
      assert.equal(invalid.effectiveRoot, "/home/alice/.worktrees");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime reload retains the last-known valid root and blocks saves while the file is invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worktree-settings-"));
  const settingsPath = join(directory, "pi-worktree.json");
  try {
    await writeFile(settingsPath, '{"worktreeRoot":"/srv/trees","future":1}\n');
    const runtime = createWorktreeSettingsRuntime({
      path: settingsPath,
      home: "/home/alice",
      platform: "linux",
    });
    await runtime.reload();
    assert.equal(runtime.get().effectiveRoot, "/srv/trees");
    assert.equal(runtime.get().canSave, true);

    await writeFile(settingsPath, "{broken\n");
    await runtime.reload();
    assert.equal(runtime.get().effectiveRoot, "/srv/trees");
    assert.equal(runtime.get().source, "user");
    assert.equal(runtime.get().canSave, false);
    assert.match(runtime.get().warning ?? "", /ignored/i);
    await assert.rejects(() => runtime.save("/other"), /fix.*settings file/i);
    assert.equal(await readFile(settingsPath, "utf8"), "{broken\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic save and reset preserve unknown fields and publish failures preserve file and runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worktree-settings-"));
  const settingsPath = join(directory, "pi-worktree.json");
  try {
    await writeFile(settingsPath, '{"worktreeRoot":"~/old","future":{"kept":true}}\n');
    const loaded = await loadWorktreeSettings(settingsPath, "/home/alice", "linux");
    assert.equal(loaded.kind, "loaded");
    await saveWorktreeSettings(loaded.document ?? {}, "/srv/new", settingsPath);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      worktreeRoot: "/srv/new",
      future: { kept: true },
    });
    const reloaded = await loadWorktreeSettings(settingsPath, "/home/alice", "linux");
    assert.equal(reloaded.kind, "loaded");
    await saveWorktreeSettings(reloaded.document ?? {}, undefined, settingsPath);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      future: { kept: true },
    });

    const original = await readFile(settingsPath, "utf8");
    const runtime = createWorktreeSettingsRuntime({
      path: settingsPath,
      home: "/home/alice",
      platform: "linux",
      operations: {
        rename: async () => {
          throw new Error("publish failed");
        },
      },
    });
    await runtime.reload();
    const before = runtime.get();
    await assert.rejects(() => runtime.save("/srv/failed"), /publish failed/);
    assert.deepEqual(runtime.get(), before);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime rereads the latest valid document and blocks concurrent invalid edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worktree-settings-latest-"));
  const settingsPath = join(directory, "pi-worktree.json");
  try {
    await writeFile(settingsPath, '{"worktreeRoot":"/old","future":{"version":1}}\n');
    const runtime = createWorktreeSettingsRuntime({
      path: settingsPath,
      home: "/home/alice",
      platform: "linux",
    });
    await runtime.reload();
    await writeFile(settingsPath, '{"worktreeRoot":"/external","future":{"version":2}}\n');
    await runtime.save("/new");
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      worktreeRoot: "/new",
      future: { version: 2 },
    });

    const invalid = '{"worktreeRoot":42,"future":"kept"}\n';
    await writeFile(settingsPath, invalid);
    const before = runtime.get();
    await assert.rejects(() => runtime.save("/blocked"), /fix|invalid/i);
    assert.equal(await readFile(settingsPath, "utf8"), invalid);
    assert.equal(runtime.get().effectiveRoot, before.effectiveRoot);
    assert.equal(runtime.get().source, before.source);
    assert.equal(runtime.get().canSave, false);
    assert.match(runtime.get().warning ?? "", /ignored/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime serializes saves in invocation order and remains usable after queued work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worktree-settings-order-"));
  const settingsPath = join(directory, "pi-worktree.json");
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const writes: string[] = [];
  const runtime = createWorktreeSettingsRuntime({
    path: settingsPath,
    home: "/home/alice",
    platform: "linux",
    operations: {
      write: async (path, data) => {
        writes.push(data);
        if (writes.length === 1) await firstMayFinish;
        await writeFile(path, data, { flag: "wx" });
      },
    },
  });
  try {
    const first = runtime.save("/srv/first");
    const second = runtime.save("/srv/second");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(writes.length, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(writes.length, 2);
    assert.equal(runtime.get().effectiveRoot, "/srv/second");
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      worktreeRoot: "/srv/second",
    });
  } finally {
    releaseFirst();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["before write", "during write"])("cancellation %s preserves settings before publication", async (phase) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worktree-settings-cancel-"));
  const settingsPath = join(directory, "pi-worktree.json");
  const original = '{"worktreeRoot":"/srv/old","future":true}\n';
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  let renames = 0;
  let writes = 0;
  try {
    await writeFile(settingsPath, original);
    const runtime = createWorktreeSettingsRuntime({
      path: settingsPath,
      home: "/home/alice",
      platform: "linux",
      operations: {
        write: async (path, data) => {
          writes++;
          entered.resolve();
          await finishWrite.promise;
          await writeFile(path, data, { flag: "wx" });
        },
        rename: async (source, destination) => {
          renames++;
          await rename(source, destination);
        },
      },
    });
    await runtime.reload();
    const before = runtime.get();
    if (phase === "before write") controller.abort();
    const pending = runtime.save("/srv/new", controller.signal);
    const rejected = assert.rejects(pending, /abort/i);
    if (phase === "during write") {
      await entered.promise;
      controller.abort();
      finishWrite.resolve();
    }
    await rejected;
    await runtime.flush?.();
    assert.equal(writes, phase === "before write" ? 0 : 1);
    assert.equal(renames, 0);
    assert.deepEqual(runtime.get(), before);
    assert.equal(await readFile(settingsPath, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["pi-worktree.json"]);
  } finally {
    finishWrite.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["/srv/new", undefined])("cancellation during successful rename commits settings %j", async (root) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worktree-settings-publish-cancel-"));
  const settingsPath = join(directory, "pi-worktree.json");
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const publish = Promise.withResolvers<void>();
  try {
    await writeFile(settingsPath, '{"worktreeRoot":"/srv/old","future":true}\n');
    const runtime = createWorktreeSettingsRuntime({
      path: settingsPath,
      home: "/home/alice",
      platform: "linux",
      operations: {
        rename: async (source, destination) => {
          entered.resolve();
          await publish.promise;
          await rename(source, destination);
        },
      },
    });
    await runtime.reload();
    const pending = runtime.save(root, controller.signal);
    await entered.promise;
    controller.abort();
    assert.equal(runtime.get().effectiveRoot, "/srv/old");
    publish.resolve();
    const updated = await pending;
    await runtime.flush?.();
    assert.deepEqual(updated, runtime.get());
    assert.equal(updated.effectiveRoot, root ?? "/home/alice/.worktrees");
    assert.equal(updated.source, root ? "user" : "default");
    assert.equal(updated.configuredRoot, root);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      ...(root ? { worktreeRoot: root } : {}),
      future: true,
    });
    assert.deepEqual(await readdir(directory), ["pi-worktree.json"]);
  } finally {
    publish.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

// Keep platform-specific expectations explicit rather than depending on the test host.
test("path fixtures use the platform path modules expected by validation", () => {
  assert.equal(posix.isAbsolute("/srv/worktrees"), true);
  assert.equal(win32.isAbsolute("D:\\worktrees"), true);
  assert.equal(win32.isAbsolute("\\\\server\\share\\worktrees"), true);
});
