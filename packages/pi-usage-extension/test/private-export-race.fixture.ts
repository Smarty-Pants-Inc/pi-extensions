import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { writePrivateExport } from "../private-export.ts";

const root = process.argv[2];
const name = process.argv[3];
assert.ok(root && name);
const path = join(root, name);
const canary = join(root, "canary");
fs.writeFileSync(canary, "foreign canary");
const originalLstat = fs.lstatSync;
const originalUnlink = fs.unlinkSync;
let inspections = 0;
let deletions = 0;
// Use real inodes/files. If cleanup inspects the owned inode, install a foreign
// file *after* that successful inspection and *before* its following unlink.
// This reproduces the old check-then-unlink race, isolated from other tests.
fs.lstatSync = ((target, ...args) => {
  const inspected = originalLstat(target, ...args);
  if (target === path) {
    inspections++;
    originalUnlink(path);
    fs.renameSync(canary, path);
  }
  return inspected;
}) as typeof fs.lstatSync;
fs.unlinkSync = (target) => {
  deletions++;
  originalUnlink(target);
};
syncBuiltinESMExports();
assert.throws(
  () =>
    writePrivateExport(root, name, "payload", (fd) => {
      fs.writeFileSync(fd, "partial");
      throw new Error("write failure");
    }),
  /write failure/,
);
// Old cleanup triggers the hook and deletes the moved canary. Safe retention
// never reaches either operation, leaving both the canary and partial export.
assert.equal(fs.readFileSync(inspections ? path : canary, "utf8"), "foreign canary");
assert.equal(inspections, 0);
assert.equal(deletions, 0);
assert.equal(fs.readFileSync(path, "utf8"), "partial");
