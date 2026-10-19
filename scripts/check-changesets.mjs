/**
 * check-changesets.mjs — every package whose PUBLISHED files changed must name
 * itself in a changeset.
 *
 * Versions here are independent (`fixed: []`, `linked: []` in
 * `.changeset/config.json`), which is what lets one package ship a fix without
 * dragging twenty-six unchanged packages to a new version. The cost of that
 * choice is that nothing forces the bump to exist: a package whose source
 * changed but whose name appears in no changeset is simply never released, and
 * npm keeps serving the old code while the repository looks current. That gap
 * is invisible until someone installs the package. This closes it.
 *
 * "Published files" includes the manifest's `files` array and npm's implicit
 * manifest/readme/license/main/bin entries. Tests, tsconfig,
 * and CI edits change the repository without changing the artifact, so they are
 * deliberately not a reason to demand a version.
 *
 * `CHANGELOG.md` is the one published file that is exempt. It is written BY the
 * release, not by the change being released: the Version Packages PR consumes
 * every changeset and writes the changelog in the same commit, so demanding a
 * changeset for it asks for one that was just spent — which failed that PR, and
 * therefore every release, on the first run.
 *
 * Base ref: `CHANGESET_BASE`, else `origin/<default>`, else the local default
 * branch. When none of those resolve — a shallow clone with no remote ref — the
 * check reports that it could not compare and exits 0 rather than failing a
 * build for a reason the author cannot act on. CI fetches full history, so the
 * enforcing run is the one that counts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(root, "packages");
const DEFAULT_BRANCH = "main";
/** Published files the release writes for itself; see the header. */
const RELEASE_GENERATED = new Set([
  "CHANGELOG.md",
  "skills/workflow-authoring/references/capabilities.md",
  "skills/workflow-authoring/references/capability-details.md",
]);
const RELEASE_VERSIONED_SKILLS = new Set([
  "skills/workflow-authoring/SKILL.md",
  "skills/workflow-patterns/SKILL.md",
  "skills/workflow-review/SKILL.md",
]);

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

function normalizeGeneratedSkillVersion(source) {
  return source.replace(/^ {2}version: "[^"]+"$/mu, '  version: "<release>"').trim();
}

function isReleaseVersionOnlySkillChange(file, relative, mergeBase) {
  if (!RELEASE_VERSIONED_SKILLS.has(relative)) return false;
  const before = tryGit(["show", `${mergeBase}:${file}`]);
  if (before === undefined || !existsSync(resolve(root, file))) return false;
  const after = readFileSync(resolve(root, file), "utf8");
  return normalizeGeneratedSkillVersion(before) === normalizeGeneratedSkillVersion(after);
}

