/**
 * Compose pipeline — orchestrates the full build→deploy lifecycle for
 * multi-service (docker-compose) projects.
 *
 * This is the compose equivalent of the single-app pipeline that lives
 * in build.service.ts. It coordinates:
 *   1. Per-service image builds  (compose/build.service)
 *   2. Multi-container deployment (compose/deploy.service)
 *   3. Lifecycle hooks            (shared deployment-lifecycle)
 *
 * Called from build.service.ts when the project is detected as compose.
 */

import { repos } from "@repo/db";
import type { Deployment, Project } from "@repo/db";
import type { ResourceConfig, MultiServiceRuntimeAdapter } from "@repo/adapters";
import { BuildLogger } from "@repo/adapters";

import type { BuildConfigSnapshotLike } from "../build-config";
import { onFailure, onSuccess, type LifecycleContext } from "../deployment-lifecycle";
import * as sessionManager from "../session-manager";

import { buildComposeImages } from "./build.service";
import { deployComposeServices } from "./deploy.service";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComposePipelineOpts {
  project: Project;
  dep: Deployment;
  runtime: MultiServiceRuntimeAdapter;
  logger: BuildLogger;
  ctx: LifecycleContext;
  snapshot: BuildConfigSnapshotLike;
  buildSessionId: string;
  buildEnvVars: Record<string, string>;
  buildResources: ResourceConfig;
  gitToken?: string;
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Run the full compose pipeline: build all service images → deploy containers.
 *
 * Handles its own success/failure lifecycle — callers should return immediately
 * after this function completes.
 */
export async function executeComposePipeline(opts: ComposePipelineOpts): Promise<void> {
  const { project, dep, runtime, logger, ctx, snapshot, buildSessionId, buildEnvVars, buildResources, gitToken } = opts;

  // ── Build phase: produce an image for each buildable service ───────
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
  });

  // ── Early exit: if all buildable services failed, fail the deployment ──
  const hasBuildableServices = composeBuild.buildFailures.size > 0 || composeBuild.imageRefs.size > 0;
  const allBuildsFailed =
    hasBuildableServices &&
    composeBuild.buildFailures.size > 0 &&
    // imageRefs includes external (image-only) services, so check if ANY
    // buildable image actually succeeded by comparing counts
    composeBuild.imageRefs.size <= (composeBuild.externalCount ?? 0);

  if (allBuildsFailed) {
    const failedNames = [...composeBuild.buildFailures.keys()];
    const firstError = [...composeBuild.buildFailures.values()][0];
    const message =
      composeBuild.buildFailures.size === 1
        ? firstError
        : `All ${composeBuild.buildFailures.size} service builds failed. First error: ${firstError}`;
    await onFailure(ctx, message, composeBuild.durationMs);
    return;
  }

  // ── Transition to deploy phase ─────────────────────────────────────
  await repos.deployment.updateStatus(dep.id, "deploying", {
    buildDurationMs: composeBuild.durationMs,
  });
  sessionManager.updateStatus(dep.id, "deploying");

  // ── Deploy phase: spin up containers on the shared network ─────────
  const composeResult = await deployComposeServices(project, dep, runtime, logger, {
    builtImages: composeBuild.imageRefs,
    buildFailures: composeBuild.buildFailures,
  });

  // ── Lifecycle: success or failure ──────────────────────────────────
  if (composeResult.status === "failed") {
    await onFailure(ctx, composeResult.error ?? "Compose deploy failed", composeBuild.durationMs);
    return;
  }

  // If any build failures exist, the deployment is degraded even if infra deployed
  const hasBuildFailures = composeBuild.buildFailures.size > 0;
  if (hasBuildFailures) {
    const failedNames = [...composeBuild.buildFailures.keys()];
    const firstError = [...composeBuild.buildFailures.values()][0];
    await onFailure(
      ctx,
      `${composeBuild.buildFailures.size} service build${composeBuild.buildFailures.size === 1 ? "" : "s"} failed: ${firstError}`,
      composeBuild.durationMs,
    );
    return;
  }

  const primary = composeResult.services.find((s) => s.containerId);
  await onSuccess(ctx, {
    containerId: primary?.containerId ?? "compose",
    url: undefined,
    durationMs: composeBuild.durationMs,
    warningMessage: composeResult.warning,
    metaPatch: {
      composeDeployment: {
        totalServices: composeResult.summary.total,
        successfulServices: composeResult.summary.successful,
        failedServices: composeResult.summary.failed,
        failedServiceNames: composeResult.summary.failedServices,
        warningMessage: composeResult.warning,
      },
    },
  });
}
