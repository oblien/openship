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
import type { Deployment, Project, Service } from "@repo/db";
import type { ResourceConfig, MultiServiceRuntimeAdapter, RoutingProvider, SslProvider } from "@repo/adapters";
import { BuildLogger } from "@repo/adapters";
import { registerResolvedRoutes } from "@repo/adapters";

import type { BuildConfigSnapshotLike } from "../build-config";
import { onFailure, onSuccess, type LifecycleContext } from "../deployment-lifecycle";
import * as sessionManager from "../session-manager";
import { buildServiceRouteDomain, createTrackedSslProvider, ensureRouteDomainRecord, toRoutedDomainInputs } from "../../../lib/routing-domains";
import type { ComposeService } from "../../../lib/compose-parser";

import { ensureManagedEdgeProxy } from "../../../lib/managed-edge-proxy";

import { buildComposeImages } from "./build.service";
import { deployComposeServices } from "./deploy.service";
import { parseServicePort } from "./domain-helpers";

async function registerComposeRoutes(opts: {
  project: Project;
  runtime: MultiServiceRuntimeAdapter;
  routing: RoutingProvider;
  ssl: SslProvider;
  logger: BuildLogger;
  services: Service[];
  deployedServices: Array<{
    serviceId: string;
    serviceName: string;
    containerId?: string;
    status: string;
    ip?: string;
    hostPort?: number;
    error?: string;
  }>;
  usesManagedRouting: boolean;
  userId: string;
  serverId?: string;
}): Promise<string | undefined> {
  const { project, runtime, routing, ssl, logger, services, deployedServices, usesManagedRouting, userId, serverId } = opts;
  const byName = new Map(services.map((s) => [s.name, s]));
  const seenDomains = new Set<string>();
  let firstPublicUrl: string | undefined;

  const exposedServices = deployedServices.filter((ds) => {
    const input = byName.get(ds.serviceName);
    return ds.status === "running" && !!ds.ip && !!input?.exposed;
  });

  if (exposedServices.length === 0) {
    logger.log("No compose services are configured for public routing. Skipping route registration.\n");
    return undefined;
  }

  // ── Load existing domain records (same as normal deploy) ───────────
  const projectDomains = await repos.domain.listByProject(project.id);
  const domainByHostname = new Map(projectDomains.map((d) => [d.hostname.toLowerCase(), d]));
  const trackedSsl = createTrackedSslProvider(ssl, domainByHostname);

  logger.log(`Configuring public routes for ${exposedServices.length} compose service${exposedServices.length === 1 ? "" : "s"}...\n`);

  for (const deployed of exposedServices) {
    const input = byName.get(deployed.serviceName);
    if (!input || !deployed.ip) continue;

    const port = parseServicePort(input.exposedPort ?? undefined) ?? parseServicePort(input.ports?.[0] ?? undefined);
    if (!port) {
      logger.log(`Skipping route for service "${deployed.serviceName}" — no routable port configured.\n`, "warn");
      continue;
    }

    const route = buildServiceRouteDomain({
      project,
      service: input,
      runtimeName: runtime.name,
      usesManagedRouting,
    });

    if (!route) {
      logger.log(`Skipping route for service "${deployed.serviceName}" — no domain configured.\n`, "warn");
      continue;
    }

    const domainKey = route.hostname.toLowerCase();
    if (seenDomains.has(domainKey)) continue;
    seenDomains.add(domainKey);

    const beforeRecord = domainByHostname.get(domainKey);
    const domainRecord = await ensureRouteDomainRecord({
      projectId: project.id,
      route,
      domainByHostname,
    });
    if (!beforeRecord && domainRecord) {
      logger.log(`Created domain record for "${route.hostname}" (service: ${deployed.serviceName}).\n`);
    }

    const targetUrl = `http://${deployed.ip}:${port}`;

    logger.log(`Configuring public route for service "${deployed.serviceName}" (${targetUrl})...\n`);
    await registerResolvedRoutes(logger, routing, trackedSsl, toRoutedDomainInputs([route]), { targetUrl });

    // ── Sync free subdomains with managed edge proxy ─────────────
    if (usesManagedRouting && route.isCloud && route.managedSubdomain) {
      logger.log(`Syncing managed edge proxy for ${route.hostname}...\n`);
      await ensureManagedEdgeProxy(userId, route.managedSubdomain, { serverId });
    }

    if (!firstPublicUrl) {
      firstPublicUrl = `https://${route.hostname}`;
    }
  }

  return firstPublicUrl;
}

async function failPendingServices(
  projectId: string,
  deploymentId: string,
  failedServiceIds: Set<string>,
  error: string,
): Promise<void> {
  const services = await repos.service.listByProject(projectId);

  for (const service of services) {
    if (!service.enabled || failedServiceIds.has(service.id)) continue;

    sessionManager.broadcastServiceStatus(deploymentId, {
      serviceName: service.name,
      serviceId: service.id,
      status: "failed",
      error,
    });
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComposePipelineOpts {
  project: Project;
  dep: Deployment;
  runtime: MultiServiceRuntimeAdapter;
  routing: RoutingProvider;
  ssl: SslProvider;
  usesManagedRouting: boolean;
  logger: BuildLogger;
  ctx: LifecycleContext;
  snapshot: BuildConfigSnapshotLike & { composeServices?: ComposeService[]; serverId?: string };
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
  const { project, dep, runtime, routing, ssl, usesManagedRouting, logger, ctx, snapshot, buildSessionId, buildEnvVars, buildResources, gitToken } = opts;

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
    const firstError = [...composeBuild.buildFailures.values()][0];
    const message =
      composeBuild.buildFailures.size === 1
        ? firstError
        : `All ${composeBuild.buildFailures.size} service builds failed. First error: ${firstError}`;

    await failPendingServices(
      project.id,
      dep.id,
      new Set(composeBuild.buildFailures.keys()),
      "Deployment aborted because all buildable services failed.",
    );

    await onFailure(ctx, message, composeBuild.durationMs);
    return;
  }

  // ── Transition to deploy phase ─────────────────────────────────────
  logger.log("Build phase complete. Starting compose service deployment...\n");
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

  let publicUrl: string | undefined;
  const persistedServices = await repos.service.listByProject(project.id);
  if (persistedServices.length > 0) {
    try {
      publicUrl = await registerComposeRoutes({
        project,
        runtime,
        routing,
        ssl,
        logger,
        services: persistedServices,
        deployedServices: composeResult.services,
        usesManagedRouting,
        userId: dep.userId,
        serverId: snapshot.serverId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to configure compose service routes";
      await onFailure(ctx, message, composeBuild.durationMs);
      return;
    }
  }

  const primary = composeResult.services.find((s) => s.containerId);
  await onSuccess(ctx, {
    containerId: primary?.containerId ?? "compose",
    url: publicUrl,
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
