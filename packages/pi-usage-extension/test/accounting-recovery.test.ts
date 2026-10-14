import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectUsageData, loadUsageCache, TAB_ORDER } from "../data.ts";
import { buildInsightsJson } from "../export.ts";
import extension from "../index.ts";

const now = new Date(2026, 6, 15, 12);
const timestamp = new Date(2026, 6, 15, 9).getTime();
const usage = (cost = 1, input = 10, output = 2, cacheRead = 3, cacheWrite = 4, reasoning = 1) => ({
  cost: { total: cost },
  input,
  output,
  cacheRead,
  cacheWrite,
  reasoning,
});
const header = (id, parentSession = "") => ({ type: "session", id, cwd: "/projects/test", parentSession });
const assistant = (id = "shared", values = usage()) => ({
  type: "message",
  id,
  parentId: null,
  timestamp,
  message: { role: "assistant", provider: "anthropic", model: "model", usage: values, timestamp },
});
const tool = (reported, children) => ({
  type: "message",
  id: "tool",
  timestamp,
  message: { role: "toolResult", toolName: "subagent", timestamp, usage: reported, details: { results: children } },
});
const journal = (path, entries) => writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "usage-accounting-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir);
  return { sessionsDir, cachePath: join(root, "cache.json"), now };
}

for (const parentName of ["0-parent", "z-parent"]) {
  test(`common observed ancestor proves sibling copies regardless of sorted order (${parentName})`, async (t) => {
    const options = fixture(t);
    const parent = join(options.sessionsDir, `${parentName}.jsonl`);
    journal(parent, [header("parent"), assistant()]);
    for (const name of ["a", "b"])
      journal(join(options.sessionsDir, `${name}.jsonl`), [header(name, parent), assistant()]);
    journal(join(options.sessionsDir, "independent.jsonl"), [header("independent"), assistant()]);
    journal(join(options.sessionsDir, "conflict.jsonl"), [
      header("conflict", parent),
      assistant("shared", usage(1, 11)),
    ]);
    journal(join(options.sessionsDir, "distinct-id.jsonl"), [header("distinct", parent), assistant("other")]);
    for (const filesToParse of [6, 0]) {
      const progress = [];
      const data = await collectUsageData({ ...options, onProgress: (event) => progress.push(event) });
      assert.ok(data);
      assert.equal(progress[0].filesToParse, filesToParse);
      assert.equal(
        data.allTime.totals.cost,
        4,
        "shared call once; independent id reuse, fingerprint conflict and distinct call survive",
      );
      assert.equal(data.allTime.totals.messages, 4);
      assert.equal(data.allTime.totals.tokens.input, 41);
      assert.equal(data.allTime.totals.tokens.output, 8);
    }
  });
}

test("a common scanned header without matching ancestor observations does not deduplicate siblings", async (t) => {
  const options = fixture(t);
  const parent = join(options.sessionsDir, "z-parent.jsonl");
  journal(parent, [header("parent")]);
  for (const name of ["a", "b"])
    journal(join(options.sessionsDir, `${name}.jsonl`), [header(name, parent), assistant()]);
  for (let pass = 0; pass < 2; pass++) {
    const data = await collectUsageData(options);
    assert.equal(data.allTime.totals.cost, 2);
    assert.equal(data.allTime.totals.messages, 2);
  }
});

for (const mismatch of ["report tokens", "report cost", "scanned child tokens"]) {
  test(`partial child reconciliation retains and flags unresolved ${mismatch}`, async (t) => {
    const options = fixture(t);
    const childPath = join(options.sessionsDir, "child.jsonl");
    journal(childPath, [
      header("child"),
      assistant("child-call", usage(2, mismatch === "scanned child tokens" ? 21 : 20, 2, 0, 0, 2)),
    ]);
    journal(join(options.sessionsDir, "parent.jsonl"), [
      header("parent"),
      tool(usage(mismatch === "report cost" ? 6 : 5, 50, mismatch === "report tokens" ? 6 : 5, 0, 0, 5), [
        { sessionFile: childPath, usage: usage(2, 20, 2, 0, 0, 2) },
        { sessionFile: join(options.sessionsDir, "missing.jsonl"), usage: usage(3, 30, 3, 0, 0, 3) },
      ]),
    ]);
    for (let pass = 0; pass < 2; pass++) {
      const data = await collectUsageData(options);
      assert.equal(data.today.totals.cost, mismatch === "report cost" ? 8 : 7);
      assert.equal(data.today.providers.get("Tools").cost, mismatch === "report cost" ? 6 : 5);
      assert.ok(data.today.insights.insights.some((insight) => /unresolved overlap/.test(insight.headline)));
    }
  });
}