/** First ref that exists, so a local checkout and a CI checkout both resolve. */
function resolveBase() {
  const candidates = [process.env.CHANGESET_BASE, `origin/${DEFAULT_BRANCH}`, DEFAULT_BRANCH].filter(
    (candidate) => typeof candidate === "string" && candidate.length > 0,
  );
  for (const candidate of candidates) {
    if (tryGit(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) return candidate;
  }
  return undefined;
}

/**
 * Paths a package publishes, as prefixes relative to the repository root.
 * A `files` entry may name a directory or a single file; both are prefix
 * matches once the directory form ends in a separator.
 */
function publishedPrefixes(directory, manifest) {
  const entries = (Array.isArray(manifest.files) ? manifest.files : ["."]).filter(
    (entry) => !RELEASE_GENERATED.has(entry.replace(/^\.\//u, "")),
  );
  const implicit = [
    "package.json",
    ...new Set(
      [
        ...readdirSync(resolve(packagesRoot, directory)),
        ...changedFiles
          .filter((file) => file.startsWith(`packages/${directory}/`))
          .map((file) => file.slice(`packages/${directory}/`.length))
          .filter((file) => !file.includes("/")),
      ].filter((name) => /^(?:readme|licen[cs]e|copying)(?:\..*)?$/iu.test(name)),
    ),
  ];
  for (const entry of [
    manifest.main,
    ...(typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {})),
  ]) {
    if (typeof entry === "string" && !entry.startsWith("../") && !entry.startsWith("/")) implicit.push(entry);
  }
  return [...new Set([...entries, ...implicit])].map((entry) => {
    const normalized = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    const packagePrefix = `packages/${directory}/`;
    if (normalized === "" || normalized === ".") return packagePrefix;
    const full = `${packagePrefix}${normalized}`;
    const onDisk = resolve(root, full);
    const isDirectory =
      (existsSync(onDisk) && statSync(onDisk).isDirectory()) ||
      tryGit(["cat-file", "-t", `${mergeBase}:${full}`]) === "tree";
    return isDirectory ? `${full}/` : full;
  });
}

/** Package names claimed by the pending changesets, from their YAML frontmatter. */
function releasedPackages() {
  const changesetDir = resolve(root, ".changeset");
  const released = new Set();
  if (!existsSync(changesetDir)) return released;
  for (const name of readdirSync(changesetDir)) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const text = readFileSync(resolve(changesetDir, name), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1];
    if (!frontmatter) continue;
    for (const line of frontmatter.split(/\r?\n/u)) {
      // `"@scope/name": minor` — the quotes are how changesets writes it, but
      // a hand-written file may leave them off.
      const match = /^\s*["']?(@?[^"':\s]+)["']?\s*:\s*(major|minor|patch)\s*$/u.exec(line);
      if (match) released.add(match[1]);
    }
  }
  return released;
}

const base = resolveBase();
if (!base) {
  console.log("check-changesets: no base ref to compare against; skipping");
  process.exit(0);
}

const mergeBase = tryGit(["merge-base", base, "HEAD"]) ?? base;
// Working tree, not `base...HEAD`: run before committing, the change that needs
// a changeset has not reached a commit yet, and that is exactly when saying so
// is useful. On CI the tree is clean, so this is the commit diff.
const changedFiles = [
  ...git(["diff", "--no-renames", "--name-only", mergeBase]).split("\n"),
  ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
].filter((line) => line.length > 0);

if (changedFiles.length === 0) {
  console.log(`check-changesets: no changes against ${base}`);
  process.exit(0);
}

const released = releasedPackages();
const missing = [];
const consumedChangesets = git([
  "diff",
  "--no-renames",
  "--name-only",
  "--diff-filter=D",
  mergeBase,
  "--",
  ".changeset",
])
  .split("\n")
  .filter((file) => /^\.changeset\/[^/]+\.md$/u.test(file) && !file.endsWith("/README.md"));
const consumedPackages = new Set(
  consumedChangesets.flatMap((file) => {
    const text = tryGit(["show", `${mergeBase}:${file}`]) ?? "";
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? "";
    return [...frontmatter.matchAll(/^\s*["']?(@?[^"':\s]+)["']?\s*:\s*(?:major|minor|patch)\s*$/gmu)].map(
      (match) => match[1],
    );
  }),
);

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableJson(entry)]),
    );
  }
  return value;
}

const releaseCandidates = new Map();

