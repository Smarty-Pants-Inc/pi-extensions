import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activateRoots } from "./smoke-pi-loaders.mjs";
import { createResponseRendezvous, queueAdmissionReady } from "./smoke-response-rendezvous.mjs";

test("response rendezvous tolerates startup skew beyond the old response window", async () => {
  const gate = createResponseRendezvous("delayed DAG", ["A", "B"], 1_000);
  const entered = [];
  const returned = [];
  let active = 0;
  let maxActive = 0;
  const response = async (name) => {
    entered.push(name);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await gate.enter(name);
      assert.deepEqual(entered, ["A", "B"], "neither provider may return before both callbacks enter");
      returned.push(name);
    } finally {
      active -= 1;
    }
  };
  try {
    await Promise.all([
      response("A"),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.deepEqual(returned, [], "the first response must still be blocked after the old 25/30ms windows");
        await response("B");
      })(),
    ]);
    gate.assertReleased();
    assert.equal(maxActive, 2);
    assert.equal(active, 0);
    assert.equal(returned.length, 2);
  } finally {
    gate.dispose();
  }
});

test("response rendezvous rejects deliberately serialized dispatch within a bounded timeout", async () => {
  const gate = createResponseRendezvous("serialized DAG", ["A", "B"], 40);
  const entered = [];
  try {
    await assert.rejects(
      (async () => {
        entered.push("A");
        await gate.enter("A");
        entered.push("B");
        await gate.enter("B");
      })(),
      /serialized DAG response rendezvous timed out after 40ms: waiting for B; provider callbacks must overlap/,
    );
    assert.deepEqual(entered, ["A"]);
    assert.throws(() => gate.assertReleased(), /response rendezvous timed out/);
    await assert.rejects(gate.enter("B"), /response rendezvous timed out/);
  } finally {
    gate.dispose();
  }
});

test("response rendezvous releases once and a third queued provider response drains", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearDeadline = t.mock.method(globalThis, "clearTimeout");
  const gate = createResponseRendezvous("queue", ["queue 1", "queue 2"], 100);
  let active = 0;
  let maxActive = 0;
  let starts = 0;
  const response = async (name, designated) => {
    starts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (designated) await gate.enter(name);
    } finally {
      active -= 1;
    }
  };
  try {
    const pair = Promise.all([response("queue 1", true), response("queue 2", true)]);
    assert.equal(clearDeadline.mock.callCount(), 1, "release clears the pending deadline");
    assert.notEqual(clearDeadline.mock.calls[0].arguments[0], undefined);
    // Passing the deadline after release must not turn success into failure.
    t.mock.timers.tick(100);
    await pair;
    await response("queue 3", false);
    gate.assertReleased();
    assert.equal(starts, 3);
    assert.equal(maxActive, 2);
    assert.equal(active, 0);
  } finally {
    gate.dispose();
  }
});

test("queue rendezvous holds both responses until the third task is actually queued", async () => {
  const states = ["running", "running"];
  const returned = [];
  const gate = createResponseRendezvous("pending queue", ["queue 1", "queue 2"], 1_000, () =>
    queueAdmissionReady(states),
  );
  try {
    await Promise.all([
      gate.enter("queue 1").then(() => returned.push("queue 1")),
      gate.enter("queue 2").then(() => returned.push("queue 2")),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.deepEqual(returned, [], "neither response may finish before queue admission evidence");
        states.push("queued");
      })(),
    ]);
    gate.assertReleased();
    assert.equal(returned.length, 2);
    states[2] = "running";
    returned.push("queue 3");
    assert.equal(returned.length, 3, "the admitted third task drains after release");
  } finally {
    gate.dispose();
  }
});

test("queue admission rejects over-admission even when the third provider enters after the pair finishes", async () => {
  const gate = createResponseRendezvous("over-admitted queue", ["queue 1", "queue 2"], 1_000, () =>
    queueAdmissionReady(["running", "running", "running"]),
  );
  let active = 0;
  let maxActive = 0;
  let starts = 0;
  const response = async (name) => {
    starts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (name !== "queue 3") await gate.enter(name);
    } finally {
      active -= 1;
    }
  };
  try {
    const results = await Promise.allSettled([
      response("queue 1"),
      response("queue 2"),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await response("queue 3");
      })(),
    ]);
    assert.equal(starts, 3);
    assert.equal(maxActive, 2, "callback-overlap alone would falsely pass this over-admission");
    assert.equal(results.filter((result) => result.status === "rejected").length, 2);
    assert.throws(
      () => gate.assertReleased(),
      /must admit two running and one queued task, observed: running, running, running/,
    );
  } finally {
    gate.dispose();
  }
});

test("cleanup clears release-condition polling as well as the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clear = t.mock.method(globalThis, "clearTimeout");
  let checks = 0;
  const gate = createResponseRendezvous("release polling", ["A", "B"], 100, () => {
    checks += 1;
    return false;
  });
  const pending = Promise.allSettled([gate.enter("A"), gate.enter("B")]);
  assert.equal(checks, 1);
  gate.dispose();
  assert.equal(clear.mock.calls.filter((call) => call.arguments[0] !== undefined).length, 2);
  t.mock.timers.tick(100);
  assert.equal(checks, 1);
  assert.equal(
    (await pending).every((result) => result.status === "rejected"),
    true,
  );
});

test("response rendezvous cleanup rejects pending callbacks and preserves cancellation instead of timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearDeadline = t.mock.method(globalThis, "clearTimeout");
  const gate = createResponseRendezvous("cancelled queue", ["queue 1", "queue 2"], 100);
  const cancelled = new Error("workflow cancelled");
  const pending = gate.enter("queue 1");
  const rejected = assert.rejects(pending, (error) => error === cancelled);
  gate.dispose(cancelled);
  assert.notEqual(clearDeadline.mock.calls[0].arguments[0], undefined, "cancellation clears the pending deadline");
  gate.dispose(new Error("duplicate cleanup"));
  t.mock.timers.tick(100);
  await rejected;
  assert.throws(
    () => gate.assertReleased(),
    (error) => error === cancelled,
  );
  await assert.rejects(gate.enter("queue 2"), (error) => error === cancelled);
});

test("response rendezvous cleanup before any callback is safe and rejects late callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createResponseRendezvous("failed workflow", ["A", "B"], 100);
  gate.dispose();
  t.mock.timers.tick(100);
  await assert.rejects(gate.enter("A"), /failed workflow response rendezvous disposed/);
});

test("response rendezvous starts its deadline at provider entry, not workflow startup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createResponseRendezvous("startup", ["A", "B"], 100);
  try {
    t.mock.timers.tick(200);
    const rejected = assert.rejects(gate.enter("A"), /startup response rendezvous timed out after 100ms/);
    t.mock.timers.tick(100);
    await rejected;
  } finally {
    gate.dispose();
  }
});

test("response rendezvous counts distinct designated callbacks only", async () => {
  const gate = createResponseRendezvous("distinct DAG", ["A", "B"], 1_000);
  try {
    const first = gate.enter("A");
    await assert.rejects(gate.enter("A"), /duplicate provider callback: A/);
    await assert.rejects(gate.enter("C"), /unexpected provider callback: C/);
    assert.throws(() => gate.assertReleased(), /waiting for B/);
    await Promise.all([first, gate.enter("B")]);
    gate.assertReleased();
  } finally {
    gate.dispose();
  }
});

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
