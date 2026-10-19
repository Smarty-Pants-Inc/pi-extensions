import { closeSync, openSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const MAX_EXPORT_ATTEMPTS = 100;

/** Create a private export without replacing regular files or following links. */
export function writePrivateExport(
  directory: string,
  name: string,
  content: string,
  write: (fd: number, content: string) => void = writeFileSync,
): string {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let attempt = 0; attempt < MAX_EXPORT_ATTEMPTS; attempt++) {
    const path = join(directory, attempt === 0 ? name : `${stem}-${attempt}${extension}`);
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
    try {
      write(fd, content);
    } finally {
      closeSync(fd);
      // The directory may be shared. Even an inode check before unlink would
      // race with path replacement, so failed private artifacts are retained.
      // Never inspect and then delete a path we cannot exclusively own.
    }
    return path;
  }
  throw new Error("Too many existing export filenames; no file was overwritten.");
}
