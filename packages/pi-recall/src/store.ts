import { randomUUID } from "node:crypto";
import {
  mkdir as mkdirCallback,
  mkdirSync,
  realpath as realpathCallback,
  realpathSync,
  rmdir as rmdirCallback,
  rmdirSync,
  stat as statCallback,
  statSync,
  utimes as utimesCallback,
  utimesSync,
} from "node:fs";
import { constants, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import lockfile from "proper-lockfile";
import {
  candidateIdentity,
  isValidTimestamp,
  MAX_MESSAGE_TEXT_BYTES,
  type MessageCandidate,
  type RecallMessageRecord,
} from "./messages.js";

export const MAX_RECALL_RECORDS = 200;
export const MAX_RECALL_FILE_BYTES = 12 * 1024 * 1024;

const LOCK_RETRY_MIN_MS = 10;
const LOCK_RETRY_MAX_MS = 200;
const LOCK_STALE_MS = 30_000;

const LOCKFILE_FS_ADAPTER = {
  mkdir: mkdirCallback,
  mkdirSync,
  realpath: realpathCallback,
  realpathSync,
  rmdir: rmdirCallback,
  rmdirSync,
  stat: statCallback,
  statSync,
  utimes: utimesCallback,
  utimesSync,
};

export class RecallStoreFormatError extends Error {}
export class RecallStoreLimitError extends Error {}
export class RecallStoreDuplicateError extends Error {}

export interface RecallStoreSnapshot {
  path: string;
  records: RecallMessageRecord[];
  bytes: number;
}

interface RecallStoreOptions {
  now?: () => number;
  createId?: () => string;
  beforeRename?: (temporaryPath: string, canonicalPath: string) => Promise<void>;
}

export class RecallStore {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly beforeRename?: RecallStoreOptions["beforeRename"];

  constructor(
    readonly path: string,
    options: RecallStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.beforeRename = options.beforeRename;
  }

  async load(signal?: AbortSignal, isCurrent?: () => boolean): Promise<RecallStoreSnapshot> {
    const assertCurrent = () => throwIfStale(signal, isCurrent);
    assertCurrent();
    const exists = await this.fileOrLockExists();
    assertCurrent();
    if (!exists) return { path: this.path, records: [], bytes: 0 };
    return this.withLock(signal, async () => {
      const contents = await readPrivateRegularFileIfExists(this.path, assertCurrent);
      assertCurrent();
      return snapshotFromContents(this.path, contents);
    });
  }

  async save(
    candidate: MessageCandidate,
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<RecallMessageRecord> {
    throwIfStale(signal, isCurrent);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    return this.withLock(signal, async (checkCompromised) => {
      throwIfStale(signal, isCurrent);
      const contents = await readPrivateRegularFileIfExists(this.path, () => throwIfStale(signal, isCurrent));
      throwIfStale(signal, isCurrent);
      const current = snapshotFromContents(this.path, contents).records;
      const identity = candidateIdentity(candidate.source.sessionId, candidate.entryId);
      if (current.some((record) => candidateIdentity(record.source.sessionId, record.source.entryId) === identity)) {
        throw new RecallStoreDuplicateError("This message is already saved in Pi Recall");
      }
      if (current.length >= MAX_RECALL_RECORDS) {
        throw new RecallStoreLimitError(`Pi Recall supports at most ${MAX_RECALL_RECORDS} saved messages`);
      }
      const record = createRecord(candidate, this.createId(), this.now());
      if (current.some(({ id }) => id === record.id)) {
        throw new RecallStoreFormatError(`Pi Recall generated duplicate ID ${record.id}`);
      }
      const next = serializeRecords([...current, record]);
      throwIfStale(signal, isCurrent);
      checkCompromised();
      await this.publish(next, () => {
        throwIfStale(signal, isCurrent);
        checkCompromised();
      });
      checkCompromised();
      return record;
    });
  }

  async delete(id: string, signal?: AbortSignal, isCurrent?: () => boolean): Promise<boolean> {
    throwIfStale(signal, isCurrent);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    return this.withLock(signal, async (checkCompromised) => {
      throwIfStale(signal, isCurrent);
      const contents = await readPrivateRegularFileIfExists(this.path, () => throwIfStale(signal, isCurrent));
      throwIfStale(signal, isCurrent);
      const current = snapshotFromContents(this.path, contents).records;
      const nextRecords = current.filter((record) => record.id !== id);
      if (nextRecords.length === current.length) return false;
      const next = serializeRecords(nextRecords);
      throwIfStale(signal, isCurrent);
      checkCompromised();
      await this.publish(next, () => {
        throwIfStale(signal, isCurrent);
        checkCompromised();
      });
      checkCompromised();
      return true;
    });
  }

  private async withLock<T>(
    signal: AbortSignal | undefined,
    operation: (checkCompromised: () => void) => Promise<T>,
  ): Promise<T> {
    let compromised: Error | undefined;
    const release = await acquireLock(this.path, signal, (error) => {
      compromised = error;
    });
    const checkCompromised = () => {
      if (compromised) throw compromised;
    };
    try {
      throwIfAborted(signal);
      checkCompromised();
      return await operation(checkCompromised);
    } finally {
      await release().catch(() => undefined);
    }
  }

  private async fileOrLockExists(): Promise<boolean> {
    if (await pathExists(this.path)) return true;
    if (await pathExists(`${this.path}.lock`)) return true;
    return pathExists(this.path);
  }

  private async publish(contents: string, assertCurrent: () => void): Promise<void> {
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await this.beforeRename?.(temporaryPath, this.path);
      // No await between this ownership check and dispatching the canonical mutation.
      assertCurrent();
      // Replacement retains the already-private temporary file's permissions.
      await rename(temporaryPath, this.path);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function createRecord(candidate: MessageCandidate, id: string, now: number): RecallMessageRecord {
  if (!id.trim()) throw new RecallStoreFormatError("Pi Recall generated an empty record ID");
  if (!isValidTimestamp(now)) throw new RecallStoreFormatError("Pi Recall received an invalid clock");
  if (
    !candidate.text.trim() ||
    Buffer.byteLength(candidate.text, "utf8") > MAX_MESSAGE_TEXT_BYTES ||
    !nonEmptyString(candidate.entryId) ||
    !nonEmptyString(candidate.source.sessionId) ||
    !isAbsolute(candidate.source.cwd) ||
    !isValidTimestamp(candidate.messageTimestamp)
  ) {
    throw new RecallStoreFormatError("Pi Recall received an invalid message candidate");
  }
  return {
    type: "recall_message",
    version: 1,
    id,
    savedAt: new Date(now).toISOString(),
    source: {
      sessionId: candidate.source.sessionId,
      entryId: candidate.entryId,
      ...(candidate.source.sessionName ? { sessionName: candidate.source.sessionName } : {}),
      cwd: candidate.source.cwd,
      messageTimestamp: candidate.messageTimestamp,
    },
    role: candidate.role,
    text: candidate.text,
  };
}

function snapshotFromContents(path: string, contents: string | undefined): RecallStoreSnapshot {
  if (contents === undefined || contents === "") return { path, records: [], bytes: 0 };
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > MAX_RECALL_FILE_BYTES) {
    throw new RecallStoreLimitError(`Pi Recall storage exceeds ${MAX_RECALL_FILE_BYTES} bytes and is read-only`);
  }
  const lines = contents.endsWith("\n") ? contents.slice(0, -1).split("\n") : contents.split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new RecallStoreFormatError("Pi Recall storage contains an empty JSONL record");
  }
  if (lines.length > MAX_RECALL_RECORDS) {
    throw new RecallStoreLimitError(
      `Pi Recall storage contains more than the supported at most ${MAX_RECALL_RECORDS} records`,
    );
  }
  const records = lines.map((line, index) => parseRecord(line, index + 1));
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new RecallStoreFormatError(`Pi Recall storage contains duplicate ID ${record.id}`);
    }
    ids.add(record.id);
  }
  return { path, records, bytes };
}

