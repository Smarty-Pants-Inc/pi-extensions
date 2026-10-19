import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Native ancestry, including metadata that does not participate in model context. */
export function captureQuestionOrigin(ctx: ExtensionContext): (current: ExtensionContext | undefined) => boolean {
  const manager = ctx.sessionManager;
  const sessionId = manager.getSessionId();
  const prefix = manager.getBranch().map(entry => createHash("sha256").update(JSON.stringify(entry)).digest("hex"));
  let retired = false;
  return current => {
    if (retired) return false;
    try {
      const branch = manager.getBranch();
      const valid = current !== undefined && current.sessionManager === manager &&
        manager.getSessionId() === sessionId && branch.length >= prefix.length &&
        prefix.every((hash, index) => createHash("sha256").update(JSON.stringify(branch[index])).digest("hex") === hash);
      if (!valid) retired = true;
      return valid;
    } catch {
      retired = true;
      return false;
    }
  };
}
