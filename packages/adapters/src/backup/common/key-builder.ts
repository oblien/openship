/**
 * Destination key paths for backup artifacts.
 *
 * Format — RELATIVE to the destination's own root:
 *   openship/<projectSlug>/<serviceName>/<runId>/<artifactName>
 *
 * ## `pathPrefix` belongs to the destination, not to the key
 *
 * These keys deliberately carry no `pathPrefix`, because every destination already
 * applies its own: `s3.fullKey()` and `sftp.fullPath()` prepend it on every put,
 * get, head and delete, and `local` applies it at its root. `runPrefix` used to
 * prepend it as well, so an S3/R2 or SFTP destination with a prefix stored each
 * artifact one level DEEPER than the key the run recorded — `openship/openship/...`
 * written to `openship/openship/openship/...`.
 *
 * Nothing noticed because it was symmetric: restore, verification and retention all
 * hand the same recorded key back to the same destination, which prepends the
 * prefix again and lands on the object. The operator is the one who paid, and
 * [#611](https://github.com/oblien/openship/issues/611) is what that costs — a run
 * reporting `objectKeyPrefix: "openship/openship/openship/postgres/bkr_…"`, and a
 * bucket listing at that prefix returning nothing at all, not even the
 * `manifest.json` the row points to. A backup you cannot locate is not obviously a
 * backup you have.
 *
 * `list()` was already the tell: it STRIPS the prefix from every key it returns, so
 * the rest of the system was built on "keys are destination-relative" all along.
 * They are now, everywhere.
 *
 * Existing runs keep restoring. Their recorded keys still contain the prefix, and
 * the destination still prepends its own, which resolves to the deeper path where
 * those bytes actually are. Only new runs use the corrected, shallower layout.
 *
 * Why this layout:
 *   - User-readable hierarchy: ops can hand-restore by browsing the bucket.
 *   - RunId in the path makes lexicographic listing chronological if
 *     the ID is sortable (ULID / time-based UUID).
 *   - manifest.json always sits at <runId>/manifest.json as the canonical
 *     pointer to the rest of the run's artifacts.
 *
 * Slugification: projectSlug + serviceName already come from columns that
 * are slug-shaped (lowercase alphanumeric + hyphens). We DO NOT re-slug
 * here — passing through preserves whatever the user picked. Path
 * traversal is defended by the strict regex in the destination validator.
 */

export interface KeyParts {
  projectSlug: string;
  serviceName: string;
  runId: string;
}

/** Reject any segment that contains a traversal token. We deliberately
 *  refuse `..`, leading `/`, embedded null bytes, and Windows drive-style
 *  prefixes — even though projectSlug/serviceName come from columns that
 *  validate at write time, defense-in-depth costs nothing and keeps an
 *  attacker from poking a destination key like `openship/../../../etc/`
 *  through the artifactName argument. */
function assertSafeSegment(segment: string, originalParts: ReadonlyArray<string | null | undefined>): void {
  if (segment.includes("\0")) {
    throw new Error("Key segment contains a null byte");
  }
  // After we strip leading/trailing slashes, any embedded `..` between
  // slashes — or a bare `..` — is a traversal attempt.
  const subSegments = segment.split("/");
  for (const sub of subSegments) {
    if (sub === ".." || sub === ".") {
      throw new Error(`Key segment "${sub}" is not allowed (parts: ${originalParts.join(", ")})`);
    }
  }
}

function joinKey(parts: Array<string | null | undefined>): string {
  const cleaned = parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/^\/+|\/+$/g, ""));

  for (const segment of cleaned) {
    assertSafeSegment(segment, parts);
  }
  return cleaned.join("/");
}

/** Run-scoped directory key (the parent prefix for all artifacts in a run). */
export function runPrefix(parts: KeyParts): string {
  return joinKey(["openship", parts.projectSlug, parts.serviceName, parts.runId]);
}

export function artifactKey(parts: KeyParts, artifactName: string): string {
  return joinKey([runPrefix(parts), artifactName]);
}

export function manifestKey(parts: KeyParts): string {
  return artifactKey(parts, "manifest.json");
}
