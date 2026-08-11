/**
 * How do we put a past deployment back on the air?
 *
 * This is the one place that decides, and it decides at ROLLBACK time from
 * what is actually still on the host — never from a flag frozen onto the
 * deployment row when it was created.
 *
 *   "unit-swap"        The runtime's artifact is a durable per-deployment UNIT
 *                      that survived the redeploy (bare: supervisor unit +
 *                      release dir; cloud: stopped workspace + disk). Restart
 *                      it in place — genuinely instant. Capability:
 *                      `unitRestore`.
 *
 *   "redeploy-pinned"  Docker. Containers are disposable and the redeploy
 *                      removed the previous one, so the durable artifact is
 *                      the IMAGE — which the rollback-window keep set already
 *                      retains for every project (see image-gc.computeKeepSet).
 *                      Restore = run the NORMAL deploy step with the target's
 *                      frozen config snapshot + env and its images PINNED, so
 *                      no build and no clone happen. Env, published port,
 *                      volumes, labels, network, healthcheck, routing, the
 *                      health gate and the stabilization watch all come from
 *                      the deploy pipeline rather than being re-implemented.
 *
 *   "rebuild"          No artifact left, but we know the commit. Same deploy
 *                      call, minus the pinned images: it re-clones and rebuilds
 *                      that commit. Slower, always correct.
 *
 * INVARIANT: a rollback never dead-ends. If the target's commit is known it is
 * restorable; the only question is instant vs rebuild. That's why "the artifact
 * was pruned" is not an error here — it's just the slower branch.
 *
 * Pure and synchronous by construction (image presence is resolved by the
 * caller and passed in), so every branch is unit-testable without a daemon —
 * same shape as image-gc's `computeKeepSet`.
 */

/** Compose deploys store this in `deployment.container_id` / `image_ref` when
 *  there is no single primary container/image for the release. It is a marker,
 *  never a real Docker reference — treating it as one is what made compose
 *  rollback try to `createContainer({ Image: "compose" })`. */
export const COMPOSE_SENTINEL = "compose";

export const ROLLBACK_ERROR_CODES = {
  NOT_READY: "ROLLBACK_NOT_READY",
  ALREADY_ACTIVE: "ROLLBACK_ALREADY_ACTIVE",
  ARTIFACT_GONE: "ROLLBACK_ARTIFACT_GONE",
  UNSUPPORTED_RUNTIME: "ROLLBACK_UNSUPPORTED_RUNTIME",
} as const;

export type RollbackErrorCode =
  (typeof ROLLBACK_ERROR_CODES)[keyof typeof ROLLBACK_ERROR_CODES];

/**
 * Does this project want past artifacts held so a restore can skip the build?
 *
 * `project.defaultRollbackStrategy` is a RETENTION preference, read LIVE — never
 * a decision frozen onto each deployment. Flipping it therefore applies to
 * releases that already exist, which is the whole point: the old per-deployment
 * flag meant "keep artifacts" only ever took effect for future deploys.
 *
 * Lives here (with the planner, which imports nothing) so the deploy pipeline can
 * read it without importing the orchestrator — that would close a static cycle
 * through build.service.
 */
export function shouldRetainArtifact(project: { defaultRollbackStrategy: string }): boolean {
  return project.defaultRollbackStrategy !== "git";
}

export type RestorePlan =
  | { mode: "unit-swap" }
  | {
      mode: "redeploy-pinned";
      /** service NAME → image tag to deploy verbatim (no build, no pull). Keyed
       *  by name because that's what `snapshot.handoverImages` is keyed by. */
      handoverImages: Record<string, string>;
      /** Single-app equivalent of the above. */
      handoverAppImage?: string;
      /** STATIC release: the retained release DIRECTORY to promote again. */
      handoverStaticDir?: string;
      /** Services whose image is gone; they rebuild inside the same deploy
       *  (a service with no pinned image simply falls into the buildable set). */
      rebuildServices: string[];
    }
  | { mode: "rebuild"; commitSha: string }
  | { mode: "ineligible"; code: RollbackErrorCode; message: string };

export interface RestorePlanInput {
  target: {
    id: string;
    status: string;
    containerId: string | null;
    imageRef: string | null;
    commitSha: string | null;
    artifactRetainedAt: Date | null;
    /** The frozen per-deploy config snapshot. A restore REPLAYS it, so a release
     *  that never recorded one (rows predating the snapshot) can't be restored —
     *  better to say so here than to start a deploy that dies in the pipeline. */
    meta?: unknown;
  };
  project: { activeDeploymentId: string | null };
  /** `runtime.supports("unitRestore")` — the artifact is a restartable unit. */
  unitRestore: boolean;
  /**
   * The EFFECTIVE image for each of the target release's services — resolved by
   * the caller, because a service that didn't change in a given deploy carries
   * its previous image forward, and a smart-deploy `skipped` row may record none
   * at all. See `resolveEffectiveServiceImages`.
   */
  serviceImages?: Array<{ serviceName: string | null; imageRef: string | null }>;
  /** Is this image tag still on the deploy host? Resolved by the caller
   *  (DockerRuntime.imageExistsLocally) so this function stays pure. */
  imagePresent?: (imageRef: string) => boolean;
  /** Does this release DIRECTORY still exist on the host? Static releases only. */
  pathPresent?: (path: string) => boolean;
}

