/**
 * Read-only file browsing INSIDE a deployed service.
 *
 * Sibling of modules/service-terminal/: same reach, same gate. Where the
 * terminal opens a PTY, this module runs bounded, non-interactive probes over
 * `runtime.inContainerExecutor()` — which docker and cloud both implement as
 * `sh -c <command>` inside the container. That shared contract is why one
 * command string works on both.
 *
 * Everything here is PURE: build a command, parse its output. No I/O, no db,
 * no runtime — which is what makes the quoting and parsing directly testable,
 * and those are the two places this feature can go wrong.
 *
 * Four invariants the rest of the module leans on:
 *
 *  1. THE COMMAND ALWAYS EXITS 0. `inContainerExecutor.exec` REJECTS on any
 *     non-zero exit, using stdout (or stderr) as the error message. If "file
 *     not found" rode the exit code it would arrive as a thrown Error and
 *     surface as a 500 with a shell string in it. Instead every failure is
 *     printed as a marker on stdout and parsed into a real reason here.
 *
 *  2. EVERY MARKER IS NONCE-SCOPED. Newlines are legal in unix filenames, and
 *     the probe prints names verbatim — so a name containing a newline splits
 *     into extra lines. Without a nonce a file could be NAMED so that its own
 *     listing line forged `ERR denied` (whole directory reads as forbidden) or
 *     `END` (listing silently truncated while still reporting success). The
 *     caller mints an unpredictable per-request nonce; a filename cannot
 *     contain it, so continuation lines are inert and get dropped.
 *
 *  3. EVERY PROBE IS TERMINATED. Both listing AND reading end with an `END`
 *     marker, and neither result is accepted without it. docker's exec resolves
 *     on stream `end` OR `close` and only throws when ExitCode is non-zero —
 *     `null` is falsy — so a stream that closes early does NOT throw. Node's
 *     base64 decoder is lenient about truncated input, so without the
 *     terminator a half-read `.env` would be served looking complete.
 *
 *  4. ONLY STDOUT CARRIES SIGNAL. Docker demuxes stderr onto its own sink;
 *     cloud funnels it into the same collector as stdout. Markers therefore go
 *     to stdout, and the payload is base64 — whose alphabet contains no tab and
 *     no newline — so on either runtime a stray stderr line can neither forge a
 *     marker nor corrupt a payload.
 */

/** Preview cap. Base64 inflates 4/3 and the whole payload is buffered on both
 *  sides — this is a string channel, not a stream. A `.env` is ~1KB; 2MB is
 *  generous for the config-file use case this serves. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Download cap. Same buffered path, so it stays modest on purpose — a real
 *  streaming download would need docker's getArchive, which cloud has no
 *  equivalent for, and forking the two runtimes apart is not worth it. */
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Entries returned per directory. This is a COST BOUND, not a display choice:
 * the probe forks one `wc -c` per regular file to get its size, so the cap is
 * what stops `/usr/lib` or a big `node_modules` from costing thousands of forks
 * of container CPU per page view. It also bounds the JSON payload and the
 * number of rows the client renders. Measured ~660ms for 274 entries.
 */
export const MAX_ENTRIES = 500;

export type EntryType = "file" | "dir";

export interface DirEntry {
  name: string;
  /** RESOLVED type — a symlink reports what it points AT, so a symlinked
   *  directory is navigable. Broken symlinks resolve to "file" and fail on
   *  read, which is the honest outcome. */
  type: EntryType;
  /** True when the entry itself is a symlink, whatever it resolves to. */
  symlink: boolean;
  /** Bytes for regular files; 0 for directories. */
  size: number;
}

export type ListResult =
  | { ok: true; entries: DirEntry[]; truncated: boolean }
  | { ok: false; reason: ListFailure };

export type ListFailure =
  | "not_found"
  | "not_a_directory"
  | "permission_denied"
  | "truncated"
  | "malformed";

export type ReadResult =
  | { ok: true; content: Buffer }
  | { ok: false; reason: ReadFailure; size?: number };

