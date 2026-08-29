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
import { webhookProxyTarget } from "../../../config";

import { buildComposeImages } from "./build.service";
import { composeDeployMadeNoChanges, deployComposeServices } from "./deploy.service";
import { COMPOSE_SENTINEL } from "../../../lib/container-ref";
import { safeErrorMessage } from "@repo/core";
import * as sessionManager from "../session-manager";
import type { HostPortTargetIdentity } from "../../../lib/host-port-target";

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
    buildEnvVars,
    buildResources,
    runtimeResources,
    gitToken,
    gitCredentialHelperPath,
    gitSsh,
    gitAmbient,
    cloneOnServer,
  } = opts;

  // Smart (partial) redeploy: when the snapshot carries a target subset and
  // this isn't a forceAll deploy, build + recreate ONLY those services and
  // leave the rest running (carried forward in the deploy step). forceAll or
  // no subset → undefined → build + deploy everything (unchanged behavior).
  const targetIds = (snapshot as { targetServiceIds?: string[] }).targetServiceIds;
  const targetServiceIds =
    !dep.forceAll && targetIds && targetIds.length > 0 ? new Set(targetIds) : undefined;
  // Env-only refresh subset: in the target set but recreated WITHOUT a rebuild.
  const refreshIds = (snapshot as { refreshServiceIds?: string[] }).refreshServiceIds;
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
  const strictScope =
    !dep.forceAll &&
    !!targetServiceIds &&
    Boolean((snapshot as { strictServiceScope?: boolean }).strictServiceScope);

  const composeBuild = await buildComposeImages({
    project,
    dep,
    runtime,
    logger,
    snapshot,
    buildSessionId,
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
  if (composeBuild.cancelled) {
    for (const [serviceId, imageRef] of composeBuild.builtImageRefs) {
      await cleanupBuildArtifact(runtime, imageRef).catch((err) => {
        const detail = safeErrorMessage(err);
        logger.log(
          `Warning: failed to clean up built service image ${serviceId}: ${detail}\n`,
          "warn",
        );
      });
    }
    await onCancelled(ctx, composeBuild.durationMs);
    return;
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

  const composeResult = await deployComposeServices(project, dep, runtime, logger, {
    builtImages: composeBuild.imageRefs,
    buildFailures: composeBuild.buildFailures,
    resources: runtimeResources,
    buildSessionId,
    routing,
    ssl,
    system,
    executor,
    localHost,
    hostPortTarget,
    promptUser: (prompt) => sessionManager.promptUser(dep.id, prompt),
    usesManagedRouting,
    serverId: snapshot.serverId,
    targetServiceIds,
    strictScope,
    routeOptions: project.webhookDomain
      ? {
          webhookDomain: project.webhookDomain,
          webhookProxy: webhookProxyTarget,
        }
      : undefined,
  });

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

  if (composeResult.status === "failed") {
    for (const [serviceId, imageRef] of composeBuild.builtImageRefs) {
      await cleanupBuildArtifact(runtime, imageRef).catch((err) => {
        const detail = safeErrorMessage(err);
        logger.log(
          `Warning: failed to clean up built service image ${serviceId}: ${detail}\n`,
          "warn",
        );
      });
    }
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
  const deployedServiceIds = new Set(
    composeResult.services
      .filter((service) => service.containerId || service.staticRoot)
      .map((service) => service.serviceId),
  );
  for (const [serviceId, imageRef] of composeBuild.builtImageRefs) {
    if (deployedServiceIds.has(serviceId)) continue;
    await cleanupBuildArtifact(runtime, imageRef).catch((err) => {
      const detail = safeErrorMessage(err);
      logger.log(
        `Warning: failed to clean up unused service image ${serviceId}: ${detail}\n`,
        "warn",
      );
    });
  }

  // Routing failures are best-effort (domains are optional — never fail the
  // deploy). Fold them into the SAME top-level "action required" signal the
  // single-app pipeline uses (`edgeUnsynced` + `deployWarning` → routingUnsynced
  // → project attention + Domains-tab dot), cleared by Retry routing / next deploy.
  const routingWarning =
    composeResult.routeWarnings?.length || composeResult.tlsPendingDomains?.length
      ? routeIssuesWarning(composeResult.routeWarnings ?? [], composeResult.tlsPendingDomains ?? [])
      : undefined;
  const successWarning = routingWarning ?? composeResult.warning;
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
    metaPatch: {
      composeDeployment: {
        totalServices: composeResult.summary.total,
        successfulServices: composeResult.summary.successful,
        failedServices: composeResult.summary.failed,
        failedServiceNames: composeResult.summary.failedServices,
        warningMessage: composeResult.warning,
      },
      ...(routingWarning ? { edgeUnsynced: true, deployWarning: routingWarning } : {}),
      ...(composeResult.portChecks && composeResult.portChecks.length > 0
        ? { portCheck: composeResult.portChecks }
        : {}),
    },
  });
}
