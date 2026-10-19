import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root, file, content) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-changesets-test-"));
  roots.push(root);
  symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
  put(root, ".gitignore", "node_modules\n");
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./check-changesets.mjs", import.meta.url), join(root, "scripts", "check-changesets.mjs"));
  put(root, "package.json", JSON.stringify({ private: true }));
  put(
    root,
    "packages/pi-demo/package.json",
    JSON.stringify({
      name: "@signalridge/pi-demo",
      version: "1.0.0",
      files: ["src"],
      main: "entry.js",
      bin: { demo: "cli.js" },
      dependencies: { external: "^1.0.0" },
    }),
  );
  for (const file of [
    "src/index.ts",
    "README.md",
    "LICENSE",
    "entry.js",
    "cli.js",
    "CHANGELOG.md",
    "tsconfig.json",
    "test/example.ts",
  ]) {
    put(
      root,
      `packages/pi-demo/${file}`,
      file === "CHANGELOG.md" ? "# Changelog\n\n## 1.0.0\n\nInitial.\n" : "original\n",
    );
  }
  put(root, ".changeset/release.md", '---\n"@signalridge/pi-demo": patch\n---\n\nA correction.\n');
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-m", "fixture baseline");
  rmSync(join(root, ".changeset", "release.md"));
  return { root, git };
}

