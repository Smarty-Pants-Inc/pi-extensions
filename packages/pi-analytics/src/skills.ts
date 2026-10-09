import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InputSource } from "@earendil-works/pi-coding-agent";

export interface AvailableSkill {
  name: string;
  filePath: string;
}

export interface PendingExplicitSkill {
  name: string;
  observedAtMs: number;
  source: "interactive" | "rpc";
}

export function explicitSkillName(text: string): string | undefined {
  return text.match(/^\/skill:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\s|$)/u)?.[1];
}

export class SkillTracker {
  private pending: PendingExplicitSkill | undefined;
  private readonly skillByPath = new Map<string, string>();
  private readonly availableNames = new Set<string>();

  constructor(
    private readonly cwd: string,
    private readonly canonicalize: (filePath: string) => Promise<string> = realpath,
  ) {}

  observeInput(text: string, source: InputSource, now: number): void {
    if (source === "extension") return;
    const name = explicitSkillName(text);
    this.pending = name ? { name, observedAtMs: now, source } : undefined;
  }

  consumeExplicitSkill(): PendingExplicitSkill | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }

  clearPending(): void {
    this.pending = undefined;
  }

  hasAvailableSkill(name: string): boolean {
    return this.availableNames.has(name);
  }

  async setAvailableSkills(skills: readonly AvailableSkill[]): Promise<void> {
    this.skillByPath.clear();
    this.availableNames.clear();
    const seenNames = new Set<string>();
    for (const skill of skills) {
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      this.availableNames.add(skill.name);
      const canonical = await this.canonicalize(skill.filePath).catch(() => path.resolve(this.cwd, skill.filePath));
      this.skillByPath.set(canonical, skill.name);
    }
  }

  async matchSuccessfulRead(input: {
    toolName: string;
    input: unknown;
    isError: boolean;
  }): Promise<string | undefined> {
    if (input.toolName !== "read" || input.isError || !isRecord(input.input)) return undefined;
    const rawPath = input.input.path;
    if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
    // Match Pi's read-path spelling before canonical lookup, without relying
    // on host-private path utilities. Invalid file URLs are not skill reads.
    let normalized = rawPath.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ");
    if (normalized.startsWith("@")) normalized = normalized.slice(1);
    if (normalized === "~") normalized = homedir();
    else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
      normalized = path.join(homedir(), normalized.slice(2));
    }
    try {
      if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
    } catch {
      return undefined;
    }
    const absolute = path.resolve(this.cwd, normalized);
    const canonical = await this.canonicalize(absolute).catch(() => absolute);
    return this.skillByPath.get(canonical);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
