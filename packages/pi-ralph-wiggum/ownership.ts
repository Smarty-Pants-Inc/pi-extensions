import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface LoopOwner {
  sessionId: string;
  branch: string[];
  manager?: ExtensionContext["sessionManager"];
}

export function captureOwner(ctx: ExtensionContext): LoopOwner | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  if (typeof ctx.sessionManager.getBranch !== "function") return undefined;
  const branch = ctx.sessionManager.getBranch().map((entry) => entry.id);
  return sessionId ? { sessionId, branch, manager: ctx.sessionManager } : undefined;
}

export function extendsOwner(ctx: ExtensionContext, owner: LoopOwner | undefined): boolean {
  const live = captureOwner(ctx);
  return Boolean(
    owner &&
      live &&
      (!owner.manager || owner.manager === live.manager) &&
      owner.sessionId === live.sessionId &&
      owner.branch.every((id, index) => live.branch[index] === id),
  );
}

type NativeUser = { role: string; content?: unknown; timestamp?: number };
type Input = { text: string; images?: unknown[]; source: string; streamingBehavior?: "steer" | "followUp" };
interface Candidate {
  fingerprint: string;
  real: boolean;
  token?: string;
  lane: "direct" | "steer" | "followUp";
  expires: number;
}
interface Delivery {
  token: string;
  loop: string;
  iteration: number;
  body: string;
  owner?: LoopOwner;
  expires: number;
}
export interface OwnedIteration {
  loop: string;
  iteration: number;
  nonce: string;
  owner?: LoopOwner;
  body?: string;
  native: NativeUser;
  nativeKey: string;
  nativeAfterBranchLength: number;
  token?: string;
}

