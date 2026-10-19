import { LIMITS, type Stream, type WatchOptions } from "./contracts.js";
import { TerminalText, terminalText } from "./terminal-text.js";

export function safeEventText(text: string): string {
  const safe = terminalText(text);
  const buffer = Buffer.from(safe);
  let end = Math.min(buffer.length, LIMITS.notificationBytes);
  while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

export function validateWatch(options: WatchOptions): WatchOptions {
  if (!Array.isArray(options.patterns) || options.patterns.length < 1 || options.patterns.length > LIMITS.patterns) {
    throw new Error(`watch patterns must contain 1 to ${LIMITS.patterns} literals`);
  }
  const patterns = options.patterns.map((pattern) => {
    if (typeof pattern !== "string" || !pattern.length || pattern.length > LIMITS.patternChars) {
      throw new Error(`watch patterns must be nonempty and at most ${LIMITS.patternChars} characters`);
    }
    return pattern;
  });
  if (options.stream !== undefined && !["both", "stdout", "stderr"].includes(options.stream)) {
    throw new Error("Invalid watch stream");
  }
  if (options.repeat !== undefined && typeof options.repeat !== "boolean") {
    throw new Error("watch repeat must be boolean");
  }
  const cooldownMs = options.cooldownMs ?? LIMITS.cooldownMs;
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1000 || cooldownMs > 3_600_000) {
    throw new Error("watch cooldownMs must be an integer between 1000 and 3600000");
  }
  if (options.attention !== undefined && options.attention !== "turn" && options.attention !== "context") {
    throw new Error("Invalid watch attention");
  }
  return { ...options, patterns: [...new Set(patterns)], cooldownMs };
}

/** Literal per-line matching; overlong lines keep only their bounded prefix. */
export class Matcher {
  readonly options: WatchOptions;
  private readonly lines = { stdout: "", stderr: "" };
  private readonly displayLines = { stdout: "", stderr: "" };
  private readonly terminal = { stdout: new TerminalText(), stderr: new TerminalText() };
  private readonly overflow = { stdout: false, stderr: false };
  private readonly lastMatch = new Map<string, number>();
  private readonly observed = { stdout: new Map<string, number>(), stderr: new Map<string, number>() };

  constructor(
    options: WatchOptions,
    private readonly onMatch: (pattern: string, line: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.options = validateWatch(options);
  }

  feed(stream: Stream, text: string): void {
    if (this.options.stream && this.options.stream !== "both" && this.options.stream !== stream) return;
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline === -1 ? text.length : newline;
      // Keep terminal-string state across IO fragments AND raw line boundaries.
      // Matching still sees literal decoded bytes; only its excerpt is sanitized.
      const display = this.terminal[stream].feed(text.slice(offset, end));
      if (!this.overflow[stream]) {
        this.displayLines[stream] = safeEventText(this.displayLines[stream] + display);
        const part = this.lines[stream] + text.slice(offset, end);
        const buffer = Buffer.from(part);
        let cut = Math.min(buffer.length, LIMITS.lineBytes);
        while (cut < buffer.length && (buffer[cut] & 0xc0) === 0x80) cut--;
        this.lines[stream] = buffer.subarray(0, cut).toString("utf8");
        this.overflow[stream] = buffer.length > LIMITS.lineBytes;
        this.match(stream, this.lines[stream]);
      }
      if (newline === -1) break;
      this.terminal[stream].feed("\n");
      this.lines[stream] = "";
      this.displayLines[stream] = "";
      this.overflow[stream] = false;
      this.observed[stream].clear();
      offset = newline + 1;
    }
  }

  private match(stream: Stream, line: string): void {
    const now = this.now();
    for (const pattern of this.options.patterns) {
      // Consume even cooldown-suppressed occurrences. Appending unrelated text
      // must never replay an old literal after its cooldown expires.
      const position = line.lastIndexOf(pattern);
      if (position < 0 || position <= (this.observed[stream].get(pattern) ?? -1)) continue;
      this.observed[stream].set(pattern, position);
      const last = this.lastMatch.get(pattern);
      if (last !== undefined && (!this.options.repeat || now - last < (this.options.cooldownMs ?? LIMITS.cooldownMs)))
        continue;
      this.lastMatch.set(pattern, now);
      this.onMatch(pattern, this.displayLines[stream]);
    }
  }
}
