/**
 * agent-guidance - Provider-specific context loading
 *
 * Loads CLAUDE.md, CODEX.md, or GEMINI.md based on current model provider,
 * supplementing Pi Core's AGENTS.md loading.
 *
 * Deduplication uses the host's actual context files, by resolved path or content.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const PROVIDER_FILES: Record<string, string[]> = {
  anthropic: ["CLAUDE.md"],
  openai: ["CODEX.md"],
  "openai-codex": ["CODEX.md"],
  "github-copilot": ["CODEX.md"],
  google: ["GEMINI.md"],
  "google-gemini-cli": ["GEMINI.md"],
  "google-antigravity": ["GEMINI.md"],
  "google-vertex": ["GEMINI.md"],
};

interface Config {
  providers?: Record<string, string[]>;
  models?: Record<string, string[]>;
}

function loadConfig(agentDir: string): Config {
  const configPath = path.join(agentDir, "agent-guidance.json");
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

function globMatch(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.replace(/\*/g, ".*")}$`, "i").test(value);
}

function getCandidateFiles(modelId: string | undefined, provider: string, config: Config): string[] {
  // Model-specific patterns take priority
  if (modelId && config.models) {
    for (const [pattern, files] of Object.entries(config.models)) {
      if (globMatch(pattern, modelId)) return files;
    }
  }
  // Then provider config, then defaults
  return config.providers?.[provider] ?? PROVIDER_FILES[provider] ?? [];
}

interface ContextFile {
  path: string;
  content: string;
}

function readContextFile(filePath: string): ContextFile | undefined {
  try {
    if (!fs.statSync(filePath).isFile()) return undefined;
    return { path: filePath, content: fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/u, "") };
  } catch {
    return undefined;
  }
}

function resolvedPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

// Older hosts do not expose systemPromptOptions. Match core selection, including
// unreadable/non-file candidates, rather than inferring selection from existence.
function legacyContextFiles(directories: string[]): ContextFile[] {
  return directories.flatMap((dir) => {
    for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
      const file = readContextFile(path.join(dir, name));
      if (file) return [file];
    }
    return [];
  });
}

function shouldLoad(file: ContextFile, contextFiles: readonly ContextFile[]): boolean {
  const candidatePath = resolvedPath(file.path);
  return !contextFiles.some((loaded) => resolvedPath(loaded.path) === candidatePath || loaded.content === file.content);
}

function getDirectories(cwd: string, agentDir: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  // Global agent dir first
  if (fs.existsSync(agentDir)) {
    dirs.push(agentDir);
    seen.add(agentDir);
  }

  // Walk up from cwd to root
  let current = cwd;
  const ancestors: string[] = [];
  while (true) {
    if (!seen.has(current)) {
      ancestors.unshift(current);
      seen.add(current);
    }
    const parent = path.resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  dirs.push(...ancestors);
  return dirs;
}

export default function agentGuidance(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const config = loadConfig(agentDir);

  pi.on("before_agent_start", async (event, ctx) => {
    const provider = ctx.model?.provider;
    if (!provider) return;

    const candidates = getCandidateFiles(ctx.model?.id, provider, config);
    if (candidates.length === 0) return;

    const directories = getDirectories(ctx.cwd, agentDir);
    const contextFiles = event.systemPromptOptions?.contextFiles ?? legacyContextFiles(directories);
    const files: ContextFile[] = [];

    for (const dir of directories) {
      for (const filename of candidates) {
        const file = readContextFile(path.join(dir, filename));
        if (file && shouldLoad(file, contextFiles)) files.push(file);
      }
    }

    if (files.length === 0) return;

    let append = "\n\n# Provider-Specific Context\n\n";
    for (const { path: p, content } of files) {
      append += `## ${p}\n\n${content}\n\n`;
    }

    return { systemPrompt: event.systemPrompt + append };
  });
}
