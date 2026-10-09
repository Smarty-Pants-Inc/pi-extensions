import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

import { type ActionOwnership, ownedCustom } from "./owned-custom.js";

export type { ActionOwnership } from "./owned-custom.js";

export async function copyToClipboard(pi: ExtensionAPI, content: string, ownership: ActionOwnership): Promise<boolean> {
  if (!ownership.isCurrent() || ownership.signal.aborted) return false;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-code-"));
  try {
    fs.chmodSync(tmpDir, 0o700);
    const tmpPath = path.join(tmpDir, "clipboard.txt");
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });

    const commands: Array<{ command: string; args: string[] }> = [];
    if (process.platform === "darwin") {
      commands.push({ command: "sh", args: ["-c", 'exec pbcopy < "$1"', "pi-clipboard", tmpPath] });
    } else if (process.platform === "win32") {
      commands.push({
        command: "powershell",
        args: ["-NoProfile", "-Command", `Get-Content -Raw "${tmpPath}" | Set-Clipboard`],
      });
    } else {
      // Replace the shell so Pi's cancellation targets the utility, not a pipeline parent.
      // Pass the private path as data: temporary-directory names can contain shell syntax.
      commands.push({ command: "sh", args: ["-c", 'exec wl-copy < "$1"', "pi-clipboard", tmpPath] });
      commands.push({ command: "sh", args: ["-c", 'exec xclip -selection clipboard < "$1"', "pi-clipboard", tmpPath] });
      commands.push({ command: "sh", args: ["-c", 'exec xsel --clipboard --input < "$1"', "pi-clipboard", tmpPath] });
    }

    for (const cmd of commands) {
      if (!ownership.isCurrent() || ownership.signal.aborted) return false;
      try {
        const result = await pi.exec(cmd.command, cmd.args, { signal: ownership.signal });
        if (!ownership.isCurrent() || ownership.signal.aborted) return false;
        if (result.code === 0 && !result.killed) return true;
      } catch {
        if (!ownership.isCurrent() || ownership.signal.aborted) return false;
        // Try the next utility only while this operation still owns the clipboard action.
      }
    }

    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function insertIntoEditor(
  ctx: ExtensionCommandContext,
  content: string,
  ownership: ActionOwnership,
): Promise<boolean> {
  if (!ownership.isCurrent()) return false;
  if (ctx.mode === "rpc") {
    const confirmed = await ctx.ui.confirm(
      "Replace client draft with snippet?",
      "RPC cannot read or append to the client draft. This will replace the entire draft with the selected snippet.",
      { signal: ownership.signal },
    );
    if (!ownership.isCurrent() || !confirmed) return false;
    ctx.ui.setEditorText(content);
    return true;
  }
  const existing = ctx.ui.getEditorText();
  const next = existing ? `${existing}\n${content}` : content;
  ctx.ui.setEditorText(next);
  return true;
}

function formatOutput(command: string, result: { stdout: string; stderr: string; code: number }): string {
  const lines: string[] = [];
  lines.push(`Command: ${command}`);
  lines.push(`Exit code: ${result.code}`);

  if (result.stdout.trim().length > 0) {
    lines.push("");
    lines.push("STDOUT:");
    lines.push(result.stdout.trimEnd());
  }

  if (result.stderr.trim().length > 0) {
    lines.push("");
    lines.push("STDERR:");
    lines.push(result.stderr.trimEnd());
  }

  return lines.join("\n");
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  const truncated = lines.slice(0, maxLines).join("\n");
  return `${truncated}\n\n[Output truncated to ${maxLines} lines]`;
}

export async function runSnippet(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  snippet: string,
  ownership: ActionOwnership,
): Promise<void> {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "powershell" : "bash";
  const args = isWindows ? ["-NoProfile", "-Command", snippet] : ["-lc", snippet];

  const result = await pi.exec(command, args, { cwd: ctx.cwd, signal: ownership.signal });
  if (!ownership.isCurrent()) return;
  const output = truncateLines(formatOutput(`${command} ${args.join(" ")}`, result), 200);

  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(output, result.code === 0 ? "info" : "error");
    return;
  }

  await ownedCustom<void>(ctx, ownership, (_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Command Output")), 1, 0));

    const text = new Text(output, 1, 0);
    container.addChild(text);

    container.addChild(new Text(theme.fg("dim", "Enter/Esc to close"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

    return {
      render: (width: number) => container.render(width).map((line) => truncateToWidth(line, width)),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
          done();
        }
      },
    };
  });
}
