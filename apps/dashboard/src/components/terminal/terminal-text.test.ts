import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { terminalText } from "./terminal-text";

function terminal(rows: Array<{ text: string; wrapped?: boolean }>): Pick<Terminal, "buffer"> {
  return {
    buffer: {
      active: {
        length: rows.length,
        getLine: (index: number) => rows[index] && ({
          isWrapped: !!rows[index].wrapped,
          translateToString: (trim: boolean) => trim ? rows[index].text.trimEnd() : rows[index].text,
        }),
      },
    },
  } as unknown as Pick<Terminal, "buffer">;
}

describe("terminal log copying", () => {
  it("joins visual wraps without losing spaces at the wrap boundary", () => {
    expect(terminalText(terminal([
      { text: "Building service " },
      { text: "api   ", wrapped: true },
      { text: "Done   " },
      { text: "      " },
    ]))).toBe("Building service api\nDone");
  });

  it("keeps real blank lines and indentation, without the blank viewport tail", () => {
    expect(terminalText(terminal([
      { text: "  first" },
      { text: "       " },
      { text: "  second" },
      { text: "       " },
      { text: "       " },
    ]))).toBe("  first\n\n  second");
  });

  it("handles empty output and a scrollback buffer starting midway through a wrapped line", () => {
    expect(terminalText(terminal([{ text: "    " }]))).toBe("");
    expect(terminalText(terminal([{ text: "retained tail", wrapped: true }]))).toBe("retained tail");
  });
});
