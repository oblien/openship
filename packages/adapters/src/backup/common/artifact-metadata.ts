/**
 * Which artifact-metadata fields are OPERATIONAL RECORDS rather than captured text.
 *
 * A backup run's `artifacts[].metadata` rides into a jsonb column through the same
 * scrubber the build logs use, and that scrubber redacts credentials out of URL
 * userinfo (`redactCredentials`). For a log line that is exactly right. For these
 * fields it is a break: `restoreCommand` is the ONLY record of how to put the
 * artifact back — `CustomCommandProducer.restore` reads it straight off the recorded
 * metadata and runs it — so rewriting `mongodb://root:pw@host` to `mongodb://***@host`
 * produced an artifact that LOOKS restorable (the boot audit only flags an EMPTY
 * command) and dies on authentication at the one moment it is needed.
 *
 * It also protected nothing: the same command is written unredacted into the
 * destination's own manifest.json, which is the copy that leaves the box, and the
 * policy's `payloadConfig` holds it unredacted in the DB already.
 *
 * Lives here rather than in the API module so the writer (the orchestrator), the
 * reader (this package's custom_command producer) and the repair path (the D5
 * backfill) all name the same set.
 */
export const PRESERVED_ARTIFACT_METADATA_KEYS: ReadonlySet<string> = new Set([
  "restoreCommand",
  "produceCommand",
  "command",
]);

/**
 * The one redaction shape that CANNOT occur in a real command.
 *
 * `redactCredentials` rewrites a URL's userinfo to `***@`, so `://***@` is
 * unambiguously scrubber output: a genuine DSN has credentials in that position and a
 * credential-less one has no `@` at all. Matching the bare `***` instead would also
 * catch an operator's own comment banner and condemn a working backup, so the
 * detection is deliberately narrow — the primary fix is that new runs are never
 * redacted here at all; this only recognises the ones already captured.
 */
export const REDACTED_USERINFO_MARKER = "://***@";

/** Was this recorded command mangled by the credential scrubber? */
export function isRedactedCommand(command: string): boolean {
  return command.includes(REDACTED_USERINFO_MARKER);
}
