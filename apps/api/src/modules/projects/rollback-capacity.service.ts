/**
 * What the rollback/retention UI needs to render a truthful label:
 *
 *   "Rollback: keeps 5 snapshots (~1.8 GB of 42 GB free) · auto"
 *
 * All of it comes from values measured at the last deploy plus a cached disk
 * probe, so opening the deploy wizard's target panel or the Git settings tab
 * never triggers a build-time-cost probe. `resolveRollbackWindowDetail` is the
 * same resolver retention prune and the image GC use — the label can't claim a
 * window the pruner wouldn't enforce.
 */

import { repos } from "@repo/db";
import {
  MAX_ROLLBACK_WINDOW,
  ROLLBACK_DISK_BUDGET_FRACTION,
  NotFoundError,
  normalizeRollbackWindow,
} from "@repo/core";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { getHostDisk } from "../../lib/host-disk";
import {
  resolveRollbackWindowDetail,
  type RollbackWindowSource,
} from "../deployments/release-retention";

export interface RollbackCapacity {
  /** Releases kept restorable right now. */
  window: number;
  source: RollbackWindowSource;
  /** Explicit override on the project, or null when the window is automatic. */
  explicit: number | null;
  /** Mean measured size of one retained release, bytes. Null = never measured. */
  snapshotSizeBytes: number | null;
  measuredAt: string | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  /** So the UI's stepper and hint text don't hardcode policy. */
  maxWindow: number;
  diskBudgetFraction: number;
  /** Retention preference: keep artifacts for an instant restore, or rebuild. */
  strategy: string;
}

export async function getRollbackCapacity(
  projectId: string,
  organizationId: string,
): Promise<RollbackCapacity> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  if (!project) throw new NotFoundError("Project", projectId);

  const detail = await resolveRollbackWindowDetail(project);

  // Which host would this project deploy to? The active release records it;
  // a project that has never deployed has no host to measure yet.
  const activeDep = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId).catch(() => null)
    : null;
  const serverId = (activeDep?.meta as { serverId?: string } | null)?.serverId;
  // An unreachable host must degrade the LABEL, not the endpoint: everything
  // else here is persisted, so a failed probe still renders a truthful window
  // with the disk figures blank.
  const disk = activeDep ? await getHostDisk(serverId, organizationId).catch(() => null) : null;

  return {
    window: detail.window,
    source: detail.source,
    explicit:
      project.rollbackWindow === null || project.rollbackWindow === undefined
        ? null
        : normalizeRollbackWindow(project.rollbackWindow),
    snapshotSizeBytes: detail.snapshotSizeBytes,
    measuredAt: detail.measuredAt ? detail.measuredAt.toISOString() : null,
    diskFreeBytes: disk?.freeBytes ?? null,
    diskTotalBytes: disk?.totalBytes ?? null,
    maxWindow: MAX_ROLLBACK_WINDOW,
    diskBudgetFraction: ROLLBACK_DISK_BUDGET_FRACTION,
    strategy: project.defaultRollbackStrategy,
  };
}
