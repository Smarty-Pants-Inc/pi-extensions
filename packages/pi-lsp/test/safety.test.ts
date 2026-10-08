import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import * as adapters from "../src/adapters.js";
import { LspClient } from "../src/lsp-client.js";
import extension from "../src/pi-lsp.js";
import * as routes from "../src/routes.js";
import { runDiagnostics, runFix, textResult } from "../src/runner.js";
import { resetStatus } from "../src/status.js";
import type { LspServerAdapter, StatusContext } from "../src/types.js";

let root: string;
const spills = new Set<string>();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "lsp-safety-test-"));
  writeFileSync(path.join(root, "slow.ts"), "original");
  writeFileSync(path.join(root, "fast.ts"), "original");
  vi.spyOn(LspClient.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "didOpen").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "didClose").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "diagnostics").mockResolvedValue([]);
  vi.spyOn(LspClient.prototype, "resolveActions").mockImplementation(async (actions) => actions);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  for (const directory of spills) rmSync(directory, { recursive: true, force: true });
  spills.clear();
});

function adapter(name: string): LspServerAdapter {
  return {
    name,
    isDefault: true,
    defaultCommand: { command: "unused", args: [] },
    missingCommandHint: "",
    extensions: [".ts"],
    skipDirectories: new Set(),
    isSupportedFile: () => true,
    languageIdFor: () => "typescript",
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function statusSession(id = "test-session") {
  const publications: Array<string | undefined> = [];
  // Distinct host call contexts and UI wrappers share only session identity.
  const context = (): StatusContext => ({
    sessionManager: { getSessionId: () => id },
    ui: {
      setStatus: (_key, label) => {
        publications.push(label);
      },
    },
  });
  return { context, publications };
}

function checkSpill(result: { content: Array<{ text: string }>; details: unknown }): string {
  const text = result.content.map((item) => item.text).join("\n");
  assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  const details = result.details as { outputPath: string };
  assert.ok(details.outputPath);
  spills.add(path.dirname(details.outputPath));
  assert.ok(text.includes(details.outputPath));
  assert.match(text, /Output truncated/);
  assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 2048);
  if (process.platform !== "win32") {
    assert.equal(statSync(path.dirname(details.outputPath)).mode & 0o777, 0o700);
    assert.equal(statSync(details.outputPath).mode & 0o777, 0o600);
  }
  return readFileSync(details.outputPath, "utf8");
}

test("8 MiB fix preview is bounded, privately spilled, and not duplicated in details", async () => {
  const replacement = "界".repeat(Math.ceil((8 * 1024 * 1024) / 3));
  vi.spyOn(LspClient.prototype, "codeActions").mockImplementation(async (uri) => [
    {
      title: "fix",
      kind: "source.fixAll",
      edit: {
        changes: {
          [uri]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
              newText: replacement,
            },
          ],
        },
      },
    },
  ]);
  const result = await runFix(
    adapter("huge"),
    { root, path: "slow.ts" },
    1000,
    undefined,
    statusSession().context(),
    "lsp",
  );
  assert.equal(checkSpill(result), `huge LSP fix computed changes for slow.ts.\n\n${replacement}`);
  const { compact, full } = checkDetailsSpill(result);
  assert.equal(compact.path, "slow.ts");
  assert.equal(compact.changed, true);
  assert.equal(compact.write, false);
  assert.equal(compact.outcome, "preview");
  assert.equal(full.text, replacement);
  assert.equal(full.edits[0].newText, replacement);
  assert.equal(readFileSync(path.join(root, "slow.ts"), "utf8"), "original");
});

