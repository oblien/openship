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
  onFailure,
  onReconciling,
  onSuccess,
  setDeploymentStatus,
  type LifecycleContext,
} from "../deployment-lifecycle";
import type { DeployableService } from "../../../lib/deployable-service";
import { webhookProxyTarget } from "../../../config";

import { buildComposeImages } from "./build.service";
import { deployComposeServices } from "./deploy.service";
import { safeErrorMessage } from "@repo/core";

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
    cloneOnServer,
    targetServiceIds,
    refreshServiceIds,
  });

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

  const composeResult = await deployComposeServices(project, dep, runtime, logger, {
    builtImages: composeBuild.imageRefs,
    buildFailures: composeBuild.buildFailures,
    resources: runtimeResources,
    buildSessionId,
    routing,
    ssl,
    system,
    executor,
    usesManagedRouting,
    serverId: snapshot.serverId,
    targetServiceIds,
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
    const primary = composeResult.services.find((s) => s.containerId);
    await onReconciling(ctx, {
      containerId: primary?.containerId,
      warningMessage:
        composeResult.warning ?? "Connection lost during deploy — verifying remote state.",
    });
    return;
  }

  if (composeResult.status === "failed") {
    for (const [serviceId, imageRef] of composeBuild.builtImageRefs) {
      await cleanupBuildArtifact(runtime, imageRef).catch((err) => {
        const detail = safeErrorMessage(err);
        logger.log(`Warning: failed to clean up built service image ${serviceId}: ${detail}\n`, "warn");
      });
    }
    await onFailure(ctx, composeResult.error ?? "Compose deploy failed", composeBuild.durationMs);
    return;
  }

  const deployedServiceIds = new Set(
    composeResult.services
      .filter((service) => service.containerId)
      .map((service) => service.serviceId),
  );
  for (const [serviceId, imageRef] of composeBuild.builtImageRefs) {
    if (deployedServiceIds.has(serviceId)) continue;
    await cleanupBuildArtifact(runtime, imageRef).catch((err) => {
      const detail = safeErrorMessage(err);
      logger.log(`Warning: failed to clean up unused service image ${serviceId}: ${detail}\n`, "warn");
    });
  }

  const primary = composeResult.services.find((s) => s.containerId);
  // Routing failures are best-effort (domains are optional — never fail the
  // deploy). Fold them into the SAME top-level "action required" signal the
  // single-app pipeline uses (`edgeUnsynced` + `deployWarning` → routingUnsynced
  // → project attention + Domains-tab dot), cleared by Retry routing / next deploy.
  const routingWarning = composeResult.routeWarnings?.length
    ? `Some domains aren't routed yet — the app is deployed and running; fix DNS/routing and ` +
      `Retry from the Domains tab: ${composeResult.routeWarnings.join("; ")}`
    : undefined;
  const successWarning = routingWarning ?? composeResult.warning;
  await onSuccess(ctx, {
    containerId: primary?.containerId ?? "compose",
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


