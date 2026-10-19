import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as utilities from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JobManager, type JobSnapshot, LIMITS } from "../src/contracts.js";
import { createJobManager } from "../src/manager.js";
import { BackgroundView, showBackgroundUI, UI_LOG_BYTES } from "../src/task-ui.js";
import { nativeUIFixture } from "./tui-fixture.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function job(id: string, terminal = false): JobSnapshot {
  return {
    id,
    command: `echo ${id}`,
    cwd: "/workspace",
    description: id,
    status: terminal ? "exited" : "running",
    startedAt: 1,
    endedAt: terminal ? 2 : undefined,
    exitCode: terminal ? 0 : undefined,
    attention: "off",
    droppedBytes: 7,
  };
}

function fixture(ids = ["one", "two"], fullscreen = true, id?: string) {
  const native = nativeUIFixture(fullscreen);
  cleanup.push(native.dispose);
  let jobs = ids.map((value) => job(value));
  let logs = Array.from({ length: 60 }, (_, index) => `line-${index}`).join("\n");
  let alive = true;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const manager: JobManager = {
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    start: vi.fn(async () => {
      throw new Error("not used");
    }),
    watch: vi.fn((value) => manager.get(value)),
    list: () => jobs,
    get: (value) => {
      const found = jobs.find((item) => item.id === value);
      if (!found) throw new Error("Unknown job");
      return found;
    },
    logs: vi.fn((_id, _tail, stream) => ({ text: stream === "stderr" ? "stderr-only" : logs, droppedBytes: 7 })),
    stop: vi.fn(async (value) => {
      const found = manager.get(value);
      found.status = "stopped";
      found.endedAt = 3;
      changed();
      return found;
    }),
    clear: vi.fn((value) => {
      jobs = jobs.filter((item) => item.id !== value);
      changed();
      return 1;
    }),
    shutdown: vi.fn(async () => {}),
  };
  const done = vi.fn();
  const cancel = vi.fn();
  const release = vi.fn();
  const view = new BackgroundView(
    native.tui,
    native.theme,
    utilities,
    {
      manager,
      live: () => alive,
      cancel,
      mount: () => release,
    },
    done,
    id,
  );
  cleanup.push(() => view.dispose());
  const text = () => view.render(native.terminal.columns).join("\n");
  return {
    native,
    view,
    manager,
    listeners,
    changed,
    done,
    cancel,
    release,
    text,
    setJobs: (values: JobSnapshot[]) => {
      jobs = values;
      changed();
    },
    setLogs: (value: string) => {
      logs = value;
      changed();
    },
    retire: () => {
      alive = false;
      changed();
    },
  };
}

