import type { LogEntry } from "@repo/adapters";

/**
 * Collapse raw log entries into their final terminal-rendered state.
 *
 * During live streaming, xterm handles \r (carriage return) to overwrite lines
 * in-place (e.g., git progress "Counting objects:  42%\r...100%").
 * When persisting to DB we don't want all intermediate lines - just the final
 * rendered result, as a terminal would show.
 *
 * Step events (entries with `step` field) pass through unchanged - they're
 * structured metadata for the stepper UI, not terminal output.
 */
export function collapseTerminalLogs(entries: LogEntry[]): LogEntry[] {
  const result: LogEntry[] = [];
  // Virtual line buffer - simulates one terminal line
  let currentLine = "";
  let currentLevel: LogEntry["level"] = "info";
  let currentTimestamp = "";
  let currentServiceName: string | undefined;
  let currentServiceId: string | undefined;

  const flushLine = () => {
    const trimmed = currentLine.trimEnd();
    if (trimmed) {
      result.push({
        timestamp: currentTimestamp,
        message: trimmed,
        level: currentLevel,
        serviceName: currentServiceName,
        // Keep serviceId so the persisted snapshot still routes each line to its
        // per-service tab on a finished/refreshed deploy (stable id, not name).
        serviceId: currentServiceId,
        // No seq: the persisted (finished) path never re-opens the SSE stream, so
        // there is no resume/dedup cursor to satisfy, and build-status falls back
        // to the array index. Copying entry.seq here would duplicate it across
        // lines a single multi-newline entry collapses into.
      });
    }
    currentLine = "";
  };

  for (const entry of entries) {
    // Step events pass through as-is
    if (entry.step) {
      flushLine();
      result.push(entry);
      continue;
    }

    const text = entry.message;
    currentLevel = entry.level;
    currentTimestamp = entry.timestamp;
    currentServiceName = entry.serviceName;
    currentServiceId = entry.serviceId;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\r") {
        // Check for \r\n (treat as plain newline)
        if (i + 1 < text.length && text[i + 1] === "\n") {
          flushLine();
          i++; // skip the \n
        } else {
          // Bare \r - overwrite: reset current line (don't flush)
          currentLine = "";
        }
      } else if (ch === "\n") {
        flushLine();
      } else {
        currentLine += ch;
      }
    }

    // Each LogEntry is a DISCRETE line from its source — docker build steps and
    // streamExec output arrive WITHOUT a trailing newline, and the live stream
    // renders each as `message + "\n"`. Flush at the entry boundary so the
    // persisted view matches the live one; otherwise consecutive newline-less
    // entries (an entire per-service docker build) concatenate into one
    // unreadable line. A bare \r within an entry has already reset currentLine
    // above, so progress bars still collapse to their final value.
    flushLine();
  }

  return result;
}
