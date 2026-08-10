import type { LogEntry } from "@repo/adapters";

/**
 * Make captured build output STORABLE before it becomes a jsonb value.
 *
 * `build_session.logs` is jsonb, and Postgres refuses a jsonb value that
 * contains a NUL ("unsupported Unicode escape sequence") or an unpaired
 * surrogate ("invalid input syntax for type json"). Build output is raw
 * process/stream bytes: a docker exec whose connection upgrade fails surfaces
 * the RAW multiplexed stream in its error message — 8-byte frame headers
 * (0x01 0x00 0x00 0x00 …) and all — and that error text is logged verbatim as a
 * build warning. The resulting UPDATE then threw out of onSuccess, the
 * pipeline's outer catch read the throw as a deploy failure, and a working
 * deploy was recorded failed with the SSE stream stuck on "deploying".
 *
 * Sanitizing lives here, at the one place the persisted array is built
 * (`persistLogs` in build-pipeline), so no call site can forget it.
 */

const CODE_TAB = 0x09;
const CODE_LF = 0x0a;
/** ESC survives: the persisted copy is replayed into xterm, so dropping it
 *  would strip the colour the live stream showed. */
const CODE_ESC = 0x1b;
const CODE_DEL = 0x7f;
const REPLACEMENT = "�";

/** Per-line cap. One entry can be an entire docker build chunk. */
export const MAX_ENTRY_CHARS = 32_768;

/** Whole-payload cap. jsonb tops out at 1 GB; this keeps a single row sane. */
export const MAX_TOTAL_CHARS = 4_000_000;

/**
 * Cut to at most `max` UTF-16 code units WITHOUT splitting a surrogate pair.
 * `slice` indexes code UNITS, so a cut that lands between the halves of an
 * astral character leaves a LONE surrogate behind — i.e. truncation MANUFACTURES
 * the exact value jsonb refuses ("invalid input syntax for type json", verified
 * against Postgres). Dropping a trailing high surrogate is right either way: if
 * it was paired its low half is past the cut anyway, and if it was already
 * orphaned it had to go regardless.
 */
export function sliceWithoutSplittingPair(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function capEntryLength(text: string): string {
  if (text.length <= MAX_ENTRY_CHARS) return text;
  const head = sliceWithoutSplittingPair(text, MAX_ENTRY_CHARS);
  const dropped = text.length - head.length;
  return `${head}… [${dropped} more character(s) truncated for storage]`;
}

/**
 * Drop the control bytes and repair unpaired surrogates. Everything else — valid
 * multi-byte UTF-8, surrogate PAIRS — passes through by identity.
 */
function stripAndRepair(text: string): string {
  const parts: string[] = [];
  let cursor = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let replacement: string | null = null;

    if (code < 0x20 || code === CODE_DEL) {
      if (code !== CODE_TAB && code !== CODE_LF && code !== CODE_ESC) replacement = "";
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // valid pair — keep both units
        continue;
      }
      replacement = REPLACEMENT;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      replacement = REPLACEMENT;
    }

    if (replacement === null) continue;
    parts.push(text.slice(cursor, i), replacement);
    cursor = i + 1;
  }

  if (cursor === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join("");
}

/**
 * One log line, made safe for jsonb and bounded in length: C0 controls and DEL
 * are dropped (except TAB, LF, ESC), CR included — `collapseTerminalLogs` has
 * already resolved carriage-return overwrites into final lines by the time we
 * run — and unpaired surrogates become U+FFFD. Valid multi-byte UTF-8 and
 * surrogate PAIRS pass through untouched.
 *
 * ORDER MATTERS: capping runs after the repair pass, so anything the cut itself
 * introduces would never be re-examined. The cut is pair-safe, and the repair is
 * re-run when it actually fired, so the returned string is well-formed no matter
 * what the input was.
 */
export function sanitizeLogText(text: string): string {
  const cleaned = stripAndRepair(text);
  const capped = capEntryLength(cleaned);
  return capped === cleaned ? capped : stripAndRepair(capped);
}

