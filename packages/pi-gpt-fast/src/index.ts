/**
 * /gpt-fast — OpenAI priority service tier for pi.
 *
 * OpenAI's Responses API accepts `service_tier: "priority"`, which buys lower
 * latency on the same model. pi exposes `before_provider_request`, whose return
 * value REPLACES the outgoing payload, so a request can be upgraded in flight
 * without touching model or reasoning effort — this is a latency switch, not a
 * quality downgrade.
 *
 * Prior art (studied 2026-08-09, both do the same injection):
 *   - github.com/calesennett/pi-codex-fast      `/codex-fast`, ships a benchmark:
 *     1.57x wall on gpt-5.6-sol, 2.25x on gpt-5.6-luna over three paired trials.
 *   - github.com/johncmunson/pi-openai-fast-mode `/fast`, MIT, on npm.
 * This is an independent implementation: the first carries no license at all
 * (package.json `license: null`, no LICENSE file) so its code cannot be
 * vendored, and neither offers the `/gpt-fast` name. Behaviour here follows the
 * former's shape — `setStatus` rather than a widget, so the indicator folds into
 * the statusline's extension row instead of costing a whole line, plus
 * session_start restoration, which the npm package lacks.
 *
 * Off by default. State persists in ~/.pi/agent/settings.json under
 * `pi-gpt-fast.enabled`. Any manager that owns that file must merge rather
 * than overwrite, preserving settings owned by Pi and other extensions.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

const STATUS_KEY = "gpt-fast";
const SETTINGS_KEY = "pi-gpt-fast";

/**
 * Exact provider/model pairs known to accept the priority tier. An allowlist,
 * not a prefix match: sending `service_tier` to a provider that rejects unknown
 * fields fails the whole request, so a wrong guess costs a turn rather than
 * degrading quietly. krill is deliberately absent — it is an OpenAI-compatible
 * gateway whose tier support is unverified; add it here once it is.
 */
const PRIORITY_MODELS = new Set([
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.6",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai/gpt-5.6",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentModel(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
}

function modelSupportsPriority(ctx: ExtensionContext): boolean {
  const name = currentModel(ctx);
  return name !== undefined && PRIORITY_MODELS.has(name);
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readSettings(path: string): Record<string, unknown> {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
  const settings: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
  if (!isRecord(settings)) throw new Error("settings.json must contain an object");
  if (SETTINGS_KEY in settings && !isRecord(settings[SETTINGS_KEY])) {
    throw new Error(`${SETTINGS_KEY} must contain an object`);
  }
  return settings;
}

function readEnabled(): boolean {
  try {
    const settings = readSettings(settingsPath());
    const block = settings?.[SETTINGS_KEY];
    return isRecord(block) && block.enabled === true;
  } catch {
    return false;
  }
}

// Match Pi's settings lock path/options and bounded synchronous contention
// retries. Never fall back to an unlocked write when another owner holds it.
function acquireSettingsLock(path: string): () => void {
  for (let attempt = 1; ; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      if (!isRecord(error) || error.code !== "ELOCKED" || attempt === 10) throw error;
      const start = Date.now();
      while (Date.now() - start < 20) {
        // Pi's settings storage also retries synchronously.
      }
    }
  }
}

/**
 * Merge the latest settings while holding Pi's shared lock, then atomically
 * rename a unique same-directory temp file. Malformed or unreadable settings
 * must fail rather than replacing unrelated configuration with an empty object.
 */
function writeEnabled(enabled: boolean): void {
  const path = settingsPath();
  // realpath:false lets the shared lock cover creation of an absent file too.
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const release = acquireSettingsLock(path);
  try {
    const settings = readSettings(path);
    const block = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
    settings[SETTINGS_KEY] = { ...block, enabled };
    const document = `${JSON.stringify(settings, null, 2)}\n`;
    writeFileSync(temporaryPath, document, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup must not replace the write result.
    }
    release();
  }
}

export default function (pi: ExtensionAPI) {
  let enabled = false;

  const refreshStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    if (!enabled) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    // "armed" says the toggle is on but the current model is not on the
    // allowlist, so nothing is actually being injected. Without the distinction
    // a silent no-op looks identical to a working fast mode.
    ctx.ui.setStatus(STATUS_KEY, modelSupportsPriority(ctx) ? "fast" : "fast (armed)");
  };

  const apply = (next: boolean, ctx: ExtensionContext, announce = true): void => {
    enabled = next;
    try {
      writeEnabled(next);
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`gpt-fast: could not persist state: ${message}`, "warning");
      }
    }
    refreshStatus(ctx);
    if (!announce || !ctx.hasUI) return;

    const model = currentModel(ctx) ?? "no active model";
    if (!next) {
      ctx.ui.notify("Fast mode off — default service tier.", "info");
    } else if (modelSupportsPriority(ctx)) {
      ctx.ui.notify(`Fast mode on — priority tier for ${model}.`, "info");
    } else {
      ctx.ui.notify(
        `Fast mode on, but ${model} is not on the priority allowlist — no effect until you switch models.`,
        "warning",
      );
    }
  };

  pi.registerFlag("gpt-fast", {
    description: "Start with OpenAI priority service tier enabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("gpt-fast", {
    description: "Toggle the OpenAI priority service tier (on | off | toggle)",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off", "toggle"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== "on" && arg !== "off" && arg !== "toggle") {
        ctx.ui.notify(`gpt-fast: expected on, off or toggle — got "${arg}".`, "error");
        return;
      }
      apply(arg === "on" ? true : arg === "off" ? false : !enabled, ctx);
    },
  });

  const restore = (ctx: ExtensionContext): void => {
    enabled = readEnabled() || pi.getFlag("gpt-fast") === true;
    refreshStatus(ctx);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  // session_start fires for startup, new sessions, resumes, and forks, so restore reads the current settings.
  // The allowlist is model-scoped, so the indicator has to follow /model.
  pi.on("model_select", (_event, ctx) => refreshStatus(ctx));

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !modelSupportsPriority(ctx) || !isRecord(event.payload)) {
      // Returning undefined leaves the payload untouched.
      return;
    }
    return { ...event.payload, service_tier: "priority" };
  });
}