function parseRecord(line: string, lineNumber: number): RecallMessageRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new RecallStoreFormatError(`Pi Recall storage has invalid JSON on line ${lineNumber}`);
  }
  if (!isRecord(value)) throw invalidRecord(lineNumber);
  if (value.type !== "recall_message" || value.version !== 1) {
    throw new RecallStoreFormatError(
      `Pi Recall storage has an unsupported record type or version on line ${lineNumber}`,
    );
  }
  if (
    !nonEmptyString(value.id) ||
    !isIsoTimestamp(value.savedAt) ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    Buffer.byteLength(value.text, "utf8") > MAX_MESSAGE_TEXT_BYTES ||
    !isRecord(value.source) ||
    !nonEmptyString(value.source.sessionId) ||
    !nonEmptyString(value.source.entryId) ||
    (value.source.sessionName !== undefined && typeof value.source.sessionName !== "string") ||
    !nonEmptyString(value.source.cwd) ||
    !isAbsolute(value.source.cwd) ||
    typeof value.source.messageTimestamp !== "number" ||
    !isValidTimestamp(value.source.messageTimestamp)
  ) {
    throw invalidRecord(lineNumber);
  }
  return value as RecallMessageRecord;
}

function serializeRecords(records: readonly RecallMessageRecord[]): string {
  if (records.length > MAX_RECALL_RECORDS) {
    throw new RecallStoreLimitError(`Pi Recall supports at most ${MAX_RECALL_RECORDS} records`);
  }
  const contents = records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_RECALL_FILE_BYTES) {
    throw new RecallStoreLimitError(`Pi Recall storage would exceed ${MAX_RECALL_FILE_BYTES} bytes`);
  }
  return contents;
}

