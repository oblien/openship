/**
 * Project service pipeline - orchestrates the full build/deploy lifecycle for
 * projects with child services. Compose is one importer for those services.
 *
 * This is the service equivalent of the single-app pipeline that lives
 * in build.service.ts. It coordinates:
 *   1. Per-service image builds  (compose/build.service)
 *   2. Multi-container deployment (compose/deploy.service)
 *   3. Lifecycle hooks            (shared deployment-lifecycle)
 *
 * Called from build.service.ts when the project has saved services or a deploy
 * request includes parsed compose services.
 */

import { listActiveServiceDeployments } from "@repo/platform/engine/lib/active-deployment";
import { repos } from "@repo/db";
import type { Deployment, Project } from "@repo/db";
import type {
  AmbientGitVia,
  CommandExecutor,
  ResourceConfig,
  MultiServiceRuntimeAdapter,
  RoutingProvider,
  SslProvider,
  SystemManager,
} from "@repo/adapters";
import { BuildLogger } from "@repo/adapters";

import type { BuildConfigSnapshotLike } from "../build-config";
import {
  cleanupBuildArtifact,
  onCancelled,
  onFailure,
  onNoChanges,
  onReconciling,
  onSuccess,
  routeIssuesWarning,
  setDeploymentStatus,
  type LifecycleContext,
} from "../deployment-lifecycle";
import type { DeployableService } from "../../../lib/deployable-service";
import { webhookProxyTarget } from "../../../config/index";

import { buildComposeImages } from "./build.service";
import { composeDeployMadeNoChanges, deployComposeServices } from "./deploy.service";
import { COMPOSE_SENTINEL } from "../../../lib/container-ref";
import { safeErrorMessage } from "@repo/core";
import * as sessionManager from "../session-manager";
import type { HostPortTargetIdentity } from "../../../lib/host-port-target";
import {
  deploymentCancellationKeepsProvisioned,
  raceDeploymentCancellation,
  throwIfDeploymentCancelled,
} from "../deployment-cancellation";
import { assertExactServiceTargets } from "../exact-service-targets";

export interface ComposePipelineOpts {
  project: Project;
  dep: Deployment;
  runtime: MultiServiceRuntimeAdapter;
  routing: RoutingProvider;
  ssl: SslProvider;
  /** SystemManager for the target (self-hosted); null for cloud/desktop. Used to
   *  ensure openresty/certbot/docker once before the service fan-out, matching
   *  the single-app deploy preflight. */
  system: SystemManager | null;
  /** Target host executor (SSH/local) — writes app template config files onto
   *  the Docker host for read-only bind-mounts. Null on cloud. */
  executor: CommandExecutor | null;
  /** The target IS this machine (`platform.localHost`) — host-path writes go
   *  through the host channel, not `executor`. */
  localHost?: boolean;
  /** Physical TCP bind namespace resolved from the actual deployment target. */
  hostPortTarget?: HostPortTargetIdentity | null;
  usesManagedRouting: boolean;
  logger: BuildLogger;
  ctx: LifecycleContext;
  snapshot: BuildConfigSnapshotLike & { composeServices?: DeployableService[]; serverId?: string };
  buildSessionId: string;
  /** Decrypted project env, without internal build-only defaults. */
  composeInterpolationEnv: Record<string, string>;
  buildEnvVars: Record<string, string>;
  buildResources: ResourceConfig;
  runtimeResources: ResourceConfig;
  gitToken?: string;
  /** Path to the git-credential relay helper on the build host (desktop relay).
   *  When set, service clones authenticate through it instead of a token. */
  gitCredentialHelperPath?: string;
  /** Per-server SSH clone credential (ssh-server-key / deploy-key mode). */
  gitSsh?: { privateKey: string; knownHosts: string };
  /** The build host clones with its OWN verified git credentials (nothing shipped). */
  gitAmbient?: { via: AmbientGitVia };
  /** Clone each service's source on the remote build host instead of cloning on
   *  the orchestrator and transferring the context. */
  cloneOnServer?: boolean;
  /** Outer deployment cancellation signal. */
  signal?: AbortSignal;
}

