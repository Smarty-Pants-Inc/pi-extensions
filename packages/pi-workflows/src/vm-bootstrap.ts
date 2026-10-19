/** Plain JavaScript bootstrap: no loader, package imports or SDK in the helper. */
export const VM_BOOTSTRAP = `
'use strict';
const vm = require('node:vm');
const { AsyncLocalStorage, createHook } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const contexts = new Map();
const localPromises = new Map();
let rootReturned = false;
// Only unresolved promises hold local continuation authority. Never retain the
// promise object itself (GC may destroy an abandoned promise), timers, or a
// historical async-id pool. Caps are separate from pending callback/RPC limits.
createHook({
  init(id,type) {
    const context = scope.getStore();
    if (type !== 'PROMISE' || !context || context.released) return;
    if (localPromises.size >= 65536) throw new Error('workflow local promise limit exceeded');
    localPromises.set(id,context); context.promises.add(id);
  },
  promiseResolve: settlePromise,
  destroy: settlePromise,
}).enable();
function settlePromise(id) {
  const context = localPromises.get(id);
  if (!context) return;
  localPromises.delete(id); context.promises.delete(id);
  releaseScope(context);
}
const callbacks = new Map();
const callbackIds = new WeakMap();
const waiting = new Map();
const scriptErrors = new WeakSet();
const nativeErrors = new WeakSet();
let realm;
function isScriptThrow(value) { return scriptErrors.has(value) || (!(value instanceof Error) && !nativeErrors.has(value)); }
function thrown(value) { return {value:encode(value),scriptError:isScriptThrow(value),errorText:String(value).slice(0,65536)}; }
function invalidResult(message) { const error = new Error(message); error.name='WorkflowError'; error.code='SCRIPT_VALIDATION_ERROR'; error.recoverable=false; return error; }
let sequence = 0, callbackSequence = 0, sent = 0, queuedBytes = 0, logBytes = 0;
let spent = 0, total = null;
const MAX_BYTES = 4 * 1024 * 1024;
function send(message) {
  const bytes = Buffer.byteLength(JSON.stringify(message));
  if (bytes > MAX_BYTES || (message.type !== 'heartbeat' && ++sent > 100000) || queuedBytes + bytes > 8 * MAX_BYTES)
    throw new Error('workflow helper IPC/backpressure limit exceeded');
  queuedBytes += bytes;
  process.send(message, error => { queuedBytes -= bytes; if (error) process.exit(1); });
}
function encode(value) {
  const seen = new Map(); let nodes = 0;
  function visit(v, depth) {
    if (++nodes > 100000 || depth > 64) throw new Error('workflow intermediate value exceeds IPC limits');
    if (v === undefined) return ['u'];
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return ['v', v];
    if (typeof v === 'number') return ['n', String(v)];
    if (typeof v === 'bigint') return ['b', String(v)];
    if (typeof v === 'function') {
      let id = callbackIds.get(v);
      if (!id) { if (callbacks.size >= 8192) throw new Error('workflow callback limit exceeded');
        id = ++callbackSequence; callbackIds.set(v, id); callbacks.set(id, v); }
      return ['f', id];
    }
    if (typeof v !== 'object') throw new Error('unsupported workflow intermediate value');
    if (seen.has(v)) return ['r', seen.get(v)];
    const id = seen.size; seen.set(v, id);
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object Date]') return ['d', id, v.toISOString()];
    if (tag === '[object RegExp]') return ['x', id, v.source, v.flags];
    if (tag === '[object Map]') return ['m', id, [...v].map(([k, x]) => [visit(k, depth + 1), visit(x, depth + 1)])];
    if (tag === '[object Set]') return ['s', id, [...v].map(x => visit(x, depth + 1))];
    if (Array.isArray(v)) return ['a', id, Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i) ? visit(v[i],depth+1) : ['h'])];
    if (tag.endsWith('Error]')) return ['e', id, visit({name:String(v.name), message:String(v.message), code:v.code,
      recoverable:v.recoverable, agentLabel:v.agentLabel, resetHint:v.resetHint}, depth + 1),isScriptThrow(v)];
    return ['o', id, Object.keys(v).map(k => [k, visit(v[k], depth + 1)])];
  }
  return visit(value, 0);
}
function decode(wire) {
  const refs = new Map();
  function visit(w) {
    const [tag, id, data, flags] = w;
    if (tag === 'u') return undefined;
    if (tag === 'v') return id;
    if (tag === 'n') return Number(id);
    if (tag === 'b') return BigInt(id);
    if (tag === 'r') return refs.get(id);
    if (tag === 'f') { const fn = callbacks.get(id); if (!fn) throw new Error('invalid returned workflow callback identity'); return fn; }
    let value;
    if (tag === 'a') value = new realm.Array();
    else if (tag === 'm') value = new realm.Map();
    else if (tag === 's') value = new realm.Set();
    else if (tag === 'd') value = new realm.Date(data);
    else if (tag === 'x') value = new realm.RegExp(data, flags);
    else if (tag === 'e') value = new realm.Error();
    else if (tag === 'o') value = new realm.Object();
    else throw new Error('invalid parent workflow value');
    refs.set(id, value);
    if (tag === 'a') for (const x of data) { if (Array.isArray(x) && x.length === 1 && x[0] === 'h') value.length++; else value.push(visit(x)); }
    if (tag === 'm') for (const [k,x] of data) value.set(visit(k),visit(x));
    if (tag === 's') for (const x of data) value.add(visit(x));
    if (tag === 'o') for (const [k,x] of data) Object.defineProperty(value,k,{value:visit(x),writable:true,enumerable:true,configurable:true});
    if (tag === 'e') {
      const fields = visit(data);
      const ctor = Object.hasOwn(realm.errors,fields.name) ? realm.errors[fields.name] : realm.Error;
      Object.setPrototypeOf(value, ctor.prototype);
      Object.assign(value, fields);
      if (flags) scriptErrors.add(value); else nativeErrors.add(value);
    }
    return value;
  }
  return visit(wire);
}
function retireScope(context) {
  if (context.released) return;
  context.released = true;
  contexts.delete(context.id);
  for (const id of context.promises) localPromises.delete(id);
  context.promises.clear();
  send({type:'scopeReleased',id:context.id});
}
function releaseScope(context) {
  if (!context || !context.settled || context.pending || context.releasing || context.released) return;
  if (!rootReturned && context.promises.size) return;
  context.releasing = true;
  // Promise settlement precedes its reactions. Let those reactions post their
  // RPCs, then recheck real credits. A local unresolved await is credited for
  // the entire running root, not guessed to have resumed after one I/O turn.
  setImmediate(() => {
    context.releasing = false;
    if (context.pending || context.released || (!rootReturned && context.promises.size)) return;
    retireScope(context);
  });
}
function closeRootAdmission() {
  rootReturned = true;
  // At the root boundary only accepted native work (or its unsettled callback)
  // carries descendant authority. Ignored, purely local promises cannot keep
  // the helper alive or mint post-root admission. Release BEFORE root result.
  for (const context of contexts.values()) {
    if (context.settled && !context.pending) retireScope(context);
  }
}
function rpc(name, args) {
  if (waiting.size >= 8192) throw new Error('workflow IPC request limit exceeded');
  const id = ++sequence;
  const context = scope.getStore();
  const promise = new Promise((resolve,reject) => {
    if (context) context.pending++;
    waiting.set(id,{resolve,reject,context});
    try { send({type:'call',id,name,args:encode(args),scope:context?.id}); }
    catch (error) {
      waiting.delete(id);
      if (context) { context.pending--; releaseScope(context); }
      reject(error);
    }
  });
  // Native helpers already own ignored-call dispositions. Observe the original
  // RPC promise without changing what author await/catch sees (strict Node).
  void promise.catch(() => {});
  return promise;
}
function notify(name,args) {
  const context = scope.getStore();
  send({type:'notify',name,args:encode(args),scope:context?.id});
}
process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  if (message.type === 'response') {
    spent = message.spent;
    const waiter = waiting.get(message.id); if (!waiter) return;
    waiting.delete(message.id);
    try { const value = decode(message.value); if (!message.ok && message.scriptError && value && (typeof value === 'object' || typeof value === 'function')) scriptErrors.add(value); message.ok ? waiter.resolve(value) : waiter.reject(value); }
    catch (error) { waiter.reject(error); }
    finally {
      if (waiter.context) { waiter.context.pending--; releaseScope(waiter.context); }
    }
  } else if (message.type === 'callback') {
    const callback = callbacks.get(message.callback);
    if (!callback) return process.exit(1);
    if (contexts.size >= 16384) throw new Error('workflow live execution context limit exceeded');
    const context = {id:message.id,pending:0,promises:new Set(),settled:false,releasing:false,released:false};
    contexts.set(context.id,context);
    scope.run(context, async () => {
      try { send({type:'callbackResult',id:message.id,ok:true,value:encode(await callback(...decode(message.args)))}); }
      catch (error) { send({type:'callbackResult',id:message.id,ok:false,...thrown(error)}); }
      finally { context.settled = true; releaseScope(context); }
    });
  } else if (message.type === 'start') {
    total = message.total; spent = message.spent;
    const globals = {};
    for (const name of message.names) globals[name] = (...args) => rpc(name,args);
    globals.log = value => { const text = String(value); logBytes += Buffer.byteLength(text); if (text.length > 65536 || logBytes > 1024 * 1024) throw new Error('workflow log limit exceeded (64KiB per entry, 1MiB per frame)'); notify('log',[text]); };
    globals.phase = (title,options) => {
      if (typeof title !== 'string' || title.length > 4096) throw new TypeError('phase title must be a string of at most 4096 characters');
      if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) throw new TypeError('phase options must be an object');
      notify('phase',[title,options]);
    };
    globals.console = {log:globals.log,info:globals.log,warn:v=>globals.log('[warn] '+String(v)),error:v=>globals.log('[error] '+String(v))};
    globals.cwd = message.cwd;
    globals.process = Object.freeze({cwd:()=>message.cwd});
    globals.budget = Object.freeze({total,spent:()=>spent,remaining:()=>total === null ? Infinity : Math.max(0,total-spent)});
    const context = vm.createContext(globals);
    realm = vm.runInContext('({Array,Object,Map,Set,Date,RegExp,Error,errors:{Error,TypeError,RangeError,SyntaxError,ReferenceError,URIError,EvalError,AggregateError}})',context);
    globals.args = decode(message.args);
    Promise.resolve().then(() => new vm.Script(message.script,{filename:message.filename}).runInContext(context,{timeout:1000}))
      .then(result => {
        try {
          const serialized = JSON.stringify(result);
          if (result !== undefined && serialized === undefined) throw new Error('workflow result is not JSON-serializable');
          const value = encode(serialized === undefined ? undefined : JSON.parse(serialized));
          closeRootAdmission();
          send({type:'result',ok:true,value});
        } catch (error) { throw invalidResult('workflow result is not JSON-serializable: '+error.message); }
      }).catch(error => send({type:'result',ok:false,...thrown(error)}));
  }
});
setInterval(() => send({type:'heartbeat'}),100).unref();
send({type:'ready'});
`;
