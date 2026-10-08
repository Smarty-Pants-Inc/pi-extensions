import type { StatusContext } from "./types.js";

// Calls receive distinct contexts/UI wrappers, but share the host session identity.
const sessions = new Map<string | object, Map<string, Map<symbol, string>>>();

function sessionIdentity(ctx: StatusContext): string | object {
  return ctx.sessionManager?.getSessionId() ?? ctx.ui;
}

export function resetStatus(ctx: StatusContext, key: string): void {
  const identity = sessionIdentity(ctx);
  const keys = sessions.get(identity);
  keys?.delete(key);
  if (keys?.size === 0) sessions.delete(identity);
  ctx.ui.setStatus(key, undefined);
}

export function beginStatus(ctx: StatusContext, key: string, label: string): () => void {
  const identity = sessionIdentity(ctx);
  let keys = sessions.get(identity);
  if (!keys) {
    keys = new Map();
    sessions.set(identity, keys);
  }
  let active = keys.get(key);
  if (!active) {
    active = new Map();
    keys.set(key, active);
  }
  const token = Symbol(label);
  active.set(token, label);
  // Only this token may complete this entry; a lifecycle reset invalidates the whole map.
  const finish = () => {
    if (sessions.get(identity)?.get(key) !== active || !active.delete(token)) return;
    const remaining = [...active.values()].at(-1);
    if (active.size === 0) {
      keys.delete(key);
      if (keys.size === 0) sessions.delete(identity);
    }
    ctx.ui.setStatus(key, remaining);
  };
  try {
    ctx.ui.setStatus(key, label);
  } catch (error) {
    finish();
    throw error;
  }
  return finish;
}
