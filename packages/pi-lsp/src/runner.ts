import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as piHost from "@earendil-works/pi-coding-agent";
import { collectSupportedFiles, resolveRoot, resolveSupportedFile } from "./files.js";
import { LspClient } from "./lsp-client.js";
import { beginStatus } from "./status.js";
import { applyTextEdits, collectWorkspaceEdits, hasOverlappingTextEdits } from "./text-edits.js";
import type { CodeAction, DiagnosticEntry, LspServerAdapter, LspTextEdit, StatusContext } from "./types.js";

export const DEFAULT_FILE_LIMIT = 50;

export async function runDiagnostics(
  adapter: LspServerAdapter,
  params: { root?: string; paths?: string[]; limit?: number; files?: string[] },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
  boundOutput = true,
) {
  const root = resolveRoot(params.root);
  const command = adapter.defaultCommand;
  const files = params.files ?? collectSupportedFiles(adapter, root, params.paths, params.limit ?? DEFAULT_FILE_LIMIT);
  if (files.length === 0) {
    return textResult(`${adapter.name} LSP found no supported files to check.`, {
      root,
      command,
      files: [],
      summary: { files: 0, diagnostics: 0 },
    });
  }

  const client = new LspClient(adapter, command, root, timeoutMs);
  const abort = () => client.close();
  throwIfAborted(signal, adapter);
  signal?.addEventListener("abort", abort, { once: true });

  let finishStatus: (() => void) | undefined;
  try {
    finishStatus = beginStatus(ctx, statusKey, `${adapter.name} diagnostics`);
    throwIfAborted(signal, adapter);
    await client.start();
    await client.initialize(root);

    const openedFiles: Array<{ file: string; uri: string }> = [];
    try {
      for (const file of files) {
        throwIfAborted(signal, adapter);
        const uri = pathToFileURL(file).href;
        const text = readFileSync(file, "utf8");
        client.didOpen(uri, text, adapter.languageIdFor(file));
        openedFiles.push({ file, uri });
      }

      const entries: DiagnosticEntry[] = await Promise.all(
        openedFiles.map(async ({ file, uri }) => ({
          path: path.relative(root, file) || file,
          uri,
          diagnostics: await client.diagnostics(uri),
        })),
      );
      return textResult(
        formatDiagnostics(adapter, entries),
        { root, command, files: entries, summary: summarize(entries) },
        boundOutput,
      );
    } finally {
      for (const { uri } of openedFiles) client.didClose(uri);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      await client.shutdown();
    } finally {
      finishStatus?.();
    }
  }
}

export async function runFix(
  adapter: LspServerAdapter,
  params: { root?: string; path: string; kind?: string; write?: boolean },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
) {
  const root = resolveRoot(params.root);
  const file = resolveSupportedFile(adapter, root, params.path);
  // Namespace lookup keeps loading compatible with hosts predating the public queue.
  const queue = (piHost as { withFileMutationQueue?: <T>(file: string, run: () => Promise<T>) => Promise<T> })
    .withFileMutationQueue;
  const run = () => runFixWindow(adapter, { ...params, root, path: file }, timeoutMs, signal, ctx, statusKey);
  return params.write && queue ? queue(file, run) : run();
}

