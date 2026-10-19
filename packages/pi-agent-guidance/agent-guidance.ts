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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileMapping(value: unknown): value is Record<string, string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every((files) => Array.isArray(files) && files.every((file) => typeof file === "string"))
  );
}

function loadConfig(agentDir: string): Config {
  const configPath = path.join(agentDir, "agent-guidance.json");
  try {
    const config: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8").replace(/^\uFEFF/u, ""));
    if (!isRecord(config)) throw new Error("expected an object");
    for (const key of ["providers", "models"]) {
      if (key in config && !isFileMapping(config[key])) throw new Error(`${key} must map names to string arrays`);
    }
    return {
      providers: isFileMapping(config.providers) ? config.providers : undefined,
      models: isFileMapping(config.models) ? config.models : undefined,
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    // Configuration is loaded once per extension instance, so invalid bytes
    // produce one diagnostic, not one warning per model request.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`agent-guidance: invalid ${configPath}: ${message}; using defaults`);
    return {};
  }
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i").test(value);
}

function getCandidateFiles(modelId: string | undefined, provider: string, config: Config): string[] {
  // Model-specific patterns take priority
  if (modelId && config.models) {
    for (const [pattern, files] of Object.entries(config.models)) {
      if (globMatch(pattern, modelId)) return files;
    }
  }
  // Then provider config, then defaults
  if (config.providers && Object.hasOwn(config.providers, provider)) return config.providers[provider];
  return Object.hasOwn(PROVIDER_FILES, provider) ? PROVIDER_FILES[provider] : [];
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
        if (file && shouldLoad(file, [...contextFiles, ...files])) files.push(file);
      }
    }

    if (files.length === 0) return;

    const options = event.systemPromptOptions;
    const section = "provider_context";
    const existing = options?.sections?.[section] ?? "";
    const additions = files
      .map(({ path: p, content }) => `## ${p}\n\n${content}\n\n`)
      .filter((text) => !(options ? existing : event.systemPrompt).includes(text));
    if (additions.length === 0) return;
    const append = `${existing ? "" : "# Provider-Specific Context\n\n"}${additions.join("")}`;

    if (!options) return { systemPrompt: `${event.systemPrompt}\n\n${append}` };
    // Mutate only our section. Rendering the whole prompt here would force an
    // opaque replacement, hiding later policy, context, and tool mutations.
    options.sections ??= {};
    options.sections[section] = `${existing}${existing && !existing.endsWith("\n\n") ? "\n\n" : ""}${append}`;
    // Respect a full replacement intentionally installed by an earlier handler.
    // Structured hosts without a forced prompt remain entirely structured.
    if (options.forceSystemPrompt !== undefined && !options.forceSystemPrompt.includes(append)) {
      options.forceSystemPrompt += `\n\n${append}`;
    }
  });
}