/**
 * Bound, then scrub, raw remote text on its way into a text/jsonb column.
 *
 * The cap comes FIRST because it's the bound the column documents; the per-line
 * pass through `sanitizeLogText` then strips the NUL bytes Postgres refuses
 * outright and repairs the surrogate pair the cap may have split in half.
 * Splitting on newlines is what makes the per-entry cap mean "per line" here
 * rather than "per payload".
 *
 * Lives beside `sanitizeLogText` and is shared by the backup/restore orchestrators
 * and the jobs runner — anywhere verbatim stdout/stderr of a user shell command
 * rides into the SAME write as a run's terminal status, so an unstorable byte
 * there is not a lost message, it's a lost outcome.
 */
export function boundedStorableText(raw: string, maxChars: number): string {
  return raw.slice(0, maxChars).split("\n").map(sanitizeLogText).join("\n");
}

function messageLength(entry: LogEntry): number {
  return entry.message?.length ?? 0;
}

/**
 * Bound the whole payload by dropping the MIDDLE — the head says how the deploy
 * started, the tail carries the failure and the final step events (and feeds the
 * failure notification's log tail), so neither end may be sacrificed. Step
 * entries are structural metadata for the stepper UI and are always kept. The
 * cut is announced in the stored logs; a silently short log reads as "nothing
 * happened".
 */
function boundTotalSize(entries: LogEntry[]): LogEntry[] {
  let total = 0;
  for (const entry of entries) total += messageLength(entry);
  if (total <= MAX_TOTAL_CHARS) return entries;

  const half = Math.floor(MAX_TOTAL_CHARS / 2);
  const keep = new Array<boolean>(entries.length).fill(false);

  let used = 0;
  for (let i = 0; i < entries.length && used < half; i++) {
    keep[i] = true;
    used += messageLength(entries[i]);
  }
  used = 0;
  for (let i = entries.length - 1; i >= 0 && used < half; i--) {
    keep[i] = true;
    used += messageLength(entries[i]);
  }
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].step) keep[i] = true;
  }

  const dropped = keep.reduce((n, kept) => (kept ? n : n + 1), 0);
  if (dropped === 0) return entries;

  const out: LogEntry[] = [];
  let markerWritten = false;
  for (let i = 0; i < entries.length; i++) {
    if (keep[i]) {
      out.push(entries[i]);
      continue;
    }
    if (!markerWritten) {
      markerWritten = true;
      out.push({
        timestamp: entries[i].timestamp,
        message: `⚠ ${dropped} log line(s) omitted from the stored copy (build output exceeded ${MAX_TOTAL_CHARS} characters). The full output was streamed live.`,
        level: "warn",
      });
    }
  }
  return out;
}

/**
 * Deep-sanitize the strings inside a value bound for a text or jsonb column.
 * A NUL is fatal in BOTH: jsonb rejects the \\u0000 escape, and a text column
 * rejects the byte outright ("invalid byte sequence for encoding UTF8: 0x00").
 * `deployment.errorMessage` and `deployment.meta` carry the same raw process
 * output the build log does (a service error, a failed prepare step), and those
 * writes land BEFORE the deployment's outcome is recorded — so a hostile byte
 * there doesn't just lose the message, it fails the deploy.
 */
export function sanitizeStorableStrings<T>(value: T, depth = 0): T {
  if (typeof value === "string") return sanitizeLogText(value) as T;
  if (depth >= 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStorableStrings(item, depth + 1)) as T;
  }
  // Only plain objects — a Date (or any class instance) is left alone.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sanitizeStorableStrings(item, depth + 1);
  }
  return out as T;
}

/**
 * Sanitize + bound an already-collapsed log array for DB persistence.
 * Returns the same entry objects when nothing needed changing.
 */
export function sanitizeLogsForPersistence(entries: LogEntry[]): LogEntry[] {
  const cleaned = entries.map((entry) => {
    const message = entry.message ? sanitizeLogText(entry.message) : entry.message;
    const serviceName = entry.serviceName ? sanitizeLogText(entry.serviceName) : entry.serviceName;
    if (message === entry.message && serviceName === entry.serviceName) return entry;
    return { ...entry, message, serviceName };
  });
  return boundTotalSize(cleaned);
}
