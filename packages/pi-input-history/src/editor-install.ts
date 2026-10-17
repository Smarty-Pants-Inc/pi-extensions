import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, TUI } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Older hosts may lack the public focus accessor. Unknown focus is never inspected. */
function focusedDraft(tui: TUI): { text: string; expanded: string } | undefined {
  const host = tui as unknown as { getFocusedComponent?: () => unknown };
  if (typeof host.getFocusedComponent !== "function") return undefined;
  const focused = host.getFocusedComponent();
  if (typeof focused !== "object" || focused === null) return undefined;
  const editor = focused as Partial<EditorComponent>;
  if (
    typeof editor.getText !== "function" ||
    typeof editor.getExpandedText !== "function" ||
    typeof editor.setText !== "function" ||
    typeof editor.handleInput !== "function" ||
    typeof editor.render !== "function"
  )
    return undefined;
  const text = editor.getText();
  const expanded = editor.getExpandedText();
  return text !== expanded ? { text, expanded } : undefined;
}

/** Pi copies getText(), not expanded paste content, after the factory returns. */
export function installEditor(ui: ExtensionContext["ui"], factory: EditorFactory): void {
  let installing = true;
  let draft: ReturnType<typeof focusedDraft>;
  let replacement: EditorComponent | undefined;
  try {
    ui.setEditorComponent((tui, theme, keybindings) => {
      // Capture before invoking an inherited factory; never retain later drafts.
      if (installing) draft = focusedDraft(tui);
      const editor = factory(tui, theme, keybindings);
      if (installing) replacement = editor;
      return editor;
    });
    // Synchronous and bounded to installation, before input/queued work resumes.
    if (draft && replacement?.getText() === draft.text) {
      replacement.setText(draft.expanded);
    }
  } finally {
    installing = false;
    draft = undefined;
    replacement = undefined;
  }
}
