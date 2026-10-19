/**
 * Convert untrusted content to terminal-safe plain text BEFORE adding UI styles.
 * Tabs and LF are kept; all other C0/C1 controls, DEL and bidi controls are not.
 * This intentionally removes content-supplied SGR colours as well as OSC52.
 * Incomplete control strings consume the rest of the input (fail closed).
 */
export function sanitizeTerminalText(text: string): string {
  return (
    text
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
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Keep only HT and LF from C0; strip C1, DEL and Unicode bidi controls.
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/gu, "")
  );
}
