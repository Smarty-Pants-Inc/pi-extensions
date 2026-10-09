import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PromptEditorView } from "./prompt-editor.js";

// Rounded, theme-following input textbox. Compose the active factory rather
// than discarding its editor: history and private large-paste state must stay
// on the instance that owns them. The view only decorates rendering/padding.
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      return new PromptEditorView(editor, theme).decorate();
    });
  });
}