test("8 MiB unchanged dry-run omits redundant file text from the persisted result", async () => {
  const original = "x".repeat(8 * 1024 * 1024);
  writeFileSync(path.join(root, "slow.ts"), original);
  vi.spyOn(LspClient.prototype, "codeActions").mockResolvedValue([]);
  const result = await runFix(
    adapter("noop"),
    { root, path: "slow.ts" },
    1000,
    undefined,
    statusSession().context(),
    "lsp",
  );
  assert.equal(result.content[0]?.text, "noop LSP fix left unchanged slow.ts.");
  const details = result.details as { path: string; changed: boolean; write: boolean; outcome: string; text?: string };
  assert.equal(details.path, "slow.ts");
  assert.equal(details.changed, false);
  assert.equal(details.write, false);
  assert.equal(details.outcome, "unchanged");
  assert.equal(details.text, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048, "session persistence must not retain the source file");
  assert.equal(readFileSync(path.join(root, "slow.ts"), "utf8"), original);
});

function checkDetailsSpill(result: { content: Array<{ text: string }>; details: unknown }) {
  const text = result.content.map((item) => item.text).join("\n");
  const details = result.details as {
    path: string;
    changed: boolean;
    write: boolean;
    outcome: string;
    outputPath: string;
    detailsPath: string;
  };
  assert.ok(details.detailsPath);
  spills.add(path.dirname(details.detailsPath));
  assert.ok(text.includes(details.detailsPath));
  assert.match(text, /Details exceeded/);
  assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 2048);
  if (process.platform !== "win32") {
    assert.equal(statSync(path.dirname(details.detailsPath)).mode & 0o777, 0o700);
    assert.equal(statSync(details.detailsPath).mode & 0o777, 0o600);
  }
  return { compact: details, full: JSON.parse(readFileSync(details.detailsPath, "utf8")) };
}

test("8 MiB no-op replacement edits are spilled even when a dry-run leaves the file unchanged", async () => {
  const original = "x".repeat(8 * 1024 * 1024);
  writeFileSync(path.join(root, "slow.ts"), original);
  vi.spyOn(LspClient.prototype, "codeActions").mockImplementation(async (uri) => [
    {
      title: "noop",
      kind: "source.fixAll",
      edit: {
        changes: {
          [uri]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: original.length } },
              newText: original,
            },
          ],
        },
      },
    },
  ]);
  const result = await runFix(
    adapter("noop"),
    { root, path: "slow.ts" },
    1000,
    undefined,
    statusSession().context(),
    "lsp",
  );
  const { compact, full } = checkDetailsSpill(result);
  assert.equal(compact.changed, false);
  assert.equal(compact.write, false);
  assert.equal(compact.path, "slow.ts");
  assert.equal(compact.outcome, "unchanged");
  assert.equal(full.text, undefined);
  assert.equal(full.edits[0].newText, original);
  assert.equal(readFileSync(compact.outputPath, "utf8"), "noop LSP fix left unchanged slow.ts.");
  assert.equal(readFileSync(path.join(root, "slow.ts"), "utf8"), original);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
});

test("8 MiB written replacement spills edits independently of the short rendered summary", async () => {
  const replacement = "x".repeat(8 * 1024 * 1024);
  vi.spyOn(LspClient.prototype, "codeActions").mockImplementation(async (uri) => [
    {
      title: "fix",
      kind: "source.fixAll",
      edit: {
        changes: {
          [uri]: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: replacement },
          ],
        },
      },
    },
  ]);
  const result = await runFix(
    adapter("huge"),
    { root, path: "slow.ts", write: true },
    1000,
    undefined,
    statusSession().context(),
    "lsp",
  );
  const { compact, full } = checkDetailsSpill(result);
  assert.deepEqual(
    { path: compact.path, changed: compact.changed, write: compact.write, outcome: compact.outcome },
    { path: "slow.ts", changed: true, write: true, outcome: "updated" },
  );
  assert.equal(full.edits[0].newText, replacement);
  assert.equal(full.text, undefined);
  assert.equal(readFileSync(compact.outputPath, "utf8"), "huge LSP fix updated slow.ts.");
  assert.equal(readFileSync(path.join(root, "slow.ts"), "utf8"), replacement);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096, "session persistence must not retain replacement edits");
});

