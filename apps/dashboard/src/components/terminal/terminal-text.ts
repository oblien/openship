import type { Terminal } from "@xterm/xterm";

/** Copy plain log lines, joining visual wraps and omitting the empty viewport tail. */
export function terminalText(terminal: Pick<Terminal, "buffer">): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join("\n").replace(/\n+$/, "");
}
