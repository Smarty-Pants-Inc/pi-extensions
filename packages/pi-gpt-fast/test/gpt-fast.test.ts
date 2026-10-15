/**
 * gpt-fast.test.ts — the behaviour behind the `/gpt-fast` toggle.
 *
 * The whole extension is one decision made three times a turn: should this
 * outgoing request carry `service_tier: "priority"`? Getting it wrong is not a
 * cosmetic bug. `service_tier` sent to a provider that rejects unknown fields
 * fails the entire request, which is exactly why the allowlist is exact pairs
 * rather than a prefix match — so the gate is what these tests are mostly about.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import gptFast from "../src/index.js";

let agentDir: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "gpt-fast-"));
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

interface Harness {
  command: (args: string, context?: unknown) => Promise<void>;
  sessionStart: (ctx: unknown) => void;
  modelSelect: (ctx: unknown) => void;
  request: (payload: unknown, ctx: unknown) => unknown;
}

/** Fail with the missing name rather than a null-dereference three frames on. */
function required<T>(map: Map<string, T>, name: string): T {
  const found = map.get(name);
  if (found === undefined) throw new Error(`the extension never registered "${name}"`);
  return found;
}

function boot(flag = false): Harness {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  gptFast({
    registerFlag: () => {},
    registerCommand: (name: string, def: unknown) => commands.set(name, def as never),
    on: (event: string, handler: unknown) => events.set(event, handler as never),
    getFlag: () => flag,
  } as never);
  return {
    command: (args, context) => required(commands, "gpt-fast").handler(args, context ?? ctx()),
    sessionStart: (context) => void required(events, "session_start")({}, context),
    modelSelect: (context) => void required(events, "model_select")({}, context),
    request: (payload, context) => required(events, "before_provider_request")({ payload }, context),
  };
}

const notices: { message: string; level: string }[] = [];
const statuses: (string | undefined)[] = [];

function ctx(model?: { provider: string; id: string; api?: string }) {
  return {
    hasUI: true,
    model,
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  };
}

const onAllowlist = { provider: "openai", api: "openai-responses", id: "gpt-5.6" };
const offAllowlist = { provider: "anthropic", id: "claude-opus-5" };

beforeEach(() => {
  notices.length = 0;
  statuses.length = 0;
});

test("leaves the payload untouched while disabled", () => {
  const pi = boot();
  pi.sessionStart(ctx(onAllowlist));
  expect(pi.request({ model: "gpt-5.6" }, ctx(onAllowlist))).toBeUndefined();
});

test("injects the priority tier once enabled on an allowlisted model", async () => {
  const pi = boot();
  pi.sessionStart(ctx(onAllowlist));
  await pi.command("on");
  expect(pi.request({ model: "gpt-5.6" }, ctx(onAllowlist))).toEqual({
    model: "gpt-5.6",
    service_tier: "priority",
  });
});

// The allowlist is exact pairs, not a prefix match, because sending
// `service_tier` to a provider that rejects unknown fields fails the whole
// request — a wrong guess costs a turn rather than degrading quietly.
test("does not inject on a model that is not on the allowlist", async () => {
  const pi = boot();
  pi.sessionStart(ctx(offAllowlist));
  await pi.command("on");
  expect(pi.request({ model: "claude-opus-5" }, ctx(offAllowlist))).toBeUndefined();
});

test("does not inject for a lookalike provider on the same model id", async () => {
  const pi = boot();
  await pi.command("on");
  const lookalike = { provider: "krill", id: "gpt-5.6" };
  expect(pi.request({ model: "gpt-5.6" }, ctx(lookalike))).toBeUndefined();
});

test("does not inject when no model is selected", async () => {
  const pi = boot();
  await pi.command("on");
  expect(pi.request({ model: "x" }, ctx(undefined))).toBeUndefined();
});