/** Validate local edits before proving the consumed-release dependency graph. */
function releaseCandidate(file, directory, after) {
  if (releaseCandidates.has(after.name)) return releaseCandidates.get(after.name);
  releaseCandidates.set(after.name, undefined);
  const source = tryGit(["show", `${mergeBase}:${file}`]);
  if (source === undefined) return undefined;
  let before;
  try {
    before = JSON.parse(source);
  } catch {
    return undefined;
  }
  const old = structuredClone(before);
  const next = structuredClone(after);
  let generated = false;
  const dependencies = new Map();
  if (old.version !== next.version) {
    const changelog = `packages/${directory}/CHANGELOG.md`;
    if (
      !semver.valid(old.version) ||
      !semver.valid(next.version) ||
      !semver.gt(next.version, old.version) ||
      !changedFiles.includes(changelog) ||
      !existsSync(resolve(root, changelog))
    )
      return undefined;
    if (!readFileSync(resolve(root, changelog), "utf8").split(/\r?\n/u).includes(`## ${next.version}`))
      return undefined;
    next.version = old.version;
    generated = true;
  }
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries(next[section] ?? {})) {
      const previous = old[section]?.[name];
      if (range === previous) continue;
      const target = readdirSync(packagesRoot).find((candidate) => {
        const path = resolve(packagesRoot, candidate, "package.json");
        return existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === name;
      });
      if (!target || typeof range !== "string" || typeof previous !== "string") return undefined;
      const targetFile = `packages/${target}/package.json`;
      const targetBefore = tryGit(["show", `${mergeBase}:${targetFile}`]);
      if (!targetBefore) return undefined;
      const oldTarget = JSON.parse(targetBefore);
      const newTarget = JSON.parse(readFileSync(resolve(root, targetFile), "utf8"));
      const workspace = previous.startsWith("workspace:") ? "workspace:" : "";
      const previousRange = previous.slice(workspace.length);
      const match = /^([~^]?)(.+)$/u.exec(previousRange);
      if (
        !match ||
        !semver.valid(match[2]) ||
        !semver.valid(oldTarget.version) ||
        !semver.valid(newTarget.version) ||
        !semver.gt(newTarget.version, oldTarget.version) ||
        !semver.lte(match[2], oldTarget.version) ||
        range !== `${workspace}${match[1]}${newTarget.version}`
      )
        return undefined;
      next[section][name] = previous;
      dependencies.set(name, { file: targetFile, directory: target, after: newTarget });
      generated = true;
    }
  }
  if (!generated || JSON.stringify(stableJson(old)) !== JSON.stringify(stableJson(next))) return undefined;
  const candidate = { name: after.name, anchored: consumedPackages.has(after.name), dependencies };
  releaseCandidates.set(after.name, candidate);
  return candidate;
}

/** Every reachable candidate, including cyclic components, must reach a consumed anchor. */
function isReleaseManifestChange(file, directory, after) {
  if (consumedPackages.size === 0) return false;
  const pending = [{ file, directory, after }];
  const candidates = new Map();
  while (pending.length) {
    const item = pending.pop();
    if (candidates.has(item.after.name)) continue;
    const candidate = releaseCandidate(item.file, item.directory, item.after);
    if (!candidate) return false;
    candidates.set(candidate.name, candidate);
    pending.push(...candidate.dependencies.values());
  }
  const proven = new Set(
    [...candidates.values()].filter((candidate) => candidate.anchored).map((candidate) => candidate.name),
  );
  let changed;
  do {
    changed = false;
    for (const candidate of candidates.values()) {
      if (!proven.has(candidate.name) && [...candidate.dependencies.keys()].some((name) => proven.has(name))) {
        proven.add(candidate.name);
        changed = true;
      }
    }
  } while (changed);
  return proven.size === candidates.size;
}

for (const directory of readdirSync(packagesRoot).sort()) {
  const packageRoot = resolve(packagesRoot, directory);
  if (!statSync(packageRoot).isDirectory()) continue;
  const manifestPath = resolve(packageRoot, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private === true || !manifest.name) continue;
  if (released.has(manifest.name)) continue;

  const prefixes = publishedPrefixes(directory, manifest);
  const packagePrefix = `packages/${directory}/`;
  const touched = changedFiles.filter((file) => {
    const relative = file.startsWith(packagePrefix) ? file.slice(packagePrefix.length) : undefined;
    if (relative !== undefined && RELEASE_GENERATED.has(relative)) return false;
    if (relative === "package.json" && isReleaseManifestChange(file, directory, manifest)) return false;
    if (relative !== undefined && isReleaseVersionOnlySkillChange(file, relative, mergeBase)) return false;
    return prefixes.some((prefix) => (prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix));
  });
  if (touched.length > 0) missing.push({ name: manifest.name, touched });
}

if (missing.length > 0) {
  console.error(`check-changesets: published files changed without a changeset (base ${base}):\n`);
  for (const { name, touched } of missing) {
    const shown = touched.slice(0, 5);
    console.error(`  ${name}`);
    for (const file of shown) console.error(`    ${file}`);
    if (touched.length > shown.length) console.error(`    … and ${touched.length - shown.length} more`);
  }
  console.error(
    "\nRun `bun run changeset` and select each package above." +
      "\nBump rule: major only when another package's code breaks (a removed" +
      "\nexport, a changed event/RPC payload, a protocol bump); minor for any" +
      "\nother behavior change, including retiring a config key; patch for fixes.",
  );
  process.exit(1);
}

console.log(`check-changesets: every package with published changes has a changeset (base ${base})`);
