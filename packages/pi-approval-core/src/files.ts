import { type BigIntStats, constants } from "node:fs";
import { access, type FileHandle, lstat, mkdir, open, stat, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import {
  type ApprovalOperation,
  type ApprovalRequestOptions,
  assertCurrent,
  escapeDisplay,
  MAX_FILE_BYTES,
  MAX_REVIEW_BYTES,
  snapshot,
  validateOperation,
} from "./contract.js";

interface Identity {
  readonly path: string;
  readonly token: string | null;
}
interface Capture {
  readonly path: string;
  readonly bytes: Buffer | null;
  readonly target: string | null;
  readonly ancestors: readonly Identity[];
  readonly descriptorRelative: boolean;
}
interface HeldDirectory {
  readonly handle: FileHandle;
  readonly via: string;
  readonly token: string;
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function token(stat: BigIntStats, target: boolean): string {
  if (target && (!stat.isFile() || stat.nlink !== 1n))
    throw new Error("Approval target must be a regular non-aliased file");
  if (!target && !stat.isDirectory()) throw new Error("Approval ancestor must be a non-symlink directory");
  if (target && stat.size > BigInt(MAX_FILE_BYTES)) throw new Error("File exceeds approval size limit");
  // Inode identities can exceed Number precision on Linux and macOS. Preserve
  // exact identity and nanosecond timestamps at this approval trust boundary.
  return JSON.stringify(
    [stat.dev, stat.ino, stat.mode, ...(target ? [stat.size, stat.mtimeNs, stat.ctimeNs] : [])].map(String),
  );
}
async function identity(path: string, target: boolean): Promise<string | null> {
  try {
    return token(await lstat(path, { bigint: true }), target);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function descriptorPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}
async function closeDirectories(directories: readonly HeldDirectory[]): Promise<void> {
  await Promise.all(directories.map(({ handle }) => handle.close()));
}
async function validateHeld(directories: readonly HeldDirectory[]): Promise<void> {
  for (const directory of directories) {
    if (
      token(await directory.handle.stat({ bigint: true }), false) !== directory.token ||
      (await identity(directory.via, false)) !== directory.token
    )
      throw new Error("Approval ancestor changed while held");
  }
}
async function holdAncestors(path: string, captured?: Capture, options?: ApprovalRequestOptions) {
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path)
    throw new Error("Safe approval file IO requires a normalized absolute file path");
  // Capability detection is separate from identity validation: once procfs is
  // available, no open/stat/identity failure may downgrade to pathname IO.
  let descriptorRelative = false;
  if (process.platform === "linux") {
    try {
      descriptorRelative = (await statfs("/proc/self/fd")).type === 0x9fa0;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["ENOENT", "ENOTDIR", "ENOSYS", "ENOTSUP", "EACCES"].includes(String(error.code))
      )
        throw error;
    }
  }
  if (captured?.descriptorRelative && !descriptorRelative)
    throw new Error("Approval descriptor path capability changed; refusing an unsafe downgrade");
  // Without openat or procfs, held no-follow descriptors and before/after
  // checks detect changes but cannot eliminate an ancestor-swap window.
  const paths: string[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    paths.unshift(parent);
    if (dirname(parent) === parent) break;
  }
  const directories: HeldDirectory[] = [];
  const ancestors: Identity[] = [];
  try {
    for (const [index, parent] of paths.entries()) {
      const previous = directories[index - 1];
      const via =
        index === 0
          ? parent
          : previous
            ? descriptorRelative
              ? `${descriptorPath(previous.handle)}/${basename(parent)}`
              : parent
            : null;
      let current = via === null ? null : await identity(via, false);
      const approved = captured?.ancestors[index];
      if (captured && (!approved || approved.path !== parent || current !== approved.token))
        throw new Error("Approval ancestor changed");
      if (current === null && options && via !== null) {
        assertCurrent(options);
        // Non-recursive mkdir through a held parent. EEXIST is a race, not an
        // invitation to adopt another writer's directory or follow a symlink.
        try {
          await mkdir(via);
        } catch (error) {
          throw new Error("Approval ancestor changed or could not be created safely", { cause: error });
        }
        assertCurrent(options);
        current = await identity(via, false);
        if (current === null) throw new Error("Created approval ancestor disappeared");
      }
      ancestors.push({ path: parent, token: current });
      if (current === null || via === null) continue;
      try {
        const handle = await open(via, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        // Register immediately so every error path closes the new descriptor.
        directories.push({ handle, via, token: current });
        if (
          token(await handle.stat({ bigint: true }), false) !== current ||
          (descriptorRelative && token(await stat(descriptorPath(handle), { bigint: true }), false) !== current)
        )
          throw new Error("Approval ancestor identity changed");
      } catch (error) {
        throw new Error("Approval ancestor identity cannot be held safely", { cause: error });
      }
    }
    await validateHeld(directories);
    const parent = directories.at(-1);
    return {
      directories,
      ancestors,
      descriptorRelative,
      targetPath:
        parent && directories.length === paths.length
          ? descriptorRelative
            ? `${descriptorPath(parent.handle)}/${basename(path)}`
            : path
          : null,
    };
  } catch (error) {
    await closeDirectories(directories);
    throw error;
  }
}
async function boundedRead(handle: FileHandle): Promise<Buffer> {
  token(await handle.stat({ bigint: true }), true);
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let count = 0;
  while (count < buffer.length) {
    const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
    if (!bytesRead) break;
    count += bytesRead;
  }
  if (count > MAX_FILE_BYTES) throw new Error("File exceeds approval size limit");
  const result = buffer.subarray(0, count);
  snapshot(result);
  return result;
}
async function capture(path: string): Promise<Capture> {
  const held = await holdAncestors(path);
  try {
    const target = held.targetPath === null ? null : await identity(held.targetPath, true);
    let bytes: Buffer | null = null;
    if (target !== null && held.targetPath !== null) {
      const handle = await open(held.targetPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (token(await handle.stat({ bigint: true }), true) !== target) throw new Error("Approval target changed");
        bytes = await boundedRead(handle);
        if (token(await handle.stat({ bigint: true }), true) !== target) throw new Error("Approval target changed");
      } finally {
        await handle.close();
      }
    }
    await validateHeld(held.directories);
    if (held.targetPath !== null && (await identity(held.targetPath, true)) !== target)
      throw new Error("Approval target changed");
    return { path, bytes, target, ancestors: held.ancestors, descriptorRelative: held.descriptorRelative };
  } finally {
    await closeDirectories(held.directories);
  }
}
async function pinnedWrite(captured: Capture, after: Buffer, options: ApprovalRequestOptions): Promise<void> {
  const held = await holdAncestors(captured.path, captured, options);
  try {
    if (!held.targetPath) throw new Error("Cannot safely hold approval target parent");
    if ((await identity(held.targetPath, true)) !== captured.target) throw new Error("Approval target changed");
    assertCurrent(options);
    let handle: FileHandle;
    try {
      handle = await open(
        held.targetPath,
        constants.O_RDWR |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (captured.target === null ? constants.O_CREAT | constants.O_EXCL : 0),
        0o666,
      );
    } catch (error) {
      throw new Error("Approval target changed or could not be opened safely", { cause: error });
    }
    try {
      const openedStat = await handle.stat({ bigint: true });
      const opened = token(openedStat, true);
      if (
        (captured.target !== null && opened !== captured.target) ||
        (captured.target === null && openedStat.size !== 0n)
      )
        throw new Error("Approval target identity changed");
      if (captured.bytes !== null && !(await boundedRead(handle)).equals(captured.bytes))
        throw new Error("Approval file contents changed");
      await validateHeld(held.directories);
      if (
        (await identity(held.targetPath, true)) !== opened ||
        token(await handle.stat({ bigint: true }), true) !== opened
      )
        throw new Error("Approval target identity changed while held");
      assertCurrent(options);
      // Positional reads above leave the descriptor offset at zero. Neither
      // opening nor checking an existing file truncates it before validation.
      await handle.writeFile(after);
      assertCurrent(options);
      await handle.truncate(after.length);
      await validateHeld(held.directories);
      assertCurrent(options);
    } finally {
      await handle.close();
    }
  } finally {
    await closeDirectories(held.directories);
  }
}
export interface FileInvocation {
  readonly kind: "write" | "edit";
  readonly cwd: string;
  readonly toolCallId: string;
  readonly source: string;
  readonly inputHash: string;
  readonly options: ApprovalRequestOptions;
  readonly request: (operation: ApprovalOperation, options: ApprovalRequestOptions) => Promise<void>;
}
function review(invocation: FileInvocation, path: string, before: Buffer | null, after: Buffer): ApprovalOperation {
  const prior = before ? snapshot(before) : null;
  const next = snapshot(after);
  // Myers line diff is quadratic for disjoint inputs. Bound tokens BEFORE
  // entering the synchronous SDK diff; byte/payload limits alone cannot do so.
  // split includes a terminal empty token, deliberately a conservative count.
  if ((prior?.text ?? "").split("\n").length + next.text.split("\n").length > 2048)
    throw new Error(
      "File exceeds approval review computational limit (2048 combined line tokens); changes were not clipped",
    );
  // Diff the escaped text so BOM, CRLF and invisible changes are explicit.
  const patch = generateUnifiedPatch(escapeDisplay(path), escapeDisplay(prior?.text ?? ""), escapeDisplay(next.text));
  const preview = `Source: ${invocation.source}\nCWD: ${escapeDisplay(invocation.cwd)}\nFile: ${escapeDisplay(path)}\nEscaped display (backslashes doubled; controls shown as \\u{hex})\nBefore: ${prior?.sha256 ?? "missing"}\nAfter: ${next.sha256}\n${patch}`;
  if (Buffer.byteLength(preview) > MAX_REVIEW_BYTES)
    throw new Error("Generated review exceeds approval size limit; changes were not clipped");
  return validateOperation({
    kind: invocation.kind,
    toolName: invocation.kind,
    source: invocation.source,
    cwd: invocation.cwd,
    toolCallId: invocation.toolCallId,
    inputHash: invocation.inputHash,
    filePath: path,
    before: prior,
    after: next,
    preview,
  });
}
/** Invocation-local operations. The SDK factory owns the only mutation queue. */
export function createFileOperations(invocation: FileInvocation) {
  let original: Capture | undefined;
  return {
    access: (path: string) => access(path, constants.R_OK | constants.W_OK),
    // SDK write calls mkdir before writeFile: deliberately defer it until approval.
    mkdir: async (_dir: string): Promise<void> => {},
    readFile: async (path: string): Promise<Buffer> => {
      assertCurrent(invocation.options);
      original = await capture(path);
      assertCurrent(invocation.options);
      if (!original.bytes) throw new Error("Edit target disappeared");
      return Buffer.from(original.bytes);
    },
    writeFile: async (path: string, content: string): Promise<void> => {
      assertCurrent(invocation.options);
      const captured = invocation.kind === "edit" ? original : await capture(path);
      if (!captured || captured.path !== path) throw new Error("Edit did not capture its input path");
      const after = Buffer.from(content, "utf8");
      if (after.toString("utf8") !== content) throw new Error("Invalid UTF-8 output");
      const operation = review(invocation, path, captured.bytes, after);
      await invocation.request(operation, invocation.options);
      assertCurrent(invocation.options);
      // Failures after approved creation may leave empty files/directories.
      await pinnedWrite(captured, after, invocation.options);
      assertCurrent(invocation.options);
    },
  };
}
