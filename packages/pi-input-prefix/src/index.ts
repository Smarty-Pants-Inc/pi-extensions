import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installEditor } from "./editor-install.js";
import { PromptEditorView } from "./prompt-editor.js";

// Rounded, theme-following input textbox. Compose the active factory and
// decorate only its instance's rendering/padding. Completed startup draft
// contents transfer through public APIs, never private paste storage.
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const previousFactory = ctx.ui.getEditorComponent();
    installEditor(ctx.ui, (tui, theme, keybindings) => {
      const editor = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      return new PromptEditorView(editor, theme).decorate();
    });
  });
}
