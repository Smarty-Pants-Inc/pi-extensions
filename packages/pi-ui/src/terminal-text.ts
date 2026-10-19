const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/** Only emoji modifiers and variation selectors may separate an emoji base from ZWJ. */
function joinsEmoji(text: string, offset: number): boolean {
  const next = text.codePointAt(offset + 1);
  if (next === undefined || !EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(next))) return false;
  let end = offset;
  while (end > 0) {
    const last = text.charCodeAt(end - 1);
    const start = end - (last >= 0xdc00 && last <= 0xdfff && end > 1 ? 2 : 1);
    const code = text.codePointAt(start) ?? 0;
    if (
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0xe0100 && code <= 0xe01ef) ||
      (code >= 0x1f3fb && code <= 0x1f3ff)
    ) {
      end = start;
      continue;
    }
    return EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(code));
  }
  return false;
}

/** Each joiner inspects only its adjacent modifier/selector run, never an earlier joiner. */
function sanitizeJoiners(text: string): string {
  const chunks: string[] = [];
  let copiedUntil = 0;
  for (let offset = text.indexOf("\u200d"); offset !== -1; offset = text.indexOf("\u200d", offset + 1)) {
    if (joinsEmoji(text, offset)) continue;
    if (offset > copiedUntil) chunks.push(text.slice(copiedUntil, offset));
    copiedUntil = offset + 1;
  }
  if (copiedUntil === 0) return text;
  chunks.push(text.slice(copiedUntil));
  return chunks.join("");
}

/**
 * Convert untrusted content to terminal-safe plain text BEFORE layout or UI styles.
 * Tabs expand to three spaces, matching pi-tui's fixed-width measurement; LF is kept.
 * Strip format controls except emoji-joining ZWJ; preserve variation selectors.
 * Replace unpaired UTF-16 surrogates with U+FFFD and Unicode line separators with LF.
 * This intentionally removes content-supplied SGR colours as well as OSC52.
 * Incomplete control strings consume the rest of the input (fail closed).
 */
export function sanitizeTerminalText(text: string): string {
  const plain = text
    // OSC ends at BEL or ST. DCS, SOS, PM and APC end at ST. Accept 7/8-bit forms.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal control strings are the untrusted input being removed.
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/gu, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal control strings are the untrusted input being removed.
    .replace(/(?:\x1b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c|$)/gu, "")
    // CSI: parameter bytes, intermediate bytes, then a final byte (or truncated at EOF).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences must not reach the terminal.
    .replace(/(?:\x1b\[|\u009b)[\x30-\x3f]*[\x20-\x2f]*(?:[\x40-\x7e]|$)/gu, "")
    // Remaining ESC sequences, including charset selection, single controls and bare ESC.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences must not reach the terminal.
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]?/gu, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal controls, retaining HT for expansion and LF.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
  // Check context before deleting other format controls: they must not bridge
  // unrelated code points into an apparently valid emoji join.
  // Fixed-string replacements avoid allocating a callback match record for each
  // character in control-dense input. Unicode mode matches only UNPAIRED Cs.
  return sanitizeJoiners(plain)
    .replace(/(?!\u200d)\p{Cf}/gu, "")
    .replace(/\p{Cs}/gu, "\ufffd")
    .replace(/\t/g, "   ")
    .replace(/[\u2028\u2029]/gu, "\n");
}
