import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface WorktreeMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
}

/** Await host work without retaining abort listeners or requiring an RPC response. */
export async function awaitOwned<T>(owner: WorktreeMenuOwner, start: () => Promise<T>): Promise<T> {
  assertOwner(owner);
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new DOMException("Worktree command cancelled", "AbortError"));
    owner.signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    assertOwner(owner);
    const result = await Promise.race([start(), cancelled]);
    assertOwner(owner);
    return result;
  } finally {
    owner.signal.removeEventListener("abort", cancel);
  }
}

export function assertOwner(owner: WorktreeMenuOwner): void {
  if (owner.signal.aborted || !owner.isCurrent()) {
    throw new DOMException("Worktree command cancelled", "AbortError");
  }
}

/** All flows use the lifecycle/action signal, never the agent-run ctx.signal. */
export function ownedContext(ctx: ExtensionCommandContext, owner: WorktreeMenuOwner): ExtensionCommandContext {
  return {
    ...ctx,
    signal: owner.signal,
    waitForIdle: () => awaitOwned(owner, () => ctx.waitForIdle()),
    ui: {
      ...ctx.ui,
      input: (title, placeholder, options) =>
        awaitOwned(owner, () => ctx.ui.input(title, placeholder, { ...options, signal: owner.signal })),
      confirm: (title, message, options) =>
        awaitOwned(owner, () => ctx.ui.confirm(title, message, { ...options, signal: owner.signal })),
      select: (title, choices, options) =>
        awaitOwned(owner, () => ctx.ui.select(title, choices, { ...options, signal: owner.signal })),
      notify: (message, level) => {
        if (!owner.signal.aborted && owner.isCurrent()) ctx.ui.notify(message, level);
      },
    },
  };
}
