import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import type { DefaultPackageManager, ResolvedResource } from "@earendil-works/pi-coding-agent";

/** Built-in identifiers and missing resources retain their original identity. */
export function extensionResourceIdentity(path: string): string {
  if (path.startsWith("builtin:") || path.startsWith("<")) return path;
  try { return realpathSync(path); } catch { return resolve(path); }
}

function packageShortName(root: string): string | undefined {
  try {
    const name: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).name;
    return typeof name === "string" ? name.split("/").pop()?.toLowerCase() : undefined;
  } catch { return undefined; }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Find candidate roots only; the public resolver decides which own the entry. */
function candidatePackageRoots(entry: string): string[] {
  if (entry.startsWith("builtin:") || entry.startsWith("<")) return [];
  const roots: string[] = [];
  let dir = isDirectory(entry) ? entry : dirname(entry);
  for (;;) {
    if (basename(dir) === "node_modules") break;
    if (existsSync(join(dir, "package.json"))) roots.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/** Only Node's supported module entry, never factory evaluation or sibling scanning. */
function resourceIdentities(path: string): string[] {
  const identity = extensionResourceIdentity(path);
  if (!isDirectory(identity)) return [identity];
  try {
    return [identity, extensionResourceIdentity(createRequire(join(identity, "package.json")).resolve(identity))];
  } catch { return [identity]; }
}

/** Union aliases for admission/exclusion; keep declared ownership separate for priority. */
export async function resolveExtensionResourceNames(
  resources: ResolvedResource[],
  packages: DefaultPackageManager,
  pathNames: (path: string) => string[],
): Promise<{ names: Map<string, string[]>; packageName: (resource: ResolvedResource) => string | undefined }> {
  const entries = new Map<string, { paths: Set<string>; names: Set<string>; owners: Set<string> }>();
  for (const resource of resources) {
    const identity = extensionResourceIdentity(resource.path);
    let entry = entries.get(identity);
    if (!entry) {
      entry = { paths: new Set([identity]), names: new Set(), owners: new Set() };
      entries.set(identity, entry);
    }
    entry.paths.add(resource.path);
    if (resource.metadata.packageRoot) {
      const name = packageShortName(resource.metadata.packageRoot);
      if (name) entry.owners.add(name);
    }
  }
  const probes = new Map<string, Set<string>>();
  const canonicalOwners = new Map<string, string>();
  for (const [identity, entry] of entries) {
    for (const path of entry.paths) {
      for (const name of pathNames(path)) entry.names.add(name);
    }
    // A lexical file alias must not conceal the canonical declaring package.
    // A nearer non-owning manifest must not stop ancestor discovery either.
    for (const root of candidatePackageRoots(identity)) {
      let declared = probes.get(root);
      if (!declared) {
        const resolved = await packages.resolveExtensionSources([root], { temporary: true });
        // Enabled is a selection preference, not evidence of file ownership.
        declared = new Set(resolved.extensions.flatMap(resource => resourceIdentities(resource.path)));
        probes.set(root, declared);
      }
      if (declared.has(identity)) {
        const name = packageShortName(root);
        if (name) {
          entry.owners.add(name);
          if (!canonicalOwners.has(identity)) canonicalOwners.set(identity, name);
        }
      }
    }
    for (const name of entry.owners) entry.names.add(name);
  }
  const names = new Map<string, string[]>();
  for (const entry of entries.values()) {
    for (const path of entry.paths) names.set(path, [...entry.names]);
  }
  return {
    names,
    // Identical paths can have different declaring metadata. Never key this by
    // path alone. Direct entries use nearest canonical declaring ownership.
    packageName: resource => resource.metadata.packageRoot
      ? packageShortName(resource.metadata.packageRoot)
      : canonicalOwners.get(extensionResourceIdentity(resource.path)),
  };
}
