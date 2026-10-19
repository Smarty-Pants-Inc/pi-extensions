import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowEngine } from "./engine.js";
import { sanitizeDisplayText } from "./safe-text.js";
import { WorkflowCommandCenter, type WorkflowNavigatorOptions } from "./ui-command-center.js";

export type { WorkflowNavigatorOptions } from "./ui-command-center.js";
export {
  formatWorkflowDetail,
  formatWorkflowRunLabel,
  liveWidgetLines,
  type RunStatus,
  snapshotRunLine,
  type WorkflowAction,
  type WorkflowActionItem,
  workflowActionsFor,
} from "./ui-presentation.js";

/** Live, explicitly opened `/workflows` command center. No headless TUI mounts. */
export async function showWorkflowNavigator(
  ctx: ExtensionContext,
  engineSource: WorkflowEngine | (() => WorkflowEngine),
  options: WorkflowNavigatorOptions = {},
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("/workflows requires TUI mode; use workflow_control for machine-readable access.", "warning");
    return;
  }
  const source = typeof engineSource === "function" ? engineSource : () => engineSource;
  let component: WorkflowCommandCenter | undefined;
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    await ctx.ui.custom<void>(
      (tui, theme, keys, done) => {
        component = new WorkflowCommandCenter(
          tui,
          theme,
          keys,
          source,
          () => ctx.sessionManager.getSessionId() === sessionId,
          done,
          (message) => ctx.ui.notify(message, "error"),
          options,
        );
        return component;
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } },
    );
  } catch (error: unknown) {
    ctx.ui.notify(sanitizeDisplayText(error instanceof Error ? error.message : String(error), 500), "error");
  } finally {
    // Also covers external cancellation or custom() rejection before TUI disposal.
    component?.dispose();
  }
}
