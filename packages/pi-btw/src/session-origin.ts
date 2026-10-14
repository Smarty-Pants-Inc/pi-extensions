import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A live branch prefix, not a model-visible projection or delayed event counter. */
export function captureSessionOrigin(ctx: Pick<ExtensionContext, "sessionManager">): () => boolean {
  const manager = ctx.sessionManager;
  let sessionId: string | undefined;
  let prefix: string[];
  let leaf: string | null;
  try {
    sessionId = manager.getSessionId?.();
    const branch = manager.getBranch();
    prefix = branch.map((entry) => entry.id);
    leaf = typeof manager.getLeafId === "function" ? manager.getLeafId() : (branch.at(-1)?.id ?? null);
    if (leaf !== (branch.at(-1)?.id ?? null)) return () => false;
  } catch {
    return () => false;
  }
  let retired = false;
  return () => {
    if (retired) return false;
    try {
      if (ctx.sessionManager !== manager || manager.getSessionId?.() !== sessionId) retired = true;
      else {
        const live = manager.getBranch();
        const liveLeaf = typeof manager.getLeafId === "function" ? manager.getLeafId() : (live.at(-1)?.id ?? null);
        // Ordinary appends preserve ownership; rewinds, sibling branches and
        // metadata-only navigation do not, even if their projections are equal.
        retired =
          liveLeaf !== (live.at(-1)?.id ?? null) ||
          live.length < prefix.length ||
          prefix.some((id, index) => live[index]?.id !== id) ||
          (live.length === prefix.length && liveLeaf !== leaf);
      }
    } catch {
      retired = true;
    }
    return !retired;
  };
}