function fingerprint(content: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(content) ?? "undefined")
    .digest("hex");
}
function inputContent(input: Input) {
  return [{ type: "text", text: input.text }, ...(input.images ?? [])];
}
function textOf(message: NativeUser) {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Input is only a candidate. The accepted native user message proves delivery;
 * exact content and unique provenance are required (no transform fallback).
 */
export class IterationOwnership {
  private deliveries = new Map<string, Delivery>();
  private secret = randomBytes(32);
  private sequence = 0;

  private knownToken(token: string) {
    const match = /^<!-- pi-ralph-iteration:(\d+):([a-f0-9]{64}) -->$/u.exec(token);
    return Boolean(match && createHmac("sha256", this.secret).update(match[1]).digest("hex") === match[2]);
  }
  private prune() {
    const now = Date.now();
    const inputs = this.inputs.filter((input) => input.expires > now).slice(-256);
    if (inputs.length !== this.inputs.length) this.uncertain = true;
    this.inputs = inputs;
    for (const [token, delivery] of this.deliveries) {
      if (delivery.expires <= now) this.deliveries.delete(token);
    }
    while (this.deliveries.size > 128) {
      const oldest = this.deliveries.keys().next().value;
      if (oldest === undefined) break;
      this.deliveries.delete(oldest);
    }
  }
  private inputs: Candidate[] = [];
  private uncertain = false;
  private seen = new WeakSet<object>();
  private native?: NativeUser;
  private deliveredNative = new WeakSet<object>();
  private runOwned = false;
  iteration?: OwnedIteration;
  rejected = false;

  send(loop: string, iteration: number, body: string, owner: LoopOwner | undefined) {
    const sequence = String(++this.sequence);
    const token = `<!-- pi-ralph-iteration:${sequence}:${createHmac("sha256", this.secret).update(sequence).digest("hex")} -->`;
    this.deliveries.set(token, { token, loop, iteration, body, owner, expires: Date.now() + 300_000 });
    this.prune();
    return token;
  }

  input(input: Input, ctx: ExtensionContext) {
    this.prune();
    const delivery = this.deliveries.get(input.text);
    if (
      input.source === "extension" &&
      this.knownToken(input.text) &&
      (!delivery || (input.images?.length ?? 0) > 0 || !extendsOwner(ctx, delivery.owner))
    ) {
      this.deliveries.delete(input.text);
      return { action: "handled" as const };
    }
    // A known token supplied by a user is not an extension delivery.
    this.inputs.push({
      fingerprint: fingerprint(inputContent(input)),
      real: input.source === "interactive" || input.source === "rpc",
      token: delivery && input.source === "extension" ? delivery.token : undefined,
      lane: input.streamingBehavior ?? "direct",
      expires: Date.now() + 300_000,
    });
    this.prune();
    return { action: "continue" as const };
  }

  bind(
    message: NativeUser,
    loop: string | null,
    owner: LoopOwner | undefined,
    ctx: ExtensionContext,
    iteration?: number,
  ) {
    if (message.role !== "user") return;
    this.prune();
    this.native = message;
    if (this.seen.has(message)) {
      if (this.iteration?.native !== message) this.finishIteration();
      return;
    }
    this.seen.add(message);
    if (this.iteration) this.iteration.body = undefined;
    this.iteration = undefined;
    this.runOwned = false;
    // Retirement is a run-level fence; only agent_settled releases it.
    const token = textOf(message);
    const delivery = this.deliveries.get(token);
    const key = fingerprint(message.content);
    const matches = this.inputs.filter((input) => input.fingerprint === key);
    // Steers and follow-ups drain in different orders. Distinct exact content
    // in another delivery lane is not a collision; identical content in ANY
    // lane is ambiguous (including a candidate handled by a later handler).
    const candidate = !this.uncertain && matches.length === 1 ? matches[0] : undefined;
    const position = candidate ? this.inputs.indexOf(candidate) : -1;
    // Native acceptance advances only a known streaming lane's FIFO watermark.
    // Earlier handled/transformed candidates in that lane cannot reappear as
    // fresh authority; the other lane and unordered direct input stay separate.
    this.inputs = this.inputs.filter(
      (input, index) =>
        input.fingerprint !== key &&
        (!candidate || candidate.lane === "direct" || input.lane !== candidate.lane || index > position),
    );
    if (candidate?.real && !this.rejected) {
      // Even an exact known-token literal remains real user input. It can own
      // a fresh user continuation, never reuse the extension delivery nonce.
      if (loop && iteration !== undefined && extendsOwner(ctx, owner)) {
        this.iteration = {
          loop,
          iteration,
          nonce: randomUUID(),
          owner,
          native: message,
          nativeKey: key,
          nativeAfterBranchLength: owner?.branch.length ?? 0,
        };
      }
    } else if (this.knownToken(token)) {
      if (
        !delivery ||
        delivery.loop !== loop ||
        delivery.iteration !== iteration ||
        !extendsOwner(ctx, delivery.owner)
      ) {
        this.rejected = true;
        this.deliveries.delete(token);
      } else if (candidate?.token === token && !this.rejected) {
        // Consume at native acceptance, never at a later context boundary.
        this.deliveries.delete(token);
        this.deliveredNative.add(message);
        this.iteration = {
          loop: delivery.loop,
          iteration: delivery.iteration,
          nonce: token,
          body: delivery.body,
          owner: delivery.owner,
          native: message,
          nativeKey: key,
          nativeAfterBranchLength: delivery.owner?.branch.length ?? 0,
          token,
        };
        delivery.body = "";
      } else {
        // A native copy with ambiguous provenance cannot be replayed later as
        // a fresh nonce. Retire it without granting any iteration authority.
        this.deliveries.delete(token);
        this.rejected = true;
      }
    }
    // User continuations may advance the loop, but their operation still
    // belongs to the user. Only an authenticated extension delivery owns abort.
    if (this.iteration?.token) this.runOwned = true;
  }

  current(ctx: ExtensionContext, loop: string | null, iteration?: number) {
    return this.iteration?.loop === loop &&
      (iteration === undefined || this.iteration.iteration === iteration) &&
      extendsOwner(ctx, this.iteration.owner)
      ? this.iteration
      : undefined;
  }

  context(
    messages: NativeUser[],
    ctx: ExtensionContext,
    loop: string | null,
    owner: LoopOwner | undefined,
    iteration?: number,
  ) {
    const latest = [...messages].reverse().find((message) => message.role === "user");
    // Context may clone native messages. Bind only the observed native identity,
    // not a prose prefix or an unobserved history entry.
    if (
      latest &&
      this.native &&
      fingerprint(latest.content) === fingerprint(this.native.content) &&
      latest.timestamp === this.native.timestamp
    )
      this.bind(this.native, loop, owner, ctx, iteration);
    if (this.iteration && fingerprint(this.iteration.native.content) !== this.iteration.nativeKey) {
      this.finishIteration();
      return undefined;
    }
    if (this.iteration) {
      const bound = this.iteration;
      const native = bound.native;
      const deliveredOnLiveBranch = ctx.sessionManager
        .getBranch()
        .some(
          (entry, index) =>
            index >= bound.nativeAfterBranchLength &&
            entry.type === "message" &&
            entry.message.role === "user" &&
            entry.message.timestamp === native.timestamp &&
            fingerprint(entry.message.content) === bound.nativeKey,
        );
      if (!deliveredOnLiveBranch || !this.current(ctx, loop, iteration)) {
        this.rejected = true;
        return undefined;
      }
      // Pin the committed native path, not just the earlier input-time leaf.
      this.iteration.owner = captureOwner(ctx);
    }
    return this.current(ctx, loop);
  }

  isDelivery(message: NativeUser) {
    return (
      this.deliveredNative.has(message) ||
      Boolean(
        this.native &&
          this.deliveredNative.has(this.native) &&
          message.role === "user" &&
          message.timestamp === this.native.timestamp &&
          fingerprint(message.content) === fingerprint(this.native.content),
      )
    );
  }

  ownsRun(nonce: string) {
    // Iteration authority can be consumed by ralph_done while its native run
    // is still inside later tool handlers. Abort ownership follows that run,
    // not the queued next iteration, and ends at the next native acceptance.
    return Boolean(
      this.runOwned &&
        this.native &&
        this.deliveredNative.has(this.native) &&
        fingerprint(this.native.content) === fingerprint([{ type: "text", text: nonce }]),
    );
  }

  finishIteration() {
    if (this.iteration) this.iteration.body = undefined;
    this.iteration = undefined;
  }

  retire() {
    if (this.runOwned) this.rejected = true;
    this.finishIteration();
    this.deliveries.clear();
    this.seen = new WeakSet();
    this.iteration = undefined;
    this.inputs = [];
    this.uncertain = false;
    this.native = undefined;
  }

  settled() {
    this.finishIteration();
    this.native = undefined;
    this.inputs = [];
    this.uncertain = false;
    this.runOwned = false;
    this.rejected = false;
    this.seen = new WeakSet();
    this.prune();
  }
}

/** Only a standalone unquoted line outside fenced code can complete work. */
export function hasCompletionMarker(text: string): boolean {
  let fence: string | undefined;
  let comment = false;
  for (const line of text.split(/\r?\n/u)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length && match[2].trim() === "") fence = undefined;
      continue;
    }
    if (!fence) {
      if (line.includes("<!--")) comment = true;
      if (!comment && line === "<promise>COMPLETE</promise>") return true;
      if (line.includes("-->")) comment = false;
    }
  }
  return false;
}
