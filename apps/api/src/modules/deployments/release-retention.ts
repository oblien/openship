import { repos } from "@repo/db";
import { computeAutoRollbackWindow, normalizeRollbackWindow } from "@repo/core";

/** The retention-relevant slice of a project row. Fields are optional so
 *  callers (and test fixtures) can pass a narrow literal; a full `Project`
 *  satisfies it structurally. */
export interface RollbackWindowProject {
  rollbackWindow?: number | null;
  rollbackWindowComputed?: number | null;
  snapshotSizeBytes?: number | null;
  capacityMeasuredAt?: Date | null;
}

export type RollbackWindowSource = "explicit" | "auto" | "instance-default";

export interface ResolvedRollbackWindow {
  window: number;
  source: RollbackWindowSource;
  /** Measured bytes for one retained release, when known. */
  snapshotSizeBytes: number | null;
  measuredAt: Date | null;
}

/**
 * THE rollback window for a project. Every retention decision — prune, the image
 * GC keep set, the wizard's label — resolves through here, so there is exactly
 * one answer to "how many releases stay restorable".
 *
 *   explicit          the operator typed a number (`project.rollbackWindow`).
 *   auto              nothing typed → the disk-sized window measured at the last
 *                     deploy (`project.rollbackWindowComputed`).
 *   instance-default  never measured → instance_settings.default_rollback_window.
 *
 * Deliberately I/O-free apart from the instance-settings read: the disk probe and
 * the snapshot measurement happen ONCE per deploy (see refreshRollbackCapacity)
 * and are persisted, so prune and the daily GC sweep never SSH anywhere to
 * decide retention.
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

  if (project.rollbackWindowComputed !== null && project.rollbackWindowComputed !== undefined) {
    return {
      window: normalizeRollbackWindow(project.rollbackWindowComputed),
      source: "auto",
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
 * Re-measure and persist the inputs to the AUTO window. Called from the image
 * reap that already runs after every successful deploy — it has the project's
 * images (and their sizes) in hand there, and the host is already reachable, so
 * this costs one extra `df`.
 *
 * `imageSizes` are this project's built images. The mean is the honest estimate
 * for "one more retained release": Docker's per-image sizes double-count shared
 * layers, so summing them would badly over-estimate, and the largest single
 * image would too.
 *
 * D9: a FAILED disk probe must not persist a window. `computeAutoRollbackWindow`
 * returns the instance default when it can't measure, and writing that into
 * `rollbackWindowComputed` — documented as "null = never measured" — makes
 * `resolveRollbackWindowDetail` report `source: "auto"` forever. The
 * `instance-default` branch then becomes permanently unreachable for that
 * project, so a later change to `instance_settings.default_rollback_window`
 * silently stops applying to it. The measured snapshot size is still worth
 * keeping: it's real, and it's what makes the NEXT successful probe able to size
 * anything at all.
 */
export async function refreshRollbackCapacity(opts: {
  projectId: string;
  imageSizes: number[];
  diskFreeBytes: number | null;
  instanceDefault: number;
}): Promise<void> {
  const sizes = opts.imageSizes.filter((n) => Number.isFinite(n) && n > 0);
  if (sizes.length === 0) return;

  const snapshotSizeBytes = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  const measuredDisk =
    typeof opts.diskFreeBytes === "number" &&
    Number.isFinite(opts.diskFreeBytes) &&
    opts.diskFreeBytes > 0;

  await repos.project
    .update(
      opts.projectId,
      measuredDisk
        ? {
            snapshotSizeBytes,
            rollbackWindowComputed: computeAutoRollbackWindow({
              diskFreeBytes: opts.diskFreeBytes,
              snapshotSizeBytes,
              fallback: opts.instanceDefault,
            }),
            capacityMeasuredAt: new Date(),
          }
        : { snapshotSizeBytes },
    )
    .catch(() => {
      /* best-effort: retention still resolves via the instance default */
    });
}
