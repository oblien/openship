import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { parseSessionLog, parseSessionLogLine } from "./session-log-line";

/**
 * The session log is STORED as `[<ISO>] <message>` and was RENDERED that way too — so every line
 * led with 26 monospace characters of `2026-08-16T21:54:22.358Z`, in a narrow column, wrapping
 * mid-word with the message. The storage format is correct and unchanged; only the render splits.
 */
describe("parseSessionLogLine", () => {
  it("splits a stamped line into a wall-clock time and the message", () => {
    const line = parseSessionLogLine("[2026-08-16T21:54:22.358Z] direct link established (push)");
    expect(line.message).toBe("direct link established (push)");
    // Local time, 24h, no date and no milliseconds — a run lasts minutes, so the date is never
    // the question and the ms are never the answer.
    expect(line.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(line.iso).toBe("2026-08-16T21:54:22.358Z");
  });

  it("keeps an unstamped line whole rather than eating its first word", () => {
    // Older rows, and anything written by a path that didn't go through `appendLog`.
    const line = parseSessionLogLine("plain message with no prefix");
    expect(line.message).toBe("plain message with no prefix");
    expect(line.time).toBeNull();
  });

  it("keeps a line whole when the prefix LOOKS like a stamp but isn't a date", () => {
    const line = parseSessionLogLine("[2026-99-99T99:99:99Z] impossible");
    expect(line.message).toBe("[2026-99-99T99:99:99Z] impossible");
    expect(line.time).toBeNull();
  });

  it("does not mistake a bracketed message for a timestamp", () => {
    const line = parseSessionLogLine("[migration] something happened");
    expect(line.message).toBe("[migration] something happened");
    expect(line.time).toBeNull();
  });

  it("survives a message that itself contains brackets and newlines", () => {
    const line = parseSessionLogLine("[2026-08-16T21:54:22.358Z] FAILED — volume(s): [a, b]");
    expect(line.message).toBe("FAILED — volume(s): [a, b]");
  });

  it("keeps an empty message empty instead of returning the raw line", () => {
    expect(parseSessionLogLine("[2026-08-16T21:54:22.358Z] ").message).toBe("");
  });
});

describe("parseSessionLog", () => {
  it("drops only the trailing blank a final newline leaves", () => {
    const lines = parseSessionLog("[2026-08-16T21:54:22.358Z] one\n[2026-08-16T21:54:23.000Z] two\n");
    expect(lines.map((l) => l.message)).toEqual(["one", "two"]);
  });

  it("keeps a blank line that is genuinely in the middle", () => {
    const lines = parseSessionLog("a\n\nb");
    expect(lines.map((l) => l.message)).toEqual(["a", "", "b"]);
  });
});

/**
 * The render side: which view shows the time, and that the raw stamp never reaches the DOM.
 */
describe("the log panel", () => {
  const wizard = readFileSync(new URL("./ServerMigrationWizard.tsx", import.meta.url), "utf8");
  // Bounded by the extracted COMPONENT, which is where the markup lives now. Anchoring on
  // `{run?.logs && (` broke when the run view grew an outer card with the same guard — the first
  // match became a wrapper containing none of the log markup. Two earlier attempts at this slice
  // failed the same way (a guessed character budget, then a duplicated anchor); the component's
  // own boundaries are the only stable bound.
  const panel = (() => {
    const from = wizard.indexOf("export function MigrationSessionLog(");
    // A line that is EXACTLY `}` — the function's own close. `"\n}"` alone matched the
    // destructured-props brace four lines into the signature and returned a 54-character slice.
    return wizard.slice(from, wizard.indexOf("\n}\n", from));
  })();
  const normalizedPanel = panel.replace(/\s+/g, " ");

  it("renders through the parser, never the stored line", () => {
    expect(panel).toContain("parseSessionLog(run.logs)");
    expect(panel).not.toContain("run.logs.split");
  });

  it("shows the time only for a finished or parked partial run", () => {
    expect(panel).toContain("{logShowsTime && (");
    // `partial` is resumable, but no work runs while it waits for the operator to resolve its
    // pending paths. Collapse formatting whitespace so Prettier line wrapping cannot change the
    // meaning of this source-level render assertion.
    expect(normalizedPanel).toContain(
      'const logShowsTime = status === "succeeded" || status === "failed" || status === "rolled_back" || status === "partial";',
    );
  });

  it("gives the time its own non-shrinking column, so it can't wrap into the message", () => {
    expect(panel).toContain("shrink-0 tabular-nums");
  });

  it("keeps the full instant reachable as a tooltip", () => {
    expect(panel).toContain("title={line.iso ?? undefined}");
  });

  it("wraps on words, not mid-character", () => {
    // `break-all` split volume names and messages at arbitrary characters, which is half of why
    // the panel was hard to read.
    //
    // Searches className VALUES only. Matching the raw slice made this fail on the comment that
    // explains the class's absence — the same trap the Project Info card's test documents.
    const classNames = (panel.match(/className="[^"]*"/g) ?? []).join(" ");
    expect(classNames).toContain("break-words");
    expect(classNames).not.toContain("break-all");
  });
});
