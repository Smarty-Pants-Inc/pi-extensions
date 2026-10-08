import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

/** Unknown filesystem errors must not turn an ordinary CLI failure into a missing-binary hint. */
export async function executableAvailable(command: string, cwd: string): Promise<boolean | undefined> {
  const windows = process.platform === "win32";
  const envValue = (name: string): string | undefined =>
    process.env[Object.keys(process.env).find((key) => (windows ? key.toUpperCase() === name : key === name)) ?? name];
  const path = envValue("PATH") ?? (windows ? "" : "/usr/bin:/bin");
  const directories =
    isAbsolute(command) || /[/\\]/u.test(command) ? [""] : [...(windows ? [cwd] : []), ...path.split(delimiter)];
  // Direct Windows spawning also probes .COM/.EXE independently of PATHEXT;
  // shell launchers may resolve additional extensions. Probe their union so
  // neither route can falsely confirm absence.
  const extensions =
    windows && !/\.[^/\\]+$/u.test(command)
      ? ["", ".COM", ".EXE", ...(envValue("PATHEXT") ?? ".BAT;.CMD").split(";")]
      : [""];
  let unknown = false;
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, windows ? directory.replace(/^"(.*)"$/u, "$1") : directory, command + extension);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") unknown = true;
      }
    }
  }
  return unknown ? undefined : false;
}
