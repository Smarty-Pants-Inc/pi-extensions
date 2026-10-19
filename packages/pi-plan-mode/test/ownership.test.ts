import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { PLAN_HANDOFF_IDENTITY_ENTRY, PlanInputOwnership } from "../src/input-ownership.js";

function fixture() {
  const manager = SessionManager.inMemory(process.cwd());
  const ctx = { sessionManager: manager } as ExtensionContext;
  const ownership = new PlanInputOwnership((data) => manager.appendCustomEntry(PLAN_HANDOFF_IDENTITY_ENTRY, data));
  let timestamp = 100;
  const accept = (text: string, source: string, images: unknown[] = [], nativeText = text) => {
    ownership.input({ text, source, images }, ctx, 1);
    const native = { role: "user", content: [{ type: "text", text: nativeText }, ...images], timestamp: ++timestamp };
    ownership.message(native, ctx, 1);
    manager.appendMessage(native as Parameters<typeof manager.appendMessage>[0]);
    return native;
  };
  return { manager, ctx, ownership, accept };
}

for (const order of ["A-first", "B-first"])
  for (const lane of ["steer", "followUp"] as const) {
    test(`same text with different images keeps exact source provenance: ${order} ${lane}`, () => {
      const f = fixture();
      const images = [{ type: "image", data: "AA==", mimeType: "image/png" }];
      const A = { text: "continue", source: "rpc", streamingBehavior: lane, images };
      const B = { text: "continue", source: "extension", streamingBehavior: lane };
      for (const input of order === "A-first" ? [A, B] : [B, A]) f.ownership.input(input, f.ctx, 1);
      const native = {
        role: "user" as const,
        content: [{ type: "text" as const, text: A.text }, ...images],
        timestamp: 101,
      };
      f.ownership.message(native, f.ctx, 1);
      f.manager.appendMessage(native as Parameters<typeof f.manager.appendMessage>[0]);
      expect(f.ownership.authorized(f.ctx, 1)).toBe(true);
    });
  }

for (const sameLane of [false, true]) {
  test(`known lane acceptance retires only its own earlier candidates: ${sameLane ? "same" : "different"} lane`, () => {
    const f = fixture();
    f.ownership.input({ text: "earlier", source: "rpc", streamingBehavior: "followUp" }, f.ctx, 1);
    f.ownership.input(
      { text: "later", source: "extension", streamingBehavior: sameLane ? "followUp" : "steer" },
      f.ctx,
      1,
    );
    for (const [index, text] of ["later", "earlier"].entries()) {
      const native = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 101 + index };
      f.ownership.message(native, f.ctx, 1);
      f.manager.appendMessage(native);
    }
    expect(f.ownership.authorized(f.ctx, 1)).toBe(!sameLane);
  });
}

test("same native content remains ambiguous across sources and delivery lanes", () => {
  const f = fixture();
  f.ownership.input({ text: "same", source: "rpc", streamingBehavior: "steer" }, f.ctx, 1);
  f.ownership.input({ text: "same", source: "extension", streamingBehavior: "followUp" }, f.ctx, 1);
  const native = { role: "user" as const, content: [{ type: "text" as const, text: "same" }], timestamp: 101 };
  f.ownership.message(native, f.ctx, 1);
  f.manager.appendMessage(native);
  expect(f.ownership.authorized(f.ctx, 1)).toBe(false);
  expect(f.ownership.revisionStarted(f.ctx, 1)).toBe(false);
  for (const source of ["other", "", "RPC"]) {
    f.accept("Please revise this plan", source);
    expect(f.ownership.authorized(f.ctx, 1)).toBe(false);
  }
});

test("completion tickets pin native revision, are one-use, and retire on reset or branch replacement", () => {
  const f = fixture();
  f.accept("revise", "rpc");
  expect(f.ownership.authorizeCall("one", f.ctx, 1)).toBe(true);
  expect(f.ownership.consumeCall("one", f.ctx, 1)).toBe(true);
  expect(f.ownership.consumeCall("one", f.ctx, 1)).toBe(false);
  expect(f.ownership.authorizeCall("one", f.ctx, 1)).toBe(false);
  expect(f.ownership.authorizeCall("old", f.ctx, 1)).toBe(true);
  f.accept("new revision", "rpc");
  expect(f.ownership.consumeCall("old", f.ctx, 1)).toBe(false);
  expect(f.ownership.authorizeCall("reset", f.ctx, 1)).toBe(true);
  f.ownership.reset();
  expect(f.ownership.consumeCall("reset", f.ctx, 1)).toBe(false);
  f.accept("new", "rpc");
  expect(f.ownership.authorizeCall("branch", f.ctx, 1)).toBe(true);
  f.manager.newSession();
  expect(f.ownership.consumeCall("branch", f.ctx, 1)).toBe(false);
});

