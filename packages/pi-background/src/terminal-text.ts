/** Plain text only. Drop terminal strings including incomplete/fragmented ones. */
export class TerminalText {
  private state: "text" | "escape" | "csi" | "designator" | "string" = "text";
  private osc = false;
  private stringEscape = false;

  feed(text: string): string {
    const output: string[] = [];
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (this.state === "string") {
        if (code === 0x9c || (this.stringEscape && char === "\\") || (this.osc && code === 7)) {
          this.state = "text";
          this.stringEscape = false;
        } else {
          this.stringEscape = code === 0x1b;
        }
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        else if (code === 0x1b) this.state = "escape";
        continue;
      }
      if (this.state === "designator") {
        if (code >= 0x30 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (this.state === "escape") {
        this.state = "text";
        if (char === "[") this.state = "csi";
        else if (["]", "P", "_", "^", "X"].includes(char)) {
          this.state = "string";
          this.osc = char === "]" || char === "_";
          this.stringEscape = false;
        } else if (code >= 0x20 && code <= 0x2f) this.state = "designator";
        continue;
      }
      if (code === 0x1b) this.state = "escape";
      else if (code === 0x9b) this.state = "csi";
      else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        this.state = "string";
        this.osc = code === 0x9d || code === 0x9f;
        this.stringEscape = false;
      } else if (code === 9 || code === 10 || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) {
        output.push(char);
      }
    }
    return output.join("");
  }
}

export function terminalText(text: string): string {
  return new TerminalText().feed(text);
}