test("leaves a non-object payload alone rather than spreading it", async () => {
  const pi = boot();
  await pi.command("on");
  expect(pi.request("not an object", ctx(onAllowlist))).toBeUndefined();
  expect(pi.request([1, 2], ctx(onAllowlist))).toBeUndefined();
  expect(pi.request(null, ctx(onAllowlist))).toBeUndefined();
});

test("preserves every other payload field", async () => {
  const pi = boot();
  await pi.command("on");
  const injected = pi.request({ model: "gpt-5.6", input: [1], reasoning: { effort: "high" } }, ctx(onAllowlist));
  expect(injected).toEqual({
    model: "gpt-5.6",
    input: [1],
    reasoning: { effort: "high" },
    service_tier: "priority",
  });
});

test("`off` stops injecting again", async () => {
  const pi = boot();
  await pi.command("on");
  await pi.command("off");
  expect(pi.request({ model: "gpt-5.6" }, ctx(onAllowlist))).toBeUndefined();
});

test("`toggle` and a bare invocation both flip the current state", async () => {
  const pi = boot();
  await pi.command("toggle");
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeDefined();
  await pi.command("");
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeUndefined();
});

test("rejects an unrecognized argument without changing state", async () => {
  const pi = boot();
  await pi.command("on");
  await pi.command("maybe");
  expect(notices.at(-1)?.level).toBe("error");
  // Still on — a typo must not silently turn the feature off.
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeDefined();
});

test("persists across a restart", async () => {
  const first = boot();
  await first.command("on");
  expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))["pi-gpt-fast"]).toEqual({
    enabled: true,
  });

  const second = boot();
  second.sessionStart(ctx(onAllowlist));
  expect(second.request({ m: 1 }, ctx(onAllowlist))).toBeDefined();
});

// pi owns this file too, so the write is read-modify-write at write time
// rather than from a cached snapshot — a stale copy would revert pi's changes.
test("preserves unrelated settings when persisting", async () => {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", "pi-gpt-fast": { other: 1 } }));
  const pi = boot();
  await pi.command("on");
  const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  expect(saved.theme).toBe("dark");
  expect(saved["pi-gpt-fast"]).toEqual({ other: 1, enabled: true });
});

test("survives a corrupt settings file instead of failing the session", () => {
  writeFileSync(join(agentDir, "settings.json"), "{ not json");
  const pi = boot();
  pi.sessionStart(ctx(onAllowlist));
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeUndefined();
});

test("the launch flag enables it without a stored setting", () => {
  const pi = boot(true);
  pi.sessionStart(ctx(onAllowlist));
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeDefined();
});

// "armed" is the distinction that keeps a silent no-op from looking identical
// to a working fast mode: the toggle is on, but this model gets nothing.
test("distinguishes `fast` from `fast (armed)` in the status", async () => {
  const pi = boot();
  await pi.command("on");
  statuses.length = 0;
  pi.modelSelect(ctx(onAllowlist));
  expect(statuses.at(-1)).toBe("fast");
  pi.modelSelect(ctx(offAllowlist));
  expect(statuses.at(-1)).toBe("fast (armed)");
});

test("clears the status when disabled", async () => {
  const pi = boot();
  await pi.command("on");
  statuses.length = 0;
  await pi.command("off");
  expect(statuses.at(-1)).toBeUndefined();
});

test("warns when enabled on a model the allowlist does not cover", async () => {
  const pi = boot();
  await pi.command("on", ctx(offAllowlist));
  expect(notices.at(-1)?.level).toBe("warning");
  expect(notices.at(-1)?.message).toContain("not on the priority allowlist");
});

test("confirms the model by name when enabled on an allowlisted one", async () => {
  const pi = boot();
  await pi.command("on", ctx(onAllowlist));
  expect(notices.at(-1)?.level).toBe("info");
  expect(notices.at(-1)?.message).toContain("openai/gpt-5.6");
});

