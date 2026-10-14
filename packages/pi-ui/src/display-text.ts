/**
 * Make untrusted text inert for display, before applying trusted theme styling.
 * This is not a reversible encoding and must not replace stored answers/data.
 */
export function sanitizeDisplayText(text: string, options?: { multiline?: boolean }): string {
  // Escape introducers rather than parsing terminal sequences: incomplete and
  // joined sequences remain visible, and no sequence can retain an active ESC.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the untrusted controls this display encoder neutralizes.
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/gu, (char) => {
    if (options?.multiline && (char === "\n" || char === "\t")) return char;
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
