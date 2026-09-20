/**
 * Shared plumbing for anything that pipes a payload out of a container: how it is
 * compressed, and how its exit status survives being piped.
 *
 * Lives in `common/` rather than `producers/` because the EXECUTOR needs it too — the
 * volume path's `tar -c | zstd` has exactly the same masking bug as the DB producers'
 * `pg_dump | zstd`, and one copy of this shell is the only way that stays true.
 *
 * ## The masking bug
 *
 * Every DB producer ran `sh -c '<dump> | zstd -c -3'`. A shell pipeline exits with
 * the status of its LAST command, so that line reports zstd's success — not the
 * dump's. `pg_dump` refused by pg_hba, `mysqldump` denied on a table, a dump
 * killed for memory: all of them exit non-zero, zstd happily compresses the
 * truncated (or empty) stream it received, and `sh` returns 0. The producer sees
 * `exit.code === 0`, the orchestrator uploads the artifact and records the run as
 * a successful backup.
 *
 * That is the same silent-false-success class as
 * [#611](https://github.com/oblien/openship/issues/611), and the "0 bytes = failed
 * run" backstop does NOT catch it: zstd of an empty stream is still a valid ~13-byte
 * frame, and gzip of nothing is ~20 bytes. A non-empty artifact containing no data
 * is the worst possible outcome, because it looks exactly like a small database.
 * (The mail backup plan already documented this trap for its own `tar | zstd`; the
 * DB producers never got the same treatment.)
 *
 * `safeDumpCommand` fixes it with the POSIX file-descriptor idiom for recovering a
 * pipeline's earlier status — verified under `dash`, which IS `/bin/sh` on the
 * Debian-based postgres/mysql images, and using only parameter expansion so it
 * needs no `sed`/`awk` inside the user's container.
 *
 * ## The codec dependency
 *
 * `zstd` was hardcoded, and it is not a given. The executor's own volume helper
 * has to `apk add --no-cache zstd` because "zstd isn't in alpine:3", and the DB
 * images are a lottery: it is present on MariaDB (the server packages pull it in
 * for `mariadb-backup`), and absent from a stock `postgres:*-alpine`. A missing
 * compressor was invisible for exactly the reason above — `sh` returned zstd's
 * 127 as... nothing, because the dump's own write to the dead pipe often fits in
 * the pipe buffer and succeeds.
 *
 * So the codec is PROBED in the container instead of assumed, recorded on the
 * artifact, and honored on the way back. `pg_dump` and `mongodump` opt out of this
 * file entirely — their archive formats compress themselves, so they need no pipe
 * and get their exit status directly.
 */

import type { PayloadCompression } from "@repo/core";

import type { BackupExecutor, ServiceHandle } from "../types";

/**
 * A compressor the container was confirmed to have (or its absence).
 *
 * An ALIAS, not a second declaration: the vocabulary is the catalog's
 * (`PAYLOAD_COMPRESSION_CODECS`), because the value arrives from a policy's jsonb and
 * the save-time validator and the shell pipeline have to agree on it exactly. The name
 * stays because it reads correctly at the call sites — here a codec is something the
 * container was PROVEN to have, not merely something a policy asked for.
 */
export type DumpCodec = PayloadCompression;

/** File-extension suffix for an artifact compressed with `codec`. */
export function codecSuffix(codec: DumpCodec): string {
  return codec === "zstd" ? ".zst" : codec === "gzip" ? ".gz" : "";
}

/**
 * Wrap a prelude so its stdout can never reach the artifact.
 *
 * The prelude runs with fd 1 still pointing at the exec's stdout — which IS the
 * payload byte stream — so anything it prints is silently PREPENDED to the dump.
 * Every backstop passes: the dump exits 0, one artifact is recorded, its size is
 * non-zero, so the "0 bytes = failed run" check is satisfied and the run goes green
 * over a file that cannot be decompressed. Demonstrated under dash: a prelude of
 * `echo X` puts `X\n` in front of gzip's `1f 8b` magic.
 *
 * Today's three preludes are safe by accident — pg/mysql are a bare `export`, and
 * every command in redis's seven-line BGSAVE wait is either `$( )`-captured or
 * `>/dev/null`'d — which is precisely the kind of accident that stops being true when
 * someone adds a line. Redirecting here makes it structural, and stray output lands in
 * the stderr the producers already surface instead of in the backup.
 *
 * `{ …; }` and not `( …; )`: a subshell would run the `export` in a child and the
 * password would never reach the dump.
 */
