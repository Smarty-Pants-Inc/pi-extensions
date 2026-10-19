import { StringDecoder } from "node:string_decoder";

// Capture prefixes independently: 64 KiB per stream, 128 KiB combined (plus
// constant-size loss notices). Drain all subsequent data without retaining it.
export const CAPTURE_BYTES_PER_STREAM = 64 * 1024;

export class CapturedOutput {
  #bytes = Buffer.alloc(CAPTURE_BYTES_PER_STREAM);
  #size = 0;
  #overflow = false;

  constructor(private readonly stream: "stdout" | "stderr") {}

  append(chunk: Buffer) {
    const admitted = Math.min(chunk.length, CAPTURE_BYTES_PER_STREAM - this.#size);
    chunk.copy(this.#bytes, this.#size, 0, admitted);
    this.#size += admitted;
    this.#overflow ||= admitted < chunk.length;
  }

  get hasOutput() {
    return this.#size > 0;
  }

  get endsWithNewline() {
    return this.#size > 0 && this.#bytes[this.#size - 1] === 10;
  }

  text() {
    // Each stream has its own decoder. Never flush a partial character cut by
    // overflow, but preserve the normal decoder's replacement at genuine EOF.
    const decoder = new StringDecoder("utf8");
    let text = decoder.write(this.#bytes.subarray(0, this.#size));
    if (!this.#overflow) text += decoder.end();
    // Invalid UTF-8 replacement can expand bytes; bound decoded output too.
    const encoded = Buffer.from(text);
    if (encoded.length > CAPTURE_BYTES_PER_STREAM) {
      text = new StringDecoder("utf8").write(encoded.subarray(0, CAPTURE_BYTES_PER_STREAM));
      this.#overflow = true;
    }
    return this.#overflow
      ? `${text}\n[${this.stream} truncated: output beyond the 64 KiB capture limit was discarded.]\n`
      : text;
  }
}