test("oversized details are bounded even with short diagnostics/error text, and notices share the text budget", () => {
  for (const text of ["no diagnostics", "server error", "a".repeat(DEFAULT_MAX_BYTES - 20)]) {
    const huge = "x".repeat(8 * 1024 * 1024);
    const result = textResult(text, { message: huge, path: "slow.ts", changed: false, write: false });
    const { compact, full } = checkDetailsSpill(result);
    assert.equal(full.message, huge);
    assert.equal(compact.path, "slow.ts");
    assert.equal(compact.changed, false);
    assert.equal(compact.write, false);
    assert.equal(readFileSync(compact.outputPath, "utf8"), text);
  }
});

test("small preview details remain available and compact spill metadata cannot be oversized", () => {
  const small = { text: "replacement", edits: [], path: "slow.ts", changed: true, write: false };
  assert.deepEqual(textResult("preview", small).details, small);
  const huge = "x".repeat(8 * 1024 * 1024);
  const result = textResult("updated", { path: huge, uri: huge, kind: huge, outcome: huge, edits: huge });
  const details = result.details as { detailsPath: string };
  spills.add(path.dirname(details.detailsPath));
  assert.ok(Buffer.byteLength(JSON.stringify(result.details)) <= DEFAULT_MAX_BYTES);
  assert.equal(JSON.parse(readFileSync(details.detailsPath, "utf8")).path, huge);
});

test("line and byte limits include the notice, and spills have unique paths", () => {
  const text = "diagnostic\n".repeat(3000);
  const first = textResult(text, { text });
  const second = textResult(text, { text });
  assert.equal(checkSpill(first), text);
  assert.equal(checkSpill(second), text);
  assert.notEqual(
    (first.details as { outputPath: string }).outputPath,
    (second.details as { outputPath: string }).outputPath,
  );
  assert.equal(checkSpill(textResult("x".repeat(8 * 1024 * 1024), undefined)), "x".repeat(8 * 1024 * 1024));
});

test("multi-route diagnostics enforce one final aggregate budget and spill every full section", async () => {
  const servers = [adapter("one"), adapter("two"), adapter("three")];
  const files = [path.join(root, "slow.ts")];
  vi.spyOn(adapters, "loadRuntime").mockReturnValue({ adapters: servers, timeoutMs: 1000 });
  vi.spyOn(routes, "selectDiagnosticRoutes").mockReturnValue({
    root,
    skipped: [],
    routes: servers.map((server) => ({ adapter: server, files, reason: `route ${server.name}` })),
  });
  const message = "diagnostic ".repeat(4000);
  vi.mocked(LspClient.prototype.diagnostics).mockResolvedValue([
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message,
    },
  ]);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<ReturnType<typeof textResult>> }> = [];
  extension({ registerTool: (tool: never) => tools.push(tool), registerCommand() {}, on() {} } as never);
  const tool = tools.find(({ name }) => name === "lsp_diagnostics");
  assert.ok(tool);
  const result = await tool.execute("aggregate", { root }, undefined, undefined, {
    ...statusSession().context(),
    cwd: root,
    isProjectTrusted: () => false,
  });
  const full = checkSpill(result);
  for (const server of servers) {
    assert.ok(full.includes(`route ${server.name}`));
    assert.ok(full.includes(`diagnostic ${server.name}: ${message}`));
  }
  assert.equal(full.split("\n\n---\n\n").length, 3);
});

