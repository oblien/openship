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
 * A pinned image is a HINT, never a guarantee: the tag may have been reclaimed
 * since. Every consumer treats a missing image as "build it normally".
 */

/** Structural view of the fields this module reads. `DeploymentConfigSnapshot`
 *  satisfies it — kept structural so there's no import cycle with build.service. */
export interface PinnedArtifactSnapshot {
  /** service NAME → image ref (compose / monorepo fan-out). */
  handoverImages?: Record<string, string>;
  /** Single-app equivalent: the whole release is this one image. */
  handoverAppImage?: string;
  /**
   * STATIC releases have no image: their artifact is a release DIRECTORY on the
   * host that the edge serves (see BareRuntime.deployStatic). Pinning it lets a
   * restore promote those exact files again — no rebuild, no clone — which is the
   * static equivalent of reusing a retained image.
   */
  handoverStaticDir?: string;
  hasBuild?: boolean;
  composeServices?: Array<{
    name: string;
    enabled?: boolean;
    kind?: string | null;
    build?: unknown;
    dockerfile?: unknown;
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
  if (pinnedAppImage(snapshot) || pinnedStaticDir(snapshot)) return true;
  return Object.values(snapshot?.handoverImages ?? {}).some((ref) => !!nonEmpty(ref));
}

/** Strip every pinned artifact — for a deploy that must genuinely rebuild. */
export function withoutPinnedArtifacts<T extends PinnedArtifactSnapshot>(snapshot: T): T {
  const {
    handoverImages: _images,
    handoverAppImage: _app,
    handoverStaticDir: _static,
    ...rest
  } = snapshot;
  return rest as T;
}

/**
 * Does this deploy need the repository (clone + token), or is every artifact it
 * would otherwise build already pinned?
 *
 * This is the gate that lets an instant restore run with no git token, no clone
 * and no GitHub access check. It replaces the inline `needsGitSource` block that
 * used to live in build-pipeline, so the single-app and compose answers stay in
 * step: a service is git-free when its image is pinned, and a pinned single-app
 * release is git-free even when the project normally builds.
 */
export function snapshotNeedsGitSource(
  snapshot: PinnedArtifactSnapshot,
  /** Service rows to judge instead of the snapshot's own frozen list — preflight
   *  validates the CURRENT rows, which may have drifted from the snapshot. */
  services?: PinnedArtifactSnapshot["composeServices"],
): boolean {
  // A pinned static release is just files we already have.
  if (pinnedStaticDir(snapshot)) return false;
  const enabled = (services ?? snapshot.composeServices ?? []).filter((s) => s.enabled !== false);
  if (enabled.length > 0) {
    return enabled.some(
      (s) =>
        (s.kind === "monorepo" || !!s.build || !!s.dockerfile) &&
        !pinnedImageForService(snapshot, s.name),
    );
  }
  return snapshot.hasBuild !== false && !pinnedAppImage(snapshot);
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
  return hasPinnedArtifacts(snapshot) && !snapshotNeedsGitSource(snapshot, services);
}
