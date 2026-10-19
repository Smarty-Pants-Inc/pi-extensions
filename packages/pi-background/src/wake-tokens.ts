import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** Constant-memory recognition of this factory's issued wakes, even after retirement. */
export class WakeTokens {
  readonly #key = randomBytes(32);

  create(): string {
    const nonce = randomUUID();
    return `${nonce}.${this.sign(nonce).toString("hex")}`;
  }

  owns(token: string): boolean {
    const match = /^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.([\da-f]{64})$/u.exec(token);
    if (!match) return false;
    return timingSafeEqual(this.sign(match[1]), Buffer.from(match[2], "hex"));
  }

  private sign(nonce: string): Buffer {
    return createHmac("sha256", this.#key).update(nonce).digest();
  }
}
