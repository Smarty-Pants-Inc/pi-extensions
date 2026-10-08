import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { captureProjectTrust, childProjectTrust, configurationContext, isProjectResource } from "../src/project-trust.js";

describe("resource traversal provenance", () => {
  it("detects denied prefixes even when the leaf escapes outside", () => {
    const root = mkdtempSync(join(tmpdir(), "trust-prefix-"));
    try {
      const denied = join(root, "denied");
      const outside = join(root, "outside");
      mkdirSync(join(denied, ".pi"), { recursive: true });
      mkdirSync(join(outside, "agents"), { recursive: true });
      writeFileSync(join(outside, "agents", "probe.md"), "outside");
      const global = join(root, "global");
      symlinkSync(join(denied, ".pi"), global);
      symlinkSync(join(outside, "agents"), join(denied, ".pi", "agents"));
      expect(isProjectResource(join(global, "agents", "probe.md"), denied)).toBe(true);
      expect(isProjectResource(join(global, "agents", "missing.md"), denied)).toBe(true);
      expect(isProjectResource(join(outside, "agents", "probe.md"), denied)).toBe(false);
      expect(isProjectResource("builtin:mcp", denied)).toBe(false);
      // Intermediate symlink targets also matter, not just lexical prefixes.
      const intermediate = join(denied, ".pi", "relay");
      symlinkSync(outside, intermediate);
      const relay = join(root, "relay");
      symlinkSync(intermediate, relay);
      expect(isProjectResource(join(relay, "agents", "probe.md"), denied)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["absolute-target", "relative-target", "direct-path", "relative-path"])("detects denied traversal before raw dot segments normalize: %s", (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "trust-dotdot-")));
    try {
      const denied = join(root, "denied");
      const outside = join(root, "outside");
      const genuineGlobal = join(root, "genuine-global");
      mkdirSync(join(denied, ".pi", "inner"), { recursive: true });
      mkdirSync(outside);
      mkdirSync(join(genuineGlobal, "agents"), { recursive: true });
      const leaf = join(genuineGlobal, "agents", "probe.md");
      writeFileSync(leaf, "SAFE_CANARY");
      symlinkSync(join(denied, ".pi", "inner"), join(outside, "bridge"));
      symlinkSync(genuineGlobal, join(denied, ".pi", "relay"));
      const rawTarget = `${outside}/bridge/../relay`;
      const alias = join(root, "alias");
      symlinkSync(kind === "relative-target" ? "outside/bridge/../relay" : rawTarget, alias);
      // Do not use join: it would erase the traversal this fixture proves.
      const rawPath = kind === "relative-path" ? `${relative(process.cwd(), outside)}/bridge/../relay` : kind === "direct-path" ? rawTarget : alias;
      const path = `${rawPath}/agents/probe.md`;
      expect(realpathSync.native(path)).toBe(leaf);
      expect(readFileSync(path, "utf8")).toBe("SAFE_CANARY");
      expect(isProjectResource(path, denied)).toBe(true);
      expect(isProjectResource(`${rawPath}/agents/missing.md`, denied)).toBe(true);
      expect(isProjectResource(path, join(root, "other-denied"))).toBe(false);
      expect(isProjectResource(leaf, denied)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds symlink traversal while retaining absent and genuinely global dot-segment paths", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "trust-walk-bounds-")));
    try {
      const denied = join(root, "denied");
      const global = join(root, "global");
      mkdirSync(join(global, "inner"), { recursive: true });
      expect(isProjectResource(`${global}/inner/../missing.md`, denied)).toBe(false);
      symlinkSync("cycle-b", join(root, "cycle-a"));
      symlinkSync("cycle-a", join(root, "cycle-b"));
      expect(isProjectResource(join(root, "cycle-a", "missing.md"), denied)).toBe(true);
      for (let index = 0; index < 65; index++) {
        symlinkSync(index === 64 ? global : `hop-${index + 1}`, join(root, `hop-${index}`));
      }
      expect(isProjectResource(join(root, "hop-0", "missing.md"), denied)).toBe(true);
      expect(isProjectResource(join(root, "hop-63", "missing.md"), denied)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([undefined, () => { throw new Error("unknown"); }])("fails closed with retained approval when the public trust API is unavailable: %s", (isProjectTrusted) => {
    const ctx = { cwd: "/approved-b", isProjectTrusted } as unknown as ExtensionContext;
    configurationContext(ctx, "/approved-b", { cwd: "/approved-b", trusted: true, deniedRoots: ["/denied-a"] });
    expect(captureProjectTrust(ctx)).toEqual({ cwd: "/approved-b", trusted: false, deniedRoots: ["/denied-a", "/approved-b"] });
  });

  it.each([undefined, () => { throw new Error("unknown"); }])("keeps ancestor denials when public trust is unavailable: %s", (isProjectTrusted) => {
    const ctx = { cwd: "/denied-a", isProjectTrusted } as unknown as ExtensionContext;
    const parent = captureProjectTrust(ctx);
    expect(parent.trusted).toBe(false);
    const child = childProjectTrust(parent, "/denied-b");
    configurationContext(ctx, child.cwd, child);
    const captured = captureProjectTrust(ctx);
    expect(captured.trusted).toBe(false);
    expect(captured.deniedRoots).toEqual(["/denied-a", "/denied-b"]);
  });
});
