import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import ts from "typescript";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const REQUIRED_SCRIPTS = ["lint", "typecheck", "test", "check", "format"];
const PACKAGE_DIRECTORY_PATTERN = /^pi-.+$/u;
const PACKAGE_NAME_PATTERN = /^@signalridge\/pi-.+$/u;
const PI_HOST_DEPENDENCIES = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);
const HOST_DEPENDENCIES = new Set([...PI_HOST_DEPENDENCIES, "typebox", "@sinclair/typebox"]);

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireNonEmptyScript(manifest, directory, name) {
  const command = manifest.scripts?.[name];
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error(`packages/${directory} needs a non-empty ${name} script`);
  }
  return command;
}

function referencesPackageScript(command, name) {
  // Package checks intentionally use the repository's existing `bun run` or
  // `npm run` convention. Match a complete script name, not incidental words
  // in package-specific flags or test file paths.
  return new RegExp(`\\b(?:bun|npm)\\s+run\\s+${name}(?=\\s|$|&&|;)`, "u").test(command);
}

function referencesQualityPhase(command, phase) {
  if (phase === "lint" && /\bbiome\s+(?:check|lint)\b/u.test(command)) return true;
  return referencesPackageScript(command, phase);
}

function validateExtensionEntries(directory, packageRoot, manifest) {
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`packages/${directory} pi.extensions must be non-empty`);
  }
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.startsWith("./")) {
      throw new Error(`packages/${directory} pi.extensions entries must be package-relative files: ${String(entry)}`);
    }
    const absolute = resolve(packageRoot, entry);
    const packageRelative = relative(packageRoot, absolute).split(sep).join("/");
    if (packageRelative === ".." || packageRelative.startsWith("../") || !isFile(absolute)) {
      throw new Error(`packages/${directory} has an invalid local extension entry: ${entry}`);
    }
    if (seen.has(packageRelative)) {
      throw new Error(`packages/${directory} pi.extensions contains duplicate entry: ${entry}`);
    }
    seen.add(packageRelative);
  }
}

export function validatePackageManifest(directory, packageRoot, manifest) {
  if (!PACKAGE_DIRECTORY_PATTERN.test(directory)) {
    throw new Error(`packages/${directory} must use a pi-* directory name`);
  }
  if (!PACKAGE_NAME_PATTERN.test(manifest.name) || manifest.name !== `@signalridge/${directory}`) {
    throw new Error(`packages/${directory} must use a matching @signalridge/pi-* package name`);
  }
  if (manifest.private === true) {
    throw new Error(`packages/${directory} must remain publishable (private=false)`);
  }
  if (manifest.type !== "module") {
    throw new Error(`packages/${directory} must be an ES module (type: module)`);
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`packages/${directory} must set publishConfig.access to public`);
  }
  if (manifest.repository?.directory !== `packages/${directory}`) {
    throw new Error(`packages/${directory} repository.directory must be packages/${directory}`);
  }
  const isLibrary = manifest.signalridgePackage?.kind === "library";
  if (
    !isLibrary &&
    manifest.piExtension?.lifecycle !== "stable" &&
    manifest.piExtension?.lifecycle !== "experimental"
  ) {
    throw new Error(`packages/${directory} must declare lifecycle stable or experimental`);
  }
  if (!isLibrary) validateExtensionEntries(directory, packageRoot, manifest);

  for (const file of ["tsconfig.json", "README.md", "LICENSE", "CHANGELOG.md"]) {
    if (!isFile(resolve(packageRoot, file))) {
      throw new Error(`packages/${directory} needs ${file}`);
    }
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes("CHANGELOG.md")) {
    throw new Error(`packages/${directory} files must include CHANGELOG.md`);
  }

  const scripts = Object.fromEntries(
    REQUIRED_SCRIPTS.map((name) => [name, requireNonEmptyScript(manifest, directory, name)]),
  );
  for (const phase of ["lint", "typecheck", "test"]) {
    if (!referencesQualityPhase(scripts.check, phase)) {
      throw new Error(
        `packages/${directory} check script must run ${phase} (via a package script or Biome lint command)`,
      );
    }
  }
}