test("both settings readers accept a BOM and preserve unrelated keys", async () => {
  const path = join(agentDir, "settings.json");
  writeFileSync(path, '\uFEFF{"theme":"dark","pi-gpt-fast":{"enabled":true,"other":1}}');
  const pi = boot();
  pi.sessionStart(ctx(onAllowlist));
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeDefined();
  await pi.command("off");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    theme: "dark",
    "pi-gpt-fast": { enabled: false, other: 1 },
  });
});

for (const bytes of ["{ not json", "", "null", "[]", "42", '{"pi-gpt-fast":false}', '{"pi-gpt-fast":null}']) {
  test(`invalid settings remain byte-for-byte unchanged: ${JSON.stringify(bytes)}`, async () => {
    const path = join(agentDir, "settings.json");
    writeFileSync(path, bytes);
    await boot().command("on");
    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
    expect(notices.some(({ message }) => message.includes("could not persist state"))).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(readdirSync(agentDir)).toEqual(["settings.json"]);
  });
}

test("an unreadable settings target is not replaced", async () => {
  const path = join(agentDir, "settings.json");
  mkdirSync(path);
  writeFileSync(join(path, "retained"), "untouched");
  await boot().command("on");
  expect(readFileSync(join(path, "retained"), "utf8")).toBe("untouched");
  expect(notices.some(({ message }) => message.includes("could not persist state"))).toBe(true);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("a lock acquisition failure cannot create or overwrite settings", async () => {
  const path = join(agentDir, "settings.json");
  const lock = spyOn(lockfile, "lockSync").mockImplementation(() => {
    throw Object.assign(new Error("lock denied"), { code: "EACCES" });
  });
  try {
    await boot().command("on");
    expect(existsSync(path)).toBe(false);
    expect(lock).toHaveBeenCalledWith(path, { realpath: false });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(notices.some(({ message }) => message.includes("lock denied"))).toBe(true);
  } finally {
    lock.mockRestore();
  }
});

test("contention with the host settings lock never falls back to an unlocked write", async () => {
  const path = join(agentDir, "settings.json");
  writeFileSync(path, '{"theme":"retained"}');
  const release = lockfile.lockSync(path, { realpath: false });
  try {
    await boot().command("on");
    expect(readFileSync(path, "utf8")).toBe('{"theme":"retained"}');
    expect(existsSync(`${path}.lock`)).toBe(true); // Do not release another writer's lock.
    expect(notices.some(({ message }) => message.includes("could not persist state"))).toBe(true);
  } finally {
    release();
  }
});

test("an absent settings file is created only under the same host lock", async () => {
  const path = join(agentDir, "settings.json");
  const acquire = lockfile.lockSync;
  let released = false;
  const lock = spyOn(lockfile, "lockSync").mockImplementation((target, options) => {
    expect(target).toBe(path);
    expect(options).toEqual({ realpath: false });
    expect(existsSync(path)).toBe(false);
    const release = acquire(target, options);
    return () => {
      expect(JSON.parse(readFileSync(path, "utf8"))["pi-gpt-fast"]).toEqual({ enabled: true });
      expect(existsSync(`${path}.lock`)).toBe(true);
      release();
      released = true;
    };
  });
  try {
    await boot().command("on");
    expect(released).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally {
    lock.mockRestore();
  }
});

test("a release failure is reported after the atomic settings update", async () => {
  const path = join(agentDir, "settings.json");
  writeFileSync(path, '{"theme":"retained"}');
  const acquire = lockfile.lockSync;
  const lock = spyOn(lockfile, "lockSync").mockImplementation((target, options) => {
    const release = acquire(target, options);
    return () => {
      release();
      throw new Error("release failed");
    };
  });
  try {
    await boot().command("on");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "retained", "pi-gpt-fast": { enabled: true } });
    expect(notices.some(({ message }) => message.includes("release failed"))).toBe(true);
    expect(readdirSync(agentDir)).toEqual(["settings.json"]);
  } finally {
    lock.mockRestore();
  }
});

test("a host update at lock acquisition is read before merging the toggle", async () => {
  const path = join(agentDir, "settings.json");
  writeFileSync(path, '{"theme":"old","unrelated":1}');
  const acquire = lockfile.lockSync;
  const lock = spyOn(lockfile, "lockSync").mockImplementation((target, options) => {
    // Gate an independent host writer immediately before our lock acquisition.
    // Reading before lockSync would capture "old" and overwrite the host update.
    const host = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `import { SettingsManager } from "@earendil-works/pi-coding-agent";
         const host = SettingsManager.create(${JSON.stringify(agentDir)}, ${JSON.stringify(agentDir)});
         host.setTheme("host-updated");
         await host.flush();
         if (host.drainErrors().length) process.exit(1);`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(host.status).toBe(0);
    return acquire(target, options);
  });
  try {
    await boot().command("on");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      theme: "host-updated",
      unrelated: 1,
      "pi-gpt-fast": { enabled: true },
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally {
    lock.mockRestore();
  }
});

test("a deterministic concurrent host settings update preserves both owners' keys", async () => {
  const path = join(agentDir, "settings.json");
  writeFileSync(path, '{"theme":"old","unrelated":1}', { mode: 0o600 });
  const host = SettingsManager.create(agentDir, agentDir);
  const pi = boot();
  pi.sessionStart(ctx(onAllowlist));
  // Queue a host write with its old snapshot, but do not flush before the toggle.
  // The extension writes first; the pending host write must merge under its lock.
  host.setTheme("new");
  const toggled = pi.command("on");
  await Promise.all([toggled, host.flush()]);
  expect(host.drainErrors()).toEqual([]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    theme: "new",
    unrelated: 1,
    "pi-gpt-fast": { enabled: true },
  });
  // Reverse the ordering too: the extension must read the host's latest bytes,
  // not the settings snapshot from session_start.
  host.setTheme("newer");
  await host.flush();
  await pi.command("off");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    theme: "newer",
    unrelated: 1,
    "pi-gpt-fast": { enabled: false },
  });
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(agentDir)).toEqual(["settings.json"]);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

