import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activateRoots } from "./smoke-pi-loaders.mjs";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

function packedFixture(root, name, lifecycle = "stable", dependencies = {}) {
  const source = join(root, `${name}-source`);
  const extracted = join(root, `${name}-extracted`);
  mkdirSync(source);
  mkdirSync(extracted);
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      files: ["index.mjs"],
      pi: { extensions: ["index.mjs"] },
      piExtension: { lifecycle },
      dependencies,
      scripts: { install: "node -e 'throw new Error(\"must not install\")'" },
    }),
  );
  writeFileSync(
    join(source, "index.mjs"),
    `export default function fixture(pi) {
  pi.registerCommand(${JSON.stringify(name)}, { description: "Fixture command", handler: async () => {} });
}\n`,
  );
  const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], source))[0];
  run("tar", ["-xzf", join(root, packed.filename), "-C", extracted], root);
  return join(extracted, "package");
}

function consumerFixture(root) {
  const consumer = join(root, "consumer");
  const agentDir = join(root, "agent");
  mkdirSync(consumer);
  mkdirSync(agentDir);
  return { consumer, agentDir };
}

test("installed host collects a packaged runtime-dependency warning and the smoke assertion rejects it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-smoke-warning-"));
  try {
    const packageRoot = packedFixture(root, "pi-bad-host-dependency", "stable", { typebox: "*" });
    const { consumer, agentDir } = consumerFixture(root);
    await assert.rejects(
      activateRoots([packageRoot], consumer, agentDir, 1, "negative dependency fixture"),
      (error) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.actual, 1, "the installed host supplied one real warning");
        assert.equal(error.expected, 0, "the normal smoke assertion requires zero warnings");
        assert.match(error.message, /negative dependency fixture resource warnings:/);
        assert.ok(error.message.includes(join(packageRoot, "package.json")));
        assert.match(error.message, /Host-provided extension packages must be declared in peerDependencies/);
        assert.match(error.message, /not dependencies: typebox/);
        return true;
      },
    );
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settings.packages, [packageRoot]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged stable combinations and explicit experimental activation keep standalone event fixtures", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-smoke-package-roots-"));
  try {
    const stable = packedFixture(root, "pi-stable-fixture");
    const experimental = packedFixture(root, "pi-experimental-fixture", "experimental");
    const { consumer, agentDir } = consumerFixture(root);
    const eventFixture = join(root, "events.mjs");
    writeFileSync(
      eventFixture,
      `export default function fixture(pi) {
  pi.on("session_start", () => { pi.events.emit("smoke:fixture", {}); });
}\n`,
    );
    const single = await activateRoots([experimental], consumer, agentDir, 1, "experimental tarball");
    assert.equal(single.resourceCount, 1);
    const pair = await activateRoots([stable, experimental], consumer, agentDir, 2, "combined tarballs", [], {
      extensionPaths: [eventFixture],
    });
    assert.equal(pair.resourceCount, 3);
    assert.deepEqual(pair.errors, []);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settings.packages, [stable, experimental]);
    assert.equal(settings.extensions, undefined, "standalone fixtures are not persisted as package resources");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