test("fast concurrent diagnostics completion retains the slow server status until the last completion", async () => {
  const session = statusSession("diagnostic-concurrency");
  const slowStarted = gate();
  const slowRelease = gate();
  vi.mocked(LspClient.prototype.diagnostics).mockImplementation(async (uri) => {
    if (uri.endsWith("slow.ts")) {
      slowStarted.release();
      await slowRelease.promise;
    }
    return [];
  });
  const slow = runDiagnostics(adapter("slow"), { root, paths: ["slow.ts"] }, 1000, undefined, session.context(), "lsp");
  await slowStarted.promise;
  await runDiagnostics(adapter("fast"), { root, paths: ["fast.ts"] }, 1000, undefined, session.context(), "lsp");
  assert.deepEqual(session.publications, ["slow diagnostics", "fast diagnostics", "slow diagnostics"]);
  slowRelease.release();
  await slow;
  assert.equal(session.publications.at(-1), undefined);
});

test("fast fixes on different files retain slow fix status and preserve both full mutation windows", async () => {
  const session = statusSession("fix-concurrency");
  const slowStarted = gate();
  const slowRelease = gate();
  vi.spyOn(LspClient.prototype, "codeActions").mockImplementation(async (uri, text) => {
    assert.equal(text, "original");
    if (uri.endsWith("slow.ts")) {
      slowStarted.release();
      await slowRelease.promise;
    }
    return [
      {
        title: "fix",
        kind: "source.fixAll",
        edit: {
          changes: {
            [uri]: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
                newText: "fixed",
              },
            ],
          },
        },
      },
    ];
  });
  const slow = runFix(
    adapter("server"),
    { root, path: "slow.ts", write: true },
    1000,
    undefined,
    session.context(),
    "lsp",
  );
  await slowStarted.promise;
  await runFix(adapter("server"), { root, path: "fast.ts", write: true }, 1000, undefined, session.context(), "lsp");
  assert.deepEqual(session.publications, ["server fix", "server fix", "server fix"]);
  assert.equal(readFileSync(path.join(root, "fast.ts"), "utf8"), "fixed");
  assert.equal(readFileSync(path.join(root, "slow.ts"), "utf8"), "original");
  slowRelease.release();
  await slow;
  assert.equal(readFileSync(path.join(root, "slow.ts"), "utf8"), "fixed");
  assert.equal(session.publications.at(-1), undefined);
});

test("a failed concurrent server call removes only its own status token", async () => {
  const session = statusSession("failed-concurrency");
  const started = gate();
  const release = gate();
  vi.mocked(LspClient.prototype.diagnostics).mockImplementation(async (uri) => {
    if (uri.endsWith("fast.ts")) throw new Error("fast diagnostics failed");
    started.release();
    await release.promise;
    return [];
  });
  const slow = runDiagnostics(adapter("slow"), { root, paths: ["slow.ts"] }, 1000, undefined, session.context(), "lsp");
  await started.promise;
  await assert.rejects(
    runDiagnostics(adapter("fast"), { root, paths: ["fast.ts"] }, 1000, undefined, session.context(), "lsp"),
    /fast diagnostics failed/,
  );
  assert.deepEqual(session.publications, ["slow diagnostics", "fast diagnostics", "slow diagnostics"]);
  release.release();
  await slow;
  assert.equal(session.publications.at(-1), undefined);
});

test("lifecycle reset invalidates old tokens and sessions cannot clear each other's status", async () => {
  const old = statusSession("reused-session");
  const started = gate();
  const release = gate();
  vi.mocked(LspClient.prototype.diagnostics).mockImplementation(async () => {
    started.release();
    await release.promise;
    return [];
  });
  const running = runDiagnostics(adapter("old"), { root, paths: ["slow.ts"] }, 1000, undefined, old.context(), "lsp");
  await started.promise;
  resetStatus(old.context(), "lsp");
  const fresh = statusSession("fresh-session");
  vi.mocked(LspClient.prototype.diagnostics).mockResolvedValue([]);
  await runDiagnostics(adapter("fresh"), { root, paths: ["fast.ts"] }, 1000, undefined, fresh.context(), "lsp");
  release.release();
  await running;
  assert.deepEqual(old.publications, ["old diagnostics", undefined]);
  assert.deepEqual(fresh.publications, ["fresh diagnostics", undefined]);
});