async function runFixWindow(
  adapter: LspServerAdapter,
  params: { root: string; path: string; kind?: string; write?: boolean },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
) {
  const root = params.root;
  const file = params.path;
  const actionKind = params.kind?.trim() || "source.fixAll";

  const command = adapter.defaultCommand;
  const client = new LspClient(adapter, command, root, timeoutMs);
  const abort = () => client.close();
  throwIfAborted(signal, adapter);
  signal?.addEventListener("abort", abort, { once: true });

  let finishStatus: (() => void) | undefined;
  try {
    finishStatus = beginStatus(ctx, statusKey, `${adapter.name} fix`);
    throwIfAborted(signal, adapter);
    await client.start();
    await client.initialize(root);
    throwIfAborted(signal, adapter);
    const uri = pathToFileURL(file).href;
    const text = readFileSync(file, "utf8");
    client.didOpen(uri, text, adapter.languageIdFor(file));
    let resolvedActions: CodeAction[];
    let selectedActions: CodeAction[];
    let edits: LspTextEdit[];
    let newText: string;
    try {
      const diagnostics = await client.diagnostics(uri);
      const actions = await client.codeActions(uri, text, diagnostics, actionKind);
      resolvedActions = await client.resolveActions(actions);
      selectedActions = selectCodeActions(resolvedActions, actionKind);
      edits = selectedActions.flatMap((action) => collectWorkspaceEdits(action.edit, uri));
      if (hasOverlappingTextEdits(text, edits)) {
        const relativePath = path.relative(root, file) || file;
        throw new Error(
          `${adapter.name} LSP returned overlapping code-action edits for ${relativePath}; ` +
            "use a narrower action kind.",
        );
      }
      newText = applyTextEdits(text, edits);
    } finally {
      client.didClose(uri);
    }
    const changed = newText !== text;

    throwIfAborted(signal, adapter);
    if (params.write && changed) writeFileSync(file, newText);

    return textResult(formatEditSummary(adapter, "fix", root, file, changed, params.write, newText), {
      path: path.relative(root, file) || file,
      uri,
      changed,
      write: params.write ?? false,
      outcome: changed ? (params.write ? "updated" : "preview") : "unchanged",
      kind: actionKind,
      actions: resolvedActions.map(({ title, kind }) => ({ title, kind })),
      appliedActions: selectedActions.map(({ title, kind }) => ({ title, kind })),
      edits,
      text: !params.write && changed ? newText : undefined,
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      await client.shutdown();
    } finally {
      finishStatus?.();
    }
  }
}

function selectCodeActions(actions: CodeAction[], requestedKind: string) {
  return actions.filter((action) => action.kind === requestedKind || action.kind?.startsWith(`${requestedKind}.`));
}

function formatDiagnostics(adapter: LspServerAdapter, entries: DiagnosticEntry[]) {
  const lines = entries.flatMap((entry) => {
    if (entry.diagnostics.length === 0) return [`${entry.path}: no diagnostics`];

    return entry.diagnostics.map((diagnostic) => {
      const line = diagnostic.range.start.line + 1;
      const column = diagnostic.range.start.character + 1;
      const severity = severityName(diagnostic.severity);
      const source = diagnostic.source ?? adapter.name;
      const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
      return `${entry.path}:${line}:${column}: ${severity} ${source}${code}: ${diagnostic.message}`;
    });
  });

  const summary = summarize(entries);
  return [
    `${adapter.name} LSP diagnostics: ${summary.diagnostics} diagnostic(s) across ${summary.files} file(s).`,
    "",
    ...lines,
  ].join("\n");
}

function formatEditSummary(
  adapter: LspServerAdapter,
  action: "fix",
  root: string,
  file: string,
  changed: boolean,
  write: boolean | undefined,
  text: string,
) {
  const relativePath = path.relative(root, file) || file;
  const status = changed ? (write ? "updated" : "computed changes for") : "left unchanged";
  const summary = `${adapter.name} LSP ${action} ${status} ${relativePath}.`;
  if (write || !changed) return summary;
  return `${summary}\n\n${text}`;
}

function summarize(entries: DiagnosticEntry[]) {
  return {
    files: entries.length,
    diagnostics: entries.reduce((total, entry) => total + entry.diagnostics.length, 0),
  };
}

function severityName(severity: number | undefined) {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "info";
  if (severity === 4) return "hint";
  return "diagnostic";
}

function throwIfAborted(signal: AbortSignal | undefined, adapter: LspServerAdapter) {
  if (signal?.aborted) throw new Error(`${adapter.name} LSP request aborted.`);
}

export function textResult(text: string, details: unknown, boundOutput = true) {
  // Unbounded sections are internal only; the complete diagnostics aggregate is bounded once.
  if (!boundOutput) return { content: [{ type: "text" as const, text }], details };
  const truncation = piHost.truncateHead(text);
  const serializedDetails = JSON.stringify(details);
  const oversizedDetails =
    serializedDetails !== undefined && Buffer.byteLength(serializedDetails) > piHost.DEFAULT_MAX_BYTES;
  if (!truncation.truncated && !oversizedDetails) {
    return { content: [{ type: "text" as const, text }], details };
  }

  const directory = mkdtempSync(path.join(tmpdir(), "pi-lsp-output-"));
  const outputPath = path.join(directory, "output.txt");
  const detailsPath = oversizedDetails ? path.join(directory, "details.json") : undefined;
  try {
    chmodSync(directory, 0o700);
    writeFileSync(outputPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (detailsPath && serializedDetails !== undefined) {
      writeFileSync(detailsPath, serializedDetails, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const notice = [
    truncation.truncated
      ? `[Output truncated at the ${piHost.DEFAULT_MAX_LINES}-line / 50 KiB limit. Full output: ${outputPath}]`
      : `[Full output: ${outputPath}]`,
    ...(detailsPath ? [`[Details exceeded the 50 KiB limit. Full details: ${detailsPath}]`] : []),
  ].join("\n");
  // Budget both notices too, including when one huge line cannot fit in the preview.
  const preview = piHost.truncateHead(text, {
    maxBytes: piHost.DEFAULT_MAX_BYTES - Buffer.byteLength(notice) - 2,
    maxLines: piHost.DEFAULT_MAX_LINES - notice.split("\n").length - 2,
  });
  return {
    content: [{ type: "text" as const, text: `${preview.content}\n\n${notice}` }],
    // Session persistence gets only compact metadata, never the bulky text/edits/messages.
    details: { ...compactDetails(details), outputPath, detailsPath, truncation: { ...preview, content: undefined } },
  };
}

function compactDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object") return {};
  const source = details as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of ["outcome", "path", "uri", "changed", "write", "kind", "root"]) {
    const value = source[key];
    if (typeof value === "string") {
      compact[key] = piHost.truncateHead(value, { maxBytes: 1024, maxLines: 4 }).content;
    } else if (typeof value === "boolean" || typeof value === "number") {
      compact[key] = value;
    }
  }
  return compact;
}
