import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  CustomEditor,
  DefaultResourceLoader,
  type ExtensionContext,
  ExtensionRunner,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorComponent, TuiMainScreen } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";

type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

for (const order of [
  ["pi-input-history", "pi-input-prefix"],
  ["pi-input-prefix", "pi-input-history"],
]) {
  for (const draft of [" normal\n draft ", `  ${"completed 😃😀 paste\n".repeat(150)}  `]) {
    test(`SDK ${order.join(" → ")} preserves an existing ${draft.length > 100 ? "completed large paste" : "normal draft"}`, async () => {
      const directory = mkdtempSync(`${tmpdir()}/history-startup-`);
      try {
        // Use the public extension loader, not cross-package implementation imports.
        const loader = new DefaultResourceLoader({
          cwd: directory,
          agentDir: `${directory}/agent`,
          settingsManager: SettingsManager.inMemory(),
          additionalExtensionPaths: order.map((name) =>
            fileURLToPath(new URL(`../../${name}/src/index.ts`, import.meta.url)),
          ),
          noExtensions: true,
          noSkills: true,
          noThemes: true,
          noPromptTemplates: true,
          noContextFiles: true,
        });
        await loader.reload();
        const loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        const session = SessionManager.create(directory, `${directory}/sessions`);
        const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, directory, session, {} as never);
        const tui = new TuiMainScreen({ rows: 40, columns: 100 } as never);
        vi.spyOn(tui, "requestRender").mockImplementation(() => {});
        const identity = (text: string) => text;
        const theme = {
          borderColor: identity,
          selectList: {
            selectedText: identity,
            selectedPrefix: identity,
            description: identity,
            scrollInfo: identity,
            noMatch: identity,
          },
        };
        const kb = { matches: () => false } as never;
        let active: EditorComponent = new CustomEditor(tui, theme, kb);
        active.handleInput(`\x1b[200~${draft}\x1b[201~`);
        if (draft.length > 100) assert.notEqual(active.getText(), draft);
        tui.setFocus(active);
        let factory: Factory | undefined;
        let mounts = 0;
        runner.setUIContext(
          {
            getEditorComponent: () => factory,
            setEditorComponent(next: Factory) {
              const text = active.getText();
              factory = next;
              active = next(tui, theme, kb);
              // Mirror the SDK host's synchronous text copy after factory creation.
              active.setText(text);
              tui.setFocus(active);
              mounts++;
            },
          } as never,
          "tui",
        );
        await runner.emit({ type: "session_start" });
        assert.equal(mounts, 2);
        assert.equal(active.getExpandedText?.(), draft);
        assert.equal(tui.getFocusedComponent(), active);
        active.handleInput("queued streaming input");
        await Promise.resolve();
        assert.equal(active.getExpandedText?.(), `${draft}queued streaming input`);
        assert.equal(mounts, 2);
        await runner.emit({ type: "session_shutdown" });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
