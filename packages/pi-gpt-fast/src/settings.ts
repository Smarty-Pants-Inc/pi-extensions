import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

const SETTINGS_KEY = "pi-gpt-fast";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function regularFile(path: string): Stats | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("settings.json must be a regular file, not a symlink or directory");
    return stat;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameFile(left: Stats | undefined, right: Stats | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}

function readSettings(path: string): { settings: Record<string, unknown>; stat?: Stats } {
  const stat = regularFile(path);
  if (!stat) return { settings: {} };
  // lstat rejects links on all hosts; NOFOLLOW also closes the check/open race
  // where supported. NONBLOCK avoids hanging if a regular target becomes a FIFO.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let content: string;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(stat, opened)) throw new Error("settings.json changed while opening");
    content = readFileSync(fd, "utf8");
    if (!sameFile(stat, fstatSync(fd))) throw new Error("settings.json changed while reading");
  } finally {
    closeSync(fd);
  }
  const settings: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
  if (!isRecord(settings)) throw new Error("settings.json must contain an object");
  if (SETTINGS_KEY in settings && !isRecord(settings[SETTINGS_KEY])) {
    throw new Error(`${SETTINGS_KEY} must contain an object`);
  }
  return { settings, stat };
}

export function readEnabled(): boolean {
  try {
    const { settings } = readSettings(settingsPath());
    const block = settings[SETTINGS_KEY];
    return isRecord(block) && block.enabled === true;
  } catch {
    return false;
  }
}

// Match Pi's shared settings lock and bounded synchronous contention retries.
function acquireSettingsLock(path: string): () => void {
  for (let attempt = 1; ; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      if (!isRecord(error) || error.code !== "ELOCKED" || attempt === 10) throw error;
      const start = Date.now();
      while (Date.now() - start < 20) {
        // Pi's settings storage also retries synchronously.
      }
    }
  }
}

/** Merge the latest settings under Pi's lock, then atomically install private bytes. */
export function writeEnabled(enabled: boolean): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const release = acquireSettingsLock(path);
  let fd: number | undefined;
  let created = false;
  try {
    const { settings, stat } = readSettings(path);
    const block = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
    settings[SETTINGS_KEY] = { ...block, enabled };
    const document = `${JSON.stringify(settings, null, 2)}\n`;
    // Never expose settings (which may contain secrets) with the process's
    // default file mode, even before rename. Exclusivity prevents following links.
    fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    writeFileSync(fd, document, "utf8");
    // Preserve permissions stricter than 0600; never copy group/other access.
    fchmodSync(fd, (stat?.mode ?? 0o600) & 0o600);
    closeSync(fd);
    fd = undefined;
    // Cooperative writers share the lock. Refuse a target swapped by an
    // uncooperative writer rather than replacing a link or unknown new settings.
    if (!sameFile(stat, regularFile(path))) throw new Error("settings.json changed before replacement");
    renameSync(temporaryPath, path);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      try {
        if (created) rmSync(temporaryPath, { force: true });
      } finally {
        release();
      }
    }
  }
}