describe("explicit background task UI", () => {
  it.each([true, false])(
    "preserves every ASCII cell through native width-one scrolling (fullscreen=%s)",
    async (fullscreen) => {
      const h = fixture(["one"], fullscreen, "one");
      h.setLogs("abcdef");
      h.native.resize(1, 8); // six headers, one log cell, reserved footer space
      h.view.mount();
      const viewing = h.native.ui.custom(
        (_tui, _theme, _keys, done) => {
          h.done.mockImplementation(() => done(undefined));
          return h.view;
        },
        {
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" },
        },
      );
      await vi.waitFor(() => expect(h.native.component()).toBe(h.view));
      h.native.key("\x1b[H");
      const cells: string[] = [];
      for (let i = 0; i < 6; i++) {
        cells.push(utilities.stripTerminalSequences(h.native.render()[6]).trim());
        h.native.key("\x1b[B");
      }
      expect(cells.join("")).toBe("abcdef");
      // Oversized graphemes get an explicit placeholder without consuming neighbors.
      h.native.key("\x1b[F");
      h.setLogs("a中b😀c");
      h.native.render();
      h.native.key("\x1b[H");
      const mixed: string[] = [];
      for (let i = 0; i < 5; i++) {
        mixed.push(utilities.stripTerminalSequences(h.native.render()[6]).trim());
        h.native.key("\x1b[B");
      }
      expect(mixed.join("")).toBe("a?b?c");
      h.native.resize(40, 12);
      h.native.key("\x1b[H");
      expect(h.native.render().join("\n")).toContain("a中b😀c");
      h.view.close();
      await viewing;
    },
  );

  it.each(["lines", "bytes"])(
    "keeps a bounded paused snapshot stable across rolling %s, duplicates and rewrap",
    (cap) => {
      const h = fixture(["one"], true, "one");
      h.view.mount();
      const line = (i: number) => (i % 3 === 0 ? "repeated" : `line-${i}-${"a".repeat(cap === "bytes" ? 90 : 0)}`);
      const window = (start: number) => Array.from({ length: 1000 }, (_, i) => line(start + i)).join("\n");
      h.setLogs(window(0));
      h.text();
      h.view.handleInput("\x1b[H");
      for (let i = 0; i < 500; i++) h.view.handleInput("\x1b[B");
      const before = h.view.render(100).slice(6, 15);
      const reads = vi.mocked(h.manager.logs).mock.calls.length;
      for (const start of [1, 8, 100, 1500]) {
        h.setLogs(window(start));
        expect(h.view.render(100).slice(6, 15)).toEqual(before);
      }
      expect(h.text()).toContain("snapshot");
      h.native.terminal.columns = 40;
      expect(h.view.render(40)[6]).toContain(before[0].slice(0, 30));
      h.native.terminal.columns = 100;
      expect(h.view.render(100).slice(6, 15)).toEqual(before);
      expect(vi.mocked(h.manager.logs).mock.calls.length).toBe(reads);
      h.view.handleInput("\x1b[F");
      expect(h.text()).toContain("line-2498");
      expect(h.text()).not.toContain("snapshot");
      h.view.handleInput("f");
      h.text();
      h.setLogs("fresh-output");
      h.view.handleInput("f");
      expect(h.text()).toContain("fresh-output");
    },
  );

  it.each([true, false])(
    "uses a full public overlay above host chrome with encoded paging (fullscreen=%s)",
    async (fullscreen) => {
      const selected = "b3fb95b7-df76-44a2-bb85-5f2d85c8a11c";
      const h = fixture([selected], fullscreen);
      const ctx = { mode: "tui", hasUI: true, ui: h.native.ui } as unknown as ExtensionContext;
      const viewing = showBackgroundUI(ctx, {
        manager: h.manager,
        live: () => true,
        cancel: h.cancel,
        mount: () => () => {},
      });
      await vi.waitFor(() => expect(h.native.component()).toBeDefined());
      for (const [width, height] of [
        [80, 24],
        [40, 12],
      ]) {
        h.native.resize(width, height);
        let screen = h.native.render().map(utilities.stripTerminalSequences).join("\n");
        expect(screen).toContain("Background tasks");
        expect(screen).toContain(`ID: ${selected}`);
        expect(screen).toContain(`> ${selected}`);
        expect(h.native.overlayBounds()).toEqual({ row: 0, col: 0, width, height });
        for (const control of ["Enter logs", "x stop", "d clear", "Esc close"]) expect(screen).toContain(control);
        h.native.key("x");
        screen = h.native.render().map(utilities.stripTerminalSequences).join("\n");
        expect(screen).toContain("y confirms");
        h.native.key("n");
        h.native.key("\r");
        screen = h.native.render().map(utilities.stripTerminalSequences).join("\n");
        expect(screen).toContain("Background logs");
        expect(screen).toContain(`ID: ${selected}`);
        expect(screen).toContain("line-59");
        for (const control of ["f follow", "s stream", "x stop", "d clear", "Esc tasks"])
          expect(screen).toContain(control);
        h.native.key("\x1b[H");
        const first = h.native
          .render()
          .map(utilities.stripTerminalSequences)
          .filter((row) => row.trim().startsWith("line-"));
        expect(first[0]?.trim()).toBe("line-0");
        h.native.key("\x1b[6~");
        const second = h.native
          .render()
          .map(utilities.stripTerminalSequences)
          .filter((row) => row.trim().startsWith("line-"));
        expect(second[0]?.trim()).toBe(`line-${first.length}`);
        h.native.key("\x1b[5~");
        expect(h.native.render().join("\n")).toContain("line-0");
        h.native.key("\x1b[F");
        expect(h.native.render().join("\n")).toContain("line-59");
        h.native.key("\x1b");
        h.setJobs([job(selected, true)]);
        h.native.key("d");
        screen = h.native.render().map(utilities.stripTerminalSequences).join("\n");
        expect(screen).toContain("Clear");
        expect(screen).toContain("y confirms");
        expect(screen).toContain("other keys cancel");
        h.native.key("n");
        h.setJobs([job(selected)]);
      }
      expect(h.native.custom).toHaveBeenCalledWith(expect.any(Function), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
      });
      h.native.key("\x1b");
      await viewing;
      expect(h.native.render().join("\n")).toContain("Host draft");
    },
  );
  it("has no subscription in construction and releases exactly once on close/dispose", () => {
    const h = fixture();
    expect(h.manager.subscribe).not.toHaveBeenCalled();
    h.view.mount();
    expect(h.listeners.size).toBe(1);
    const late = [...h.listeners][0];
    h.view.close();
    h.view.close();
    h.view.dispose();
    expect(h.listeners.size).toBe(0);
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.done).toHaveBeenCalledOnce();
    const render = vi.spyOn(h.native.tui, "requestRender");
    render.mockClear();
    late();
    h.view.handleInput("x");
    expect(render).not.toHaveBeenCalled();
    expect(h.view.render(80)).toEqual([]);
  });

  it("navigates by stable ID through updates, insertion and removal", () => {
    const h = fixture(Array.from({ length: 25 }, (_, index) => `job-${index}`));
    h.view.mount();
    h.text();
    h.view.handleInput("\x1b[B");
    expect(h.text()).toContain("ID: job-1");
    h.setJobs([job("insert"), ...Array.from({ length: 25 }, (_, index) => job(`job-${index}`))]);
    expect(h.text()).toContain("ID: job-1");
    h.view.handleInput("\x1b[6~");
    expect(h.text()).toContain("ID: job-11");
    h.view.handleInput("\x1b[F");
    expect(h.text()).toContain("ID: job-24");
    h.view.handleInput("\x1b[H");
    expect(h.text()).toContain("ID: insert");
    h.setJobs([job("other")]);
    expect(h.text()).toContain("ID: other");
    h.setJobs([]);
    expect(h.text()).toContain("No background jobs");
  });

  it("scrolls live logs, follows End/tail and switches both/stdout/stderr", () => {
    const h = fixture(["one"], true, "one");
    h.view.mount();
    expect(h.text()).toContain("line-59");
    h.view.handleInput("\x1b[H");
    expect(h.text()).toContain("line-0\n");
    h.setLogs(Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n"));
    expect(h.text()).toContain("line-0\n");
    expect(h.text()).not.toContain("line-79\n");
    h.view.handleInput("\x1b[6~");
    expect(h.text()).toContain("line-9\n");
    h.view.handleInput("\x1b[5~");
    expect(h.text()).toContain("line-0\n");
    h.view.handleInput("\x1b[F");
    expect(h.text()).toContain("line-79");
    h.view.handleInput("s");
    h.text();
    expect(h.manager.logs).toHaveBeenLastCalledWith("one", 1000, "stdout");
    h.view.handleInput("s");
    expect(h.text()).toContain("stderr-only");
    h.view.handleInput("s");
    expect(h.text()).toContain("Stream: both");
    h.view.handleInput("f");
    expect(h.text()).toContain("scroll paused");
    h.view.handleInput("\x1b");
    expect(h.text()).toContain("Background tasks");
  });

  it.each([true, false])(
    "bounds terminal-height layout and sanitizes before wrapping (fullscreen=%s)",
    (fullscreen) => {
      const h = fixture(["one"], fullscreen, "one");
      h.view.mount();
      const wrap = vi.fn(utilities.wrapTextWithAnsi);
      const view = new BackgroundView(
        h.native.tui,
        h.native.theme,
        { ...utilities, wrapTextWithAnsi: wrap },
        {
          manager: h.manager,
          live: () => true,
          cancel: h.cancel,
          mount: () => () => {},
        },
        () => {},
        "one",
      );
      cleanup.push(() => view.dispose());
      h.setLogs(`${"x".repeat(UI_LOG_BYTES * 4)}\x1b]52;c;SECRET\x07中😀\x1bPqhidden\x1b\\safe\x9b31m\x7f\n`);
      for (const width of [1, 2, 4, 20, 80]) {
        for (const height of [1, 2, 4, 16]) {
          h.native.terminal.rows = height;
          const lines = view.render(width);
          expect(lines.length).toBeLessThanOrEqual(height);
          expect(lines.every((line) => utilities.visibleWidth(line) <= width)).toBe(true);
          for (const forbidden of ["SECRET", "hidden", "\x1b", "\x9b", "\x7f"]) {
            // Pi's clipping helper adds its own harmless SGR reset.
            expect(lines.join("\n").replaceAll("\x1b[0m", "")).not.toContain(forbidden);
          }
        }
      }
      expect(wrap.mock.calls.every(([text]) => Buffer.byteLength(text) <= UI_LOG_BYTES)).toBe(true);
      expect(wrap.mock.calls.every(([text]) => !text.includes("\x1b"))).toBe(true);
    },
  );

  it("confirms only x then non-repeat y and targets exactly the captured owned job", async () => {
    const h = fixture();
    h.view.mount();
    h.text();
    h.view.handleInput("x");
    h.view.handleInput("x");
    h.view.handleInput("y");
    expect(h.manager.stop).not.toHaveBeenCalled();
    h.view.handleInput("x");
    h.view.handleInput("\x1b[121;1:2u");
    expect(h.manager.stop).not.toHaveBeenCalled();
    h.view.handleInput("x");
    h.setJobs([job("insert"), job("two"), job("one")]);
    h.view.handleInput("y");
    await vi.waitFor(() => expect(h.manager.stop).toHaveBeenCalledWith("one"));
    expect(h.manager.stop).toHaveBeenCalledOnce();
    expect(h.cancel).toHaveBeenCalledWith("one");
    expect(h.text()).toContain("ID: one");
  });

  it("requires confirmed terminal state for clear; repeating d/Enter never confirms", async () => {
    const h = fixture(["one"]);
    h.view.mount();
    h.text();
    h.view.handleInput("d");
    h.view.handleInput("y");
    expect(h.manager.clear).not.toHaveBeenCalled();
    h.setJobs([job("one", true), job("two")]);
    h.view.handleInput("d");
    h.view.handleInput("\r");
    expect(h.manager.clear).not.toHaveBeenCalled();
    h.view.handleInput("d");
    h.view.handleInput("d");
    h.view.handleInput("y");
    expect(h.manager.clear).not.toHaveBeenCalled();
    h.view.handleInput("d");
    h.view.handleInput("y");
    await vi.waitFor(() => expect(h.manager.clear).toHaveBeenCalledWith("one"));
    expect(h.cancel).toHaveBeenCalledWith("one");
    expect(h.text()).toContain("ID: two");
  });

  it("awaits confirmed stop, preserves selection on failure and allows deliberate retry", async () => {
    const h = fixture();
    h.view.mount();
    h.text();
    let reject!: (error: Error) => void;
    vi.mocked(h.manager.stop).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    h.view.handleInput("x");
    h.view.handleInput("y");
    expect(h.text()).toContain("Waiting for confirmed stop: one");
    h.view.handleInput("\x1b[B");
    expect(h.text()).toContain("ID: one");
    reject(new Error("temporary stop failure"));
    await vi.waitFor(() => expect(h.text()).toContain("temporary stop failure"));
    expect(h.text()).toContain("ID: one");
    h.view.handleInput("x");
    h.view.handleInput("y");
    await vi.waitFor(() => expect(h.manager.get("one").endedAt).toBeDefined());
    expect(h.manager.stop).toHaveBeenCalledTimes(2);
  });

  it("closes at ownership divergence and ignores saved/late IO and async stop results", async () => {
    const h = fixture();
    h.view.mount();
    h.text();
    const late = [...h.listeners][0];
    let resolve!: (job: JobSnapshot) => void;
    vi.mocked(h.manager.stop).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    h.view.handleInput("x");
    h.view.handleInput("y");
    h.retire();
    expect(h.done).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0);
    const render = vi.spyOn(h.native.tui, "requestRender");
    render.mockClear();
    resolve(job("one", true));
    await Promise.resolve();
    late();
    h.view.handleInput("x");
    h.view.handleInput("y");
    expect(render).not.toHaveBeenCalled();
    expect(h.manager.stop).toHaveBeenCalledOnce();
    expect(h.view.render(80)).toEqual([]);
  });

  it.each([true, false])(
    "uses real native output/drop bytes and confirmed stop in public custom UI (fullscreen=%s)",
    async (fullscreen) => {
      const native = nativeUIFixture(fullscreen);
      cleanup.push(native.dispose);
      const events = vi.fn();
      const manager = createJobManager(events);
      cleanup.push(() => manager.shutdown());
      const started = await manager.start({
        command: "printf '%300000s' x; printf 'stderr-marker\\n' >&2; sleep 20",
        cwd: process.cwd(),
        attention: "off",
      });
      await vi.waitFor(() => expect(manager.get(started.id).droppedBytes).toBeGreaterThan(0));
      const cancel = vi.fn();
      const ctx = { mode: "tui", hasUI: true, ui: native.ui } as unknown as ExtensionContext;
      const viewing = showBackgroundUI(ctx, { manager, live: () => true, cancel, mount: () => () => {} }, started.id);
      await vi.waitFor(() => expect(native.component()).toBeDefined());
      expect(native.render().join("\n")).toContain("dropped=");
      native.key("s");
      native.key("s");
      expect(native.render().join("\n")).toContain("stderr-marker");
      native.resize(2, 3);
      expect(native.render().every((line) => utilities.visibleWidth(line) <= 2)).toBe(true);
      native.resize(100, 16);
      native.key("x");
      native.key("y");
      await vi.waitFor(() => expect(manager.get(started.id).endedAt).toBeDefined());
      expect(manager.get(started.id).status).toBe("stopped");
      expect(cancel).toHaveBeenCalledWith(started.id);
      expect(events).not.toHaveBeenCalled();
      expect(Buffer.byteLength(manager.logs(started.id).text)).toBeLessThanOrEqual(LIMITS.logBytes);
      native.key("\x1b");
      native.key("\x1b");
      await viewing;
      expect(native.component()).toBeUndefined();
    },
  );
});
