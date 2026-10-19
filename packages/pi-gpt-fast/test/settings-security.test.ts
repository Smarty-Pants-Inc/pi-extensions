import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEnabled } from "../src/settings.js";

let agentDir: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.PI_CODING_AGENT_DIR;
  agentDir = fs.mkdtempSync(join(tmpdir(), "gpt-fast-security-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test("temporary files are exclusive and private before any document bytes are written", () => {
  const path = join(agentDir, "settings.json");
  const open = fs.openSync;
  let temporaries = 0;
  const spy = spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
    const fd = open(target, flags, mode);
    if (String(target).endsWith(".tmp")) {
      temporaries++;
      expect(flags).toBe(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      expect(mode).toBe(0o600);
      expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(fs.fstatSync(fd).size).toBe(0);
      expect(fs.existsSync(`${path}.lock`)).toBe(true);
    }
    return fd;
  });
  try {
    writeEnabled(true);
    writeEnabled(false);
    expect(temporaries).toBe(2);
    expect(fs.readdirSync(agentDir)).toEqual(["settings.json"]);
  } finally {
    spy.mockRestore();
  }
});

test("a regular settings update outside the lock is preserved rather than overwritten", () => {
  const path = join(agentDir, "settings.json");
  fs.writeFileSync(path, '{"theme":"old"}', { mode: 0o600 });
  const changed = '{"theme":"new","unknown":{"retained":true}}';
  const chmod = fs.fchmodSync;
  const spy = spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
    chmod(fd, mode);
    fs.writeFileSync(path, changed);
  });
  try {
    expect(() => writeEnabled(true)).toThrow("changed before replacement");
    expect(fs.readFileSync(path, "utf8")).toBe(changed);
    expect(fs.readdirSync(agentDir)).toEqual(["settings.json"]);
  } finally {
    spy.mockRestore();
  }
});

test("NOFOLLOW rejects a settings target swapped between lstat and open", () => {
  if (!fs.constants.O_NOFOLLOW) return; // lstat still protects hosts without this flag.
  const path = join(agentDir, "settings.json");
  const target = join(agentDir, "actual.json");
  fs.writeFileSync(path, '{"theme":"old"}');
  fs.writeFileSync(target, '{"secret":"retained"}');
  const open = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
    if (candidate === path) {
      expect(Number(flags) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
      fs.rmSync(path);
      fs.symlinkSync(target, path);
    }
    return open(candidate, flags, mode);
  });
  try {
    expect(() => writeEnabled(true)).toThrow();
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe('{"secret":"retained"}');
    expect(fs.readdirSync(agentDir).sort()).toEqual(["actual.json", "settings.json"]);
  } finally {
    spy.mockRestore();
  }
});
