import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { exportFileName } from "../export.ts";
import { writePrivateExport } from "../private-export.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "usage-private-export-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const name = exportFileName("table", "today", null, "csv", new Date(2026, 6, 15, 12));

test("exports never follow a real symlink or replace an existing regular file, and are private", (t) => {
  const root = fixture(t);
  const canary = join(root, "canary");
  writeFileSync(canary, "canary unchanged");
  symlinkSync(canary, join(root, name));
  const collision = name.replace(".csv", "-1.csv");
  writeFileSync(join(root, collision), "existing export");
  const first = writePrivateExport(root, name, "new export");
  const second = writePrivateExport(root, name, "next export");
  assert.equal(first, join(root, name.replace(".csv", "-2.csv")));
  assert.equal(second, join(root, name.replace(".csv", "-3.csv")));
  assert.equal(readFileSync(canary, "utf8"), "canary unchanged");
  assert.ok(lstatSync(join(root, name)).isSymbolicLink());
  assert.equal(readFileSync(join(root, collision), "utf8"), "existing export");
  assert.equal(readFileSync(first, "utf8"), "new export");
  assert.equal(readFileSync(second, "utf8"), "next export");
  if (process.platform !== "win32")
    for (const file of [first, second]) assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("collision retries are bounded and leave every existing artifact untouched", (t) => {
  const root = fixture(t);
  for (let i = 0; i < 100; i++)
    writeFileSync(join(root, i === 0 ? name : name.replace(".csv", `-${i}.csv`)), "preserved");
  assert.throws(() => writePrivateExport(root, name, "no overwrite"), /Too many existing/);
  assert.equal(readdirSync(root).length, 100);
  for (const file of readdirSync(root)) assert.equal(readFileSync(join(root, file), "utf8"), "preserved");
});

test("partial write failure retains private artifacts and never deletes replacement paths", (t) => {
  const root = fixture(t);
  assert.throws(
    () =>
      writePrivateExport(root, name, "payload", (fd) => {
        writeFileSync(fd, "partial");
        throw new Error("failed write");
      }),
    /failed write/,
  );
  assert.deepEqual(readdirSync(root), [name]);
  assert.equal(readFileSync(join(root, name), "utf8"), "partial");
  if (process.platform !== "win32") assert.equal(statSync(join(root, name)).mode & 0o777, 0o600);
  assert.equal(writePrivateExport(root, name, "retry"), join(root, name.replace(".csv", "-1.csv")));
  unlinkSync(join(root, name)); // Test-only removal; production never unlinks shared paths.
  const canary = join(root, "canary");
  writeFileSync(canary, "preserved");
  assert.throws(
    () =>
      writePrivateExport(root, name, "payload", (fd) => {
        writeFileSync(fd, "partial");
        unlinkSync(join(root, name));
        symlinkSync(canary, join(root, name));
        throw new Error("replaced while writing");
      }),
    /replaced while writing/,
  );
  assert.ok(lstatSync(join(root, name)).isSymbolicLink());
  assert.equal(readFileSync(canary, "utf8"), "preserved");
});

test("an after-lstat/before-unlink replacement hook cannot delete a foreign canary", (t) => {
  const root = fixture(t);
  assert.equal(
    execFileSync("node", [fileURLToPath(new URL("./private-export-race.fixture.ts", import.meta.url)), root, name], {
      encoding: "utf8",
      timeout: 10_000,
    }),
    "",
  );
});