test("handoff attribution reloads from compact validated branch entries, never literal prefixes/images", () => {
  const f = fixture();
  const body =
    "Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n# Private plan";
  const text = f.ownership.send(body, { implementationId: "implementation" }, f.ctx, 1);
  const owned = f.accept(text, "extension");
  const literal = f.accept(text, "rpc", [{ type: "image", data: "AA==", mimeType: "image/png" }]);
  f.ownership.commitHandoffs(f.ctx, 1);
  const entries = f.manager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === PLAN_HANDOFF_IDENTITY_ENTRY);
  expect(entries).toHaveLength(1);
  expect(JSON.stringify(entries)).not.toContain("Private plan");
  expect(JSON.stringify(entries)).not.toContain("AA==");
  const restored = new PlanInputOwnership();
  const active = restored.context([structuredClone(owned), literal], f.ctx, 9, {
    id: "implementation",
    plan: "# Private plan",
  });
  expect(active[0]).toMatchObject({ role: "custom", content: body });
  expect(active[1]).toBe(literal);
  const inactive = restored.context([owned, literal], f.ctx, 9);
  expect(inactive[0]).toMatchObject({ role: "custom", content: "" });
  expect(inactive[1]).toBe(literal);
  // Full native content is unchanged, including the private transport marker.
  expect(f.manager.getBranch().find((entry) => entry.type === "message")?.type).toBe("message");
  expect(owned.content[0]).toEqual({ type: "text", text });
  const nativeEntry = f.manager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.timestamp === owned.timestamp);
  expect(nativeEntry?.type).toBe("message");
  if (nativeEntry?.type === "message") nativeEntry.message.content = [{ type: "text", text: "changed" }];
  expect(restored.context([owned], f.ctx, 9)[0]).toBe(owned);
});

test("historical unattributed prose and malformed/cross-session identities are never claimed", () => {
  const f = fixture();
  const ordinary = f.accept("Plan mode is now disabled. Implement this proposed plan now: literal", "unknown");
  expect(f.ownership.authorized(f.ctx, 1)).toBe(false);
  f.manager.appendCustomEntry(PLAN_HANDOFF_IDENTITY_ENTRY, { version: 1, nativeId: "fake", key: "not a key" });
  expect(new PlanInputOwnership().context([ordinary], f.ctx, 2)[0]).toBe(ordinary);
});

test("many completed workflows and compactions keep only compact branch-relevant attribution", () => {
  const f = fixture();
  let first = "";
  for (let i = 0; i < 200; i++) {
    const text = f.ownership.send(`private body-${i}`, { implementationId: `implementation-${i}` }, f.ctx, 1);
    first ||= text;
    const native = f.accept(text, "extension");
    const transformed = f.ownership.context([native], f.ctx, 1);
    expect(transformed[0]).toMatchObject({ role: "custom", content: "" });
    f.ownership.settled();
    f.ownership.reset();
    if (i % 25 === 0) f.manager.appendCompaction("summary", f.manager.getLeafId(), 10_000);
    const restored = new PlanInputOwnership();
    expect(restored.context([structuredClone(native)], f.ctx, 7)[0]).toMatchObject({ role: "custom", content: "" });
    const memory = f.ownership as unknown as {
      deliveries: Map<string, unknown>;
      uncommittedHandoffs: unknown[];
      binding?: unknown;
      identities?: unknown;
    };
    expect(memory.deliveries.size).toBe(0);
    expect(memory.uncommittedHandoffs).toHaveLength(0);
    expect(memory.binding).toBeUndefined();
    expect(memory.identities).toBeUndefined();
  }
  const metadata = f.manager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === PLAN_HANDOFF_IDENTITY_ENTRY);
  expect(metadata).toHaveLength(200);
  expect(JSON.stringify(metadata)).not.toContain("private body-");
  f.manager.newSession();
  expect(f.ownership.context([], f.ctx, 2)).toEqual([]);
  expect(f.ownership.input({ text: first, source: "extension" }, f.ctx, 2)).toEqual({ action: "handled" });
});

for (const settleWhileInputIsAwaiting of [false, true]) {
  test(`retired native provenance survives an input await without claiming user literals: settle=${settleWhileInputIsAwaiting}`, () => {
    const f = fixture();
    const text = f.ownership.send(
      "Implement this proposed plan now:\n\n# Retired",
      { implementationId: "old" },
      f.ctx,
      1,
    );
    f.ownership.input({ text, source: "extension" }, f.ctx, 1);
    f.ownership.reset();
    if (settleWhileInputIsAwaiting) f.ownership.settled();
    const stale = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 101 };
    expect(f.ownership.message(stale, f.ctx, 2)).toEqual({ retired: true });
    f.manager.appendMessage(stale);
    expect(f.ownership.context([stale], f.ctx, 2)[0]?.content).toEqual([]);
    expect(f.ownership.revisionStarted(f.ctx, 2)).toBe(false);
    expect(f.ownership.authorized(f.ctx, 2)).toBe(false);
    for (const [index, images] of [[], [{ type: "image", data: "AA==", mimeType: "image/png" }]].entries()) {
      f.ownership.input({ text, source: "rpc", images }, f.ctx, 2);
      const literal = {
        role: "user" as const,
        content: [{ type: "text" as const, text }, ...images],
        timestamp: 102 + index,
      };
      f.ownership.message(literal, f.ctx, 2);
      f.manager.appendMessage(literal as Parameters<typeof f.manager.appendMessage>[0]);
      expect(f.ownership.context([stale, literal], f.ctx, 2).at(-1)).toEqual(literal);
    }
    expect(
      f.manager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === PLAN_HANDOFF_IDENTITY_ENTRY),
    ).toBe(false);
  });
}