export type ReadFailure =
  | "not_found"
  | "is_a_directory"
  | "not_regular"
  | "permission_denied"
  | "too_large"
  | "no_base64"
  | "incomplete"
  | "malformed";

// ─── Quoting ────────────────────────────────────────────────────────────────

/**
 * POSIX single-quote a value for `sh -c`.
 *
 * SECURITY BOUNDARY. The path is caller-controlled and lands in a shell string.
 * Inside single quotes every character is literal and the only one that can end
 * the quoting is `'` itself — POSIX offers no backslash escape there — so an
 * embedded quote must close, emit an escaped quote, and reopen: `'` → `'\''`.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** An unpredictable marker scope for one probe — see invariant 2. */
export function newProbeNonce(): string {
  // Hex only: it has to survive a shell single-quoted string and a tab-split
  // parser without escaping, and be impossible to guess from outside.
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/**
 * Canonicalise a path for display and for embedding in a probe.
 *
 * NOTE this is NOT a sandbox: browsing is gated at the same admin tier as the
 * service terminal, which already grants the whole container. Normalising is
 * about producing one canonical spelling (so breadcrumbs and caching agree) and
 * refusing inputs the shell and the kernel would disagree about.
 *
 * Returns null for a path containing NUL — the syscall truncates there, so what
 * `[ -r "$f" ]` checks and what `base64` opens could differ.
 */
export function normalizeContainerPath(input?: string | null): string | null {
  const raw = input ?? "";
  if (raw.includes("\0")) return null;

  const out: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Clamp at the root rather than escaping it: "/.." is "/" on every unix.
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`.replace(/\/{2,}/g, "/");
}

/** Resolve an entry name against its directory, canonically. */
export function joinContainerPath(dir: string, name: string): string | null {
  return normalizeContainerPath(`${dir}/${name}`);
}

// ─── Listing ────────────────────────────────────────────────────────────────

/**
 * One directory listing, POSIX-sh only so it runs on busybox (alpine), dash and
 * bash alike — no `find -printf`, no `ls --full-time`, no `stat -c`, none of
 * which exist on all three.
 *
 * The three globs cover normal names, dotfiles, and `..`-prefixed names while
 * excluding `.` and `..` themselves. An unmatched glob stays literal in sh, so
 * every candidate is re-checked with `[ -e ]` before it is emitted.
 *
 * Symlinks report their RESOLVED type (`[ -d ]` dereferences), so a symlinked
 * directory — `storage`, `current`, and friends, which real Laravel and
 * release-dir images are full of — is navigable rather than a dead end.
 */
export function buildListCommand(path: string, nonce: string, maxEntries = MAX_ENTRIES): string {
  const d = shellQuote(path);
  const n = shellQuote(nonce);
  return [
    `d=${d}`,
    `N=${n}`,
    `if [ ! -e "$d" ]; then printf '%s\\tERR\\tnotfound\\n' "$N"; exit 0; fi`,
    `if [ ! -d "$d" ]; then printf '%s\\tERR\\tnotdir\\n' "$N"; exit 0; fi`,
    `cd "$d" 2>/dev/null || { printf '%s\\tERR\\tdenied\\n' "$N"; exit 0; }`,
    `if [ ! -r "$d" ]; then printf '%s\\tERR\\tdenied\\n' "$N"; exit 0; fi`,
    `c=0`,
    `t=0`,
    `for e in * .[!.]* ..?*; do`,
    `  [ -e "$e" ] || [ -L "$e" ] || continue`,
    `  c=$((c+1))`,
    `  if [ "$c" -gt ${Math.floor(maxEntries)} ]; then t=1; break; fi`,
    `  if [ -L "$e" ]; then l=1; else l=0; fi`,
    // `-d` dereferences, so this is the RESOLVED type for symlinks too.
    `  if [ -d "$e" ]; then k=d; else k=f; fi`,
    `  s=0`,
    `  if [ "$k" = f ] && [ -f "$e" ]; then s=$(wc -c < "$e" 2>/dev/null || echo 0); fi`,
    `  printf '%s\\tE\\t%s\\t%s\\t%s\\t%s\\n' "$N" "$k" "$l" "$s" "$e"`,
    `done`,
    `if [ "$t" = 1 ]; then printf '%s\\tTRUNC\\n' "$N"; fi`,
    `printf '%s\\tEND\\n' "$N"`,
    `exit 0`,
  ].join("\n");
}

const LIST_FAILURES: Record<string, ListFailure> = {
  notfound: "not_found",
  notdir: "not_a_directory",
  denied: "permission_denied",
};

export function parseListOutput(stdout: string, nonce: string): ListResult {
  // Only lines the probe itself wrote carry the nonce — see invariant 2. A
  // filename with an embedded newline produces continuation lines that fail
  // this prefix test and are dropped, so it can forge nothing.
  const marked = stdout
    .split("\n")
    .filter((l) => l.startsWith(`${nonce}\t`))
    .map((l) => l.slice(nonce.length + 1));

  for (const line of marked) {
    if (line.startsWith("ERR\t")) {
      return { ok: false, reason: LIST_FAILURES[line.slice(4).trim()] ?? "malformed" };
    }
  }

  // Invariant 3: no terminator means the read was cut short, which must never
  // be presented as "this folder is empty".
  if (!marked.some((l) => l.trim() === "END")) return { ok: false, reason: "truncated" };
  const truncated = marked.some((l) => l.trim() === "TRUNC");

  const entries: DirEntry[] = [];
  for (const line of marked) {
    if (!line.startsWith("E\t")) continue;
    const parts = line.slice(2).split("\t");
    if (parts.length < 4) continue;
    const [kind, link, size, ...nameParts] = parts;
    // Re-join so a name containing a tab survives; only the leading fields are
    // structural.
    const name = nameParts.join("\t");
    if (!name) continue;
    entries.push({
      name,
      type: kind === "d" ? "dir" : "file",
      symlink: link === "1",
      size: Number.parseInt(size ?? "0", 10) || 0,
    });
  }

  // Directories first, then case-insensitive by name — the ordering every file
  // browser uses, and stable regardless of the shell's glob order.
  entries.sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "accent" });
  });

  return { ok: true, entries, truncated };
}

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * Read one file as base64 — binary-safe over a channel that hands us a utf8
 * string.
 *
 * The `-f` test is load-bearing, not defensive noise: without it a FIFO or a
 * character device passes every other guard, and `wc -c < /dev/zero` never
 * returns. Both size caps only fire on a payload that finishes arriving, so an
 * infinite source would bypass them entirely and wedge the request.
 *
 * The in-container size guard is a courtesy that avoids shipping a huge
 * payload; the authoritative cap is enforced on the parsed bytes, because a
 * file can grow between the check and the read.
 */
export function buildReadCommand(path: string, maxBytes: number, nonce: string): string {
  const f = shellQuote(path);
  const n = shellQuote(nonce);
  return [
    `f=${f}`,
    `N=${n}`,
    `if [ ! -e "$f" ]; then printf '%s\\tERR\\tnotfound\\n' "$N"; exit 0; fi`,
    `if [ -d "$f" ]; then printf '%s\\tERR\\tisdir\\n' "$N"; exit 0; fi`,
    // Regular files only — see the note above.
    `if [ ! -f "$f" ]; then printf '%s\\tERR\\tnotregular\\n' "$N"; exit 0; fi`,
    `if [ ! -r "$f" ]; then printf '%s\\tERR\\tdenied\\n' "$N"; exit 0; fi`,
    `s=$(wc -c < "$f" 2>/dev/null || echo -1)`,
    `printf '%s\\tSIZE\\t%s\\n' "$N" "$s"`,
    `if [ "$s" -lt 0 ]; then printf '%s\\tERR\\tdenied\\n' "$N"; exit 0; fi`,
    `if [ "$s" -gt ${Math.floor(maxBytes)} ]; then printf '%s\\tERR\\ttoolarge\\n' "$N"; exit 0; fi`,
    `command -v base64 >/dev/null 2>&1 || { printf '%s\\tERR\\tnobase64\\n' "$N"; exit 0; }`,
    `printf '%s\\tDATA\\n' "$N"`,
    `base64 "$f" 2>/dev/null || { printf '\\n%s\\tERR\\tdenied\\n' "$N"; exit 0; }`,
    `printf '\\n%s\\tEND\\n' "$N"`,
    `exit 0`,
  ].join("\n");
}

const READ_FAILURES: Record<string, ReadFailure> = {
  notfound: "not_found",
  isdir: "is_a_directory",
  notregular: "not_regular",
  denied: "permission_denied",
  toolarge: "too_large",
  nobase64: "no_base64",
};

export function parseReadOutput(stdout: string, maxBytes: number, nonce: string): ReadResult {
  const lines = stdout.split("\n");
  const marker = (line: string) =>
    line.startsWith(`${nonce}\t`) ? line.slice(nonce.length + 1).trim() : null;

  let size: number | undefined;
  let dataIndex = -1;
  let endIndex = -1;
  let failure: ReadFailure | undefined;

  lines.forEach((line, i) => {
    const m = marker(line);
    if (m === null) return;
    if (m.startsWith("SIZE\t")) {
      const parsed = Number.parseInt(m.slice(5).trim(), 10);
      if (Number.isFinite(parsed) && parsed >= 0) size = parsed;
    } else if (m.startsWith("ERR\t")) {
      failure ??= READ_FAILURES[m.slice(4).trim()] ?? "malformed";
    } else if (m === "DATA") {
      dataIndex = i;
    } else if (m === "END") {
      endIndex = i;
    }
  });

  if (failure) return size === undefined ? { ok: false, reason: failure } : { ok: false, reason: failure, size };
  if (dataIndex === -1) return { ok: false, reason: "malformed" };
  // Invariant 3 — a payload with no terminator was cut short. Serving it would
  // hand back a truncated file that looks complete.
  if (endIndex === -1 || endIndex < dataIndex) return { ok: false, reason: "incomplete", size };

  // Both coreutils and busybox wrap base64 output; strip all whitespace rather
  // than assuming a column width. The base64 alphabet has no tab or newline, so
  // nothing between the markers can impersonate one.
  const payload = lines.slice(dataIndex + 1, endIndex).join("").replace(/\s+/g, "");
  const content = Buffer.from(payload, "base64");

  // Authoritative cap. Never return a partial file: a truncated .env that looks
  // complete is worse than a refusal.
  if (content.byteLength > maxBytes) {
    return { ok: false, reason: "too_large", size: size ?? content.byteLength };
  }
  // Node's base64 decoder is lenient, so a payload that lost bytes in transit
  // decodes happily. The container already told us how big the file was —
  // disagreement means we did not receive all of it.
  if (size !== undefined && content.byteLength !== size) {
    return { ok: false, reason: "incomplete", size };
  }

  return { ok: true, content };
}

// ─── Content sniffing ───────────────────────────────────────────────────────

/**
 * Is this payload binary? Used only to decide between rendering text and
 * offering a download — never to gate access.
 *
 * A NUL byte is decisive. Beyond that, a high density of C0 control characters
 * (excluding tab/newline/CR, which are ordinary in text) means it isn't
 * something a text pane should render. Multi-byte UTF-8 is all >= 0x80 and is
 * deliberately NOT counted, so translated content reads as text.
 */
export function looksBinary(buf: Buffer): boolean {
  if (buf.byteLength === 0) return false;

  const sample = buf.subarray(0, 8192);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const isOrdinaryWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (!isOrdinaryWhitespace && byte < 0x20) control++;
  }
  return control / sample.byteLength > 0.1;
}
