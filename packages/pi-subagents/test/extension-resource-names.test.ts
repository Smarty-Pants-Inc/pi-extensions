import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager, type ResolvedResource, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { extensionCanonicalNames } from "../src/agent-runner.js";
import { resolveExtensionResourceNames } from "../src/extension-resource-names.js";

describe("resource association priority", () => {
  it.each([false, true])("keeps separate declaring owners for the same path while canonical direct B wins (reverse=%s)", async reverse => {
    const root = mkdtempSync(join(tmpdir(), "resource-associations-"));
    try {
      const a = join(root, "a"); const b = join(root, "b"); const agentDir = join(root, "agent");
      for (const directory of [a, b, agentDir]) mkdirSync(directory);
      const entry = join(b, "entry.ts");
      writeFileSync(entry, "export default function() { throw new Error('must not evaluate'); }");
      symlinkSync(entry, join(a, "alias.ts"), "file");
      writeFileSync(join(a, "package.json"), JSON.stringify({ name: "@fixture/a", pi: { extensions: ["./alias.ts"] } }));
      writeFileSync(join(b, "package.json"), JSON.stringify({ name: "@fixture/b", pi: { extensions: ["./entry.ts"] } }));
      const resource = (packageRoot?: string): ResolvedResource => ({ path: entry, enabled: true,
        metadata: { source: packageRoot ?? entry, scope: "user", origin: packageRoot ? "package" : "top-level", packageRoot } });
      const declaredA = resource(a); const declaredB = resource(b); const direct = resource();
      const resources = reverse ? [direct, declaredB, declaredA] : [declaredA, declaredB, direct];
      const packages = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir) });
      const resolved = await resolveExtensionResourceNames(resources, packages, extensionCanonicalNames);
      expect(resolved.names.get(entry)).toEqual(expect.arrayContaining(["a", "b", "entry"]));
      expect(resolved.packageName(declaredA)).toBe("a");
      expect(resolved.packageName(declaredB)).toBe("b");
      expect(resolved.packageName(direct)).toBe("b");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