test("unfinished native handoffs retain exact provenance through retirement and repeated pre-commit probes", () => {
  const f = fixture();
  const text = f.ownership.send("owned instruction", { implementationId: "old" }, f.ctx, 1);
  f.ownership.input({ text, source: "extension" }, f.ctx, 1);
  const native = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 101 };
  f.ownership.message(native, f.ctx, 1);
  f.ownership.commitHandoffs(f.ctx, 1);
  f.ownership.reset();
  f.ownership.settled();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 900_001);
  try {
    f.ownership.commitHandoffs(f.ctx, 2);
    f.manager.appendMessage(native);
    expect(f.ownership.context([native], f.ctx, 2)[0]).toMatchObject({ role: "custom", content: "" });
    expect(
      f.manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === PLAN_HANDOFF_IDENTITY_ENTRY),
    ).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
  }
});

test("retirement never aborts a different live operation through a lazy public context", () => {
  const f = fixture();
  const original = new AbortController();
  const replacement = new AbortController();
  let live = original.signal;
  const abort = vi.fn();
  const ctx = {
    ...f.ctx,
    get signal() {
      return live;
    },
    abort,
  } as ExtensionContext;
  const text = f.ownership.send("owned instruction", { implementationId: "old" }, ctx, 1);
  f.ownership.input({ text, source: "extension" }, ctx, 1);
  f.ownership.message({ role: "user", content: [{ type: "text", text }], timestamp: 101 }, ctx, 1);
  live = replacement.signal;
  f.ownership.reset();
  expect(abort).not.toHaveBeenCalled();
});

test("replacement factories deny authentic old natives with no candidates, but long-held real literal proofs survive", () => {
  const f = fixture();
  const text = f.ownership.send("old owned instruction", { revision: true }, f.ctx, 1);
  const replacement = new PlanInputOwnership();
  expect(replacement.message({ role: "user", content: [{ type: "text", text }], timestamp: 101 }, f.ctx, 2)).toEqual({
    retired: true,
  });
  replacement.input({ text, source: "rpc" }, f.ctx, 2);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 900_001);
  try {
    replacement.reset();
    replacement.settled();
    const literal = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 102 };
    expect(replacement.message(literal, f.ctx, 3)).toBeUndefined();
    f.manager.appendMessage(literal);
    expect(replacement.context([literal], f.ctx, 3)[0]).toBe(literal);
  } finally {
    vi.restoreAllMocks();
  }
});

test("unfinished bindings and retired context proofs remain bounded without TTL-based release", () => {
  const f = fixture();
  const replacement = new PlanInputOwnership();
  for (let index = 0; index < 300; index++) {
    const text = f.ownership.send(`owned-${index}`, { implementationId: `implementation-${index}` }, f.ctx, 1);
    f.ownership.input({ text, source: "extension" }, f.ctx, 1);
    const native = { role: "user", content: [{ type: "text", text }], timestamp: 101 + index };
    f.ownership.message(native, f.ctx, 1);
    expect(replacement.message(native, f.ctx, 2)).toEqual({ retired: true });
  }
  expect((f.ownership as unknown as { uncommittedHandoffs: unknown[] }).uncommittedHandoffs).toHaveLength(128);
  expect((replacement as unknown as { retiredNatives: unknown[] }).retiredNatives).toHaveLength(128);
});

test("pending/replay memory is bounded; authentic stale tokens remain rejected after eviction/reset/TTL", () => {
  const f = fixture();
  const first = f.ownership.send("private body", { revision: true }, f.ctx, 1);
  for (let i = 0; i < 1000; i++) {
    f.ownership.send(`body-${i}`, { revision: true }, f.ctx, 1);
    f.ownership.input(
      { text: `candidate-${i}`, source: "rpc", streamingBehavior: i % 2 ? "steer" : "followUp" },
      f.ctx,
      1,
    );
  }
  const memory = f.ownership as unknown as { pending: unknown[]; deliveries: Map<string, unknown> };
  expect(memory.pending.length).toBeLessThanOrEqual(256);
  expect(memory.deliveries.size).toBeLessThanOrEqual(128);
  expect(f.ownership.input({ text: first, source: "extension" }, f.ctx, 1)).toEqual({ action: "handled" });
  const latest = f.ownership.send("latest", { revision: true }, f.ctx, 1);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
  try {
    expect(f.ownership.input({ text: latest, source: "extension" }, f.ctx, 1)).toEqual({ action: "handled" });
    expect(memory.pending).toHaveLength(0);
    expect(memory.deliveries.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
  f.ownership.reset();
  expect(f.ownership.input({ text: latest, source: "extension" }, f.ctx, 2)).toEqual({ action: "handled" });
  f.accept(first, "rpc");
  expect(f.ownership.authorized(f.ctx, 1)).toBe(true);
});
