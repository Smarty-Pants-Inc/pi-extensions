import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { WorkflowEngine } from "../src/engine.js";
import type { ScriptRun } from "../src/journal.js";
import { formatWorkflowDetail, showWorkflowNavigator } from "../src/ui.js";

describe("workflow detail viewport and display-only sanitization", () => {
  it.each([24, 40].flatMap((rows) => [0, 30, 1000].map((calls) => ({ rows, calls }))))(
    "keeps controls reachable at $rows rows with $calls calls",
    async ({ rows, calls }) => {
      const run = {
        runId: "run\u001bid",
        status: "running",
        startedAt: 1,
        updatedAt: 2,
        meta: { name: "name\u009btitle", description: "description" },
        callStatus: Object.fromEntries(Array.from({ length: calls }, (_, i) => [i, "completed"])),
        callResults: Object.fromEntries(
          Array.from({ length: calls }, (_, i) => [
            i,
            {
              status: "completed",
              result:
                i === 0 ? { toString: "not callable", payload: `raw\u001b[2J\u202e${i}` } : `raw\u001b[2J\u202e${i}`,
            },
          ]),
        ),
        agentIds: {},
        compactions: {},
        error: "error\u0000raw",
      } as unknown as ScriptRun;
      const engine = {
        list: () => [{ runId: run.runId }],
        getRun: () => run,
        getState: () => ({ run }),
      } as unknown as WorkflowEngine;
      const original = JSON.stringify(run);
      const detail = formatWorkflowDetail(engine, run.runId);
      for (const control of ["\u0000", "\u001b", "\u009b", "\u202e"]) expect(detail).not.toContain(control);
      if (calls) expect(detail).toContain("raw\\u001b[2J\\u202e");
      let screen = 0;
      const ctx = {
        mode: "tui",
        hasUI: true,
        ui: {
          custom: async (
            factory: (
              tui: unknown,
              theme: unknown,
              keys: unknown,
              done: (value: unknown) => void,
            ) => {
              render(width: number): string[];
              handleInput(data: string): void;
            },
          ) => {
            screen++;
            let selection: unknown;
            const component = factory(
              { terminal: { rows }, requestRender() {} },
              { fg: (_name: string, text: string) => text, bold: (text: string) => text },
              {},
              (value) => {
                selection = value;
              },
            );
            if (screen === 1) component.handleInput("\r");
            else {
              const rendered = component.render(80);
              expect(rendered.length).toBeLessThanOrEqual(rows);
              expect(rendered.join("\n")).toContain("enter confirm");
              if (screen === 2) {
                for (const key of ["\u001b[6~", "\u001b[6~", "\u001b[5~"]) {
                  component.handleInput(key);
                  const page = component.render(80);
                  expect(page.length).toBeLessThanOrEqual(rows);
                  for (const label of ["Pause", "Stop", "Back"]) expect(page.join("\n")).toContain(label);
                }
              }
              component.handleInput("\u001b");
            }
            return selection;
          },
          notify() {},
        },
      } as unknown as ExtensionCommandContext;
      await showWorkflowNavigator(ctx, engine);
      expect(screen).toBe(3);
      expect(JSON.stringify(run)).toBe(original); // Never sanitize stored result/metadata.
    },
  );
});
