import { repos } from "@repo/db";
import { normalizeRollbackWindow } from "@repo/core";
import type { RollbackCapacity } from "@repo/contracts";

/** The retention-relevant slice of a project row. Fields are optional so
 *  callers (and test fixtures) can pass a narrow literal; a full `Project`
 *  satisfies it structurally. */
export interface RollbackWindowProject {
  rollbackWindow?: number | null;
  /** Legacy measurement, ignored by retention. Disk space never changes the limit. */
  rollbackWindowComputed?: number | null;
  snapshotSizeBytes?: number | null;
  capacityMeasuredAt?: Date | null;
}

export type RollbackWindowSource = RollbackCapacity["source"];

export interface ResolvedRollbackWindow {
  window: number;
  source: RollbackWindowSource;
  /** Mean built-image bytes, including shared layers, when known. */
  snapshotSizeBytes: number | null;
  measuredAt: Date | null;
}

/**
 * THE rollback window for a project. Every retention decision — prune, the image
 * GC keep set, the wizard's label — resolves through here, so there is exactly
 * one answer to "how many releases stay restorable".
 *
 *   explicit          the operator typed a number (`project.rollbackWindow`).
 *   instance-default  no override → instance_settings.default_rollback_window (5).
 *
 * Deliberately I/O-free apart from the instance-settings read: the disk probe and
 * the snapshot measurement are informational. A previous automatic window must
 * not override the operator's configured limit, even on an upgraded instance.
 */
export async function resolveRollbackWindowDetail(
  project: RollbackWindowProject,
): Promise<ResolvedRollbackWindow> {
  const snapshotSizeBytes = project.snapshotSizeBytes ?? null;
  const measuredAt = project.capacityMeasuredAt ?? null;

  if (project.rollbackWindow !== null && project.rollbackWindow !== undefined) {
    return {
      window: normalizeRollbackWindow(project.rollbackWindow),
      source: "explicit",
      snapshotSizeBytes,
      measuredAt,
    };
  }

  const settings = await repos.instanceSettings.get();
  return {
    window: normalizeRollbackWindow(settings?.defaultRollbackWindow),
    source: "instance-default",
    snapshotSizeBytes,
    measuredAt,
  };
}

export async function resolveRollbackWindow(project: RollbackWindowProject): Promise<number> {
  return (await resolveRollbackWindowDetail(project)).window;
}

/**
 * Re-measure the informational image size. Called from the image
 * reap that already runs after every successful deploy — it has the project's
 * images (and their sizes) in hand there, and the host is already reachable, so
 * no extra host probe is needed.
 *
 * Docker sizes include shared layers, so this is an average image size, not a
 * claim about the disk that deleting a whole release will reclaim.
 */
export async function refreshRollbackCapacity(opts: {
  projectId: string;
  imageSizes: number[];
}): Promise<void> {
  const sizes = opts.imageSizes.filter((n) => Number.isFinite(n) && n > 0);
  if (sizes.length === 0) return;

  const snapshotSizeBytes = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  await repos.project
    .update(
      opts.projectId,
      { snapshotSizeBytes, capacityMeasuredAt: new Date() },
    )
    .catch(() => {
      /* best-effort: retention still resolves via the instance default */
    });
}