async function readPrivateRegularFileIfExists(path: string, assertCurrent: () => void): Promise<string | undefined> {
  assertCurrent();
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new RecallStoreFormatError(`Pi Recall storage path must be a regular file: ${path}`);
  }
  assertCurrent();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assertCurrent();
    const after = await handle.stat();
    assertCurrent();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new RecallStoreFormatError(`Pi Recall storage path must be a stable regular file: ${path}`);
    }
    if (after.size > MAX_RECALL_FILE_BYTES) {
      throw new RecallStoreLimitError(`Pi Recall storage exceeds ${MAX_RECALL_FILE_BYTES} bytes and is read-only`);
    }
    const bytes = await handle.readFile();
    assertCurrent();
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new RecallStoreFormatError("Pi Recall storage contains invalid UTF-8 and is read-only");
    }
    // Invalid storage is read-only, including permission bits. Validate the
    // complete JSONL before repairing this already-open canonical descriptor.
    snapshotFromContents(path, contents);
    assertCurrent();
    await handle.chmod(0o600);
    assertCurrent();
    return contents;
  } finally {
    await handle.close();
  }
}

async function acquireLock(
  path: string,
  signal: AbortSignal | undefined,
  onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
  let delayMs = LOCK_RETRY_MIN_MS;
  while (true) {
    throwIfAborted(signal);
    try {
      return await lockfile.lock(path, {
        fs: LOCKFILE_FS_ADAPTER,
        realpath: false,
        retries: 0,
        stale: LOCK_STALE_MS,
        onCompromised,
      });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ELOCKED") throw error;
      await abortableDelay(delayMs, signal);
      delayMs = Math.min(LOCK_RETRY_MAX_MS, delayMs * 2);
    }
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function throwIfStale(signal: AbortSignal | undefined, isCurrent: (() => boolean) | undefined): void {
  throwIfAborted(signal);
  if (isCurrent && !isCurrent()) throw new DOMException("Pi Recall operation is no longer current", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function invalidRecord(line: number): RecallStoreFormatError {
  return new RecallStoreFormatError(`Pi Recall storage has an invalid record on line ${line}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
