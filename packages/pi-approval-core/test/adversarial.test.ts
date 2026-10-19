import childProcess, { spawn } from "node:child_process";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionToolContext,
  initTheme,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import {
  APPROVAL_QUERY_CHANNEL,
  captureApprovalService,
  createApprovalBashOperations,
  createApprovalToolDefinitions,
  hashBytes,
  queryApprovalService,
  validateQuery,
} from "../src/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const f of cleanup.splice(0).reverse()) await f();
});
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "approval-adversarial-")));
  let context: ExtensionContext | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) => {
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    tools: [],
  });
  cleanup.push(async () => {
    session.dispose();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "print" });
  if (!context) throw new Error("Missing SDK context");
  const ctx: ExtensionToolContext = {
    ...context,
    tools: [],
    executeTool: async () => {
      throw new Error("Unused nested execution");
    },
  };
  return { cwd, session, ctx };
}
it("A: deadline-isolated 40k disjoint edit render never reads or diffs", async () => {
  if (process.env.APPROVAL_RENDER_PROBE !== "1") {
    const probe = await fs.mkdtemp(join(tmpdir(), "approval-render-deadline-"));
    cleanup.push(() => fs.rm(probe, { recursive: true, force: true }));
    const cli = fileURLToPath(new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")));
    const child = spawn(
      process.execPath,
      [cli, "run", "test/adversarial.test.ts", "-t", "A: deadline", "--pool=threads", "--maxWorkers=1"],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: { ...process.env, TMPDIR: probe, TMP: probe, TEMP: probe, APPROVAL_RENDER_PROBE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (b) => {
      output = (output + b).slice(-4096);
    });
    child.stderr.on("data", (b) => {
      output = (output + b).slice(-4096);
    });
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      expect(await closed, output).toEqual({ code: 0, signal: null });
    } finally {
      clearTimeout(deadline);
    }
    return;
  }
  const { cwd, session } = await fixture();
  const path = join(cwd, "render-target");
  await fs.writeFile(path, "a\n".repeat(40000));
  const read = vi.spyOn(syncFs, "readFileSync");
  syncBuiltinESMExports();
  const [edit] = createApprovalToolDefinitions({ source: "test", request: async () => {}, isCurrent: () => true });
  const args = { path, edits: [{ oldText: "a\n".repeat(40000), newText: "b\n".repeat(40000) }] };
  initTheme("dark", false);
  const theme = session.extensionRunner.getUIContext().theme;
  const readAsync = vi.spyOn(fs, "readFile");
  syncBuiltinESMExports();
  const component = edit.renderCall?.(args, theme, {
    args,
    toolCallId: "render",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd,
    executionStarted: false,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
  });
  expect(component).toBeDefined();
  expect(read.mock.calls.some((call) => call[0] === path)).toBe(false);
  for (const width of [0, 1, 4, 40, 80])
    expect(component?.render(width)).toEqual(["edit (human approval required)".slice(0, width)]);
  await new Promise((r) => setImmediate(r));
  expect(readAsync).not.toHaveBeenCalled();
}, 8000);
it.each(["ownership", "service"])("B: held cwd access blocks dispatch after %s invalidation", async (loss) => {
  const { cwd } = await fixture();
  const entered = gate(),
    release = gate();
  const access = fs.access;
  vi.spyOn(fs, "access").mockImplementation(async (...args) => {
    if (args[0] === cwd) {
      entered.resolve();
      await release.promise;
    }
    return access(...args);
  });
  const dispatched = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  let current = true;
  const events = createEventBus();
  const request = vi.fn(async () => {});
  const peer = { version: 1, id: "peer", request };
  const off = events.on(APPROVAL_QUERY_CHANNEL, (v) => validateQuery(v).respond(peer));
  const captured = captureApprovalService(events);
  if (!captured) throw new Error("Missing peer");
  const ops = createApprovalBashOperations({
    source: "test",
    toolCallId: "dispatch",
    inputHash: hashBytes("cmd"),
    request: captured.service.request,
    isCurrent: () => {
      captured.assertCurrent();
      return current;
    },
  });
  const running = ops.exec("printf unsafe > marker", cwd, { onData() {} }).then(
    () => "executed",
    () => "denied",
  );
  await entered.promise;
  if (loss === "service") off();
  else current = false;
  release.resolve();
  expect(await running).toBe("denied");
  expect(syncFs.existsSync(join(cwd, "marker"))).toBe(false);
  expect(request).toHaveBeenCalledOnce();
  expect(dispatched).not.toHaveBeenCalled();
});
it.each(["retired", "replaced"])(
  "C: documented generic factory keeps its same-peer guard during held recheck (%s)",
  async (loss) => {
    const { cwd, ctx } = await fixture();
    const events = createEventBus();
    let approved = false;
    const request = vi.fn(async () => {
      approved = true;
    });
    let peer = { version: 1, id: "peer", request };
    const off = events.on(APPROVAL_QUERY_CHANNEL, (v) => validateQuery(v).respond(peer));
    const doc = await fs.readFile(fileURLToPath(new URL("../coreAPI.md", import.meta.url)), "utf8");
    const snippet = doc.split("```ts\n")[1]?.split("```")[0];
    if (!snippet) throw new Error("Missing example");
    let options: Parameters<typeof createApprovalToolDefinitions>[0] | undefined;
    new Function(
      "captureApprovalService",
      "queryApprovalService",
      "rootPi",
      "createApprovalToolDefinitions",
      "callerStillOwns",
      snippet,
    )(
      captureApprovalService,
      queryApprovalService,
      { events },
      (value: typeof options) => {
        options = value;
        return [];
      },
      () => true,
    );
    if (!options) throw new Error("Missing factory options");
    const [, write] = createApprovalToolDefinitions(options);
    const entered = gate(),
      release = gate();
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (approved) {
        entered.resolve();
        await release.promise;
      }
      return lstat(...args);
    });
    syncBuiltinESMExports();
    const running = write
      .execute("doc", { path: "doc-new/dir/file", content: "never" }, undefined, undefined, ctx)
      .then(
        () => "executed",
        () => "denied",
      );
    await entered.promise;
    if (loss === "retired") off();
    else peer = { ...peer };
    release.resolve();
    expect(await running).toBe("denied");
    expect(syncFs.existsSync(join(cwd, "doc-new"))).toBe(false);
    expect(() => options?.isCurrent(ctx)).toThrow(/unavailable|replaced|retired/);
    expect(request).toHaveBeenCalledOnce();
  },
);
it.each(["edit", "write", "bash"] as const)(
  "D: exact-name invocation guard denies %s after review without another request",
  async (name) => {
    const { cwd, ctx } = await fixture();
    let admitted = true;
    const request = vi.fn(async () => {
      admitted = false;
    });
    const admission = vi.fn((_ctx: ExtensionToolContext, actual: string) => {
      expect(actual).toBe(name);
      return admitted;
    });
    const [edit, write, bash] = createApprovalToolDefinitions({
      source: "test",
      isCurrent: () => true,
      isToolCurrent: admission,
      request,
      commandPrefix: "export PREFIX=reviewed",
    });
    await fs.writeFile(join(cwd, "existing"), "before");
    const running =
      name === "edit"
        ? edit.execute(
            "admission",
            { path: "existing", edits: [{ oldText: "before", newText: "after" }] },
            undefined,
            undefined,
            ctx,
          )
        : name === "write"
          ? write.execute("admission", { path: "admission/file", content: "never" }, undefined, undefined, ctx)
          : bash.execute("admission", { command: "printf '%s' \"$PREFIX\" > marker" }, undefined, undefined, ctx);
    await expect(running).rejects.toThrow(/stale|cancelled/);
    expect(await fs.readFile(join(cwd, "existing"), "utf8")).toBe("before");
    expect(syncFs.existsSync(join(cwd, "admission"))).toBe(false);
    expect(syncFs.existsSync(join(cwd, "marker"))).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(admission.mock.calls.length).toBeGreaterThan(1);
  },
);
// Exercise both the old pathname write and the new descriptor open. Hooks
// mutate the real filesystem exactly once, then call the original native IO.
function beforeMutation(path: string, approved: () => boolean, swap: () => Promise<void>) {
  let swaps = 0;
  const trigger = async () => {
    if (!approved() || swaps !== 0) return;
    swaps++;
    await swap();
  };
  const open = fs.open;
  const writeFile = fs.writeFile;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (typeof args[1] === "number" && args[1] & (syncFs.constants.O_WRONLY | syncFs.constants.O_RDWR)) await trigger();
    return open(...args);
  });
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === path) await trigger();
    return writeFile(...args);
  });
  syncBuiltinESMExports();
  return () => swaps;
}
it.each([
  ["write", "target-symlink"],
  ["edit", "target-symlink"],
  ["write", "ancestor-symlink"],
  ["edit", "ancestor-symlink"],
  ["write", "regular-inode"],
  ["write", "new-target-symlink"],
  ["write", "new-target-regular"],
] as const)("pinned file race: %s refuses %s at native mutation seam", async (kind, race) => {
  const { cwd, ctx } = await fixture();
  const parent = join(cwd, "approved");
  const otherParent = join(cwd, "other");
  await fs.mkdir(parent);
  await fs.mkdir(otherParent);
  const path = join(parent, "target");
  const other = join(otherParent, "target");
  const saved = race === "ancestor-symlink" ? join(cwd, "saved-parent", "target") : join(parent, "saved-target");
  await fs.writeFile(other, "other destination must survive");
  const newTarget = race.startsWith("new-target-");
  if (!newTarget) await fs.writeFile(path, "original bytes must survive");
  let approved = false;
  const [edit, write] = createApprovalToolDefinitions({
    source: "test",
    isCurrent: () => true,
    request: async () => {
      approved = true;
    },
  });
  const swaps = beforeMutation(
    path,
    () => approved,
    async () => {
      if (race === "ancestor-symlink") {
        await fs.rename(parent, dirname(saved));
        await fs.symlink(otherParent, parent, "dir");
      } else {
        if (!newTarget) await fs.rename(path, saved);
        // Identical bytes ensure the inode check, not only a content check,
        // is necessary to refuse an existing regular-file replacement.
        if (race === "regular-inode" || race === "new-target-regular")
          await fs.writeFile(path, "original bytes must survive");
        else await fs.symlink(other, path);
      }
    },
  );
  const running =
    kind === "edit"
      ? edit.execute("race", { path, edits: [{ oldText: "original", newText: "changed" }] }, undefined, undefined, ctx)
      : write.execute("race", { path, content: "changed" }, undefined, undefined, ctx);
  await expect(running).rejects.toThrow(/Approval|non-symlink|ELOOP|ENOTDIR/);
  expect(swaps()).toBe(1);
  expect(await fs.readFile(other, "utf8")).toBe("other destination must survive");
  if (!newTarget) expect(await fs.readFile(saved, "utf8")).toBe("original bytes must survive");
  if (race === "regular-inode" || race === "new-target-regular")
    expect(await fs.readFile(path, "utf8")).toBe("original bytes must survive");
});
it("pinned file race: refuses an ancestor swap after writable open before descriptor write", async () => {
  const { cwd, ctx } = await fixture();
  const parent = join(cwd, "approved");
  const otherParent = join(cwd, "other");
  await fs.mkdir(parent);
  await fs.mkdir(otherParent);
  const path = join(parent, "target");
  await fs.writeFile(path, "original");
  await fs.writeFile(join(otherParent, "target"), "other");
  let approved = false;
  let swapped = false;
  const swap = async () => {
    if (!approved || swapped) return;
    swapped = true;
    await fs.rename(parent, join(cwd, "saved"));
    await fs.symlink(otherParent, parent, "dir");
  };
  const open = fs.open;
  const writeFile = fs.writeFile;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (typeof args[1] === "number" && args[1] & (syncFs.constants.O_WRONLY | syncFs.constants.O_RDWR)) await swap();
    return handle;
  });
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === path) await swap();
    return writeFile(...args);
  });
  syncBuiltinESMExports();
  const [, write] = createApprovalToolDefinitions({
    source: "test",
    isCurrent: () => true,
    request: async () => {
      approved = true;
    },
  });
  await expect(write.execute("race", { path, content: "changed" }, undefined, undefined, ctx)).rejects.toThrow(
    /Approval|non-symlink/,
  );
  expect(swapped).toBe(true);
  expect(await fs.readFile(join(cwd, "saved", "target"), "utf8")).toBe("original");
  expect(await fs.readFile(join(otherParent, "target"), "utf8")).toBe("other");
});
it.each([false, true])(
  "pinned file controls: shorter, unchanged and missing nested writes (fallback=%s)",
  async (fallback) => {
    const { cwd, ctx } = await fixture();
    if (fallback) {
      vi.spyOn(fs, "statfs").mockRejectedValue(Object.assign(new Error("procfs unavailable"), { code: "ENOENT" }));
      syncBuiltinESMExports();
    }
    const request = vi.fn(async () => {});
    const [, write] = createApprovalToolDefinitions({ source: "test", isCurrent: () => true, request });
    const path = join(cwd, "target");
    await fs.writeFile(path, "long original bytes");
    await write.execute("shorter", { path, content: "short" }, undefined, undefined, ctx);
    expect(await fs.readFile(path, "utf8")).toBe("short");
    await write.execute("unchanged", { path, content: "short" }, undefined, undefined, ctx);
    expect(await fs.readFile(path, "utf8")).toBe("short");
    const nested = join(cwd, "new", "nested", "target");
    await write.execute("new", { path: nested, content: "created" }, undefined, undefined, ctx);
    expect(await fs.readFile(nested, "utf8")).toBe("created");
    expect(request).toHaveBeenCalledTimes(3);
  },
);
it("pinned file identity: accepts exact virtual inode IDs above 2^53 through SDK write", async () => {
  // Keep reason: inode identity is an approval trust boundary; large valid
  // identities must not reject safe writes, including on macOS without procfs.
  const { cwd, ctx } = await fixture();
  const path = join(cwd, "large-inode");
  await fs.writeFile(path, "original bytes");
  const offset = 1n << 54n;
  const observed = new Set<bigint>();
  let numericStats = 0;
  let descriptorStats = 0;
  function virtualInode<T extends syncFs.Stats | syncFs.BigIntStats>(value: T): T {
    const inode = BigInt(value.ino) + offset;
    observed.add(inode);
    if (typeof value.ino === "bigint") value.ino = inode;
    else {
      numericStats++;
      value.ino = Number(inode);
    }
    return value;
  }
  const lstat = fs.lstat;
  const stat = fs.stat;
  const open = fs.open;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) =>
    virtualInode(await lstat(...args)),
  );
  vi.spyOn(fs, "stat").mockImplementation(async (...args: Parameters<typeof fs.stat>) =>
    virtualInode(await stat(...args)),
  );
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const handleStat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async (...options: Parameters<typeof handle.stat>) => {
      descriptorStats++;
      const stats = await handleStat(...options);
      if (stats === undefined) throw new Error("Fixture handle.stat returned no stats");
      return virtualInode(stats);
    });
    return handle;
  });
  syncBuiltinESMExports();
  const request = vi.fn(async () => {});
  const [, write] = createApprovalToolDefinitions({ source: "test", isCurrent: () => true, request });
  await write.execute("large-inode", { path, content: "exact new bytes" }, undefined, undefined, ctx);
  expect(await fs.readFile(path, "utf8")).toBe("exact new bytes");
  expect(request).toHaveBeenCalledOnce();
  expect(descriptorStats).toBeGreaterThan(0);
  expect(observed.size).toBeGreaterThan(1);
  expect([...observed].every((inode) => inode > BigInt(Number.MAX_SAFE_INTEGER))).toBe(true);
  expect(numericStats).toBe(0);
});
it("pinned file fallback: detects an ancestor swap before mutation and preserves both files", async () => {
  const { cwd, ctx } = await fixture();
  vi.spyOn(fs, "statfs").mockRejectedValue(Object.assign(new Error("procfs unavailable"), { code: "ENOENT" }));
  const parent = join(cwd, "approved");
  const other = join(cwd, "other");
  await fs.mkdir(parent);
  await fs.mkdir(other);
  const path = join(parent, "target");
  await fs.writeFile(path, "original");
  await fs.writeFile(join(other, "target"), "other");
  let approved = false;
  const [, write] = createApprovalToolDefinitions({
    source: "test",
    isCurrent: () => true,
    request: async () => {
      approved = true;
    },
  });
  const swaps = beforeMutation(
    path,
    () => approved,
    async () => {
      await fs.rename(parent, join(cwd, "saved"));
      await fs.symlink(other, parent, "dir");
    },
  );
  await expect(write.execute("fallback-race", { path, content: "changed" }, undefined, undefined, ctx)).rejects.toThrow(
    /Approval|non-symlink/,
  );
  expect(swaps()).toBe(1);
  expect(await fs.readFile(join(cwd, "saved", "target"), "utf8")).toBe("original");
  expect(await fs.readFile(join(other, "target"), "utf8")).toBe("other");
});
it.skipIf(process.platform !== "linux").each(["capability", "identity"] as const)(
  "pinned file capability: Linux refuses %s failure rather than downgrading",
  async (failure) => {
    const { cwd, ctx } = await fixture();
    const path = join(cwd, "target");
    await fs.writeFile(path, "original");
    let approved = false;
    const statfs = fs.statfs;
    const stat = fs.stat;
    vi.spyOn(fs, "statfs").mockImplementation(async (...args: Parameters<typeof fs.statfs>) => {
      if (approved && failure === "capability")
        throw Object.assign(new Error("procfs disappeared"), { code: "ENOENT" });
      return statfs(...args);
    });
    vi.spyOn(fs, "stat").mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (approved && failure === "identity" && String(args[0]).startsWith("/proc/self/fd/"))
        throw new Error("descriptor verification failed");
      return stat(...args);
    });
    syncBuiltinESMExports();
    const [, write] = createApprovalToolDefinitions({
      source: "test",
      isCurrent: () => true,
      request: async () => {
        approved = true;
      },
    });
    await expect(
      write.execute("no-downgrade", { path, content: "changed" }, undefined, undefined, ctx),
    ).rejects.toThrow(/Approval.*(capability|identity)/);
    expect(await fs.readFile(path, "utf8")).toBe("original");
  },
);
it("pinned file directory creation: missing nested mkdir refuses a swapped ancestor", async () => {
  const { cwd, ctx } = await fixture();
  const parent = join(cwd, "approved");
  const other = join(cwd, "other");
  await fs.mkdir(parent);
  await fs.mkdir(join(other, "new"), { recursive: true });
  await fs.writeFile(join(other, "new", "target"), "other");
  let approved = false;
  let swaps = 0;
  const mkdir = fs.mkdir;
  vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
    if (approved && swaps === 0) {
      swaps++;
      await fs.rename(parent, join(cwd, "saved"));
      await fs.symlink(other, parent, "dir");
    }
    return mkdir(...args);
  });
  syncBuiltinESMExports();
  const [, write] = createApprovalToolDefinitions({
    source: "test",
    isCurrent: () => true,
    request: async () => {
      approved = true;
    },
  });
  await expect(
    write.execute("mkdir-race", { path: join(parent, "new", "target"), content: "changed" }, undefined, undefined, ctx),
  ).rejects.toThrow(/Approval|non-symlink/);
  expect(swaps).toBe(1);
  expect(await fs.readFile(join(other, "new", "target"), "utf8")).toBe("other");
  expect(syncFs.existsSync(join(cwd, "saved", "new", "target"))).toBe(false);
});
it("pinned file controls: existing symlink ancestors are refused before requesting approval", async () => {
  const { cwd, ctx } = await fixture();
  await fs.mkdir(join(cwd, "real"));
  await fs.writeFile(join(cwd, "real", "target"), "original");
  await fs.symlink(join(cwd, "real"), join(cwd, "alias"), "dir");
  const request = vi.fn(async () => {});
  const [, write] = createApprovalToolDefinitions({ source: "test", isCurrent: () => true, request });
  await expect(
    write.execute("symlink", { path: join(cwd, "alias", "target"), content: "changed" }, undefined, undefined, ctx),
  ).rejects.toThrow(/non-symlink/);
  expect(request).not.toHaveBeenCalled();
  expect(await fs.readFile(join(cwd, "real", "target"), "utf8")).toBe("original");
});
it("B: SDK factory prefixes the exact reviewed command without replacing output behavior", async () => {
  const { ctx, cwd } = await fixture();
  const request = vi.fn(async () => {});
  const [, , bash] = createApprovalToolDefinitions({
    source: "test",
    isCurrent: () => true,
    request,
    commandPrefix: "export PREFIX=reviewed",
  });
  const result = await bash.execute("prefix", { command: "printf '%s' \"$PREFIX\"" }, undefined, undefined, ctx);
  expect(result.structuredContent).toMatchObject({ output: "reviewed", exit_code: 0 });
  expect(request.mock.calls[0]).toMatchObject([
    { command: "export PREFIX=reviewed\nprintf '%s' \"$PREFIX\"", cwd },
    expect.anything(),
  ]);
});
