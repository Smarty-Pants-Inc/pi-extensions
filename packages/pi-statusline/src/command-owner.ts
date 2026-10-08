import {
  type ExtensionCommandContext,
  ExtensionEditorComponent,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

type CustomComponent = Component & { dispose?(): void };
type CustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keys: KeybindingsManager,
  done: (value: T) => void,
) => CustomComponent | Promise<CustomComponent>;

export interface CommandOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
  /** The terminal survives session replacement/reload, but never genuine quit. */
  isHostActive?(): boolean;
}

function editorTui(tui: TUI, owner: CommandOwner): TUI {
  return new Proxy(tui, {
    get(target, key) {
      const property: unknown = Reflect.get(target, key, target);
      if (typeof property !== "function") return property;
      if (key === "start" || key === "requestRender") {
        return (...args: unknown[]) => {
          if (owner.isHostActive?.() ?? isOwnerCurrent(owner)) return Reflect.apply(property, target, args);
        };
      }
      if (key === "stop") {
        return (...args: unknown[]) => {
          if (isOwnerCurrent(owner)) return Reflect.apply(property, target, args);
        };
      }
      return property.bind(target);
    },
  });
}

export function isOwnerCurrent(owner: CommandOwner): boolean {
  return !owner.signal.aborted && owner.isCurrent();
}

/** Use Pi's editor semantics with a custom dialog that can close before navigation. */
export async function ownedEditor(
  ctx: ExtensionCommandContext,
  owner: CommandOwner,
  title: string,
  prefill?: string,
  externalEditorCommand?: string,
): Promise<string | undefined> {
  const custom = ownedCustom(ctx, owner);
  const result = await custom<string | undefined>(
    (tui, _theme, keys, done) =>
      new ExtensionEditorComponent(
        editorTui(tui, owner),
        keys,
        title,
        prefill,
        done,
        () => done(undefined),
        undefined,
        externalEditorCommand,
      ),
  );
  return isOwnerCurrent(owner) ? result : undefined;
}

/** Close raw custom dialogs before Pi gives the captured editor to another branch. */
export function ownedCustom(
  ctx: ExtensionCommandContext,
  owner: CommandOwner,
): ExtensionCommandContext["ui"]["custom"] {
  return async <T>(factory: CustomFactory<T>, options?: Parameters<ExtensionCommandContext["ui"]["custom"]>[1]) => {
    if (!isOwnerCurrent(owner)) return undefined as T;
    let cancel: (() => void) | undefined;
    try {
      return await ctx.ui.custom<T>((tui, theme, keys, done) => {
        let settled = false;
        let disposed = false;
        let component: (Component & { dispose?(): void }) | undefined;
        const dispose = () => {
          if (disposed || !component) return;
          disposed = true;
          settled = true;
          if (cancel) owner.signal.removeEventListener("abort", cancel);
          component.dispose?.();
        };
        const finish = (value: T) => {
          if (settled) return;
          settled = true;
          if (cancel) owner.signal.removeEventListener("abort", cancel);
          try {
            dispose();
          } finally {
            done(value);
          }
        };
        cancel = () => finish(undefined as T);
        owner.signal.addEventListener("abort", cancel, { once: true });
        const built = factory(tui, theme, keys, (value) => {
          if (isOwnerCurrent(owner)) finish(value);
          else cancel?.();
        });
        const attach = (value: CustomComponent): CustomComponent => {
          component = value;
          if (settled) dispose();
          if (!isOwnerCurrent(owner)) cancel?.();
          // Preserve optional component capabilities (focus, async actions,
          // toolkit markers) rather than reducing it to only render/input.
          return new Proxy(value, {
            get(target, key, receiver) {
              if (key === "dispose") return dispose;
              if (key === "handleInput") {
                return (data: string) => {
                  if (!settled && isOwnerCurrent(owner)) target.handleInput?.(data);
                };
              }
              const property: unknown = Reflect.get(target, key, receiver);
              return typeof property === "function" ? property.bind(target) : property;
            },
          });
        };
        return built instanceof Promise ? built.then(attach) : attach(built);
      }, options);
    } finally {
      if (cancel) owner.signal.removeEventListener("abort", cancel);
    }
  };
}
