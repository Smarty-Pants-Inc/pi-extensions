import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { MessageCandidate } from "../src/messages.js";
import { RecallStore } from "../src/store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

afterEach(() => vi.restoreAllMocks());

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function candidate(entryId: string): MessageCandidate {
  return {
    entryId,
    role: "assistant",
    text: `message ${entryId}`,
    messageTimestamp: 1_786_000_000_000,
    source: { sessionId: "session-a", cwd: "/work/project" },
  };
}

for (const operation of ["load", "save", "delete"] as const) {
  for (const stage of ["stat", "readFile"] as const) {
    test(`${operation} cannot repair canonical permissions after live ownership retires during ${stage}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-recall-owner-"));
      const path = join(root, "pi-recall.jsonl");
      const store = new RecallStore(path);
      const entered = barrier();
      const release = barrier();
      let current = true;
      const repairs: number[] = [];
      let pending: Promise<unknown> | undefined;
      try {
        const saved = await store.save(candidate("original"));
        const original = await readFile(path, "utf8");
        await chmod(path, 0o644);
        const realOpen = vi.mocked(open).getMockImplementation();
        assert.ok(realOpen);
        vi.mocked(open).mockImplementation(async (...args) => {
          const handle = await realOpen(...args);
          if (String(args[0]) === path) {
            if (stage === "stat") {
              const realStat = handle.stat.bind(handle);
              vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
                const stats = await realStat();
                entered.resolve();
                await release.promise;
                return stats;
              });
            } else {
              const realRead = handle.readFile.bind(handle);
              vi.spyOn(handle, "readFile").mockImplementationOnce(async () => {
                const bytes = await realRead();
                entered.resolve();
                await release.promise;
                return bytes;
              });
            }
            const realChmod = handle.chmod.bind(handle);
            vi.spyOn(handle, "chmod").mockImplementation(async (mode) => {
              repairs.push(Number(mode));
              return realChmod(mode);
            });
          }
          return handle;
        });
        const isCurrent = () => current;
        pending =
          operation === "load"
            ? store.load(undefined, isCurrent)
            : operation === "save"
              ? store.save(candidate("stale"), undefined, isCurrent)
              : store.delete(saved.id, undefined, isCurrent);
        // Attach rejection handling before allowing the suspended callback to resume.
        const rejected = assert.rejects(pending, { name: "AbortError" });
        await entered.promise;
        current = false;
        release.resolve();
        await rejected;
        assert.deepEqual(repairs, []);
        assert.equal((await lstat(path)).mode & 0o777, 0o644);
        assert.equal(await readFile(path, "utf8"), original);
      } finally {
        release.resolve();
        await pending?.catch(() => undefined);
        vi.mocked(open).mockReset();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
