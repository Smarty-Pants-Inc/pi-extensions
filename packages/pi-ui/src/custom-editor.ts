import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type NativeFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomFactory<T> = (
  tui: Parameters<NativeFactory>[0],
  theme: Parameters<NativeFactory>[1],
  keybindings: Parameters<NativeFactory>[2],
  done: (result: T) => void,
) => ReturnType<NativeFactory>;

/**
 * Opt in to preserving editor writes across custom UI's saved-draft restoration.
 * Only custom's factory completion and promises are wrapped, never components.
 * See the README for public-API limits around retirement and concurrent writers.
 */
export function withPreservedCustomEditor<T extends { ui: ExtensionUIContext }>(context: T): T {
  const ui = context.ui;
  const custom: ExtensionUIContext["custom"] = async <Result>(
    factory: CustomFactory<Result>,
    options?: Parameters<ExtensionUIContext["custom"]>[1],
  ): Promise<Result> => {
    const opening = readEditor(ui);
    let captured: string | undefined;
    let finished = false;
    let repaired = false;

    const capture = () => {
      if (finished) return;
      finished = true;
      // Read immediately before calling the host, not when the dialog opened.
      captured = opening === undefined ? undefined : readEditor(ui);
    };
    const repair = () => {
      if (repaired || opening === undefined || captured === undefined || captured === opening) return;
      try {
        // A later destination writer owns the editor. No unconditional replay.
        if (ui.getEditorText() !== opening) return;
        repaired = true;
        ui.setEditorText(captured);
      } catch {
        // A retired/invalid context must not make completion fail or be retried.
        repaired = true;
      }
    };

    try {
      return await ui.custom<Result>((tui, theme, keybindings, done) => {
        const finish = (result: Result) => {
          if (finished) return;
          capture();
          try {
            done(result);
          } finally {
            // SDK 1.0.4 restores synchronously; repair before caller code resumes.
            repair();
          }
        };
        try {
          const created = factory(tui, theme, keybindings, finish);
          if (isPromiseLike(created)) {
            return created.catch((error: unknown) => {
              capture();
              throw error;
            });
          }
          return created;
        } catch (error) {
          capture();
          throw error;
        }
      }, options);
    } finally {
      // Also cover hosts that await pending work before restoring/resolving.
      repair();
      finished = true;
    }
  };
  const wrappedUi = new Proxy(ui, {
    get(target, property, receiver) {
      if (property === "custom") return custom;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === "ui") return wrappedUi;
      return Reflect.get(target, property, receiver);
    },
  });
}

function readEditor(ui: ExtensionUIContext): string | undefined {
  try {
    const text = ui.getEditorText();
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
