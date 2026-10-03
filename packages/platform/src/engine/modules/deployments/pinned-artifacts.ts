/**
 * Pinned artifacts — "deploy THIS exact image; don't build it, don't pull it."
 *
 * Two producers, one mechanism:
 *
 *   - Migration cutover seeds `handoverImages` so an adopted service deploys
 *     from the image its transferred container was already running.
 *   - Rollback seeds the same fields from a past deployment's retained images,
 *     which is what makes an instant restore go through the NORMAL deploy step
 *     instead of a bespoke container-recreation path.
 *
 * Consumers ask this module rather than reading the snapshot fields directly, so
 * the compose path (`compose/build.service.ts`), the single-app path
 * (`build-pipeline.ts`) and the commit resolver (`build.service.ts`) can't drift
 * on what counts as pinned.
 *
 * Rollback/migration pins are hints: if retention reclaimed one, consumers may
 * build normally. A refresh marker is a promise not to rebuild; its consumer
 * fails closed when the active artifact is unavailable.
 */

import { classNeedsGitSource, hasRelativeVolumeMounts } from "@repo/core";
import { snapshotToClass, type SnapshotClassInput } from "./deployment-class";

/** Structural view of the fields this module reads. `DeploymentConfigSnapshot`
 *  satisfies it — kept structural so there's no import cycle with build.service.
 *  The source-axis fields (repoUrl/framework/localPath/…) feed `snapshotToClass`
 *  so the git-clone gate keys off SOURCE, not the build flag — see #538-A. */