async function cleanupBuiltArtifacts(
  runtime: MultiServiceRuntimeAdapter,
  builtImageRefs: ReadonlyMap<string, string>,
  logger: BuildLogger,
  retainedServiceIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  // Artifact refs can theoretically be shared (for example, by an adapter or
  // imported build result). Protect the ref itself, not only the service key,
  // so cleaning an unused sibling can never delete a published artifact.
  const retainedRefs = new Set(
    [...builtImageRefs]
      .filter(([serviceId]) => retainedServiceIds.has(serviceId))
      .map(([, imageRef]) => imageRef),
  );
  for (const [serviceId, imageRef] of builtImageRefs) {
    if (retainedRefs.has(imageRef)) continue;
    await cleanupBuildArtifact(runtime, imageRef).catch((err) => {
      logger.log(
        `Warning: failed to clean up built service artifact ${serviceId}: ${safeErrorMessage(err)}\n`,
        "warn",
      );
    });
  }
}

async function recordCohortAbort(opts: {
  dep: Deployment;
  services: Awaited<ReturnType<typeof repos.service.listByProject>>;
  targetServiceIds?: ReadonlySet<string>;
  failures: ReadonlyMap<string, string>;
  reason: string;
  logger: BuildLogger;
}): Promise<void> {
  const targeted = opts.services.filter(
    (service) =>
      service.enabled && (!opts.targetServiceIds || opts.targetServiceIds.has(service.id)),
  );
  for (const service of targeted) {
    const error =
      opts.failures.get(service.id) ??
      `Not deployed because the coordinated service deployment was aborted: ${opts.reason}`;
    sessionManager.broadcastServiceStatus(opts.dep.id, {
      serviceName: service.name,
      serviceId: service.id,
      status: "failed",
      error,
    });
    await repos.service
      .markServiceDeploymentFailed({
        deploymentId: opts.dep.id,
        serviceId: service.id,
        serviceName: service.name,
        errorMessage: error,
        reason: opts.failures.has(service.id) ? "build-failed" : "cohort-aborted",
      })
      .catch((err) => {
        opts.logger.log(
          `Warning: could not record the aborted service "${service.name}": ${safeErrorMessage(err)}\n`,
          "warn",
        );
      });
  }
}

/**
 * A thrown deploy has no result telling us which services crossed the
 * activation boundary. Use durable per-service evidence and reclaim only build
 * artifacts that definitely never reached it. If the evidence query itself is
 * unavailable, retaining an artifact is safer than deleting one a live
 * workload may still use.
 */
async function cleanupUnusedBuiltArtifactsAfterDeployError(
  dep: Deployment,
  runtime: MultiServiceRuntimeAdapter,
  builtImageRefs: ReadonlyMap<string, string>,
  logger: BuildLogger,
): Promise<void> {
  if (builtImageRefs.size === 0) return;

  let rows: Awaited<ReturnType<typeof repos.service.listByDeployment>>;
  try {
    rows = await repos.service.listByDeployment(dep.id);
  } catch (err) {
    logger.log(
      `Warning: could not verify which built service artifacts are unused; retaining them: ${safeErrorMessage(err)}\n`,
      "warn",
    );
    return;
  }

  const protectedRows = rows.filter((row) =>
    ["deploying", "success", "indeterminate"].includes(row.status),
  );
  const protectedServiceIds = new Set(protectedRows.map((row) => row.serviceId));
  const referencedArtifacts = new Set(
    protectedRows.map((row) => row.imageRef).filter((ref): ref is string => Boolean(ref)),
  );
  for (const [serviceId, imageRef] of builtImageRefs) {
    if (protectedServiceIds.has(serviceId)) referencedArtifacts.add(imageRef);
  }

  for (const [serviceId, imageRef] of builtImageRefs) {
    if (referencedArtifacts.has(imageRef)) continue;
    await cleanupBuildArtifact(runtime, imageRef).catch((err) => {
      logger.log(
        `Warning: failed to clean up unused built service artifact ${serviceId}: ${safeErrorMessage(err)}\n`,
        "warn",
      );
    });
  }
}

/**
 * Run the full service pipeline: build service images, then deploy containers.
 *
 * Handles its own success/failure lifecycle - callers should return immediately
 * after this function completes.
 */
