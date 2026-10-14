import { AsyncResource } from "node:async_hooks";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { markScriptThrow, scriptThrowText, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { VM_BOOTSTRAP } from "./vm-bootstrap.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 8192;
const MAX_CONTEXTS = 2 * MAX_PENDING;
const fail = (message: string) =>
  new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
type Wire = unknown[];
type Callback = (...args: unknown[]) => Promise<unknown>;

/** Encode intermediate JS data, not just the final (JSON-only) workflow result. */
function encode(value: unknown, callbackId?: (fn: object) => number | undefined): Wire {
  const seen = new Map<object, number>();
  let nodes = 0;
  const visit = (v: unknown, depth: number): Wire => {
    if (++nodes > 100000 || depth > 64) throw fail("workflow intermediate value exceeds IPC limits");
    if (v === undefined) return ["u"];
    if (v === null || typeof v === "string" || typeof v === "boolean") return ["v", v];
    if (typeof v === "number") return ["n", String(v)];
    if (typeof v === "bigint") return ["b", String(v)];
    if (typeof v === "function") {
      const id = callbackId?.(v);
      if (id !== undefined) return ["f", id];
      throw fail("unsupported native workflow function");
    }
    if (typeof v !== "object") throw fail("unsupported native workflow value");
    if (seen.has(v)) return ["r", seen.get(v)];
    const id = seen.size;
    seen.set(v, id);
    if (v instanceof Date) return ["d", id, v.toISOString()];
    if (v instanceof RegExp) return ["x", id, v.source, v.flags];
    if (v instanceof Map) return ["m", id, [...v].map(([k, x]) => [visit(k, depth + 1), visit(x, depth + 1)])];
    if (v instanceof Set) return ["s", id, [...v].map((x) => visit(x, depth + 1))];
    if (Array.isArray(v))
      return [
        "a",
        id,
        Array.from({ length: v.length }, (_, index) => (Object.hasOwn(v, index) ? visit(v[index], depth + 1) : ["h"])),
      ];
    if (v instanceof Error) {
      const classified = v as Error & Partial<WorkflowError>;
      return [
        "e",
        id,
        visit(
          {
            name: v.name,
            message: v.message,
            code: classified.code,
            recoverable: classified.recoverable,
            agentLabel: classified.agentLabel,
            resetHint: classified.resetHint,
          },
          depth + 1,
        ),
        scriptThrowText(v) !== undefined,
      ];
    }
    return ["o", id, Object.entries(v).map(([k, x]) => [k, visit(x, depth + 1)])];
  };
  return visit(value, 0);
}

/** Validate every helper value before it can reach native runtime bindings. */
function decode(wire: unknown, callback: (id: number) => Callback): unknown {
  const refs = new Map<number, unknown>();
  let nodes = 0;
  const visit = (w: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 64 || !Array.isArray(w)) throw fail("invalid workflow IPC value");
    const [tag, id, data, flags] = w;
    if (tag === "u" && w.length === 1) return undefined;
    if (tag === "v" && w.length === 2 && (id === null || typeof id === "string" || typeof id === "boolean")) return id;
    if (
      tag === "n" &&
      typeof id === "string" &&
      /^(?:NaN|[-+]?Infinity|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)$/i.test(id)
    )
      return Number(id);
    if (tag === "b" && typeof id === "string" && /^-?\d{1,10000}$/.test(id)) return BigInt(id);
    if (!Number.isSafeInteger(id) || id < 0 || id > 100000) throw fail("invalid workflow IPC identity");
    if (tag === "f" && id > 0 && id <= MAX_PENDING) return callback(id);
    if (tag === "r" && refs.has(id)) return refs.get(id);
    if (refs.has(id)) throw fail("duplicate workflow IPC identity");
    let value: unknown;
    if (tag === "a") value = [];
    else if (tag === "m") value = new Map();
    else if (tag === "s") value = new Set();
    else if (tag === "d" && typeof data === "string") value = new Date(data);
    else if (tag === "x" && typeof data === "string" && typeof flags === "string") value = new RegExp(data, flags);
    else if (tag === "e") value = new Error();
    else if (tag === "o") value = {};
    else throw fail("invalid workflow IPC tag");
    refs.set(id, value);
    if (["a", "m", "s", "o"].includes(tag) && !Array.isArray(data)) throw fail("invalid workflow IPC collection");
    if (tag === "a")
      for (const x of data) {
        if (Array.isArray(x) && x.length === 1 && x[0] === "h") (value as unknown[]).length++;
        else (value as unknown[]).push(visit(x, depth + 1));
      }
    if (tag === "s") for (const x of data) (value as Set<unknown>).add(visit(x, depth + 1));
    if (tag === "m" || tag === "o")
      for (const pair of data) {
        if (!Array.isArray(pair) || pair.length !== 2) throw fail("invalid workflow IPC entry");
        if (tag === "m") (value as Map<unknown, unknown>).set(visit(pair[0], depth + 1), visit(pair[1], depth + 1));
        else {
          if (typeof pair[0] !== "string") throw fail("invalid workflow IPC key");
          Object.defineProperty(value, pair[0], {
            value: visit(pair[1], depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    if (tag === "e") {
      const fields = visit(data, depth + 1) as Partial<WorkflowError>;
      if (
        !fields ||
        typeof fields.message !== "string" ||
        typeof fields.name !== "string" ||
        typeof flags !== "boolean"
      )
        throw fail("invalid workflow IPC error");
      if (!flags && fields.code && Object.values(WorkflowErrorCode).includes(fields.code)) {
        value = new WorkflowError(fields.message, fields.code, {
          recoverable: fields.recoverable === true,
          agentLabel: typeof fields.agentLabel === "string" ? fields.agentLabel : undefined,
          resetHint: typeof fields.resetHint === "string" ? fields.resetHint : undefined,
        });
      } else {
        const constructors: Record<string, { prototype: Error }> = {
          Error,
          TypeError,
          RangeError,
          SyntaxError,
          ReferenceError,
          URIError,
          EvalError,
          AggregateError,
        };
        Object.setPrototypeOf(
          value,
          (Object.hasOwn(constructors, fields.name) ? constructors[fields.name] : Error).prototype,
        );
        Object.assign(value as Error, fields);
      }
      if (flags) markScriptThrow(value, `${fields.name}: ${fields.message}`);
      refs.set(id, value);
    }
    return value;
  };
  return visit(wire, 0);
}

interface VmOptions {
  script: string;
  filename: string;
  args: unknown;
  cwd: string;
  bindings: Record<string, unknown>;
  total: number | null;
  spent: () => number;
  signal: AbortSignal;
  cancel: () => void;
}

/** Own the actual child handle through close. Never signal a restored/historical PID. */
export async function executeOwnedVm(options: VmOptions): Promise<unknown> {
  if (options.signal.aborted)
    throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
  const nodeHost =
    !process.versions.bun && process.release.name === "node" && /^(?:node|node.exe)$/i.test(basename(process.execPath));
  const executable = nodeHost ? process.execPath : "node";
  const child = spawn(executable, ["--max-old-space-size=128", "-e", VM_BOOTSTRAP], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "json",
    // Inherit NODE_OPTIONS unchanged, including --inspect-brk. The ready deadline
    // makes a paused debugger actionable rather than silently hanging Pi.
    env: process.env,
  });
  let closed = false;
  const close = new Promise<void>((resolve) =>
    child.once("close", () => {
      closed = true;
      resolve();
    }),
  );
  let diagnostic = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4096);
  });
  const callbacks = new Map<number, Callback>();
  const callbackIds = new WeakMap<object, number>();
  const toWire = (value: unknown) => encode(value, (fn) => callbackIds.get(fn));
  const requests = new Map<number, number>();
  const operations = new Set<Promise<void>>();
  let returned = false;
  let returnedValue: unknown;
  let retainedBytes = 0;
  // Callback responses settle independently of their execution context. A
  // descendant RPC may still resume in that same ALS context after the callback
  // has returned. The helper tracks unresolved local promises until the root
  // returns, then retains only accepted native descendant credits. Native
  // operations also hold a credit through response publication.
  const scopes = new Map<number, { resource: AsyncResource; active: number; released: boolean }>();
  const callbackResponses = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  let sequence = 0,
    messages = 0,
    queuedBytes = 0;
  let finished = false,
    ready = false,
    lastHeartbeat = performance.now();
  let settle!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<unknown>((resolve, failResult) => {
    settle = resolve;
    reject = failResult;
  });
  const completeIfDrained = () => {
    if (!finished && returned && operations.size === 0 && scopes.size === 0) {
      finished = true;
      settle(returnedValue);
    }
  };
  const retireScope = (id: number) => {
    const scope = scopes.get(id);
    if (!scope?.released || scope.active !== 0) return;
    scopes.delete(id);
    scope.resource.emitDestroy();
    completeIfDrained();
  };
  const stop = (error: unknown) => {
    if (finished) return;
    finished = true;
    options.cancel();
    for (const response of callbackResponses.values()) response.reject(error);
    callbackResponses.clear();
    for (const scope of scopes.values()) scope.resource.emitDestroy();
    scopes.clear();
    reject(error);
  };
  const send = (message: Record<string, unknown>) => {
    if (finished || !child.connected) throw fail("workflow helper is no longer connected");
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_BYTES || queuedBytes + bytes > 8 * MAX_BYTES)
      throw fail("workflow helper IPC/backpressure limit exceeded");
    queuedBytes += bytes;
    child.send(message, (error) => {
      queuedBytes -= bytes;
      if (error) stop(error);
    });
  };
  const callback = (id: number): Callback => {
    const existing = callbacks.get(id);
    if (existing) return existing;
    const proxy: Callback = (...args) =>
      new Promise((resolve, rejectCallback) => {
        if (callbackResponses.size >= MAX_PENDING)
          return rejectCallback(fail("workflow callback concurrency limit exceeded"));
        if (scopes.size >= MAX_CONTEXTS) return rejectCallback(fail("workflow live execution context limit exceeded"));
        const callId = ++sequence;
        const resource = new AsyncResource("workflow-vm-callback");
        scopes.set(callId, { resource, active: 0, released: false });
        callbackResponses.set(callId, { resolve, reject: rejectCallback });
        try {
          send({ type: "callback", id: callId, callback: id, args: toWire(args) });
        } catch (error) {
          callbackResponses.delete(callId);
          scopes.delete(callId);
          resource.emitDestroy();
          rejectCallback(error);
        }
      });
    callbacks.set(id, proxy);
    callbackIds.set(proxy, id);
    return proxy;
  };
  const markThrown = (message: Record<string, unknown>, value: unknown) => {
    if (
      typeof message.scriptError !== "boolean" ||
      typeof message.errorText !== "string" ||
      message.errorText.length > 65536
    )
      throw fail("invalid workflow exception provenance/text");
    if (message.scriptError) markScriptThrow(value, message.errorText);
  };
  const onAbort = () =>
    stop(new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true }));
  options.signal.addEventListener("abort", onAbort, { once: true });
  const startup = setTimeout(
    () =>
      stop(
        fail(
          "workflow Node helper was not ready within 5s; check Node on PATH and NODE_OPTIONS/debugger (--inspect-brk)",
        ),
      ),
    5000,
  );
  let lastWatchdogTick = performance.now();
  let heartbeatProgress = 0;
  let graceProgress = -1;
  let lagCheck: ReturnType<typeof setImmediate> | undefined;
  const checkHeartbeat = () => {
    if (ready && performance.now() - lastHeartbeat > 1500)
      stop(fail("workflow JavaScript CPU stall: helper heartbeat timed out"));
  };
  const watchdog = setInterval(() => {
    const now = performance.now();
    const parentLag = now - lastWatchdogTick;
    lastWatchdogTick = now;
    if (parentLag > 500 && graceProgress !== heartbeatProgress) {
      // One I/O turn for queued heartbeats, never a fabricated heartbeat.
      // Only actual IPC progress can renew this bounded lag exemption.
      graceProgress = heartbeatProgress;
      if (lagCheck === undefined)
        lagCheck = setImmediate(() => {
          lagCheck = undefined;
          checkHeartbeat();
        });
      return;
    }
    checkHeartbeat();
  }, 100);
  child.once("error", (error) =>
    stop(fail(`Cannot start workflow Node helper; install Node on PATH: ${error.message}`)),
  );
  child.once("close", (code, signal) => {
    if (!finished) stop(fail(`workflow Node helper exited (${code ?? signal}): ${diagnostic}`));
  });
  child.on("message", (raw: unknown) => {
    if (finished) return;
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES || !raw || typeof raw !== "object" || Array.isArray(raw))
        throw fail("invalid/bounded workflow IPC message");
      const message = raw as Record<string, unknown>;
      if (message.type !== "heartbeat" && ++messages > 100000) throw fail("workflow IPC message limit exceeded");
      if (message.type === "ready" && !ready) {
        ready = true;
        lastHeartbeat = performance.now();
        clearTimeout(startup);
        send({
          type: "start",
          script: options.script,
          filename: options.filename,
          args: toWire(options.args),
          cwd: options.cwd,
          names: Object.keys(options.bindings).filter(
            (key) => typeof options.bindings[key] === "function" && !["log", "phase"].includes(key),
          ),
          total: options.total,
          spent: options.spent(),
        });
      } else if (message.type === "heartbeat" && ready) {
        lastHeartbeat = performance.now();
        heartbeatProgress++;
      } else if (message.type === "result" && ready && typeof message.ok === "boolean") {
        const value = decode(message.value, callback);
        if (!message.ok) {
          markThrown(message, value);
          stop(value);
          return;
        }
        if (returned) throw fail("duplicate workflow frame result");
        returned = true;
        returnedValue = value;
        // Keep the helper alive: accepted native operations may still require
        // VM callbacks and scoped RPC (including nested workflow frames).
        completeIfDrained();
      } else if (
        message.type === "callbackResult" &&
        typeof message.id === "number" &&
        typeof message.ok === "boolean"
      ) {
        const response = callbackResponses.get(message.id);
        if (!response) throw fail("unknown workflow callback response");
        const value = decode(message.value, callback);
        if (!message.ok) markThrown(message, value);
        callbackResponses.delete(message.id);
        if (message.ok) response.resolve(value);
        else response.reject(value);
      } else if (message.type === "scopeReleased" && ready) {
        if (!Number.isSafeInteger(message.id)) throw fail("invalid workflow callback scope identity");
        const scope = scopes.get(message.id as number);
        if (!scope || scope.released || callbackResponses.has(message.id as number))
          throw fail("unknown/unsettled workflow callback scope release");
        scope.released = true;
        retireScope(message.id as number);
      } else if ((message.type === "call" || message.type === "notify") && ready) {
        const notify = message.type === "notify";
        if (returned && message.scope === undefined) throw fail("workflow frame has closed native call admission");
        const name = message.name;
        if (
          typeof name !== "string" ||
          !Object.hasOwn(options.bindings, name) ||
          typeof options.bindings[name] !== "function" ||
          notify !== ["log", "phase"].includes(name)
        )
          throw fail("invalid workflow runtime binding request");
        if (
          !notify &&
          (!Number.isSafeInteger(message.id) ||
            (message.id as number) <= 0 ||
            requests.has(message.id as number) ||
            requests.size >= MAX_PENDING)
        )
          throw fail("invalid/bounded workflow request identity");
        if (!notify) {
          const bytes = Buffer.byteLength(JSON.stringify(message.args));
          if (retainedBytes + bytes > 8 * MAX_BYTES) throw fail("workflow pending IPC memory limit exceeded");
          retainedBytes += bytes;
          requests.set(message.id as number, bytes);
        }
        const args = decode(message.args, callback);
        if (!Array.isArray(args)) throw fail("invalid workflow request arguments");
        const scope = message.scope === undefined ? undefined : scopes.get(message.scope as number);
        if (message.scope !== undefined && (!Number.isSafeInteger(message.scope) || !scope || scope.released))
          throw fail("retired workflow callback scope");
        const resource = scope?.resource;
        if (!notify && scope) scope.active++;
        const invoke = () => (options.bindings[name] as (...args: unknown[]) => unknown)(...args);
        let answer: unknown;
        try {
          answer = resource ? resource.runInAsyncScope(invoke) : invoke();
        } catch (error) {
          if (notify) throw error;
          answer = Promise.reject(error);
        }
        if (!notify) {
          const operation = Promise.resolve(answer)
            .then(
              (value) => {
                if (!finished)
                  send({ type: "response", id: message.id, ok: true, value: toWire(value), spent: options.spent() });
              },
              (error) => {
                if (!finished)
                  send({
                    type: "response",
                    id: message.id,
                    ok: false,
                    value: toWire(error),
                    spent: options.spent(),
                    scriptError: scriptThrowText(error) !== undefined,
                    errorText: scriptThrowText(error) ?? (error instanceof Error ? error.message : String(error)),
                  });
              },
            )
            .catch(stop)
            .finally(() => {
              retainedBytes -= requests.get(message.id as number) ?? 0;
              requests.delete(message.id as number);
              operations.delete(operation);
              if (scope) {
                scope.active--;
                retireScope(message.scope as number);
              }
              completeIfDrained();
            });
          operations.add(operation);
        }
      } else throw fail("invalid workflow helper message");
    } catch (error) {
      stop(error);
    }
  });
  try {
    return await result;
  } finally {
    clearTimeout(startup);
    clearInterval(watchdog);
    if (lagCheck !== undefined) clearImmediate(lagCheck);
    options.signal.removeEventListener("abort", onAbort);
    if (!closed) {
      child.kill("SIGTERM");
      const escalation = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 250);
      try {
        await Promise.race([
          close,
          new Promise<never>((_resolve, rejectClose) => {
            const timer = setTimeout(
              () => rejectClose(fail("workflow Node helper did not close after TERM/KILL")),
              1500,
            );
            void close.then(() => clearTimeout(timer));
          }),
        ]);
      } finally {
        clearTimeout(escalation);
      }
    }
    // Failure cancelled the frame and rejected VM callback waits. Confirm all
    // accepted native operations (including nested helpers) before returning.
    while (operations.size > 0) await Promise.allSettled([...operations]);
  }
}
