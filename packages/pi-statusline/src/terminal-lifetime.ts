import type { TUI } from "@earendil-works/pi-tui";

export interface TerminalLifetime {
  active: boolean;
}

// Pi keeps the public TUI passed to footer/custom factories across replacement
// and reload, but invalidates the old ctx/pi and its event-bus subscriptions.
// Keep only extension-owned lifetime tokens (not host internals) in a weak map.
// A namespaced process slot also survives re-evaluation of this module on reload.
const key = Symbol.for("@signalridge/pi-statusline/terminal-lifetimes/v1");
const storage = globalThis as typeof globalThis & { [key: symbol]: unknown };
const existing = storage[key];
const lifetimes =
  existing instanceof WeakMap ? (existing as WeakMap<TUI, TerminalLifetime>) : new WeakMap<TUI, TerminalLifetime>();
storage[key] = lifetimes;

export function terminalLifetime(tui: TUI): TerminalLifetime {
  let lifetime = lifetimes.get(tui);
  if (!lifetime?.active) {
    lifetime = { active: true };
    lifetimes.set(tui, lifetime);
  }
  return lifetime;
}