function update(root, patch) {
  const path = join(root, "packages/pi-demo/package.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...value, ...patch }));
}

function check(root) {
  return spawnSync(process.execPath, [join(root, "scripts", "check-changesets.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CHANGESET_BASE: "main" },
  });
}

function requiresChangeset(root) {
  const result = check(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /@signalridge\/pi-demo/u);
}

function passes(root) {
  const result = check(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("manifest-only metadata requires a changeset even when files excludes package.json", () => {
  const { root } = fixture();
  update(root, { description: "Published metadata changed" });
  requiresChangeset(root);
  put(root, ".changeset/metadata.md", '---\n"@signalridge/pi-demo": patch\n---\n\nMetadata.\n');
  passes(root);
});

for (const file of ["README.md", "LICENSE", "COPYING", "COPYING.md", "entry.js", "cli.js"]) {
  test(`implicitly published ${file} requires a changeset`, () => {
    const { root } = fixture();
    put(root, `packages/pi-demo/${file}`, "changed\n");
    requiresChangeset(root);
  });
}

for (const file of ["README.md", "LICENSE"]) {
  test(`deleted implicitly published ${file} still requires a changeset`, () => {
    const { root } = fixture();
    rmSync(join(root, "packages/pi-demo", file));
    requiresChangeset(root);
  });
}

test("deleting a complete published directory still requires a changeset", () => {
  const { root } = fixture();
  rmSync(join(root, "packages/pi-demo/src"), { recursive: true });
  requiresChangeset(root);
});

for (const committed of [false, true]) {
  test(`${committed ? "committed" : "staged"} published-to-unpublished rename requires a changeset`, () => {
    const { root, git } = fixture();
    git("checkout", "-b", "rename-fixture");
    renameSync(join(root, "packages/pi-demo/src/index.ts"), join(root, "packages/pi-demo/test/moved.ts"));
    git("add", "-A");
    if (committed) git("commit", "-m", "move published source to tests");
    requiresChangeset(root);
  });

  test(`${committed ? "committed" : "staged"} cross-package rename needs the source package changeset`, () => {
    const { root, git } = fixture();
    put(
      root,
      "packages/pi-peer/package.json",
      JSON.stringify({
        name: "@signalridge/pi-peer",
        version: "1.0.0",
        files: ["src"],
      }),
    );
    put(root, "packages/pi-peer/src/keep.ts", "keep\n");
    git("add", "packages/pi-peer");
    git("commit", "-m", "peer baseline");
    git("checkout", "-b", "rename-fixture");
    renameSync(join(root, "packages/pi-demo/src/index.ts"), join(root, "packages/pi-peer/src/index.ts"));
    put(root, ".changeset/peer.md", '---\n"@signalridge/pi-peer": patch\n---\n\nPeer change.\n');
    git("add", "-A");
    if (committed) git("commit", "-m", "move source between packages");
    requiresChangeset(root);
    put(root, ".changeset/source.md", '---\n"@signalridge/pi-demo": patch\n---\n\nSource removal.\n');
    passes(root);
  });
}

test("absent files publishes all paths without a dot-prefix mismatch", () => {
  const { root, git } = fixture();
  const path = join(root, "packages/pi-demo/package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  delete manifest.files;
  writeFileSync(path, JSON.stringify(manifest));
  git("add", "packages/pi-demo/package.json");
  git("commit", "-m", "default publication baseline");
  put(root, "packages/pi-demo/src/index.ts", "changed\n");
  requiresChangeset(root);
});

test("an empty files array publishes only implicit entries", () => {
  const { root, git } = fixture();
  update(root, { files: [] });
  git("add", "packages/pi-demo/package.json");
  git("commit", "-m", "implicit entries only");
  put(root, "packages/pi-demo/src/index.ts", "changed\n");
  put(root, "packages/pi-demo/test/example.ts", "changed\n");
  passes(root);
  put(root, "packages/pi-demo/README.md", "changed\n");
  requiresChangeset(root);
});

test("nonpublished test and compiler configuration changes remain exempt", () => {
  const { root } = fixture();
  put(root, "packages/pi-demo/test/example.ts", "changed\n");
  put(root, "packages/pi-demo/tsconfig.json", "changed\n");
  passes(root);
});

test("consumed release version plus matching generated changelog passes", () => {
  const { root } = fixture();
  update(root, { version: "1.0.1" });
  put(root, "packages/pi-demo/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nA correction.\n\n## 1.0.0\n\nInitial.\n");
  passes(root);
});

test("release evidence cannot hide a decreasing package version", () => {
  const { root } = fixture();
  update(root, { version: "0.9.0" });
  put(root, "packages/pi-demo/CHANGELOG.md", "# Changelog\n\n## 0.9.0\n\nNot a generated upgrade.\n");
  requiresChangeset(root);
});

test("release evidence does not exempt unrelated manifest metadata", () => {
  const { root } = fixture();
  update(root, { version: "1.0.1", description: "Not release-generated" });
  put(root, "packages/pi-demo/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nA correction.\n");
  requiresChangeset(root);
});

test("release evidence does not exempt external dependency upgrades", () => {
  const { root } = fixture();
  update(root, { version: "1.0.1", dependencies: { external: "^2.0.0" } });
  put(root, "packages/pi-demo/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nA correction.\n");
  requiresChangeset(root);
});

test("a version-only edit without a consumed release still requires a changeset", () => {
  const { root, git } = fixture();
  git("add", ".changeset/release.md");
  git("commit", "-m", "remove pending release before test");
  update(root, { version: "1.0.1" });
  put(root, "packages/pi-demo/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nA correction.\n");
  requiresChangeset(root);
});

test("generated internal ranges must match the dependency's proven old and new versions", () => {
  const { root, git } = fixture();
  put(
    root,
    "packages/pi-peer/package.json",
    JSON.stringify({ name: "@signalridge/pi-peer", version: "1.0.0", files: ["src"] }),
  );
  put(root, "packages/pi-peer/src/index.ts", "original\n");
  put(root, "packages/pi-peer/CHANGELOG.md", "# Changelog\n\n## 1.0.0\n");
  update(root, { dependencies: { external: "^1.0.0", "@signalridge/pi-peer": "^1.0.0" } });
  put(
    root,
    ".changeset/release.md",
    '---\n"@signalridge/pi-demo": patch\n"@signalridge/pi-peer": patch\n---\n\nA correction.\n',
  );
  git("add", "packages", ".changeset/release.md");
  git("commit", "-m", "internal dependency baseline");
  rmSync(join(root, ".changeset", "release.md"));
  put(
    root,
    "packages/pi-peer/package.json",
    JSON.stringify({ name: "@signalridge/pi-peer", version: "1.0.1", files: ["src"] }),
  );
  put(root, "packages/pi-peer/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nA correction.\n");
  update(root, { version: "1.0.1", dependencies: { external: "^1.0.0", "@signalridge/pi-peer": "^1.0.1" } });
  put(root, "packages/pi-demo/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nUpdated dependency.\n");
  passes(root);
  update(root, { dependencies: { external: "^1.0.0", "@signalridge/pi-peer": "^9.0.0" } });
  requiresChangeset(root);
});

for (const prefix of ["^", "~", "", "workspace:^", "workspace:~", "workspace:"]) {
  test(`generated ${prefix || "exact"} ranges may have an older lower bound`, () => {
    const { root, git } = fixture();
    const peer = (version) => ({ name: "@signalridge/pi-peer", version, files: ["src"] });
    put(root, "packages/pi-peer/package.json", JSON.stringify(peer("1.0.1")));
    put(root, "packages/pi-peer/src/index.ts", "original\n");
    put(root, "packages/pi-peer/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n");
    update(root, { dependencies: { "@signalridge/pi-peer": `${prefix}1.0.0` } });
    put(
      root,
      ".changeset/release.md",
      '---\n"@signalridge/pi-demo": patch\n"@signalridge/pi-peer": patch\n---\n\nA correction.\n',
    );
    git("add", "packages", ".changeset/release.md");
    git("commit", "-m", "older dependency range baseline");
    rmSync(join(root, ".changeset", "release.md"));
    put(root, "packages/pi-peer/package.json", JSON.stringify(peer("1.0.2")));
    put(root, "packages/pi-peer/CHANGELOG.md", "# Changelog\n\n## 1.0.2\n\nA correction.\n");
    update(root, { version: "1.0.1", dependencies: { "@signalridge/pi-peer": `${prefix}1.0.2` } });
    put(root, "packages/pi-demo/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nA correction.\n");
    passes(root);
  });
}

for (const bothAnchored of [false, true]) {
  test(`cyclic internal releases require collective proof (${bothAnchored ? "two" : "one"} consumed anchors)`, () => {
    const { root, git } = fixture();
    const peer = (version, range) => ({
      name: "@signalridge/pi-peer",
      version,
      files: ["src"],
      dependencies: { "@signalridge/pi-demo": range },
    });
    put(root, "packages/pi-peer/package.json", JSON.stringify(peer("1.0.0", "^1.0.0")));
    put(root, "packages/pi-peer/src/index.ts", "original\n");
    put(root, "packages/pi-peer/CHANGELOG.md", "# Changelog\n\n## 1.0.0\n");
    update(root, { dependencies: { "@signalridge/pi-peer": "^1.0.0" } });
    put(
      root,
      ".changeset/release.md",
      `---\n"@signalridge/pi-demo": patch\n${bothAnchored ? '"@signalridge/pi-peer": patch\n' : ""}---\n\nA correction.\n`,
    );
    git("add", "packages", ".changeset/release.md");
    git("commit", "-m", "cyclic dependency baseline");
    rmSync(join(root, ".changeset", "release.md"));
    put(root, "packages/pi-peer/package.json", JSON.stringify(peer("1.0.1", "^1.0.1")));
    put(root, "packages/pi-peer/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nA correction.\n");
    update(root, { version: "1.0.1", dependencies: { "@signalridge/pi-peer": "^1.0.1" } });
    put(root, "packages/pi-demo/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nA correction.\n");
    passes(root);
    const value = peer("1.0.1", "^1.0.1");
    put(root, "packages/pi-peer/package.json", JSON.stringify({ ...value, description: "Not generated" }));
    assert.equal(check(root).status, 1);
  });
}

test("a consumed root cannot legitimize an unanchored dependency cycle", () => {
  const { root, git } = fixture();
  for (const [name, dependency] of [
    ["pi-peer", "pi-other"],
    ["pi-other", "pi-peer"],
  ]) {
    put(
      root,
      `packages/${name}/package.json`,
      JSON.stringify({
        name: `@signalridge/${name}`,
        version: "1.0.0",
        files: ["src"],
        dependencies: { [`@signalridge/${dependency}`]: "^1.0.0" },
      }),
    );
    put(root, `packages/${name}/src/index.ts`, "original\n");
    put(root, `packages/${name}/CHANGELOG.md`, "# Changelog\n\n## 1.0.0\n");
  }
  update(root, { dependencies: { "@signalridge/pi-peer": "^1.0.0" } });
  git("add", "packages");
  git("commit", "-m", "unanchored dependency cycle baseline");
  for (const [name, dependency] of [
    ["pi-peer", "pi-other"],
    ["pi-other", "pi-peer"],
  ]) {
    put(
      root,
      `packages/${name}/package.json`,
      JSON.stringify({
        name: `@signalridge/${name}`,
        version: "1.0.1",
        files: ["src"],
        dependencies: { [`@signalridge/${dependency}`]: "^1.0.1" },
      }),
    );
    put(root, `packages/${name}/CHANGELOG.md`, "# Changelog\n\n## 1.0.1\n\nUnproven.\n");
  }
  update(root, { version: "1.0.1", dependencies: { "@signalridge/pi-peer": "^1.0.1" } });
  put(root, "packages/pi-demo/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\nA correction.\n");
  requiresChangeset(root);
});
