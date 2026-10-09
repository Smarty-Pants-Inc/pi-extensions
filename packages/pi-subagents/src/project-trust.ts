import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, SettingsManager } from "@earendil-works/pi-coding-agent";

// Child contexts report the execution cwd, but their SettingsManager may own
// a different configuration root. Keep that provenance package-internal when
// nested tools forward the child's public context to the manager.
export interface ProjectTrust {
  readonly cwd: string;
  readonly trusted: boolean;
  readonly deniedRoots: readonly string[];
}

const configurationRoots = new WeakMap<ExtensionContext, {
  cwd: string;
  trusted?: boolean;
  deniedRoots: readonly string[];
}>();

export function configurationContext(ctx: ExtensionContext, cwd: string, trust?: ProjectTrust): ExtensionContext {
  const previous = configurationRoots.get(ctx);
  configurationRoots.set(ctx, {
    cwd,
    trusted: trust?.trusted ?? previous?.trusted,
    deniedRoots: Object.freeze([...new Set([...(previous?.deniedRoots ?? []), ...(trust?.deniedRoots ?? [])])]),
  });
  return ctx;
}

/** A changed configuration root is denied; ancestor denials survive every hop. */
export function childProjectTrust(parent: ProjectTrust, cwd: string): ProjectTrust {
  const trusted = parent.trusted && isSameConfiguration(cwd, parent.cwd);
  return Object.freeze({
    cwd: canonicalPath(cwd),
    trusted,
    deniedRoots: Object.freeze([...new Set([...parent.deniedRoots, ...(trusted ? [] : [canonicalPath(cwd)])])]),
  });
}

/** Pi's MCP factory reads config from the session cwd; pin only its bootstrap to the config root. */
export function configurationMcpFactory(factory: ExtensionFactory, cwd: string, settings: SettingsManager): ExtensionFactory {
  return (pi) => factory(new Proxy(pi, {
    get(target, key, receiver) {
      if (key === "on") return ((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        if (event === "session_start") {
          return target.on("session_start", async (event, ctx) => {
            await handler(event, {
              ...ctx,
              cwd,
              isProjectTrusted: () => settings.isProjectTrusted(),
            });
          });
        }
        return Reflect.apply(target.on, target, [event, handler]);
      }) as ExtensionAPI["on"];
      return Reflect.get(target, key, receiver);
    },
  }));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Capture before child resolution/async work; missing or failed trust is denial. */
export function captureProjectTrust(ctx: ExtensionContext): ProjectTrust {
  const provenance = configurationRoots.get(ctx);
  const cwd = canonicalPath(provenance?.cwd ?? ctx.cwd);
  let trusted = false;
  try {
    // Validate the public trust API even with retained authority. If present,
    // prefer the captured configuration trust to a late execution-cwd callback.
    if (typeof ctx.isProjectTrusted === "function") {
      const publicTrust = ctx.isProjectTrusted() === true;
      trusted = provenance?.trusted ?? publicTrust;
    }
  } catch {
    // A context that cannot establish trust must not authorize project code.
  }
  return Object.freeze({
    cwd,
    trusted,
    deniedRoots: Object.freeze([...new Set([...(provenance?.deniedRoots ?? []), ...(trusted ? [] : [cwd])])]),
  });
}

export function isSameConfiguration(cwd: string, parentCwd: string): boolean {
  return canonicalPath(cwd) === parentCwd;
}

/**
 * Check every traversed prefix, including intermediate symlink targets. A
 * global alias into denied metadata cannot gain authority by pointing its
 * descendants back outside. This is provenance admission, not a race-free
 * filesystem sandbox; an absent leaf still has its existing ancestors checked.
 */
export function isProjectResource(path: string, cwd: string): boolean {
  if (path.startsWith("builtin:")) return false;
  const roots = [resolve(cwd), canonicalPath(cwd)];
  const within = (file: string): boolean => roots.some(root => {
    const rel = relative(root, file);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
  const visited = new Set<string>();
  const traverse = (file: string): boolean => {
    // Normalize separator variants, never dot segments. Both resolve and join
    // would erase a traversed symlink before a following ".." is inspected.
    let absolute = sep === "\\" ? file.replaceAll("/", sep) : file;
    if (!isAbsolute(absolute)) {
      const root = parse(absolute).root;
      // Resolve only the base (including Windows drive-relative bases), not
      // the unexamined components supplied by the caller or readlink.
      absolute = `${resolve(root || ".")}${sep}${absolute.slice(root.length)}`;
    }
    let prefix = parse(absolute).root;
    if (within(prefix) || within(canonicalPath(prefix))) return true;
    for (const component of absolute.slice(prefix.length).split(sep)) {
      if (!component) continue;
      prefix = `${prefix}${prefix.endsWith(sep) ? "" : sep}${component}`;
      if (within(prefix) || within(canonicalPath(prefix))) return true;
      try {
        if (!lstatSync(prefix).isSymbolicLink()) continue;
      } catch {
        // No readable descendant can exist beyond an absent/invalid prefix.
        return false;
      }
      // Unknown/cyclic resolution is not evidence of global authority.
      if (visited.has(prefix) || visited.size >= 64) return true;
      visited.add(prefix);
      try {
        const target = readlinkSync(prefix);
        if (traverse(isAbsolute(target) ? target : `${dirname(prefix)}${sep}${target}`)) return true;
      } catch {
        return true;
      } finally {
        visited.delete(prefix);
      }
    }
    return false;
  };
  return traverse(path);
}
