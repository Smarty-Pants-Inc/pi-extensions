import { StringDecoder } from "node:string_decoder";
import { LIMITS, type LogSnapshot, type Stream } from "./contracts.js";

interface Entry {
  stream: Stream;
  text: string;
  bytes: number;
}

/** A shared byte budget, with independent incremental UTF-8 decoders. */
export class LogBuffer {
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  private entries: (Entry | undefined)[] = [];
  private head = 0;
  private bytes = 0;
  private dropped = 0;

  append(stream: Stream, chunk: Uint8Array): string {
    const text = this.decoders[stream].write(Buffer.from(chunk));
    this.store(stream, text);
    return text;
  }

  end(stream: Stream): string {
    const text = this.decoders[stream].end();
    this.store(stream, text);
    return text;
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  snapshot(tail = 200, stream: Stream | "both" = "both"): LogSnapshot {
    if (!Number.isSafeInteger(tail) || tail < 1 || tail > 1000) {
      throw new Error("tail must be an integer between 1 and 1000");
    }
    if (!["stdout", "stderr", "both"].includes(stream)) {
      throw new Error("Invalid log stream");
    }
    const text = this.entries
      .filter((entry): entry is Entry => entry !== undefined && (stream === "both" || entry.stream === stream))
      .map((entry) => entry.text)
      .join("");
    const lines = text.split("\n");
    const trailing = lines.at(-1) === "";
    return {
      text: lines.slice(-(tail + (trailing ? 1 : 0))).join("\n"),
      droppedBytes: this.dropped,
    };
  }

  private store(stream: Stream, text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text);
    const last = this.entries.at(-1);
    if (last?.stream === stream && last.bytes + bytes <= LIMITS.lineBytes) {
      last.text += text;
      last.bytes += bytes;
    } else {
      this.entries.push({ stream, text, bytes });
    }
    this.bytes += bytes;
    while (this.bytes > LIMITS.logBytes) {
      const first = this.entries[this.head];
      if (!first) throw new Error("Log ring invariant violated");
      const excess = this.bytes - LIMITS.logBytes;
      if (first.bytes <= excess) {
        this.entries[this.head++] = undefined;
        this.bytes -= first.bytes;
        this.dropped += first.bytes;
      } else {
        const buffer = Buffer.from(first.text);
        let cut = excess;
        while (cut < buffer.length && (buffer[cut] & 0xc0) === 0x80) cut++;
        first.text = buffer.subarray(cut).toString("utf8");
        first.bytes -= cut;
        this.bytes -= cut;
        this.dropped += cut;
      }
    }
    // Release consumed entries without quadratic Array.shift behavior.
    if (this.head >= 1024 && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }
}