export async function executeComposePipeline(opts: ComposePipelineOpts): Promise<void> {
  const {
    project,
    dep,
    runtime,
    routing,
    ssl,
    system,
    executor,
    localHost,
    hostPortTarget,
    usesManagedRouting,
    logger,
    ctx,
    snapshot,
    buildSessionId,
    composeInterpolationEnv,
    buildEnvVars,
    buildResources,
    runtimeResources,
    gitToken,
    gitCredentialHelperPath,
    gitSsh,
    gitAmbient,
    cloneOnServer,
  } = opts;

  throwIfDeploymentCancelled(opts.signal);

  // Smart (partial) redeploy: when the snapshot carries a target subset and
  // this isn't a forceAll deploy, build + recreate ONLY those services and
  // leave the rest running (carried forward in the deploy step). forceAll or
  // no subset → undefined → build + deploy everything (unchanged behavior).
  const targetIds = snapshot.targetServiceIds;
  const targetServiceIds =
    !dep.forceAll && targetIds && targetIds.length > 0 ? new Set(targetIds) : undefined;
  // Env-only refresh subset: in the target set but recreated WITHOUT a rebuild.
  const refreshIds = snapshot.refreshServiceIds;
  const refreshServiceIds =
    !dep.forceAll && refreshIds && refreshIds.length > 0 ? new Set(refreshIds) : undefined;
  /**
   * EXCLUSIVE scope: never deploy, fail or reap a service outside `targetServiceIds`.
   *
   * `targetServiceIds` alone only means "build/recreate these and carry the rest forward",
   * and carrying requires a previous deployment to carry FROM. A caller whose untargeted
   * services must be untouchable even with no previous release (a migration reusing
   * already-running containers in place) sets this on the snapshot.
   */
  const strictScope = !dep.forceAll && !!targetServiceIds && Boolean(snapshot.strictServiceScope);

  // Service rows can change after request-time/reconciliation validation. Do
  // one final fail-closed check in the worker before any image build, pull, or
  // container replacement begins.
  const checksCloudImageRefresh =
    snapshot.forcePullImages && runtime.name === "cloud" && !runtime.supports("dockerHost") && Boolean(project.activeDeploymentId);
  let currentServices: Awaited<ReturnType<typeof repos.service.listByProject>> | undefined;
  const getCurrentServices = async () => {
    currentServices ??= await repos.service.listByProject(project.id);
    return currentServices;
  };
  if ((strictScope && targetServiceIds) || checksCloudImageRefresh) {
    const services = await getCurrentServices();
    if (strictScope && targetServiceIds) {
      assertExactServiceTargets(services, [...targetServiceIds]);
    }
  }
  // Read this before building too. If the ownership query is unavailable, the
  // safe result is a failed deployment with no newly-created artifact to leak.
  const priorCloudWorkspaceServiceIds = checksCloudImageRefresh
    ? new Set(
        (await listActiveServiceDeployments(project))
          .filter((row) => Boolean(row.containerId))
          .map((row) => row.serviceId),
      )
    : undefined;
  const keepProvisionedOnCancel = () => deploymentCancellationKeepsProvisioned(opts.signal);

  const composeBuild = await buildComposeImages({
    project,
    dep,
    runtime,
    logger,
    snapshot,
    buildSessionId,
    composeInterpolationEnv,
    buildEnvVars,
    buildResources,
    gitToken,
    gitCredentialHelperPath,
    gitSsh,
    gitAmbient,
    cloneOnServer,
    targetServiceIds,
    refreshServiceIds,
  });

  // Cancelled during the image phase: stop here. setDeploymentStatus below has no
  // terminal-state guard, so without this the cancelled row would be flipped back
  // to "deploying" and the services the user cancelled would start anyway.
  if (composeBuild.cancelled || opts.signal?.aborted) {
    if (!keepProvisionedOnCancel()) {
      await cleanupBuiltArtifacts(runtime, composeBuild.builtImageRefs, logger);
    }
    await onCancelled(ctx, composeBuild.durationMs, {
      keepProvisioned: keepProvisionedOnCancel(),
    });
    return;
  }

  // An exact multi-service webhook is one coordinated rollout. If any selected
  // image failed to build, stop before the first service cutover instead of
  // updating only the successful half of the requested cohort.
  if (strictScope && composeBuild.buildFailures.size > 0) {
    const detail = [...composeBuild.buildFailures.values()].join("; ");
    const message = `Coordinated service deployment aborted before cutover because image preparation failed: ${detail}`;
    logger.log(`${message}\n`, "error");
    await recordCohortAbort({
      dep,
      services: await getCurrentServices(),
      targetServiceIds,
      failures: composeBuild.buildFailures,
      reason: "another selected service failed to build",
      logger,
    });
    await cleanupBuiltArtifacts(runtime, composeBuild.builtImageRefs, logger);
    await onFailure(ctx, message, composeBuild.durationMs);
    return;
  }

  // Cloud preserves an image service's only durable disk by reusing its
  // existing workspace. That also preserves the workspace's original image,
  // so a forced mutable-tag refresh cannot be honoured safely there without
  // deleting user data. Refuse the whole cohort before any service is touched;
  // Docker remains the supported image-refresh runtime.
  if (checksCloudImageRefresh && priorCloudWorkspaceServiceIds) {
    const blockedIds = new Set(
      [...composeBuild.imageRefs.keys()].filter(
        (serviceId) =>
          (!targetServiceIds || targetServiceIds.has(serviceId)) &&
          !composeBuild.builtImageRefs.has(serviceId) &&
          priorCloudWorkspaceServiceIds.has(serviceId),
      ),
    );
    if (blockedIds.size > 0) {
      const services = await getCurrentServices();
      const blockedNames = services
        .filter((service) => blockedIds.has(service.id))
        .map((service) => service.name);
      const message =
        `Cannot refresh mutable image${blockedNames.length === 1 ? "" : "s"} for cloud service${blockedNames.length === 1 ? "" : "s"} ` +
        `${blockedNames.join(", ")} without replacing persistent workspace data. ` +
        "Use a self-hosted Docker target for forced image refreshes.";
      logger.log(`${message}\n`, "error");
      await recordCohortAbort({
        dep,
        services,
        targetServiceIds,
        failures: new Map([...blockedIds].map((id) => [id, message])),
        reason: "cloud cannot safely refresh an existing image workspace",
        logger,
      });
      await cleanupBuiltArtifacts(runtime, composeBuild.builtImageRefs, logger);
      await onFailure(ctx, message, composeBuild.durationMs);
      return;
    }
  }

  if (composeBuild.buildFailures.size > 0) {
    logger.log(
      `Build phase completed with ${composeBuild.buildFailures.size} failed service image${composeBuild.buildFailures.size === 1 ? "" : "s"}. Deploying available services...\n`,
      "warn",
    );
  } else {
    logger.log("Build phase complete. Starting project service deployment...\n");
  }
  await setDeploymentStatus(dep.id, "deploying", {
    extra: { buildDurationMs: composeBuild.durationMs },
  });
  sessionManager.broadcastInstallPhase(dep.id, { id: "services", status: "active" });

  let composeResult;
  let artifactActivationStarted = false;
  try {
    composeResult = await deployComposeServices(project, dep, runtime, logger, {
      builtImages: composeBuild.imageRefs,
      preparedLocalImages: composeBuild.preparedLocalImages,
      staticArtifactRefs: composeBuild.staticArtifactRefs,
      staticServiceIds: composeBuild.staticServiceIds,
      buildFailures: composeBuild.buildFailures,
      resources: runtimeResources,
      buildSessionId,
      routing,
      ssl,
      system,
      executor,
      localHost,
      hostPortTarget,
      promptUser: (prompt) =>
        raceDeploymentCancellation(sessionManager.promptUser(dep.id, prompt), opts.signal),
      usesManagedRouting,
      serverId: snapshot.serverId,
      targetServiceIds,
      strictScope,
      forcePullImages: snapshot.forcePullImages,
      onArtifactActivationStart: () => {
        artifactActivationStarted = true;
      },
      routeOptions: project.webhookDomain
        ? {
            webhookDomain: project.webhookDomain,
            webhookProxy: webhookProxyTarget,
          }
        : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) {
      // The cancel endpoint may have raced this service call. The parent owns
      // the terminal transition and cleanup; do it here once and return so the
      // outer worker can acknowledge its lease instead of reporting a failure.
      if (!keepProvisionedOnCancel()) {
        await cleanupBuiltArtifacts(runtime, composeBuild.builtImageRefs, logger);
      }
      await onCancelled(ctx, composeBuild.durationMs, {
        keepProvisioned: keepProvisionedOnCancel(),
      });
      return;
    }
    // Unlike the normal failed-result path, a throw bypasses lifecycle cleanup.
    // Reclaim only artifacts with no evidence of activation, and never let a
    // cleanup/query failure replace the deploy error the caller needs to see.
    if (!artifactActivationStarted) {
      if (strictScope) {
        const detail = safeErrorMessage(err);
        await recordCohortAbort({
          dep,
          services: await getCurrentServices(),
          targetServiceIds,
          failures: new Map(),
          reason: detail,
          logger,
        });
      }
      await cleanupUnusedBuiltArtifactsAfterDeployError(
        dep,
        runtime,
        composeBuild.builtImageRefs,
        logger,
      ).catch(() => {});
    } else {
      logger.log(
        "Warning: service activation may have started; retaining built artifacts for reconciliation.\n",
        "warn",
      );
    }
    throw err;
  }

  if (opts.signal?.aborted) {
    if (!keepProvisionedOnCancel()) {
      await cleanupBuiltArtifacts(runtime, composeBuild.builtImageRefs, logger);
    }
    await onCancelled(ctx, composeBuild.durationMs, {
      keepProvisioned: keepProvisionedOnCancel(),
    });
    return;
  }

  // RECONCILING: the connection dropped after some containers started, so the
  // outcome is unknown. Must be handled BEFORE the `failed` branch and must NOT
  // go through onFailure (which destroys containers) — the containers may be
  // running fine. Persist `reconciling` and leave the images in place (reconcile
  // may confirm ready; cleaning up now would hit the same dead connection).
  if (composeResult.status === "reconciling") {
    await onReconciling(ctx, {
      containerId: composeResult.primaryContainerId,
      warningMessage:
        composeResult.warning ?? "Connection lost during deploy — verifying remote state.",
    });
    return;
  }

  // A failed result is not proof that nothing crossed the activation boundary.
  // A later required prepare step, for example, can fail after a static release
  // was promoted and its vhost was written. Protect every artifact the deployer
  // reports as published, regardless of the aggregate outcome; onFailure owns
  // container teardown and retained artifacts are reclaimed by normal GC.
  const publishedServiceIds = new Set(
    composeResult.services
      .filter((service) => service.containerId || service.staticRoot)
      .map((service) => service.serviceId),
  );

  if (composeResult.status === "failed") {
    await cleanupBuiltArtifacts(runtime, composeBuild.builtImageRefs, logger, publishedServiceIds);
    await onFailure(ctx, composeResult.error ?? "Compose deploy failed", composeBuild.durationMs);
    return;
  }

  // Which services actually got deployed — everything else's build artifact is
  // unused and gets reclaimed below.
  //
  // `staticRoot` is part of the test, not a nicety: a self-hosted static sub-app
  // is served from disk by the edge, so it deliberately carries a staticRoot
  // INSTEAD of a containerId (see MultiServiceDeployResult.services). Reading
  // "no containerId" as "not deployed" put its doc-root — which is the SAME path
  // the vhost was just pointed at — into the unused list, so every SUCCESSFUL
  // compose deploy `rm -rf`'d the static site it had just published, reported
  // ready, and then 404'd every request.
  await cleanupBuiltArtifacts(runtime, composeBuild.builtImageRefs, logger, publishedServiceIds);

  // Routing failures are best-effort (domains are optional — never fail the
  // deploy). Fold them into the SAME top-level "action required" signal the
  // single-app pipeline uses (`edgeUnsynced` + `deployWarning` → routingUnsynced
  // → project attention + Domains-tab dot), cleared by Retry routing / next deploy.
  const routingWarning =
    composeResult.routeWarnings?.length || composeResult.tlsPendingDomains?.length
      ? routeIssuesWarning(composeResult.routeWarnings ?? [], composeResult.tlsPendingDomains ?? [])
      : undefined;
  const successWarning = routingWarning ?? composeResult.warning;
  const decisionPending = composeResult.summary.failed > 0 && composeResult.summary.successful > 0;
  sessionManager.broadcastInstallPhase(dep.id, { id: "ready", status: "done" });

  // Every service was carried forward: this row owns no container and no image, so
  // promoting it would point the project at an empty release and offer it as a
  // rollback target (#498). Settle it without advancing. NOT via onFailure /
  // onCancelled — both destroy the deployment's service containers, which here are
  // the live ones still serving.
  if (composeDeployMadeNoChanges(composeResult)) {
    await onNoChanges(ctx, {
      warningMessage: successWarning,
      durationMs: composeBuild.durationMs,
    });
    return;
  }

  await onSuccess(ctx, {
    containerId: composeResult.primaryContainerId ?? COMPOSE_SENTINEL,
    url: composeResult.publicUrl,
    durationMs: composeBuild.durationMs,
    warningMessage: successWarning,
    decisionPending,
    metaPatch: {
      composeDeployment: {
        totalServices: composeResult.summary.total,
        successfulServices: composeResult.summary.successful,
        failedServices: composeResult.summary.failed,
        failedServiceNames: composeResult.summary.failedServices,
        warningMessage: composeResult.warning,
        ...(decisionPending ? { decision: "pending" } : {}),
      },
      ...(routingWarning ? { edgeUnsynced: true, deployWarning: routingWarning } : {}),
      ...(composeResult.portChecks && composeResult.portChecks.length > 0
        ? { portCheck: composeResult.portChecks }
        : {}),
    },
  });
}