function preludeBlock(prelude: string): string {
  return `{\n${prelude}\n} >&2`;
}

/** The command that compresses stdin → stdout, or null when nothing is applied. */
function compressor(codec: DumpCodec): string | null {
  // -3 on zstd and -6 (gzip's default) are the usual speed/ratio knee; a backup is
  // bound by the destination, not by the compressor.
  if (codec === "zstd") return "zstd -c -3";
  if (codec === "gzip") return "gzip -c";
  return null;
}

/** The matching decompressor for a restore pipeline, or null for uncompressed. */
export function decompressor(codec: DumpCodec): string | null {
  if (codec === "zstd") return "zstd -d -c";
  if (codec === "gzip") return "gzip -d -c";
  return null;
}

/**
 * Read the codec recorded on an artifact at capture time.
 *
 * Unknown or missing values fall back to `zstd`, NOT to `none`: every artifact
 * written before this existed was zstd-compressed and recorded exactly that, and a
 * restore that guessed `none` for one of them would feed a compressed file
 * straight into `pg_restore`.
 */
export function recordedCodec(value: unknown): DumpCodec {
  return value === "gzip" || value === "none" || value === "zstd" ? value : "zstd";
}

/**
 * Ask the container which compressor it actually has, preferring the strongest.
 *
 * Never throws. A probe that cannot run answers `none`, which is the only answer
 * that is always safe to act on: the dump still streams, just uncompressed. Any
 * real problem with exec-ing in this container resurfaces immediately on the dump
 * itself, with the dump's own error message rather than the probe's.
 */
export async function detectDumpCodec(
  service: ServiceHandle,
  executor: BackupExecutor,
): Promise<DumpCodec> {
  try {
    const { stdout, awaitExit } = await executor.execStream(service, [
      "sh",
      "-c",
      "if command -v zstd >/dev/null 2>&1; then echo zstd; " +
        "elif command -v gzip >/dev/null 2>&1; then echo gzip; else echo none; fi",
    ]);
    const chunks: Buffer[] = [];
    stdout.on("data", (c: Buffer) => {
      if (chunks.length < 8) chunks.push(c);
    });
    // MANDATORY, not defensive. The executor destroys this stream with an Error on
    // every abnormal end — an idle timeout, the ceiling, a desynchronized frame — and
    // `'error'` on a stream with no listener is an uncaught exception, i.e. the API
    // process dies. The `catch` below does not help: it only sees the awaitExit
    // rejection, while the destroy emits separately. Swallowing is right HERE
    // specifically because the probe is best-effort by contract: any real problem
    // exec-ing in this container resurfaces one call later on the dump itself, with
    // the dump's own message rather than the probe's.
    stdout.on("error", () => {});
    // Await the exit AND let the (tiny) output drain — awaitExit can settle before
    // the PassThrough has delivered its buffered chunk.
    const exit = await awaitExit;
    await new Promise((resolve) => setImmediate(resolve));
    if (exit.code !== 0) return "none";
    const answer = Buffer.concat(chunks).toString("utf8").trim();
    return answer === "zstd" || answer === "gzip" ? answer : "none";
  } catch {
    return "none";
  }
}

/**
 * `sh -c` argv for `left | right` where BOTH sides' exit status is honored.
 *
 * `fd 4` carries the payload out to the exec's real stdout while `fd 3` is captured
 * by the command substitution, so each side of the pipe reports its status without
 * contaminating the data. Both are checked and both are explained on stderr, which
 * the producers surface verbatim. `right` is checked first: "no such command" lands
 * there, and it is the more confusing failure to read second-hand.
 *
 * `prelude` is emitted before the pipeline for anything that must be in scope on
 * both sides — in practice `export PGPASSWORD=…`, which the shorthand
 * `VAR=x cmd1 | cmd2` would only ever set on cmd1. Its stdout is sent to STDERR; see
 * `preludeBlock`.
 */