for (const costMode of ["zero", "unknown"]) {
  for (const exact of [false, true]) {
    test(`${costMode}-cost partial reports ${exact ? "reconcile exactly" : "warn about token overlap"} cold and warm`, async (t) => {
      const options = fixture(t);
      const amount = (input) => {
        const values = usage(0, input, 0, 0, 0, 0);
        if (costMode === "unknown") delete values.cost;
        return values;
      };
      const childPath = join(options.sessionsDir, "child.jsonl");
      const parentPath = join(options.sessionsDir, "parent.jsonl");
      journal(childPath, [header("child"), assistant("child-call", amount(exact ? 20 : 21))]);
      journal(parentPath, [
        header("parent"),
        tool(amount(50), [
          { sessionFile: childPath, usage: amount(20) },
          { sessionFile: join(options.sessionsDir, "missing.jsonl"), usage: amount(30) },
        ]),
      ]);
      const original = [readFileSync(childPath), readFileSync(parentPath)];
      for (const filesToParse of [2, 0]) {
        const progress = [];
        const data = await collectUsageData({ ...options, onProgress: (event) => progress.push(event) });
        assert.ok(data);
        assert.equal(progress[0].filesToParse, filesToParse);
        assert.equal(data.today.totals.cost, 0);
        assert.equal(data.today.totals.tokens.input, exact ? 50 : 71);
        assert.equal(data.today.providers.get("Tools").tokens.input, exact ? 30 : 50);
        assert.equal(JSON.parse(readFileSync(options.cachePath, "utf8")).version, 12);
        assert.deepEqual([readFileSync(childPath), readFileSync(parentPath)], original);
        for (const period of TAB_ORDER) {
          const warnings = data[period].insights.insights;
          assert.equal(
            warnings.length,
            !exact && period !== "lastWeek" ? 1 : 0,
            "integrity is period-scoped, not cost-scoped",
          );
          if (warnings.length) {
            assert.equal(warnings[0].kind, "alarm");
            assert.equal(warnings[0].stat, "1 report");
            assert.match(warnings[0].headline, /unresolved overlap/);
            assert.match(warnings[0].advice, /may double-count/);
          }
        }
        assert.equal(
          JSON.parse(buildInsightsJson("today", data.today.totals, data.today.insights.insights)).insights.length,
          exact ? 0 : 1,
        );
        // Exercise the actual command's dashboard factory, bypassing only its
        // loader. A zero-cost empty state must not hide the integrity warning.
        let handler: (args: string, ctx: never) => Promise<void> = async () => {};
        extension({
          registerCommand: (_name, command) => {
            handler = command.handler;
          },
        } as never);
        let calls = 0;
        let rendered = "";
        await handler("", {
          mode: "tui",
          hasUI: true,
          ui: {
            custom: async (factory) => {
              if (++calls === 1) return data;
              const component = factory(
                { requestRender() {} },
                { fg: (_color, text) => text, bold: (text) => text },
                {},
                () => {},
              );
              component.handleInput("v");
              component.handleInput("v");
              rendered = component.render(120).join("\n");
            },
          },
        } as never);
        if (exact) assert.match(rendered, /No cost data recorded/);
        else {
          assert.match(rendered, /unresolved overlap/);
          assert.doesNotMatch(rendered, /No cost data recorded|Nothing notable/);
        }
      }
    });
  }
}

test("zero-cost unresolved reports also warn in periods with ordinary recorded spend", async (t) => {
  const options = fixture(t);
  const childPath = join(options.sessionsDir, "child.jsonl");
  journal(childPath, [header("child"), assistant("child-call", usage(0, 21, 0, 0, 0, 0))]);
  journal(join(options.sessionsDir, "parent.jsonl"), [
    header("parent"),
    assistant("paid", usage(3)),
    tool(usage(0, 50, 0, 0, 0, 0), [
      { sessionFile: childPath, usage: usage(0, 20, 0, 0, 0, 0) },
      { sessionFile: "missing.jsonl", usage: usage(0, 30, 0, 0, 0, 0) },
    ]),
  ]);
  for (let pass = 0; pass < 2; pass++) {
    const data = await collectUsageData(options);
    assert.equal(data.today.totals.cost, 3);
    assert.ok(data.today.insights.insights.some((insight) => /unresolved overlap/.test(insight.headline)));
    assert.ok(data.today.insights.insights.some((insight) => insight.kind === "structure"));
  }
});

test("matching-stat v12 cache rejects nonnumeric, overflowing and negative numeric slots and reparses unchanged journals", async (t) => {
  const options = fixture(t);
  const file = join(options.sessionsDir, "source.jsonl");
  journal(file, [header("session"), assistant(), tool(usage(3), [{ sessionFile: "missing.jsonl", usage: usage(3) }])]);
  const originalBytes = readFileSync(file);
  const original = await collectUsageData(options);
  const pristineCache = readFileSync(options.cachePath, "utf8");
  const slots = [
    ...[2, 3, 4, 5, 6, 7, 9, 16].map((slot) => (entry) => {
      entry.messages[0][slot] = "__invalid__";
    }),
    (entry) => {
      entry.toolUsages[0][1] = "__invalid__";
    },
    (entry) => {
      entry.toolUsages[0][4][0][0] = "__invalid__";
    },
    ...[0, 1, 2, 3, 4, 5].map((slot) => (entry) => {
      entry.toolUsages[0][2][slot] = "__invalid__";
    }),
    ...[0, 1, 2, 3, 4, 5].map((slot) => (entry) => {
      entry.toolUsages[0][4][0][2][slot] = "__invalid__";
    }),
  ];
  for (const corrupt of slots) {
    for (const value of ["1e309", '"1e309"', "{}", "-1", "null"]) {
      const cache = JSON.parse(pristineCache);
      assert.equal(cache.version, 12);
      corrupt(cache.files[file]);
      writeFileSync(options.cachePath, JSON.stringify(cache).replace('"__invalid__"', value));
      assert.equal((await loadUsageCache(options.cachePath)).has(file), false, value);
      const progress = [];
      const repaired = await collectUsageData({ ...options, onProgress: (event) => progress.push(event) });
      assert.equal(progress[0].filesToParse, 1, "valid matching file stats must not admit a poisoned tuple");
      assert.deepEqual(repaired.allTime.totals, original.allTime.totals);
      assert.ok(Number.isFinite(repaired.allTime.totals.cost));
      assert.deepEqual(readFileSync(file), originalBytes);
    }
  }
  const progress = [];
  await collectUsageData({ ...options, onProgress: (event) => progress.push(event) });
  assert.equal(progress[0].filesToParse, 0, "repaired v12 cache remains reusable without a version bump");
});
