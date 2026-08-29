/**
 * Project-scoped Docker volume naming.
 *
 * Docker auto-creates a named volume from the bare source token in a container's
 * `HostConfig.Binds` (e.g. `postgres_data:/var/lib/postgresql/data` → a global
 * volume literally named `postgres_data`). Two projects that both author a common
 * name therefore share ONE daemon-level volume — silent cross-project data
 * corruption. Real `docker compose` avoids this by prefixing volume names with
 * the compose project; openship never did.
 *
 * This module is the single canonical place that maps a raw compose volume spec
 * to the actual Docker volume name, applying an `openship-<slug>-` prefix to
 * NAMED volumes (mirroring the existing `openship-<slug>` network +
 * `openship-<slug>-<service>` container conventions). Bind mounts (host paths)
 * and anonymous volumes are left untouched. It's imported by both the runtime
 * (at container-create) and the backup executor (fallback path) so the scoped
 * name can never drift between deploy, teardown, backup, and restore.
 *
 * Pure string logic, no dependencies — trivially unit-testable.
 */

/** Trailing bind mode suffix (":ro" / ":rw" / SELinux / nocopy). Mirrors the
 *  regex in backup/executors/docker.ts so classification stays identical. */
const MODE_SUFFIX = /:(ro|rw|z|Z|nocopy)$/;

/** The project-scoped Docker volume name for a bare compose volume name. */
export function scopedVolumeName(slug: string, name: string): string {
  return `openship-${slug}-${name}`;
}

/**
 * `scopedVolumeName` for a source that may ALREADY carry this project's prefix.
 *
 * `scopedVolumeName` is deliberately unconditional — the migration importer relies on
 * that to claim a foreign volume whose name happens to look scoped. But a source read
 * back out of our OWN `service.volumes` column may already be stored scoped, and
 * prefixing it twice names a volume that has never existed. Docker then creates it
 * empty on mount, so a backup archives nothing and a restore writes where nothing
 * reads. Same guard `scopeVolumeBinds` applies, exposed for callers that hold a bare
 * source rather than a whole spec.
 */
export function ensureScopedVolumeName(slug: string, source: string): string {
  const prefix = `openship-${slug}-`;
  return source.startsWith(prefix) ? source : scopedVolumeName(slug, source);
}

/**
 * A volume source that is a HOST PATH (bind mount), not a named volume. Named
 * volumes get scoped; bind mounts must pass through untouched. Covers the `~`
 * (home) case that the legacy backup classifier missed.
 */
export function isHostPathSource(source: string): boolean {
  return (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~")
  );
}

/**
 * Rewrite each NAMED volume in a list of raw compose volume specs to its
 * project-scoped name. Bind mounts and anonymous (single-segment) volumes are
 * returned unchanged. When `enabled` is false (grandfathered pre-migration
 * services) the input is returned verbatim so existing data keeps its bare name.
 * Idempotent: an already-scoped source is left alone.
 */
export function scopeVolumeBinds(
  slug: string,
  rawVolumes: string[],
  enabled: boolean,
): string[] {
  if (!enabled) return rawVolumes;
  const prefix = `openship-${slug}-`;
  return rawVolumes.map((spec) => {
    const modeMatch = spec.match(MODE_SUFFIX);
    const mode = modeMatch ? modeMatch[0] : "";
    const body = mode ? spec.slice(0, -mode.length) : spec;

    const parts = body.split(":");
    // Single segment = anonymous volume (bare container path) → leave as-is.
    if (parts.length < 2) return spec;

    const source = parts[0];
    // Bind mount (host path) or already-scoped → leave as-is.
    if (isHostPathSource(source) || source.startsWith(prefix)) return spec;

    parts[0] = scopedVolumeName(slug, source);
    return parts.join(":") + mode;
  });
}