for (const [provider, api] of [
  ["openai", "openai-responses"],
  ["openai-codex", "openai-codex-responses"],
]) {
  for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    test(`eligible tuple ${provider}/${api}/${id} receives priority without mutating the original`, () => {
      const pi = boot(true);
      const context = ctx({ provider, api, id });
      pi.sessionStart(context);
      const payload = { service_tier: "flex", unknown: { retained: true } };
      expect(pi.request(payload, context)).toEqual({ ...payload, service_tier: "priority" });
      expect(payload.service_tier).toBe("flex");
    });
  }
  for (const unsupportedApi of [
    undefined,
    "openai-completions",
    "anthropic-messages",
    "openai-responses-other",
    api === "openai-responses" ? "openai-codex-responses" : "openai-responses",
  ]) {
    test(`leaves unsupported API untouched: ${provider}/${unsupportedApi}`, async () => {
      const context = ctx({ provider, api: unsupportedApi, id: "gpt-5.6" });
      const pi = boot(true);
      pi.sessionStart(context);
      const payload = { service_tier: "flex", unknown: { retained: true } };
      expect(pi.request(payload, context)).toBeUndefined();
      expect(payload).toEqual({ service_tier: "flex", unknown: { retained: true } });
      expect(statuses.at(-1)).toBe("fast (armed)");
    });
  }
  for (const id of ["gpt-5", "gpt-5.7", "gpt-5.6-sol-extra", "GPT-5.6"]) {
    test(`does not broaden the exact model allowlist: ${provider}/${id}`, () => {
      const context = ctx({ provider, api, id });
      const pi = boot(true);
      pi.sessionStart(context);
      expect(pi.request({ input: [] }, context)).toBeUndefined();
    });
  }
}

