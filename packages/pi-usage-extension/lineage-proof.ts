/** Identical accounting is not identity. Join observations only through a
 * scanned ancestor that actually carries the same entry id and fingerprint. */
export function buildObservationProofs(
  lineage: ReadonlyMap<string, { parentPath?: string }>,
  observations: Iterable<{ filePath: string; identity: string }>,
): Map<string, Map<string, string>> {
  const groups = new Map<string, Map<string, string>>();
  for (const { filePath, identity } of observations) {
    let paths = groups.get(identity);
    if (!paths) {
      paths = new Map();
      groups.set(identity, paths);
    }
    paths.set(filePath, filePath);
  }
  const ancestors = new Map<string, string[]>();
  for (const paths of groups.values()) {
    const root = (path: string): string => {
      const parent = paths.get(path);
      if (!parent || parent === path) return path;
      const found = root(parent);
      paths.set(path, found);
      return found;
    };
    for (const path of paths.keys()) {
      let chain = ancestors.get(path);
      if (!chain) {
        chain = [];
        const visited = new Set([path]);
        let cursor = lineage.get(path)?.parentPath;
        while (cursor && !visited.has(cursor)) {
          visited.add(cursor);
          chain.push(cursor);
          cursor = lineage.get(cursor)?.parentPath;
        }
        ancestors.set(path, chain);
      }
      for (const ancestor of chain) {
        if (!paths.has(ancestor)) continue;
        const left = root(path);
        const right = root(ancestor);
        if (left !== right) paths.set(left < right ? right : left, left < right ? left : right);
      }
    }
    for (const path of paths.keys()) paths.set(path, root(path));
  }
  return groups;
}
