import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureOwner, IterationOwnership } from "../ownership.ts";

function fixture() {
  const manager = SessionManager.inMemory(process.cwd());
  const ctx = { sessionManager: manager };
  const ownership = new IterationOwnership();
  let timestamp = 100;
  const bind = (text, owner, images = []) => {
    const native = { role: "user", content: [{ type: "text", text }, ...images], timestamp: ++timestamp };
    ownership.bind(native, "loop", owner, ctx, 1);
    manager.appendMessage(native);
    return native;
  };
  return { manager, ctx, ownership, bind };
}

for (const order of ["A-first", "B-first"])
  for (const lane of ["steer", "followUp"]) {
    test(`image-distinct same text has unique provenance: ${order} ${lane}`, () => {
      const f = fixture();
      const owner = captureOwner(f.ctx);
      const images = [{ type: "image", data: "AA==", mimeType: "image/png" }];
      const A = { text: "continue", source: "rpc", streamingBehavior: lane, images };
      const B = { text: "continue", source: "extension", streamingBehavior: lane };
      for (const input of order === "A-first" ? [A, B] : [B, A]) f.ownership.input(input, f.ctx);
      const native = f.bind(A.text, owner, images);
      assert.ok(f.ownership.context([native], f.ctx, "loop", owner, 1));
      assert.deepEqual(native.content, [{ type: "text", text: A.text }, ...images]);
    });
  }

for (const sameLane of [false, true]) {
  test(`known lane acceptance retires only its own earlier candidates: ${sameLane ? "same" : "different"} lane`, () => {
    const f = fixture();
    const owner = captureOwner(f.ctx);
    f.ownership.input({ text: "earlier", source: "rpc", streamingBehavior: "followUp" }, f.ctx);
    f.ownership.input(
      { text: "later", source: "extension", streamingBehavior: sameLane ? "followUp" : "steer" },
      f.ctx,
    );
    f.bind("later", owner);
    const native = f.bind("earlier", owner);
    assert.equal(Boolean(f.ownership.context([native], f.ctx, "loop", owner, 1)), !sameLane);
  });
}

test("same native content/source collisions fail closed even across known delivery lanes", () => {
  const f = fixture();
  const owner = captureOwner(f.ctx);
  const token = f.ownership.send("loop", 1, "private body", owner);
  f.ownership.input({ text: token, source: "extension", streamingBehavior: "steer" }, f.ctx);
  f.ownership.input({ text: token, source: "extension", streamingBehavior: "followUp" }, f.ctx);
  const native = f.bind(token, owner);
  assert.equal(f.ownership.context([native], f.ctx, "loop", owner, 1), undefined);
  assert.equal(f.ownership.rejected, true);
  f.ownership.settled();
  assert.deepEqual(f.ownership.input({ text: token, source: "extension" }, f.ctx), { action: "handled" });
});

test("ordinary unknown sources and marker-shaped literals acquire no user or delivery authority", () => {
  const f = fixture();
  const owner = captureOwner(f.ctx);
  for (const source of ["extension", "other", "", "RPC"]) {
    const text = "<!-- pi-ralph-iteration:1:literal -->";
    f.ownership.input({ text, source }, f.ctx);
    const native = f.bind(text, owner);
    assert.equal(f.ownership.context([native], f.ctx, "loop", owner, 1), undefined);
    assert.equal(f.ownership.isDelivery(native), false);
  }
});

test("retirement fences remain rejected until settled, despite later ordinary native messages", () => {
  const f = fixture();
  const owner = captureOwner(f.ctx);
  const token = f.ownership.send("loop", 1, "body", owner);
  f.ownership.input({ text: token, source: "extension" }, f.ctx);
  const native = f.bind(token, owner);
  assert.ok(f.ownership.context([native], f.ctx, "loop", owner, 1));
  f.ownership.retire();
  f.ownership.input({ text: "notification", source: "extension" }, f.ctx);
  f.bind("notification", owner);
  assert.equal(f.ownership.rejected, true);
  f.ownership.settled();
  assert.equal(f.ownership.rejected, false);
});

test("one-use authentic tokens remain recognizable after bounded eviction, retirement and session replacement", () => {
  const f = fixture();
  const owner = captureOwner(f.ctx);
  const first = f.ownership.send("loop", 1, "private body", owner);
  for (let i = 0; i < 1000; i++) {
    f.ownership.send("loop", 1, `body-${i}`, owner);
    f.ownership.input({ text: `input-${i}`, source: "rpc", streamingBehavior: i % 2 ? "steer" : "followUp" }, f.ctx);
  }
  assert.ok(f.ownership.deliveries.size <= 128);
  assert.ok(f.ownership.inputs.length <= 256);
  assert.deepEqual(f.ownership.input({ text: first, source: "extension" }, f.ctx), { action: "handled" });
  const next = f.ownership.send("loop", 1, "next private body", owner);
  f.ownership.retire();
  assert.equal(f.ownership.deliveries.size, 0);
  assert.equal(f.ownership.inputs.length, 0);
  assert.equal(f.ownership.native, undefined);
  f.manager.newSession();
  assert.deepEqual(f.ownership.input({ text: next, source: "extension" }, f.ctx), { action: "handled" });
  f.ownership.input({ text: next, source: "rpc" }, f.ctx);
  const newOwner = captureOwner(f.ctx);
  const literal = f.bind(next, newOwner);
  assert.ok(f.ownership.context([literal], f.ctx, "loop", newOwner, 1));
  assert.equal(f.ownership.isDelivery(literal), false);
});

test("many owned iterations across compaction keep no retired bodies or native bindings", () => {
  const f = fixture();
  let first;
  for (let i = 0; i < 200; i++) {
    const owner = captureOwner(f.ctx);
    const token = f.ownership.send("loop", 1, `private body-${i}`, owner);
    first ??= token;
    f.ownership.input({ text: token, source: "extension" }, f.ctx);
    const native = f.bind(token, owner);
    assert.ok(f.ownership.context([native], f.ctx, "loop", owner, 1));
    f.ownership.settled();
    f.ownership.retire();
    if (i % 25 === 0) f.manager.appendCompaction("summary", f.manager.getLeafId(), 10_000);
    assert.equal(f.ownership.iteration, undefined);
    assert.equal(f.ownership.native, undefined);
    assert.equal(f.ownership.deliveries.size, 0);
    assert.equal(f.ownership.inputs.length, 0);
    assert.equal(f.ownership.bindings, undefined);
  }
  assert.doesNotMatch(JSON.stringify(f.manager.getBranch()), /private body-/);
  f.manager.newSession();
  assert.deepEqual(f.ownership.input({ text: first, source: "extension" }, f.ctx), { action: "handled" });
});

test("expired bodies and candidates are dropped without a replay token list", () => {
  const f = fixture();
  const token = f.ownership.send("loop", 1, "private body", captureOwner(f.ctx));
  f.ownership.input({ text: "pending", source: "rpc" }, f.ctx);
  const original = Date.now;
  const later = Date.now() + 300_001;
  Date.now = () => later;
  try {
    assert.deepEqual(f.ownership.input({ text: token, source: "extension" }, f.ctx), { action: "handled" });
    assert.equal(f.ownership.deliveries.size, 0);
    assert.equal(f.ownership.inputs.length, 0);
  } finally {
    Date.now = original;
  }
});