for (const initialMode of [undefined, 0o600, 0o400, 0o200, 0o644]) {
  test(`settings and temporary bytes stay private under umask 022: initial mode ${initialMode?.toString(8) ?? "absent"}`, () => {
    const path = join(agentDir, "settings.json");
    if (initialMode !== undefined) {
      writeFileSync(path, '{"unknown":{"retained":true}}');
      chmodSync(path, initialMode);
    }
    // Subprocess isolates umask and permits deterministic mode checks in the
    // same process that writes. Read-only targets may be unreadable to an
    // unprivileged owner when their initial mode is write-only.
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      import assert from "node:assert/strict";
      import * as fs from "node:fs";
      import { writeEnabled } from ${JSON.stringify(new URL("../src/settings.ts", import.meta.url).href)};
      process.umask(0o022);
      const path = ${JSON.stringify(path)};
      const mode = ${initialMode === undefined ? "undefined" : initialMode};
      if (mode === 0o200 && process.getuid() !== 0) {
        assert.throws(() => writeEnabled(true));
      } else {
        for (const enabled of [true, false]) {
          writeEnabled(enabled);
          assert.equal(fs.lstatSync(path).mode & 0o777, (mode ?? 0o600) & 0o600);
          if (mode === 0o200) fs.chmodSync(path, 0o600);
          const settings = JSON.parse(fs.readFileSync(path, "utf8"));
          assert.equal(settings["pi-gpt-fast"].enabled, enabled);
          if (mode !== undefined) assert.deepEqual(settings.unknown, { retained: true });
          if (mode === 0o200) fs.chmodSync(path, mode);
        }
      }
      assert.deepEqual(fs.readdirSync(${JSON.stringify(agentDir)}), ["settings.json"]);
    `,
      ],
      { env: process.env, encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
}

test("a symlink settings target is never read, replaced, or followed", async () => {
  const target = join(agentDir, "actual.json");
  const path = join(agentDir, "settings.json");
  const bytes = '{"secret":"retained","pi-gpt-fast":{"enabled":true}}';
  writeFileSync(target, bytes);
  symlinkSync(target, path);
  const pi = boot();
  pi.sessionStart(ctx(onAllowlist));
  expect(pi.request({}, ctx(onAllowlist))).toBeUndefined();
  for (const state of ["on", "off"]) {
    await pi.command(state);
    expect(readFileSync(target, "utf8")).toBe(bytes);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(notices.some(({ message }) => message.includes("regular file"))).toBe(true);
    expect(readdirSync(agentDir).sort()).toEqual(["actual.json", "settings.json"]);
  }
});

test("failed atomic rename leaves settings intact and removes its private temp under the lock", async () => {
  const path = join(agentDir, "settings.json");
  const bytes = '{"secret":"retained"}';
  writeFileSync(path, bytes, { mode: 0o600 });
  const rename = spyOn(fs, "renameSync").mockImplementation((source, target) => {
    expect(target).toBe(path);
    expect(existsSync(`${path}.lock`)).toBe(true);
    expect(lstatSync(source).mode & 0o777).toBe(0o600);
    throw new Error("rename denied");
  });
  try {
    await boot().command("on");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(notices.some(({ message }) => message.includes("rename denied"))).toBe(true);
    expect(readdirSync(agentDir)).toEqual(["settings.json"]);
  } finally {
    rename.mockRestore();
  }
});

test("a target replaced with a symlink before rename is rejected with no temp or lock leak", async () => {
  const path = join(agentDir, "settings.json");
  const target = join(agentDir, "actual.json");
  writeFileSync(path, '{"theme":"old"}', { mode: 0o600 });
  writeFileSync(target, '{"secret":"retained"}');
  const chmod = fs.fchmodSync;
  const change = spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
    chmod(fd, mode);
    rmSync(path);
    symlinkSync(target, path);
  });
  try {
    await boot().command("on");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe('{"secret":"retained"}');
    expect(readdirSync(agentDir).sort()).toEqual(["actual.json", "settings.json"]);
    expect(notices.some(({ message }) => message.includes("could not persist state"))).toBe(true);
  } finally {
    change.mockRestore();
  }
});