/** A real, dial-able artifact reference (not a compose marker, not blank). */
export function usableRef(ref: string | null | undefined): string | null {
  const trimmed = ref?.trim();
  if (!trimmed || trimmed === COMPOSE_SENTINEL) return null;
  return trimmed;
}

/**
 * A STATIC release records a host PATH where every other kind records a
 * container/workspace id — the same convention `DockerRuntime.destroy` and
 * `cleanupBuildArtifact` key off. Its artifact is that directory of built files.
 */
export function staticReleaseDir(target: {
  containerId: string | null;
}): string | null {
  const id = target.containerId?.trim();
  return id && id.startsWith("/") ? id : null;
}

export function planRestore(input: RestorePlanInput): RestorePlan {
  const { target, project, unitRestore } = input;

  // `partial_failure` counts as success: some services are up and the release
  // is a legitimate restore point (it's also what the compose keep/reject
  // decision restores when the operator rejects a bad deploy).
  if (target.status !== "ready" && target.status !== "partial_failure") {
    return {
      mode: "ineligible",
      code: ROLLBACK_ERROR_CODES.NOT_READY,
      message: "Only successful deployments can be rolled back to.",
    };
  }
  if (project.activeDeploymentId === target.id) {
    return {
      mode: "ineligible",
      code: ROLLBACK_ERROR_CODES.ALREADY_ACTIVE,
      message: "This deployment is already active.",
    };
  }
  // Every restore mode except the in-place unit swap replays the frozen snapshot.
  // Without one there is nothing to replay — fail here with a reason instead of
  // starting a deploy that dies on "Deployment has no config snapshot".
  const hasSnapshot =
    !!target.meta && typeof target.meta === "object" && Object.keys(target.meta).length > 0;
  if (!hasSnapshot && !(unitRestore && target.containerId && target.artifactRetainedAt)) {
    return {
      mode: "ineligible",
      code: ROLLBACK_ERROR_CODES.ARTIFACT_GONE,
      message:
        "This deployment didn't record a config snapshot, so it can't be replayed. Deploy again to create a restorable release.",
    };
  }

  // STATIC first, and deliberately before the unit check: a static release has
  // no process to restart — its "container id" is the directory of built files
  // the edge serves. Restoring it means promoting those files again, so the
  // deploy step re-points the edge at them. (Treating that path as a unit is how
  // a static rollback used to end up calling `start("/var/lib/...")`.)
  const staticDir = staticReleaseDir(target);
  if (staticDir) {
    const dirPresent = input.pathPresent ?? (() => true);
    if (dirPresent(staticDir)) {
      return {
        mode: "redeploy-pinned",
        handoverImages: {},
        handoverStaticDir: staticDir,
        rebuildServices: [],
      };
    }
    return target.commitSha
      ? { mode: "rebuild", commitSha: target.commitSha }
      : {
          mode: "ineligible",
          code: ROLLBACK_ERROR_CODES.ARTIFACT_GONE,
          message:
            "This release's files are no longer on the host and it has no commit to rebuild from.",
        };
  }

  // Bare / cloud: the unit is still there, stopped. Restart it.
  if (unitRestore && target.containerId && target.artifactRetainedAt) {
    return { mode: "unit-swap" };
  }

  const present = input.imagePresent ?? (() => true);

  // Compose: per-service tags off the target's own service rows.
  const handoverImages: Record<string, string> = {};
  const rebuildServices: string[] = [];
  for (const row of input.serviceImages ?? []) {
    const name = row.serviceName?.trim();
    if (!name) continue;
    const ref = usableRef(row.imageRef);
    if (ref && present(ref)) handoverImages[name] = ref;
    else rebuildServices.push(name);
  }

  // Single-app: the release's own image.
  const appRef = usableRef(target.imageRef);
  const handoverAppImage = appRef && present(appRef) ? appRef : undefined;

  if (handoverAppImage || Object.keys(handoverImages).length > 0) {
    return {
      mode: "redeploy-pinned",
      handoverImages,
      ...(handoverAppImage ? { handoverAppImage } : {}),
      rebuildServices,
    };
  }

  // Nothing retained — but the commit is the other artifact.
  if (target.commitSha) {
    return { mode: "rebuild", commitSha: target.commitSha };
  }

  return {
    mode: "ineligible",
    code: ROLLBACK_ERROR_CODES.ARTIFACT_GONE,
    message:
      "This deployment can't be restored: its artifact is no longer retained and it has no commit to rebuild from.",
  };
}

/** Does this plan need the repository? Only a rebuild clones — which is what
 *  lets an instant restore skip the GitHub-access gate and the git token. */
export function planNeedsRepository(plan: RestorePlan): boolean {
  if (plan.mode === "rebuild") return true;
  if (plan.mode === "redeploy-pinned") return plan.rebuildServices.length > 0;
  return false;
}
