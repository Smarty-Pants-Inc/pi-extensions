import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type RecallMenuSource, showRecallMenu } from "./menu.js";
import { extractMessageCandidates, normalizeCwd } from "./messages.js";
import { RecallStore } from "./store.js";

const EXPERIMENTAL_WARNING = "Pi Recall is experimental; its storage format and interaction flow may change.";

interface RecallDependencies {
  getAgentDir(): string;
  createStore(path: string): RecallStore;
}

export function createRecallExtension(dependencies: Partial<RecallDependencies> = {}): (pi: ExtensionAPI) => void {
  const deps: RecallDependencies = {
    getAgentDir: dependencies.getAgentDir ?? getAgentDir,
    createStore: dependencies.createStore ?? ((path) => new RecallStore(path)),
  };

  return function recallExtension(pi: ExtensionAPI): void {
    let generation = 0;
    let sessionController = new AbortController();
    let activeSessionManager: ExtensionContext["sessionManager"] | undefined;

    pi.registerCommand("recall", {
      description: "Save and recall messages across Pi sessions",
      handler: async (args, ctx) => {
        if (args.trim()) {
          rejectCommand(ctx, "Usage: /recall");
          return;
        }
        if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
          throw new Error("/recall requires Pi TUI or RPC mode.");
        }
        const owner = ctx.sessionManager;
        const ownerGeneration = generation;
        const controller = sessionController;
        const isSessionCurrent = () =>
          activeSessionManager === owner && generation === ownerGeneration && !controller.signal.aborted;
        if (!isSessionCurrent()) throw new Error("Pi Recall session is no longer active.");
        const sessionId = owner.getSessionId();
        const branch = owner.getBranch();
        const leafId = owner.getLeafId();
        const branchIds = branch.map(({ id }) => id);
        let retired = false;
        const isCurrent = () => {
          retired ||= !(isSessionCurrent() && ownsBranch(owner, sessionId, leafId, branchIds));
          return !retired;
        };
        if (!isCurrent()) throw new Error("Pi Recall session is no longer active.");
        const cwd = normalizeCwd(ctx.cwd, process.platform);
        const sessionName = ctx.sessionManager.getSessionName();
        const candidates = extractMessageCandidates(branch, {
          sessionId,
          ...(sessionName ? { sessionName } : {}),
          cwd,
        });
        const store = deps.createStore(join(deps.getAgentDir(), "pi-recall.jsonl"));
        const source: RecallMenuSource = {
          path: store.path,
          current: { sessionId, cwd },
          candidates,
          load: (signal) => store.load(signal, isCurrent),
          save: (candidate, signal) => store.save(candidate, signal, isCurrent),
          delete: (id, signal) => store.delete(id, signal, isCurrent),
        };
        await showRecallMenu(ctx, source, { signal: controller.signal, isCurrent });
      },
    });

    pi.on("session_start", (_event, ctx) => {
      sessionController.abort(new DOMException("Pi Recall session replaced", "AbortError"));
      sessionController = new AbortController();
      generation += 1;
      activeSessionManager = ctx.sessionManager;
      if (ctx.hasUI) safeNotify(ctx, EXPERIMENTAL_WARNING, "warning");
    });

    pi.on("session_tree", (_event, ctx) => {
      if (ctx.sessionManager !== activeSessionManager) return;
      sessionController.abort(new DOMException("Pi Recall session branch changed", "AbortError"));
      sessionController = new AbortController();
      generation += 1;
    });

    pi.on("session_shutdown", (_event, ctx) => {
      if (ctx.sessionManager !== activeSessionManager) return;
      sessionController.abort(new DOMException("Pi Recall session shut down", "AbortError"));
      activeSessionManager = undefined;
      generation += 1;
    });
  };
}

function ownsBranch(
  owner: ExtensionContext["sessionManager"],
  sessionId: string,
  leafId: string | null,
  branchIds: readonly string[],
): boolean {
  try {
    const liveLeafId = owner.getLeafId();
    const liveBranch = owner.getBranch();
    // Pi commits navigation before awaiting sequential session_tree handlers. Check the live
    // public branch at callback boundaries, not just our not-yet-delivered generation event.
    // Ordinary appends preserve the origin path as a prefix and must not retire an interaction.
    return (
      owner.getSessionId() === sessionId &&
      (branchIds.at(-1) ?? null) === leafId &&
      (liveBranch.at(-1)?.id ?? null) === liveLeafId &&
      branchIds.every((id, index) => liveBranch[index]?.id === id)
    );
  } catch {
    return false;
  }
}

function rejectCommand(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    safeNotify(ctx, message, "warning");
    return;
  }
  throw new Error(message);
}

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Session replacement can invalidate an old UI immediately.
  }
}

export default createRecallExtension();
