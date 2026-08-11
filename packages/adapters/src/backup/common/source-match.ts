import type { BackupSource } from "../types";

/**
 * Resolve a recorded artifact's source id against the sources visible NOW.
 *
 * The ids are not stable across a service's lifetime, because `listSources`
 * derives them from whichever of its two tiers answered: a live container's
 * mounts yield the physical name (`myproj_data`), while the DB fallback yields
 * a positional suffix (`myproj_data-0`). A backup captured while the container
 * was up therefore records an id the DB fallback never produces, and a restore
 * of that artifact into a stopped project failed with "restore target not
 * found" even though the volume was right there under a different label.
 *
 * Matching is deliberately narrow — exact id, then physical source, then the
 * positional suffix stripped — and refuses ambiguity rather than guessing,
 * because the wrong answer here writes an archive into the wrong volume.
 */
export function matchBackupSource(
  sources: BackupSource[],
  targetSourceId: string,
): BackupSource | null {
  const wanted = targetSourceId.trim();
  if (!wanted) return null;

  const exact = sources.find((s) => s.id === wanted);
  if (exact) return exact;

  const byPhysical = sources.filter((s) => s.source === wanted);
  if (byPhysical.length === 1) return byPhysical[0];
  if (byPhysical.length > 1) return null;

  // The DB fallback's `${source}-${index}` shape, matched from the other
  // direction: a recorded `myproj_data-0` against a live `myproj_data`.
  const stripped = wanted.replace(/-\d+$/, "");
  if (stripped !== wanted) {
    const byStripped = sources.filter(
      (s) => s.id === stripped || s.source === stripped,
    );
    if (byStripped.length === 1) return byStripped[0];
  }

  return null;
}
