import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LoopState {
  name: string;
  taskFile: string;
  iteration: number;
  maxIterations: number;
  itemsPerIteration: number;
  reflectEvery: number;
  reflectInstructions: string;
  active: boolean;
  status: "active" | "paused" | "completed";
  startedAt: string;
  completedAt?: string;
  lastReflectionAt: number;
  ownerSessionId?: string;
  ownerBranchIds?: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validateLoopState(value: unknown): LoopState | undefined {
  if (!record(value)) return;
  const raw = { ...value };
  if (raw.status === undefined && typeof raw.active === "boolean") raw.status = raw.active ? "active" : "paused";
  raw.reflectEvery ??= raw.reflectEveryItems ?? 0;
  raw.lastReflectionAt ??= raw.lastReflectionAtItems ?? 0;
  if (!["active", "paused", "completed"].includes(String(raw.status))) return;
  if (["name", "taskFile", "startedAt", "reflectInstructions"].some((key) => typeof raw[key] !== "string")) return;
  if (!raw.name || !raw.taskFile || !Number.isFinite(Date.parse(String(raw.startedAt)))) return;
  if (
    ["iteration", "maxIterations", "itemsPerIteration", "reflectEvery", "lastReflectionAt"].some(
      (key) => !count(raw[key]),
    )
  )
    return;
  if (raw.ownerSessionId !== undefined && typeof raw.ownerSessionId !== "string") return;
  if (
    raw.completedAt !== undefined &&
    (typeof raw.completedAt !== "string" || !Number.isFinite(Date.parse(raw.completedAt)))
  )
    return;
  if (
    raw.ownerBranchIds !== undefined &&
    (!Array.isArray(raw.ownerBranchIds) || raw.ownerBranchIds.some((id) => typeof id !== "string"))
  )
    return;
  raw.active = raw.status === "active";
  return raw as unknown as LoopState;
}

export function readLoopState(file: string, warn: (message: string) => void): LoopState | null {
  if (!fs.existsSync(file)) return null;
  try {
    const contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
    const state = validateLoopState(JSON.parse(contents));
    if (
      !state ||
      path.basename(file) !== `${state.name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_")}.state.json`
    )
      throw new Error("invalid loop state");
    return state;
  } catch (error: unknown) {
    warn(`Ralph state ignored: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function publishLoopState(file: string, state: LoopState): void {
  if (!validateLoopState(state)) throw new Error(`Invalid Ralph state: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