export interface PinnedArtifactSnapshot extends SnapshotClassInput {
  /** service NAME → image ref (compose / monorepo fan-out). */
  handoverImages?: Record<string, string>;
  /** Single-app equivalent: the whole release is this one image. */
  handoverAppImage?: string;
  /**
   * Env-only single-app refresh: reuse the ACTIVE deployment's retained
   * artifact. Docker pairs this with handoverAppImage; Bare resolves the
   * deployment's release directory itself. Unlike rollback pins, absence is a
   * hard refresh failure — refresh must never silently become a source build.
   */
  refreshAppDeploymentId?: string;
  /**
   * STATIC releases have no image: their artifact is a release DIRECTORY on the
   * host that the edge serves (see BareRuntime.deployStatic). Pinning it lets a
   * restore promote those exact files again — no rebuild, no clone — which is the
   * static equivalent of reusing a retained image.
   */
  handoverStaticDir?: string;
  /** One-deployment execution intent. These fields must not leak into a later
   * manual redeploy or rollback merely because its source snapshot is reused. */
  targetServiceIds?: string[];
  strictServiceScope?: boolean;
  refreshServiceIds?: string[];
  forcePullImages?: boolean;
  capacityAdjustment?: { key: string; requestHash: string };
  composeServices?: Array<{
    name: string;
    enabled?: boolean;
    kind?: string | null;
    build?: unknown;
    dockerfile?: unknown;
    image?: string | null;
    volumes?: string[] | null;
    advanced?: { build?: unknown } | null;
  }>;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The pinned image for one compose/monorepo service, if any. */
export function pinnedImageForService(
  snapshot: PinnedArtifactSnapshot | null | undefined,
  serviceName: string | null | undefined,
): string | undefined {
  if (!snapshot?.handoverImages || !serviceName) return undefined;
  return nonEmpty(snapshot.handoverImages[serviceName]);
}

/** The pinned image for a single-app deploy, if any. */
export function pinnedAppImage(
  snapshot: PinnedArtifactSnapshot | null | undefined,
): string | undefined {
  return nonEmpty(snapshot?.handoverAppImage);
}

export function refreshAppDeploymentId(
  snapshot: PinnedArtifactSnapshot | null | undefined,
): string | undefined {
  return nonEmpty(snapshot?.refreshAppDeploymentId);
}

/** The pinned release DIRECTORY for a static deploy, if any. Absolute by
 *  construction — a relative value is not a host path and is ignored. */
export function pinnedStaticDir(
  snapshot: PinnedArtifactSnapshot | null | undefined,
): string | undefined {
  const dir = nonEmpty(snapshot?.handoverStaticDir);
  return dir?.startsWith("/") ? dir : undefined;
}

/** Does this snapshot pin anything at all? */
export function hasPinnedArtifacts(snapshot: PinnedArtifactSnapshot | null | undefined): boolean {
  if (pinnedAppImage(snapshot) || pinnedStaticDir(snapshot) || refreshAppDeploymentId(snapshot)) {
    return true;
  }
  return Object.values(snapshot?.handoverImages ?? {}).some((ref) => !!nonEmpty(ref));
}

/** Only strict refreshes promise not to fall back to building. Ordinary
 * rollback/migration pins may be reclaimed, so they still reserve build capacity. */
export function strictRefreshImages(snapshot: PinnedArtifactSnapshot): Readonly<Record<string, string>> | undefined {
  return snapshot.strictServiceScope && snapshot.targetServiceIds?.length &&
    snapshot.targetServiceIds.every(id => snapshot.refreshServiceIds?.includes(id))
    ? snapshot.handoverImages : undefined;
}

/** Strip every one-shot artifact and execution hint before a new native deploy. */
export function withoutPinnedArtifacts<T extends PinnedArtifactSnapshot>(snapshot: T): T {
  const {
    handoverImages: _images,
    handoverAppImage: _app,
    handoverStaticDir: _static,
    refreshAppDeploymentId: _refreshApp,
    targetServiceIds: _targets,
    strictServiceScope: _strictScope,
    refreshServiceIds: _refreshServices,
    forcePullImages: _forcePull,
    capacityAdjustment: _capacityAdjustment,
    ...rest
  } = snapshot;
  return rest as T;
}

/**
 * Does this deploy need the project's repository or uploaded source?
 * A retained image skips its source build; a relative bind still needs its
 * configuration files. Inline catalog contexts supply their own files.
 * The Git-specific wrapper below also excludes uploaded and local sources.
 */
export function snapshotNeedsProjectSource(
  snapshot: PinnedArtifactSnapshot,
  /** Service rows to judge instead of the snapshot's own frozen list — preflight
   *  validates the CURRENT rows, which may have drifted from the snapshot. */
  services?: PinnedArtifactSnapshot["composeServices"],
): boolean {
  // A pinned static release is just files we already have.
  if (pinnedStaticDir(snapshot)) return false;
  const enabled = (services ?? snapshot.composeServices ?? []).filter((s) => s.enabled !== false);
  if (enabled.length > 0) {
    const inlineSource = enabled.some(s => s.advanced?.build);
    return enabled.some(
      (s) =>
        (!inlineSource && hasRelativeVolumeMounts(s.volumes)) ||
        (!s.advanced?.build && ((s.kind === "monorepo" && !s.image) || !!s.build || !!s.dockerfile) &&
          !pinnedImageForService(snapshot, s.name)),
    );
  }
  // A Dockerfile app still needs its source even with hasBuild=false (no
  // buildpack commands). Uploads/local folders need staging instead of a clone.
  return (
    (classNeedsGitSource(snapshotToClass(snapshot)) || !!snapshot.localPath) &&
    !pinnedAppImage(snapshot) &&
    !refreshAppDeploymentId(snapshot)
  );
}

/** Source from an upload/local folder still needs staging, but no Git credential. */
export function snapshotNeedsGitSource(
  snapshot: PinnedArtifactSnapshot,
  services?: PinnedArtifactSnapshot["composeServices"],
): boolean {
  if (snapshot.localPath) return false;
  return snapshotNeedsProjectSource(snapshot, services);
}

/**
 * Is this deploy fully covered by pinned artifacts — nothing to build at all?
 *
 * Such a deploy must NOT be judged by today's BUILD-config rules: it runs an
 * artifact that was already validated and already built. Requiring an install or
 * start command from it is not just noise, it's a trap — add a required field to
 * the config schema later and every release created before it becomes
 * un-restorable, exactly when someone needs to roll back.
 */
export function isFullyPinned(
  snapshot: PinnedArtifactSnapshot,
  services?: PinnedArtifactSnapshot["composeServices"],
): boolean {
  return hasPinnedArtifacts(snapshot) && !snapshotNeedsProjectSource(snapshot, services);
}
