import { sanitizeDisplayText as encodeDisplayText } from "@signalridge/pi-ui";

/** Display-only encoding. Never apply it to stored workflow values or journals. */
export function sanitizeTerminalText(value: string): string {
  return encodeDisplayText(value);
}

/** Retained public helper: single-line, code-point-bounded display copy. */
export function sanitizeDisplayText(value: string, maximumLength: number): string {
  if (maximumLength < 1) return "";
  const safe = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  return [...safe].slice(0, maximumLength).join("");
}