function validateHostDependencies(directory, manifest, rootManifest) {
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (!HOST_DEPENDENCIES.has(dependency)) continue;
      throw new Error(
        `packages/${directory}/package.json ${section}[${dependency}] is host-provided; ` +
          'declare it only in peerDependencies with a "*" range (and optionally devDependencies for tests).',
      );
    }
  }
  for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!HOST_DEPENDENCIES.has(dependency)) continue;
    if (range !== "*") {
      throw new Error(
        `packages/${directory}/package.json peerDependencies[${dependency}] must use "*" for host module ownership; ` +
          `found ${JSON.stringify(range)}. The exact tested Pi version belongs in devDependencies.`,
      );
    }
  }
  for (const dependency of PI_HOST_DEPENDENCIES) {
    const devPin = manifest.devDependencies?.[dependency];
    if (!(dependency in (manifest.peerDependencies ?? {})) && devPin === undefined) continue;
    const label = `packages/${directory}/package.json`;
    const testedVersion = rootManifest.devDependencies?.[dependency];
    if (typeof testedVersion !== "string" || semver.valid(testedVersion) !== testedVersion) {
      throw new Error(
        `${label} needs an exact tested version in root package.json devDependencies[${dependency}]; ` +
          `found ${JSON.stringify(testedVersion) ?? "missing"}. Pin the Pi version used by repository checks.`,
      );
    }
    if (devPin !== undefined && devPin !== testedVersion) {
      throw new Error(
        `${label} devDependencies[${dependency}] must match the exact root-tested Pi pin ${testedVersion}; ` +
          `found ${JSON.stringify(devPin)}.`,
      );
    }
  }
}

function isPublishedSource(path, manifest) {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path)) return false;
  const patterns = manifest.files;
  const matches = (pattern) => matchesGlob(path, pattern) || matchesGlob(path, `${pattern}/**`);
  return (
    patterns.some((pattern) => !pattern.startsWith("!") && matches(pattern)) &&
    !patterns.some((pattern) => pattern.startsWith("!") && matches(pattern.slice(1)))
  );
}

function validatePublishedHostImports(directory, packageRoot, manifest) {
  function walk(root) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (["node_modules", ".git", "coverage"].includes(entry.name)) continue;
      const absolute = resolve(root, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const path = relative(packageRoot, absolute).split(sep).join("/");
        if (!isPublishedSource(path, manifest)) continue;
        const source = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest);
        function visit(node) {
          let specifier;
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
          else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === "require"))
          ) {
            specifier = node.arguments[0];
          } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            specifier = node.argument.literal;
          } else if (ts.isExternalModuleReference(node)) {
            specifier = node.expression;
          }
          if (specifier && ts.isStringLiteralLike(specifier)) {
            const dependency = [...HOST_DEPENDENCIES].find(
              (name) => specifier.text === name || specifier.text.startsWith(`${name}/`),
            );
            if (dependency && manifest.peerDependencies?.[dependency] !== "*") {
              throw new Error(
                `packages/${directory}/${path} imports host-provided ${dependency}; ` +
                  `declare peerDependencies[${dependency}] with a "*" range.`,
              );
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  walk(packageRoot);
}

export function validatePackageConfig(root = REPOSITORY_ROOT) {
  const packagesRoot = resolve(root, "packages");
  if (!existsSync(packagesRoot) || !statSync(packagesRoot).isDirectory()) {
    throw new Error("packages/ directory is missing");
  }

  const directories = readdirSync(packagesRoot)
    .filter((name) => statSync(resolve(packagesRoot, name)).isDirectory())
    .sort();
  if (directories.length === 0) throw new Error("packages/ must contain at least one package");

  const rootManifestPath = resolve(root, "package.json");
  if (!isFile(rootManifestPath)) throw new Error("missing root package.json with tested Pi devDependency pins");
  const rootManifest = readManifest(rootManifestPath);

  for (const directory of directories) {
    const packageRoot = resolve(packagesRoot, directory);
    const manifestPath = resolve(packageRoot, "package.json");
    if (!isFile(manifestPath)) throw new Error(`missing package manifest: packages/${directory}/package.json`);
    const manifest = readManifest(manifestPath);
    validatePackageManifest(directory, packageRoot, manifest);
    validateHostDependencies(directory, manifest, rootManifest);
    validatePublishedHostImports(directory, packageRoot, manifest);
  }
  return directories.length;
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  const count = validatePackageConfig();
  console.log(`check-package-config: ${count} package manifests valid`);
}
