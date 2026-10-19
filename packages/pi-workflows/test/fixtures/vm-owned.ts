import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WorkflowErrorCode } from "../../src/errors.js";
import { type JournalEntry, runWorkflow } from "../../src/runtime.js";

const mode = process.argv[2];
const meta = 'export const meta = { name: "owned-vm", description: "test" };';
const loops: Record<string, string> = {
  sync: "while (true) {}",
  async: "await Promise.resolve(); while (true) {}",
  parallel: "return await parallel([() => { while (true) {} }]);",
  dag: 'return await orchestrate([{id:"a",run:()=>agent("first")},{id:"b",dependsOn:["a"],run:()=>{while(true){}}}]);',
  gate: "return await gate(() => 1, () => { while (true) {} });",
  retry: "return await retry(() => 1, {until:()=>{while(true){}}});",
  round: "return await loopUntilDry({round:()=>{while(true){}}});",
  key: "return await loopUntilDry({round:()=>[1], key:()=>{while(true){}}});",
  errorCoercion: "await Promise.resolve(); throw {toString(){while(true){}}};",
  inFlight: 'void agent("pending"); await Promise.resolve(); while (true) {}',
};
let ticks = 0,
  calls = 0,
  cleaned = false;
const timer = setInterval(() => ticks++, 20);
const controller = new AbortController();
const runner = {
  async run(_prompt: string, options?: { signal?: AbortSignal }) {
    calls++;
    if (mode === "inFlight" || mode === "cancel" || (mode === "localPromiseCancel" && _prompt === "second")) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            void delay(80).then(() => {
              cleaned = true;
              reject(new Error("aborted"));
            });
          },
          { once: true },
        );
      });
    }
    if (_prompt === "first") await delay(100);
    if (_prompt === "delay") await delay(150);
    if (_prompt === "second" && mode.startsWith("localPromise")) return "2";
    if (mode === "longAwait") await delay(2200);
    if (["ignoredRejection", "nestedDrain", "unawaitedControls", "nestedDescendants"].includes(mode)) await delay(180);
    return '{"ok":true}';
  },
};
try {
  if (mode === "parentLagHealthy" || mode === "parentLagStall") {
    let armed = false;
    const script =
      mode === "parentLagStall"
        ? 'log("armed"); await Promise.resolve(); while(true){}'
        : 'log("armed"); return await checkpoint("hold");';
    const started = performance.now();
    const pending = runWorkflow(`${meta} ${script}`, {
      onLog: () => {
        armed = true;
      },
      confirm: async () => {
        await delay(3600);
        return "healthy";
      },
    });
    void pending.catch(() => {});
    while (!armed) await delay(10);
    // Repeated parent stalls used to fabricate heartbeats forever. No helper
    // model work is involved, and this entire parent is disposable/deadlined.
    const busy = setInterval(() => {
      const until = performance.now() + 550;
      while (performance.now() < until) {}
    }, 600);
    try {
      if (mode === "parentLagHealthy") assert.equal((await pending).result, "healthy");
      else {
        await assert.rejects(pending, /CPU stall/);
        assert.ok(performance.now() - started < 4500, "repeated lag must not suppress the deadline");
      }
    } finally {
      clearInterval(busy);
    }
  } else if (mode === "ignoredRejection") {
    const result = await runWorkflow(
      `${meta}
      void agent("invalid", {strength:"typo"});
      void checkpoint(42);
      void pipeline(42,x=>x);
      const caught = await agent("invalid", {strength:"typo"}).catch(e=>e.code);
      const native = await pipeline(42,x=>x).catch(e=>e instanceof TypeError);
      return [await agent("good"),caught,native];`,
      { agent: runner },
    );
    assert.deepEqual(result.result, ['{"ok":true}', "SCRIPT_VALIDATION_ERROR", true]);
    assert.equal(calls, 1);
  } else if (mode === "realm") {
    const data: unknown[] = [];
    data[2] = undefined;
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const result = await runWorkflow(
      `${meta}
      const closure = () => 42;
      const types = await pipeline([new Map(),new Set(),new Date("2020-01-01"),/a/i,[],new TypeError("x"),12n,closure],
        (x,_original,i)=> i===0?x instanceof Map:i===1?x instanceof Set:i===2?x instanceof Date:i===3?x instanceof RegExp:i===4?x instanceof Array:i===5?x instanceof TypeError:i===6?typeof x==="bigint":x===closure);
      const caught = await retry(()=>{throw new TypeError("subclass");}).catch(e=>[e instanceof TypeError,e instanceof Error,e.message]);
      const input = [args.map instanceof Map,args.set instanceof Set,args.date instanceof Date,args.regex instanceof RegExp,args.array instanceof Array,args.error instanceof RangeError,args.cycle.self===args.cycle,args.holes.length,0 in args.holes,2 in args.holes,args.holes[2]===undefined,typeof args.bigint];
      return {types,caught,input};`,
      {
        args: {
          map: new Map(),
          set: new Set(),
          date: new Date("2020-01-01"),
          regex: /a/i,
          array: [],
          error: new RangeError("r"),
          cycle,
          holes: data,
          bigint: 12n,
        },
      },
    );
    assert.deepEqual(result.result, {
      types: Array(8).fill(true),
      caught: [true, true, "subclass"],
      input: [true, true, true, true, true, true, true, 3, false, true, true, "bigint"],
    });
  } else if (["localPromiseThenRootNative", "localPromiseControls", "localPromiseBudget"].includes(mode)) {
    const phases: Array<string | undefined> = [];
    const journals: JournalEntry[] = [];
    const exact = `let pending, release;
      await parallel([()=>{pending=(async()=>{
        await new Promise(r=>release=r);return await agent('second');
      })();return 1}]);
      await agent('delay');release();return await pending;`;
    const nested = `phase('private',{budget:${mode === "localPromiseBudget" ? 1 : 100}});phase('outer');
      let pending, release;
      await orchestrate([{id:'a',phase:'private',run:()=>{
        pending=(async()=>{await new Promise(r=>release=r);
          return await gate(()=>retry(()=>pipeline([1],()=>agent('second'))),()=>({ok:true}));
        })();return 1;
      }}]);
      await agent('delay');release();return await pending;`;
    const pending = runWorkflow(
      `${meta} ${mode === "localPromiseThenRootNative" ? exact : 'return await workflow("saved");'}`,
      {
        agent: runner,
        tokenBudget: 1000,
        loadSavedWorkflow: () => `${meta} ${nested}`,
        onAgentStart: (event) => phases.push(event.phase),
        onAgentJournal: (entry) => journals.push(entry),
      },
    );
    if (mode === "localPromiseBudget") {
      await assert.rejects(
        pending,
        (error) => (error as { code?: string }).code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
      );
      assert.equal(calls, 1, "local continuation must retain its exhausted private phase budget");
      assert.deepEqual(phases, ["outer"]);
    } else {
      const result = await pending;
      assert.equal(calls, 2, "local promise descendant must dispatch second exactly once");
      assert.equal(result.agentCount, 2);
      assert.equal(journals.length, 2);
      assert.deepEqual(
        result.result,
        mode === "localPromiseThenRootNative" ? "2" : { ok: true, value: ["2"], attempts: 1 },
      );
      if (mode === "localPromiseControls") assert.deepEqual(phases, ["outer", "private"]);
    }
  } else if (mode === "ignoredLocalPromise" || mode === "retainedContextCapacity") {
    const pids: number[] = [];
    const started = performance.now();
    const script =
      mode === "ignoredLocalPromise"
        ? `await parallel([()=>{void (async()=>{await new Promise(()=>{});await agent('second');})();return 1}]);return 1;`
        : `const held = new Promise(()=>{});
         const fn=()=>{void (async()=>{await held;await agent('second');})();return 1;};
         for(let i=0;i<8300;i++) await retry(fn);return 1;`;
    const result = await runWorkflow(`${meta} log(log.constructor('return process')().pid); ${script}`, {
      agent: runner,
      onLog: (entry) => pids.push(Number(entry)),
    });
    assert.equal(result.result, 1);
    assert.equal(calls, 0);
    assert.equal(pids.length, 1);
    assert.throws(
      () => process.kill(pids[0], 0),
      (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    if (mode === "ignoredLocalPromise")
      assert.ok(performance.now() - started < 1500, "ignored local promises must not delay root success");
  } else if (mode === "localPromiseCancel") {
    const pids: number[] = [];
    const child = `${meta} log(log.constructor('return process')().pid);
      let pending, release;
      await parallel([()=>{pending=(async()=>{await new Promise(r=>release=r);return await agent('second')})();return 1}]);
      await agent('delay');release();return await pending;`;
    const pending = runWorkflow(
      `${meta} log(log.constructor('return process')().pid);void workflow('saved');return 1;`,
      {
        agent: runner,
        signal: controller.signal,
        loadSavedWorkflow: () => child,
        onLog: (entry) => pids.push(Number(entry)),
      },
    );
    void pending.catch(() => {});
    while (calls < 2) await delay(10);
    controller.abort();
    await assert.rejects(pending, (error) => (error as { code?: string }).code === WorkflowErrorCode.WORKFLOW_ABORTED);
    assert.equal(cleaned, true, "native second cancellation must be confirmed before publishing failure");
    assert.equal(pids.length, 2);
    for (const pid of pids)
      assert.throws(
        () => process.kill(pid, 0),
        (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
  } else if (["awaitedDescendants", "forgottenDescendants", "descendantControls", "descendantBudget"].includes(mode)) {
    const journals: JournalEntry[] = [];
    const phases: Array<string | undefined> = [];
    let successes = 0;
    const exact = `let pending;
      await parallel([()=>{pending=(async()=>{await agent('first');return await agent('second')})();return 1}]);
      return await pending;`;
    const forgotten = `void parallel([()=>{
      void (async()=>{await agent('first');return await agent('second')})();return 1;
    }]);return 1;`;
    // The orphan resumes under its original task-local phase, not the current
    // root phase, including native controls that invoke further VM callbacks.
    const controls = `phase('private',{budget:${mode === "descendantBudget" ? 1 : 100}});phase('outer');
      let pending;
      await orchestrate([{id:'a',phase:'private',run:()=>{
        pending=(async()=>{await agent('first');
          return await gate(()=>retry(()=>pipeline([1],()=>agent('second'))),()=>({ok:true}));
        })();return 1;
      }}]);
      return await pending;`;
    const pending = runWorkflow(
      `${meta} ${mode === "awaitedDescendants" ? exact : mode === "forgottenDescendants" ? forgotten : controls}`,
      {
        agent: runner,
        tokenBudget: 1000,
        onAgentStart: (event) => phases.push(event.phase),
        onAgentEnd: (event) => {
          if (!event.error) successes++;
        },
        onAgentJournal: (entry) => journals.push(entry),
      },
    );
    if (mode === "descendantBudget") {
      await assert.rejects(
        pending,
        (error) => (error as { code?: string }).code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
      );
      assert.equal(calls, 1, "descendant must not escape its private phase budget");
      assert.equal(successes, 1);
      assert.deepEqual(phases, ["private"]);
    } else {
      const result = await pending;
      assert.equal(calls, 2, "second descendant must dispatch exactly once");
      assert.equal(successes, 2);
      assert.equal(journals.length, 2);
      assert.equal(result.agentCount, 2);
      assert.deepEqual(
        result.result,
        mode === "awaitedDescendants"
          ? '{"ok":true}'
          : mode === "forgottenDescendants"
            ? 1
            : { ok: true, value: ['{"ok":true}'], attempts: 1 },
      );
      if (mode === "descendantControls") assert.deepEqual(phases, ["private", "private"]);
    }
    const settledCalls = calls;
    await delay(150);
    assert.equal(calls, settledCalls, "frame success/failure must close descendant dispatch");
  } else if (mode === "postRootLocalPromise") {
    await assert.rejects(
      runWorkflow(
        `${meta}
      let release;
      const held = new Promise(r=>release=r);
      await parallel([()=>{void (async()=>{await held;await agent('second');})().catch(()=>{});return 1;}]);
      log.constructor('return setTimeout')()(()=>release(),150);
      void checkpoint('hold');return 1;`,
        {
          agent: runner,
          confirm: async () => {
            await delay(400);
            return true;
          },
        },
      ),
      /retired workflow callback scope/,
    );
    assert.equal(
      calls,
      0,
      "local-only authority must retire at root result even if accepted native work keeps the helper alive",
    );
  } else if (mode === "rootLateCall" || mode === "deadScope" || mode === "foreignScope") {
    const script =
      mode === "rootLateCall"
        ? `void (async()=>{await agent('first');return await agent('second')})().catch(()=>{});
         void checkpoint('hold');return 1;`
        : mode === "deadScope"
          ? `await parallel([()=>{log.constructor('return setTimeout')()(()=>{void agent('second');},100);return 1;}]);
           return await checkpoint('hold');`
          : `log.constructor('return process')().send({type:'call',id:123,name:'agent',args:['a',0,[['v','second']]],scope:999});
           return await checkpoint('hold');`;
    await assert.rejects(
      runWorkflow(`${meta} ${script}`, {
        agent: runner,
        confirm: async () => {
          await delay(400);
          return true;
        },
      }),
      mode === "rootLateCall" ? /closed native call admission/ : /retired workflow callback scope/,
    );
    assert.equal(calls, mode === "rootLateCall" ? 1 : 0, "late/foreign contexts must not widen native admission");
  } else if (mode === "scopeRecycling") {
    // More callbacks than MAX_PENDING over time: completed contexts must retire
    // rather than accumulating until a healthy frame reaches the live cap.
    const result = await runWorkflow(`${meta}
      const fn=()=>1;
      for(let i=0;i<8300;i++) await retry(fn);
      return 1;`);
    assert.equal(result.result, 1);
  } else if (mode === "nestedDrain" || mode === "nestedDescendants" || mode === "unawaitedControls") {
    const journals: JournalEntry[] = [];
    let childEnded = false;
    const nested = mode !== "unawaitedControls";
    const child =
      mode === "nestedDescendants"
        ? `${meta} void parallel([()=>{
          void (async()=>{await agent('first');await retry(()=>agent('second'));log('child-done');})();return 1;
        }]);return 1;`
        : `${meta} void pipeline([1],async()=>{await agent("child");log("child-done");}); return 1;`;
    const script = nested
      ? 'void workflow("saved"); return 1;'
      : `
      void parallel([()=>agent("parallel")]);
      void pipeline([1],()=>agent("pipeline"));
      void retry(()=>agent("retry"));
      void gate(()=>agent("gate"),()=>({ok:true}));
      void orchestrate([{id:"a",run:()=>agent("dag")}]);
      void loopUntilDry({round:async i=>i===0?[await agent("round")]:[]});
      return 1;`;
    const result = await runWorkflow(`${meta} ${script}`, {
      agent: runner,
      loadSavedWorkflow: () => child,
      onLog: () => {
        childEnded = true;
      },
      onAgentJournal: (entry) => journals.push(entry),
      onWorkflowJournal: (entry) => journals.push(entry),
    });
    assert.equal(result.result, 1);
    assert.equal(calls, mode === "nestedDescendants" ? 2 : nested ? 1 : 6);
    assert.equal(journals.length, mode === "nestedDescendants" ? 3 : nested ? 2 : 6);
    if (nested) assert.equal(childEnded, true);
    const settledCalls = calls;
    await delay(250);
    assert.equal(calls, settledCalls, "completed frame must not leave a dispatch-capable helper");
  } else if (mode === "nestedAbort") {
    let armed = false;
    const pending = runWorkflow(`${meta} void workflow("saved"); return 1;`, {
      signal: controller.signal,
      loadSavedWorkflow: () => `${meta} void retry(async()=>{log("armed"); await new Promise(()=>{});}); return 1;`,
      onLog: () => {
        armed = true;
      },
    });
    while (!armed) await delay(10);
    controller.abort();
    await assert.rejects(pending, (error) => (error as { code?: string }).code === WorkflowErrorCode.WORKFLOW_ABORTED);
  } else if (mode === "compiled" || mode === "missingNode") {
    Object.defineProperty(process, "execPath", { value: "/unavailable/compiled-host", configurable: true });
    if (mode === "missingNode") {
      process.env.PATH = "";
      await assert.rejects(runWorkflow(`${meta} return 1;`), /Cannot start workflow Node helper; install Node on PATH/);
    } else assert.equal((await runWorkflow(`${meta} return 1;`)).result, 1);
  } else if (mode === "ignoreTerm" || mode === "abortSpin") {
    let armed = false;
    const script =
      mode === "ignoreTerm"
        ? 'log.constructor("return process")().on("SIGTERM",()=>{}); log("armed"); await new Promise(()=>{});'
        : 'log("armed"); await Promise.resolve(); while(true){}';
    const pending = runWorkflow(`${meta} ${script}`, {
      signal: controller.signal,
      onLog: () => {
        armed = true;
      },
    });
    while (!armed) await delay(10);
    const started = performance.now();
    controller.abort();
    await assert.rejects(pending, (error) => (error as { code?: string }).code === WorkflowErrorCode.WORKFLOW_ABORTED);
    const elapsed = performance.now() - started;
    if (mode === "ignoreTerm") assert.ok(elapsed >= 200, "must wait for TERM escalation and actual KILL close");
    assert.ok(elapsed < 2000, "owned helper close must stay bounded");
  } else if (mode === "bounds") {
    await assert.rejects(runWorkflow(`${meta} log("x".repeat(65537));`), /log limit exceeded/);
    await assert.rejects(
      runWorkflow(`${meta} return await pipeline([Array.from({length:100000},()=>1)],x=>x);`),
      /IPC limits/,
    );
    await assert.rejects(
      runWorkflow(`${meta} return 1;`, { args: "x".repeat(4 * 1024 * 1024) }),
      /IPC\/backpressure limit/,
    );
  } else if (mode === "inspect") {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --inspect-brk=0`.trim();
    await assert.rejects(runWorkflow(`${meta} return 1;`, { agent: runner }), /not ready within 5s.*NODE_OPTIONS/);
  } else if (mode in loops) {
    await assert.rejects(
      runWorkflow(`${meta} ${loops[mode]}`, { agent: runner, agentTimeoutMs: null }),
      /Script execution timed out|CPU stall/,
    );
    assert.ok(ticks > 10, "Pi parent event loop must remain responsive during VM CPU loops");
    if (mode === "inFlight") {
      assert.equal(calls, 1);
      assert.equal(cleaned, true);
    }
  } else if (mode === "scriptErrors") {
    await assert.rejects(runWorkflow(`${meta} throw new Error("quota described by the script");`), /quota described/);
    const results = await runWorkflow(`${meta}
      const first = await parallel([()=>{throw new Error("rate limit described by the script");}]);
      const second = await gate(()=>{throw {toString(){return "object throw";}}},()=>({ok:true})).catch(value=>String(value));
      return [first,second];`);
    assert.deepEqual(results.result, [[null], "object throw"]);
    await assert.rejects(
      runWorkflow(`${meta} return 1n;`),
      (error) => (error as { code?: string }).code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
  } else if (mode === "cancel") {
    const pending = runWorkflow(`${meta} return await agent("pending");`, { agent: runner, signal: controller.signal });
    while (calls === 0) await delay(10);
    controller.abort();
    await assert.rejects(pending, (error) => (error as { code?: string }).code === WorkflowErrorCode.WORKFLOW_ABORTED);
    assert.equal(cleaned, true);
  } else if (mode === "longAwait") {
    const result = await runWorkflow(
      `${meta} return await agent("wait",{schema:{type:"object",required:["ok"],properties:{ok:{type:"boolean"}}}});`,
      { agent: runner },
    );
    assert.deepEqual(result.result, { ok: true });
    assert.ok(ticks > 80, "legitimate agent await must continue heartbeats");
  } else if (mode === "controls") {
    const journal = new Map<string, JournalEntry>();
    const script = `${meta}
      phase("one",{budget:100}); log("raw\\u001btext");
      const graph = await orchestrate([{id:"a",run:()=>agent("one")},{id:"b",dependsOn:["a"],run:({results})=>results.a}]);
      const values = await parallel([() => 1, () => 2]);
      const staged = await pipeline([1,2], value => value+1);
      const retried = await retry(i=>i,{until:value=>value===1});
      const gated = await gate(()=>3,value=>({ok:value===3}));
      const dry = await loopUntilDry({round:i=>i===0?[{key:"a"}]:[],key:x=>x.key});
      const data = await pipeline([new Map([["a",new Set([1])]]),new Date("2020-01-01"),12n], x=>x);
      const transport = await pipeline([()=>42, (()=>{const a=[]; a[2]=3; return a;})(), (()=>{const v={};v.self=v;return v;})()], (v,_item,i)=>i===0?v():i===1?[v.length,0 in v,2 in v]:v.self===v);
      let syncPhase=false; try { phase(42); } catch { syncPhase=true; }
      const classified = await retry(()=>{const e=new Error("quota"); e.code="PROVIDER_USAGE_LIMIT"; e.recoverable=true; e.resetHint="in 1 seconds"; throw e;}).catch(e=>[e.message,e.code,e.recoverable,e.resetHint]);
      return {graph:graph.results, values,staged,retried,gated,dry,classified,transport,syncPhase,
        intermediate:[data[0].get("a").has(1),data[1].getUTCFullYear(),String(data[2])],budget:budget.remaining()};`;
    const options = {
      runId: "controls",
      agent: runner,
      tokenBudget: 1000,
      onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId}:${entry.index}`, entry),
    };
    const first = await runWorkflow(script, options);
    const second = await runWorkflow(script, { ...options, resumeJournal: journal });
    const { budget: firstBudget, ...firstValue } = first.result as Record<string, unknown>;
    const { budget: secondBudget, ...secondValue } = second.result as Record<string, unknown>;
    assert.deepEqual(secondValue, firstValue);
    assert.equal(firstBudget, 994);
    assert.equal(secondBudget, 1000); // Replayed calls spend no tokens.
    assert.ok(first.logs.includes("raw\u001btext"));
    assert.equal(calls, 1);
    assert.deepEqual((first.result as { classified: unknown }).classified, [
      "quota",
      "PROVIDER_USAGE_LIMIT",
      true,
      "in 1 seconds",
    ]);
    assert.deepEqual((first.result as { transport: unknown }).transport, [42, [3, false, true], true]);
    assert.equal((first.result as { syncPhase: unknown }).syncPhase, true);
    assert.deepEqual((first.result as { intermediate: unknown }).intermediate, [true, 2020, "12"]);
    const child = `${meta} return await agent("child");`;
    const nested = await runWorkflow(`${meta} return await workflow("saved");`, {
      agent: runner,
      loadSavedWorkflow: () => child,
    });
    assert.equal(nested.result, '{"ok":true}');
  } else throw new Error(`unknown fixture mode ${mode}`);
  console.log(`PASS ${mode}`);
} finally {
  clearInterval(timer);
}
