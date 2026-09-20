/**
 * One line of a migration's session log, split into its timestamp and its message.
 *
 * The orchestrator stores every line as `[<ISO>] <message>` and that is the right thing to
 * STORE — unambiguous, sortable, machine-readable, timezone-free. It is the wrong thing to
 * SHOW: 26 characters of `2026-08-16T21:54:22.358Z` in a narrow monospace column, on every
 * line, in front of the words you are actually reading, and repeated for lines written in the
 * same second. So the split happens at render time and the storage format is untouched.
 *
 * What each view wants differs:
 *   - LIVE, while the run is going: the message. You are watching it happen, so "when" is now;
 *     the clock is noise competing with the only column that carries information.
 *   - HISTORY, after it is terminal: the time, because "what happened and how long did each
 *     step take" is the entire reason to open a finished run — but as a local wall-clock
 *     `HH:MM:SS`, not a UTC instant with a date and milliseconds. A run lasts minutes; the date
 *     is never the question.
 */
export type SessionLogLine = {
  /** Wall-clock `HH:MM:SS` in the viewer's timezone, or null when the line carries no stamp. */
  time: string | null;
  /** The line without its timestamp prefix. Never empty when the input wasn't. */
  message: string;
  /** The full ISO instant, for a tooltip — the precision stays reachable, just not in the way. */
  iso: string | null;
};

// `[` ISO-8601 `]` + one space. Anchored, and tolerant of a line that has no prefix (older
// rows, or anything written by a path that didn't go through `appendLog`).
const STAMPED = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]\s?(.*)$/s;

export function parseSessionLogLine(line: string): SessionLogLine {
  const m = STAMPED.exec(line);
  if (!m) return { time: null, message: line, iso: null };
  const [, iso, message] = m;
  const at = new Date(iso!);
  if (Number.isNaN(at.getTime())) {
    // Shaped like a stamp but not a real date. Keep the line whole rather than silently
    // dropping characters the operator might need.
    return { time: null, message: line, iso: null };
  }
  return {
    time: at.toLocaleTimeString([], { hour12: false }),
    message: message ?? "",
    iso: iso!,
  };
}

/** Split a stored log blob into lines, dropping the trailing empty one a newline leaves. */
export function parseSessionLog(logs: string): SessionLogLine[] {
  return logs
    .split("\n")
    .filter((l, i, all) => l.length > 0 || i < all.length - 1)
    .map(parseSessionLogLine);
}
