import type { Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";

// ToolInfo does not expose prepareLoadout's effective descriptions or sampling
// metadata. Compare only fields available on both sides of the public API.
export function comparableTools(tools: readonly Tool[]): Tool[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

const compat: { getToolStateChanges?: typeof piAi.getToolStateChanges } = piAi;

export function sameTools(previous: Tool[], current: Tool[]): boolean {
  const changes = compat.getToolStateChanges?.(previous, current);
  return !!changes && changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;
}

type ObservedTools = { sessionId: string; recorded: Tool[]; registry: Tool[] };

/**
 * Pi exposes active tool names and raw ToolInfo, not prepareLoadout's effective
 * descriptions. Remember both public surfaces at normal provider dispatch so
 * later compaction can compare each surface against itself. Do not infer that
 * an arbitrary description mismatch is a loadout rewrite.
 *
 * This evidence is deliberately ephemeral: reload and branch navigation require
 * a new dispatch before transformed descriptions can pass the compaction guard.
 */
export class ToolStateTracker {
  private readonly observed = new WeakMap<object, ObservedTools>();

  reset(owner: object): void {
    this.observed.delete(owner);
  }

  observe(owner: object, sessionId: string, recorded: Tool[], registry: Tool[]): void {
    // A description rewrite is legitimate, but unsent membership/schema changes
    // must not acquire provenance merely because another hook was dispatched.
    const withoutDescriptions = (tools: Tool[]) => tools.map((tool) => ({ ...tool, description: "" }));
    if (!sameTools(withoutDescriptions(recorded), withoutDescriptions(registry))) {
      this.reset(owner);
      return;
    }
    this.observed.set(owner, structuredClone({ sessionId, recorded, registry }));
  }

  matches(owner: object, sessionId: string, recorded: Tool[], registry: Tool[]): boolean {
    const observed = this.observed.get(owner);
    if (!observed || observed.sessionId !== sessionId) return sameTools(recorded, registry);
    // Check each surface against itself, not transformed descriptions against raw
    // descriptions. Registry description edits still invalidate the observation.
    return sameTools(observed.recorded, recorded) && sameTools(observed.registry, registry);
  }
}