/**
 * The pipeline as a SCRIPT FRAGMENT — usable on its own or as one line of a larger
 * script that already has `set -e`, a `trap`, and a staging dir (the mail backup plan).
 *
 * `fd 4` carries the payload out to the real stdout while `fd 3` is captured by the
 * command substitution, so each side reports its status without contaminating the data.
 * Both are checked; the right side first, because "no such command" lands there and is
 * the more confusing failure to read second-hand.
 *
 * Each status is taken from an `if` rather than from `$?` after the command, and that is
 * what makes this safe to drop into a `set -e` script. Measured under `dash`: with
 * errexit on, a failing left-hand command aborts its subshell BEFORE a trailing
 * `echo "d=$?"` can run, so the report goes missing and the real exit code is lost (the
 * check still fails, but reports 1 instead of 4). A command whose status is being tested
 * by `if` is exempt from errexit, so the code survives.
 */
export function safePipelineFragment(
  left: string,
  right: string,
  labels: { left: string; right: string },
): string {
  return [
    // Duplicating stdout is harmless to repeat, so a caller may use more than one of
    // these in a script.
    "exec 4>&1",
    // `{ right; } >&4` and not `right >&4`: a right-hand side containing `&&` (the redis
    // loader is `cat > file && chmod …`) would otherwise attach the redirect to its LAST
    // command only. Grouping covers the whole side whatever the caller passes.
    `res=$( { { if ${left}; then echo "d=0" >&3; else echo "d=$?" >&3; fi; } | ` +
      `{ if { ${right}; } >&4; then echo "c=0" >&3; else echo "c=$?" >&3; fi; } } 3>&1 )`,
    // Both default to FAILURE, so a report that never arrived cannot read as success.
    "d=1; c=1",
    // Unquoted `$res` word-splits on IFS, which includes the newline separating the two
    // reports — no `sed`/`awk` (a minimal image may have neither), and order-independent.
    // The two writes are single sub-PIPE_BUF lines on one pipe, so they cannot interleave.
    'for kv in $res; do case "$kv" in d=*) d=${kv#d=} ;; c=*) c=${kv#c=} ;; esac; done',
    // A status we could not parse is a failure, never an implicit success.
    "case \"$d\" in ''|*[!0-9]*) d=1 ;; esac",
    "case \"$c\" in ''|*[!0-9]*) c=1 ;; esac",
    `[ "$c" = 0 ] || { echo "openship: ${labels.right} failed with status $c" >&2; exit "$c"; }`,
    `[ "$d" = 0 ] || { echo "openship: ${labels.left} failed with status $d" >&2; exit "$d"; }`,
  ].join("\n");
}

/** The fragment wrapped as a standalone `sh -c` argv, with an optional prelude. */
function safePipelineCommand(
  left: string,
  right: string,
  labels: { left: string; right: string },
  prelude?: string,
): string[] {
  const script = [
    ...(prelude ? [preludeBlock(prelude)] : []),
    safePipelineFragment(left, right, labels),
  ].join("\n");
  return ["sh", "-c", script];
}

/**
 * `sh -c` argv for a dump, compressed with `codec`, whose OWN failure is fatal.
 *
 * With `codec: "none"` there is no pipeline at all, so `sh` already reports the
 * dump's status and the bare command is used — the simplest correct thing, and the
 * shape `pg_dump -Fc` and `mongodump --gzip` use because they compress themselves.
 */
export function safeDumpCommand(dump: string, codec: DumpCodec, prelude?: string): string[] {
  const comp = compressor(codec);
  if (!comp) return ["sh", "-c", prelude ? `${preludeBlock(prelude)}\n${dump}` : dump];
  return safePipelineCommand(
    dump,
    comp,
    { left: "the dump command", right: `the compressor '${comp}'` },
    prelude,
  );
}

/**
 * `sh -c` argv for `decompressor | load` on the restore side.
 *
 * The same masking applies in this direction and is worse here: a pipeline reports
 * the LOADER's status, and a loader handed zero bytes because the decompressor was
 * missing can exit 0 (`pg_restore` on empty input does). That is a restore that
 * reports success having written nothing — the failure mode of #611, pointed at the
 * moment someone is relying on the backup.
 */
export function safeRestoreCommand(
  codec: DumpCodec,
  load: string,
  prelude?: string,
): string[] {
  const decomp = decompressor(codec);
  if (!decomp) return ["sh", "-c", prelude ? `${preludeBlock(prelude)}\n${load}` : load];
  return safePipelineCommand(
    decomp,
    load,
    { left: `the decompressor '${decomp}'`, right: "the restore command" },
    prelude,
  );
}
