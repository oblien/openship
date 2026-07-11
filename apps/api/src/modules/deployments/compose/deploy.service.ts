/**
 * Compose deploy service - deploys multi-service projects.
 *
 * Instead of building a single image and running one container,
 * compose deployments:
 *   1. Ensure a shared Docker network for the project
 *   2. Deploy each enabled service as a separate container on that network
 *   3. Track per-service container state in serviceDeployment rows
 *   4. Services discover each other by name (hostname = service name)
 */

import { repos, type Deployment, type Domain, type Project, type Service } from "@repo/db";
import { SYSTEM, resolveServiceHostnameLabel, type ComposeAdvanced } from "@repo/core";
import {
  BuildLogger,
  DEFAULT_RESOURCE_CONFIG,
  DockerRuntime,
  runDeployPipeline,
  type DeployConfig,
  type DeployEnvironment,
  type LogEntry,
  type MultiServiceDeployConfig,
  type MultiServiceDeployResult,
  type MultiServiceRuntimeAdapter,
  type ResourceConfig,
  type RouteRegistrationOptions,
  type RoutingProvider,
  type SslProvider,
  type SystemManager,
} from "@repo/adapters";
import { decryptEnvMap } from "../../../lib/encryption";
import { isConnectionLoss } from "../../../lib/remote-state";
import {
  buildServiceRouteDomain,
  createTrackedSslProvider,
  ensureRouteDomainRecord,
  toRoutedDomainInputs,
  type PlannedRouteDomain,
} from "../../../lib/routing-domains";
import { ensureManagedEdgeProxy } from "../../../lib/managed-edge-proxy";
import * as sessionManager from "../session-manager";
import { resolveServicePort } from "./domain-helpers";
import { serviceKind } from "./project-services";

export interface ComposeDeployResult {
  /** `reconciling` when at least one service's outcome is UNKNOWN because the
   *  connection dropped after its container started — the deploy can't be
   *  finalized until reconciliation reads the true remote state. */
  status: "ready" | "failed" | "reconciling";
  summary: {
    total: number;
    successful: number;
    failed: number;
    /** Services whose container started but whose outcome is unverified
     *  (connection lost mid-deploy). Neither success nor failure yet. */
    indeterminate: number;
    failedServices: string[];
  };
  services: Array<{
    serviceId: string;
    serviceName: string;
    containerId?: string;
    status: string;
    ip?: string;
    hostPort?: number;
    error?: string;
  }>;
  warning?: string;
  error?: string;
  publicUrl?: string;
}

function topoSort(services: Service[]): Service[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const sorted: Service[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(svc: Service) {
    if (visited.has(svc.name)) return;
    if (visiting.has(svc.name)) {
      // Circular dependency - break cycle
      sorted.push(svc);
      visited.add(svc.name);
      return;
    }
    visiting.add(svc.name);
    const deps = (svc.dependsOn as string[]) ?? [];
    for (const depName of deps) {
      const dep = byName.get(depName);
      if (dep) visit(dep);
    }
    visiting.delete(svc.name);
    visited.add(svc.name);
    sorted.push(svc);
  }

  for (const svc of services) {
    visit(svc);
  }
  return sorted;
}

function resolveServicePublicPort(service: Service): number | undefined {
  if (!service.exposed) return undefined;
  return resolveServicePort(service) ?? undefined;
}

function resolveServicePublicSlug(project: Project, service: Service): string | undefined {
  if (!service.exposed || service.domainType === "custom") return undefined;
  return resolveServiceHostnameLabel(
    project.slug ?? project.name,
    service.name,
    service.domain ?? undefined,
    serviceKind(service),
  );
}

function resolveServiceCustomDomain(service: Service): string | undefined {
  if (!service.exposed || service.domainType !== "custom") return undefined;
  return service.customDomain ?? undefined;
}

function resolveServicePublicUrl(project: Project, service: Service): string | undefined {
  const customDomain = resolveServiceCustomDomain(service);
  if (customDomain) return `https://${customDomain}`;

  const publicSlug = resolveServicePublicSlug(project, service);
  return publicSlug ? `https://${publicSlug}.${SYSTEM.DOMAINS.CLOUD_DOMAIN}` : undefined;
}

function toDeployRestartPolicy(restart?: string): DeployConfig["restartPolicy"] {
  if (restart === "always" || restart === "on-failure" || restart === "no") {
    return restart;
  }
  return "always";
}

function createServicePipelineLogger(
  parent: BuildLogger,
  serviceName: string,
  serviceId: string,
): BuildLogger {
  return new BuildLogger((entry) => {
    // Compose owns the global deploy step. Per-service pipeline step events are
    // intentionally kept out of the shared progress bar.
    if (entry.step && entry.stepStatus) return;
    if (entry.message === "No domains configured - skipping routing for this deployment.\n") {
      return;
    }
    parent.callback({
      ...entry,
      serviceName: entry.serviceName ?? serviceName,
      serviceId: entry.serviceId ?? serviceId,
    });
  });
}

function createServiceRuntimeConfig(opts: {
  project: Project;
  dep: Deployment;
  service: Service;
  image: string;
  environment: Record<string, string>;
  resources?: ResourceConfig;
}): MultiServiceDeployConfig {
  const { project, dep, service, image, environment, resources } = opts;
  // Monorepo sub-apps store their long-running process in `startCommand`;
  // compose services in `command`. The DB invariant is that compose rows
  // never have `startCommand` set, so a single `??` chain covers both:
  // monorepo → startCommand (with command fallback if missing), compose →
  // command. No branching on kind needed.
  const runtimeCommand = service.startCommand ?? service.command ?? undefined;
  return {
    deploymentId: dep.id,
    projectId: project.id,
    slug: project.slug,
    serviceName: service.name,
    image,
    ports: (service.ports as string[]) ?? [],
    environment,
    volumes: (service.volumes as string[]) ?? [],
    namespaceVolumes: service.namespaceVolumes,
    command: runtimeCommand,
    restart: service.restart ?? "unless-stopped",
    advanced: service.advanced ?? undefined,
    resources,
    expose: service.exposed,
    publicPort: resolveServicePublicPort(service),
    publicSlug: resolveServicePublicSlug(project, service),
    customDomain: resolveServiceCustomDomain(service),
  };
}

function createServiceDeployConfig(opts: {
  project: Project;
  dep: Deployment;
  service: Service;
  image: string;
  environment: Record<string, string>;
  resources?: ResourceConfig;
  buildSessionId?: string;
}): DeployConfig {
  const { project, dep, service, image, environment, resources, buildSessionId } = opts;
  const publicPort = resolveServicePublicPort(service);
  const publicSlug = resolveServicePublicSlug(project, service);
  const customDomain = resolveServiceCustomDomain(service);

  // Monorepo sub-apps carry their own framework + startCommand on the row;
  // compose rows have those columns null. A direct `??` chain falls through
  // cleanly in both cases - monorepo rows hit the service-level value,
  // compose rows skip straight to the project / command fallback.
  const stack = service.framework ?? project.framework ?? undefined;
  const startCommand = service.startCommand ?? service.command ?? undefined;

  return {
    deploymentId: dep.id,
    projectId: project.id,
    buildSessionId: buildSessionId ?? dep.id,
    imageRef: image,
    environment: dep.environment,
    port: resolveServicePublicPort(service) ?? 0,
    startCommand,
    stack,
    envVars: environment,
    resources: resources ?? DEFAULT_RESOURCE_CONFIG,
    restartPolicy: toDeployRestartPolicy(service.restart ?? undefined),
    runtimeName: publicSlug ?? `${project.slug}-${service.name}`,
    publicEndpoints: service.exposed && publicPort
      ? [{
          port: publicPort,
          domain: service.domainType === "custom" ? undefined : publicSlug,
          customDomain: service.domainType === "custom" ? customDomain : undefined,
          domainType: service.domainType === "custom" ? "custom" : "free",
        }]
      : undefined,
  };
}

interface ServiceRouteContext {
  routing: RoutingProvider;
  trackedSsl: SslProvider;
  usesManagedRouting: boolean;
  organizationId: string;
  serverId?: string;
  routeOptions?: RouteRegistrationOptions;
  domainByHostname: Map<string, Domain>;
}

async function prepareServiceRoute(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  routeContext?: ServiceRouteContext;
  logger: BuildLogger;
}): Promise<PlannedRouteDomain | null> {
  const { project, service, runtimeName, routeContext, logger } = opts;
  if (!routeContext) return null;

  const route = buildServiceRouteDomain({
    project,
    service,
    runtimeName,
    usesManagedRouting: routeContext.usesManagedRouting,
  });
  if (!route) return null;

  const domainKey = route.hostname.toLowerCase();
  const beforeRecord = routeContext.domainByHostname.get(domainKey);
  const domainRecord = await ensureRouteDomainRecord({
    projectId: project.id,
    route,
    domainByHostname: routeContext.domainByHostname,
  });
  if (!beforeRecord && domainRecord) {
    logger.log(`Created domain record for "${route.hostname}".\n`, "info", {
      serviceName: service.name,
    });
  }

  return route;
}

/**
 * Deploy all services for a compose project.
 * Called from the compose pipeline after the build phase.
 */
export async function deployComposeServices(
  project: Project,
  dep: Deployment,
  runtime: MultiServiceRuntimeAdapter,
  logger: BuildLogger,
  opts?: {
    builtImages?: Map<string, string>;
    buildFailures?: Map<string, string>;
    resources?: ResourceConfig;
    buildSessionId?: string;
    routing?: RoutingProvider;
    ssl?: SslProvider;
    system?: SystemManager | null;
    usesManagedRouting?: boolean;
    serverId?: string;
    /** Smart (partial) redeploy: recreate ONLY these services; leave the
     *  rest running and carry their previous runtime row forward. Undefined
     *  = full deploy (recreate every enabled service). */
    targetServiceIds?: Set<string>;
    routeOptions?: RouteRegistrationOptions;
  },
): Promise<ComposeDeployResult> {
  const services = await repos.service.listByProject(project.id);
  const enabled = services.filter((s) => s.enabled);

  if (enabled.length === 0) {
    const hasServices = services.length > 0;
    return {
      status: "failed",
      summary: {
        total: 0,
        successful: 0,
        failed: 0,
        indeterminate: 0,
        failedServices: [],
      },
      services: [],
      error: hasServices
        ? "All project services are currently disabled. Enable at least one service before deploying."
        : "No services were found for this project. Add a service or sync a compose file before deploying.",
    };
  }

  const ordered = topoSort(enabled);

  logger.step("deploy", "running", `Deploying ${ordered.length} services...`);
  logger.log("Preparing shared service group for project services...\n");

  const group = await runtime.ensureServiceGroup({
    deploymentId: dep.id,
    projectId: project.id,
    slug: project.slug,
    resources: opts?.resources,
  });
  logger.log(`Service group ready for ${project.slug}.\n`);

  // Ensure the server has the components this deploy needs — ONCE, before the
  // fan-out — mirroring the single-app deploy preflight (build-pipeline.ts
  // buildDeployEnvironment). Compose previously ensured nothing here, so on a
  // fresh box the first exposed service would register routes / provision certs
  // against an openresty/certbot that were never installed. Each ensureFeature
  // is serialized per server by the injected provision lock. (No per-service
  // host-port check: compose services are reached through openresty by hostname,
  // not by binding host ports the way a bare process does.)
  if (opts?.system) {
    const systemLog = (entry: { message: string; level: "info" | "warn" | "error" }) => {
      logger.log(`${entry.message}\n`, entry.level);
    };
    const plannedRoutes = enabled
      .map((svc) =>
        buildServiceRouteDomain({
          project,
          service: svc,
          runtimeName: runtime.name,
          usesManagedRouting: opts.usesManagedRouting ?? false,
        }),
      )
      .filter((route): route is PlannedRouteDomain => route !== null);

    await opts.system.ensureFeature("deploy", systemLog);
    if (plannedRoutes.length > 0) {
      await opts.system.ensureFeature("routing", systemLog);
    }
    if (plannedRoutes.some((route) => route.provisionSsl)) {
      await opts.system.ensureFeature("ssl", systemLog);
    }
  }

  const projectEnvMap = await repos.project.getEnvMap(project.id, dep.environment);
  const decryptedProjectEnv = decryptEnvMap(projectEnvMap, (key) => {
    logger.log(`Warning: failed to decrypt project env var "${key}", skipping.\n`, "warn");
  });

  const depEnvVars = dep.envVars as Record<string, string> | null;
  const depEnv = depEnvVars
    ? decryptEnvMap(depEnvVars, (key) => {
        logger.log(`Warning: failed to decrypt deployment env var "${key}", skipping.\n`, "warn");
      })
    : {};

  // 4. Load previous service containers so each service is replaced in-place
  //    instead of tearing down the whole app before the first deploy attempt.
  const previousServiceDeps = project.activeDeploymentId
    ? await repos.service.listByDeployment(project.activeDeploymentId)
    : [];
  const previousByServiceId = new Map(previousServiceDeps.map((row) => [row.serviceId, row]));
  const enabledServiceIds = new Set(enabled.map((svc) => svc.id));

  // Full/forceAll deploy (no explicit target subset) churn-avoidance: an
  // image-only (external) service that hasn't changed since the active
  // deployment has nothing to rebuild — recreating it just bounces a DB (brief
  // downtime + re-pull) for no reason. Carry those forward too, using the SAME
  // "changed since the active deployment" anchor as the smart-route env-dirty
  // check (active.createdAt): a changed image/config (svc.updatedAt) or env
  // (env_var updatedAt) after the anchor → recreate; otherwise keep it running.
  const carryAnchorDep = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId).catch(() => null)
    : null;
  const carryAnchor = carryAnchorDep?.createdAt ?? null;
  const carryEnvMeta = carryAnchor
    ? await repos.project.listEnvVarChangeMeta(project.id, dep.environment).catch(() => [])
    : [];
  const carryProjectEnvChanged = carryEnvMeta.some(
    (m) => m.serviceId === null && carryAnchor !== null && m.updatedAt > carryAnchor,
  );
  const carryEnvChangedServiceIds = new Set(
    carryEnvMeta
      .filter((m) => m.serviceId !== null && carryAnchor !== null && m.updatedAt > carryAnchor)
      .map((m) => m.serviceId as string),
  );
  const isExternalUnchanged = (svc: Service): boolean => {
    if (opts?.targetServiceIds) return false; // smart subset already carries non-targets forward
    if (!carryAnchor) return false; // never deployed → deploy it
    if (svc.build || !svc.image) return false; // must be image-only (external); buildables always rebuild
    if (svc.updatedAt > carryAnchor) return false; // image/command/ports/volumes/… changed
    if (carryProjectEnvChanged || carryEnvChangedServiceIds.has(svc.id)) return false; // env changed
    const prev = previousByServiceId.get(svc.id);
    if (!prev?.containerId) return false; // nothing running to carry
    if (prev.imageRef && prev.imageRef !== svc.image) return false; // image tag changed
    return true;
  };

  let routeContext: ServiceRouteContext | undefined;
  if (opts?.routing && opts.ssl && typeof opts.usesManagedRouting === "boolean") {
    const projectDomains = await repos.domain.listByProject(project.id);
    const domainByHostname = new Map(
      projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
    );
    routeContext = {
      routing: opts.routing,
      trackedSsl: createTrackedSslProvider(opts.ssl, domainByHostname),
      usesManagedRouting: opts.usesManagedRouting,
      organizationId: dep.organizationId,
      serverId: opts.serverId,
      routeOptions: opts.routeOptions,
      domainByHostname,
    };
  }

  const results: ComposeDeployResult["services"] = [];
  let successful = 0;
  let firstPublicUrl: string | undefined;
  const seenRouteDomains = new Set<string>();
  const unavailableServiceNames = new Set<string>();
  // Services whose container STARTED but whose outcome we couldn't confirm
  // because the connection dropped mid-deploy. Not counted as failed — the
  // deploy resolves to `reconciling` and reconciliation reads the true state.
  const indeterminateServiceNames = new Set<string>();

  for (const svc of ordered) {
    // Ownership guard - ensure this service actually belongs to the project
    if (svc.projectId !== project.id) continue;

    // Leave a service running exactly as-is (carry its previous runtime row
    // forward under THIS deployment id) instead of recreating it, in two cases:
    //   1. Smart (partial) redeploy — it's not in the target subset.
    //   2. Full/forceAll deploy — it's an unchanged image-only external (isExternalUnchanged).
    // Either way we don't rebuild, recreate, or re-register its route (register
    // is additive; nothing tears it down); it stays in `enabledServiceIds` (so
    // the de-listed reaper won't kill it) and out of `unavailableServiceNames`
    // (so dependents aren't blocked). The liveness check below still redeploys
    // it if its container turns out to be gone.
    const carried =
      (opts?.targetServiceIds && !opts.targetServiceIds.has(svc.id)) || isExternalUnchanged(svc)
        ? previousByServiceId.get(svc.id)
        : undefined;
    if (carried?.containerId) {
      // Only carry a service forward if its container is ACTUALLY running.
      // A prior rollback / partial deploy / external `docker rm` could have
      // left the row pointing at a gone or stopped container — carrying that
      // forward would advertise a dead upstream (502) and show it "running".
      // Verify liveness; if it's not up, fall through and redeploy it (from
      // its previous image via the fallback below). When the runtime can't
      // report container status, trust the row (best-effort, prior behavior).
      const live = runtime.supports("containerInfo")
        ? await runtime.getContainerInfo(carried.containerId).catch(() => null)
        : undefined;
      const alive = live === undefined || live?.status === "running";
      if (alive) {
        // A network reconnect may have re-assigned the container's IP, so
        // prefer the live values over the stored row when we have them.
        const carriedIp = live?.ip ?? carried.ip ?? null;
        const carriedHostPort = live?.hostPort ?? carried.hostPort ?? null;
        await repos.service.upsertServiceDeployment({
          deploymentId: dep.id,
          serviceId: svc.id,
          serviceName: svc.name,
          containerId: carried.containerId,
          status: "success",
          imageRef: carried.imageRef ?? null,
          hostPort: carriedHostPort,
          ip: carriedIp,
        });
        results.push({
          serviceId: svc.id,
          serviceName: svc.name,
          containerId: carried.containerId,
          status: carried.status,
          ip: carriedIp ?? undefined,
          hostPort: carriedHostPort ?? undefined,
        });
        successful += 1;
        sessionManager.broadcastServiceStatus(dep.id, {
          serviceName: svc.name,
          serviceId: svc.id,
          status: "running",
          containerId: carried.containerId,
          hostPort: carriedHostPort ?? undefined,
        });
        logger.log(`Service "${svc.name}" unchanged - kept running (carried forward).\n`, "info", {
          serviceName: svc.name,
        });
        continue;
      }
      logger.log(
        `Service "${svc.name}" was expected running but its container is gone - redeploying it.\n`,
        "warn",
        { serviceName: svc.name },
      );
      // fall through → normal deploy (recreates from the previous image)
    }

    const blockedDependencies = ((svc.dependsOn as string[]) ?? []).filter((dependency) =>
      unavailableServiceNames.has(dependency),
    );
    if (blockedDependencies.length > 0) {
      const message = `Skipped because required service${blockedDependencies.length === 1 ? "" : "s"} ${blockedDependencies.join(", ")} did not deploy.`;
      logger.log(`Service "${svc.name}" skipped: ${message}\n`, "warn", {
        serviceName: svc.name,
      });
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failure",
        imageRef: opts?.builtImages?.get(svc.id) ?? svc.image ?? null,
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: message,
      });
      unavailableServiceNames.add(svc.name);
      continue;
    }

    const serviceEnvMap = await repos.project.getEnvMap(project.id, dep.environment, svc.id);
    const decryptedServiceEnv = decryptEnvMap(serviceEnvMap, (key) => {
      logger.log(
        `Warning: failed to decrypt env var "${key}" for service "${svc.name}", skipping.\n`,
        "warn",
        {
          serviceName: svc.name,
        },
      );
    });

    // Merge: shared project env → current deploy shared env → service env.
    // Service values intentionally win so the compose UI can override globals per service.
    const mergedEnv: Record<string, string> = {
      ...decryptedProjectEnv,
      ...depEnv,
      ...((svc.environment as Record<string, string>) ?? {}),
      ...decryptedServiceEnv,
    };

    const buildFailure = opts?.buildFailures?.get(svc.id);
    if (buildFailure) {
      logger.log(`Service "${svc.name}" build failed: ${buildFailure}\n`, "error", {
        serviceName: svc.name,
      });
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: buildFailure,
      });
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failure",
        imageRef: svc.image ?? null,
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: buildFailure,
      });
      unavailableServiceNames.add(svc.name);
      continue;
    }

    // Prefer a freshly-built image; else the service's configured image
    // (pulled/external); else — for an env-only REFRESH (recreated but not
    // rebuilt) — reuse the previous deployment's image so the container comes
    // back with fresh env and no build.
    const image =
      opts?.builtImages?.get(svc.id) ??
      svc.image ??
      previousByServiceId.get(svc.id)?.imageRef ??
      "";
    if (!image) {
      const message = `No image available for service "${svc.name}"`;
      logger.log(`${message}\n`, "error", { serviceName: svc.name });
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failure",
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: message,
      });
      unavailableServiceNames.add(svc.name);
      continue;
    }

    logger.log(`Deploying service "${svc.name}" (${image})...\n`, "info", {
      serviceName: svc.name,
    });

    // Broadcast per-service "deploying" status to SSE subscribers
    sessionManager.broadcastServiceStatus(dep.id, {
      serviceName: svc.name,
      serviceId: svc.id,
      status: "deploying",
    });

    // Warn-and-drop: advanced compose keys this runtime can't honor (e.g. cloud
    // has no Docker healthcheck). Never fails the deploy — the service still
    // runs, just without the unsupported extras.
    const droppedAdvancedKeys = (Object.keys(svc.advanced ?? {}) as (keyof ComposeAdvanced)[]).filter(
      (key) => runtime.unsupportedComposeKeys.has(key),
    );
    if (droppedAdvancedKeys.length > 0) {
      logger.log(
        `Service "${svc.name}": the ${runtime.name} runtime does not support ${droppedAdvancedKeys.join(", ")} — ignoring.\n`,
        "warn",
        { serviceName: svc.name },
      );
    }

    const serviceRuntimeConfig = createServiceRuntimeConfig({
      project,
      dep,
      service: svc,
      image,
      environment: mergedEnv,
      resources: opts?.resources,
    });
    const serviceDeployConfig = createServiceDeployConfig({
      project,
      dep,
      service: svc,
      image,
      environment: mergedEnv,
      resources: opts?.resources,
      buildSessionId: opts?.buildSessionId,
    });
    let route = await prepareServiceRoute({
      project,
      service: svc,
      runtimeName: runtime.name,
      routeContext,
      logger,
    });
    if (route) {
      const routeKey = route.hostname.toLowerCase();
      if (seenRouteDomains.has(routeKey)) {
        logger.log(
          `Skipping route for service "${svc.name}" - ${route.hostname} is already assigned in this deployment.\n`,
          "warn",
          { serviceName: svc.name },
        );
        route = null;
      } else {
        seenRouteDomains.add(routeKey);
      }
    }
    const routePort = resolveServicePublicPort(svc);
    const proxyRoute = route && runtime.name !== "cloud" && routePort ? route : null;
    if (route && runtime.name !== "cloud" && !routePort) {
      logger.log(
        `Skipping route for service "${svc.name}" - no routable port configured.\n`,
        "warn",
        { serviceName: svc.name },
      );
    }

    let deployedContainerId: string | undefined;
    let deployedContainerCleaned = false;
    try {
      const previous = previousByServiceId.get(svc.id);
      let serviceResult: MultiServiceDeployResult | undefined;
      const serviceLogger = createServicePipelineLogger(logger, svc.name, svc.id);
      const routeDomains = proxyRoute ? toRoutedDomainInputs([proxyRoute]) : [];
      const deployEnv: DeployEnvironment = {
        activate: async (_cfg, onLog) => {
          const result = await runtime.deployServiceWorkload(
            group,
            serviceRuntimeConfig,
            (entry: LogEntry) =>
              onLog({
                ...entry,
                serviceName: entry.serviceName ?? svc.name,
              }),
          );
          deployedContainerId = result.containerId;
          serviceResult = result;
          return { containerId: result.containerId };
        },
        deactivate: (containerId) => runtime.destroy(containerId),
        resolveTargetUrl:
          proxyRoute && routePort && runtime.supports("containerIp")
            ? async (containerId, port) => {
                const ip =
                  serviceResult?.containerId === containerId
                    ? serviceResult.ip
                    : await runtime.getContainerIp(containerId);
                return ip ? `http://${ip}:${port}` : null;
              }
            : undefined,
      };

      const deployResult = await runDeployPipeline(
        deployEnv,
        {
          config: serviceDeployConfig,
          previousContainerId: previous?.containerId ?? undefined,
          domains: routeDomains,
          routing: routeDomains.length ? routeContext?.routing : undefined,
          ssl: routeDomains.length ? routeContext?.trackedSsl : undefined,
          routeOptions: routeDomains.length ? routeContext?.routeOptions : undefined,
        },
        serviceLogger,
      );

      if (deployResult.status === "failed") {
        // A CONNECTION-LOSS failure means the container STARTED but a post-start
        // step (health / route) couldn't reach the host (e.g. a stale-connection
        // "Channel open failure" during route registration). Keep it running —
        // the catch below marks it `indeterminate` so the deploy RECONCILES
        // instead of hard-failing and destroying a healthy container. Only a
        // genuine failure destroys the container here.
        if (deployedContainerId && !isConnectionLoss(deployResult.error)) {
          try {
            await runtime.destroy(deployedContainerId);
            deployedContainerCleaned = true;
          } catch (destroyErr) {
            const destroyMessage =
              destroyErr instanceof Error ? destroyErr.message : "Unknown error";
            logger.log(
              `Warning: failed to clean up "${svc.name}" after deploy failure: ${destroyMessage}\n`,
              "warn",
              {
                serviceName: svc.name,
              },
            );
          }
        }
        throw new Error(deployResult.error ?? `Failed to deploy service "${svc.name}"`);
      }

      const result = serviceResult ?? {
        containerId: deployResult.containerId!,
        status: "running",
      };

      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        containerId: result.containerId,
        status: "success",
        imageRef: image,
        hostPort: result.hostPort ?? null,
        ip: result.ip ?? null,
      });

      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        containerId: result.containerId,
        status: result.status,
        ip: result.ip,
        hostPort: result.hostPort,
      });
      successful += 1;

      // Broadcast per-service "running" status to SSE subscribers
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "running",
        containerId: result.containerId,
        hostPort: result.hostPort,
      });

      logger.log(`Service "${svc.name}" deployed successfully.\n`, "info", {
        serviceName: svc.name,
      });

      if (previous?.imageRef && previous.imageRef !== image && runtime instanceof DockerRuntime) {
        await runtime.removeImage(previous.imageRef).catch((err) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          logger.log(
            `Warning: failed to remove previous image for "${svc.name}": ${message}\n`,
            "warn",
            {
              serviceName: svc.name,
            },
          );
        });
      }

      if (
        proxyRoute &&
        routeContext?.usesManagedRouting &&
        proxyRoute.isCloud &&
        proxyRoute.managedSubdomain
      ) {
        logger.log(`Syncing managed edge proxy for ${proxyRoute.hostname}...\n`, "info", {
          serviceName: svc.name,
        });
        // Best-effort: the service container is already running and any
        // custom domain is routed locally. The managed edge proxy only
        // wires up the free .opsh.io URL via Openship Cloud — a cloud
        // failure here (403 owner mismatch, slug taken, unreachable) must
        // not flip a healthy service to "failed".
        try {
          await ensureManagedEdgeProxy(routeContext.organizationId, proxyRoute.managedSubdomain, {
            serverId: routeContext.serverId,
          });
        } catch (edgeErr) {
          const edgeMessage = edgeErr instanceof Error ? edgeErr.message : "Unknown error";
          logger.log(
            `Warning: could not sync managed edge proxy for ${proxyRoute.hostname}: ${edgeMessage}. ` +
              `The service is live; this only affects the free ${proxyRoute.hostname} URL.\n`,
            "warn",
            { serviceName: svc.name },
          );
        }
      }

      firstPublicUrl ??= proxyRoute
        ? `https://${proxyRoute.hostname}`
        : runtime.name === "cloud"
          ? resolveServicePublicUrl(project, svc)
          : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";

      // INDETERMINATE: the container STARTED (we have its id) but a post-start
      // step (health / route) lost the connection. Do NOT destroy it — it may
      // be running fine — and do NOT mark it failed. Record `indeterminate` so
      // the deploy resolves to `reconciling`; reconciliation reads the true
      // remote state and settles it to ready/failed later.
      if (isConnectionLoss(err) && deployedContainerId && !deployedContainerCleaned) {
        logger.log(
          `Service "${svc.name}" — connection lost after container start; will verify on reconcile.\n`,
          "warn",
          { serviceName: svc.name },
        );
        // SSE has no "indeterminate" — keep it "deploying" (accurate: verifying).
        sessionManager.broadcastServiceStatus(dep.id, {
          serviceName: svc.name,
          serviceId: svc.id,
          status: "deploying",
        });
        await repos.service.createServiceDeployment({
          deploymentId: dep.id,
          serviceId: svc.id,
          containerId: deployedContainerId,
          status: "indeterminate",
          imageRef: image,
        });
        results.push({
          serviceId: svc.id,
          serviceName: svc.name,
          containerId: deployedContainerId,
          status: "indeterminate",
        });
        indeterminateServiceNames.add(svc.name);
      } else {
        if (deployedContainerId && !deployedContainerCleaned) {
          await runtime.destroy(deployedContainerId).catch((destroyErr) => {
            const destroyMessage = destroyErr instanceof Error ? destroyErr.message : "Unknown error";
            logger.log(
              `Warning: failed to clean up "${svc.name}" after deploy failure: ${destroyMessage}\n`,
              "warn",
              {
                serviceName: svc.name,
              },
            );
          });
        }
        logger.log(`Service "${svc.name}" failed: ${message}\n`, "error", {
          serviceName: svc.name,
        });

        // Broadcast per-service "failed" status to SSE subscribers
        sessionManager.broadcastServiceStatus(dep.id, {
          serviceName: svc.name,
          serviceId: svc.id,
          status: "failed",
          error: message,
        });

        await repos.service.createServiceDeployment({
          deploymentId: dep.id,
          serviceId: svc.id,
          status: "failure",
          imageRef: image,
        });

        results.push({
          serviceId: svc.id,
          serviceName: svc.name,
          status: "failed",
          error: message,
        });
        unavailableServiceNames.add(svc.name);
      }
    }
  }

  for (const previous of previousServiceDeps) {
    if (!previous.containerId || enabledServiceIds.has(previous.serviceId)) continue;
    try {
      await runtime.destroy(previous.containerId);
      logger.log(`Stopped disabled service container (${previous.containerId.slice(0, 12)}).\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.log(`Warning: failed to stop disabled service container: ${message}\n`, "warn");
    }
  }

  // Reap a previous SINGLE-APP container when switching single→multi. The
  // loop above only handles the prior deployment's service_deployment rows;
  // a single-app predecessor has none, leaving its lone container
  // (deployment.containerId) with no owner. Destroy it unless it's the
  // "compose" sentinel or one of the per-service containers already handled
  // (the compose→compose case, where prevDep.containerId IS a service row).
  if (project.activeDeploymentId) {
    const prevDep = await repos.deployment.findById(project.activeDeploymentId);
    const prevContainerId = prevDep?.containerId;
    const handledContainerIds = new Set(
      previousServiceDeps
        .map((row) => row.containerId)
        .filter((id): id is string => !!id),
    );
    if (
      prevContainerId &&
      prevContainerId !== "compose" &&
      !handledContainerIds.has(prevContainerId)
    ) {
      try {
        await runtime.destroy(prevContainerId);
        logger.log(`Stopped previous single-app container (${prevContainerId.slice(0, 12)}).\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        logger.log(`Warning: failed to stop previous single-app container: ${message}\n`, "warn");
      }
    }
  }

  const failed = results.filter((r) => r.status === "failed");
  const failedNames = failed.map((r) => r.serviceName);
  const indeterminate = results.filter((r) => r.status === "indeterminate");
  const warning =
    failed.length > 0
      ? `${failed.length}/${ordered.length} services failed: ${failedNames.join(", ")}`
      : undefined;
  const firstFailure = failed.find((service) => service.error?.trim())?.error;

  // Any unverified service → the deploy's outcome is UNKNOWN. Resolve to
  // `reconciling` (not ready/failed): reconciliation reads the real remote
  // state and settles it, and — critically — this keeps the pipeline off the
  // onFailure path, which would DESTROY the containers we're unsure about.
  if (indeterminate.length > 0) {
    const names = indeterminate.map((r) => r.serviceName).join(", ");
    logger.step(
      "deploy",
      "running",
      `Connection lost during deploy — ${indeterminate.length} service(s) pending verification: ${names}.`,
    );
    logger.log(
      `Connection to the server was lost after ${indeterminate.length} container(s) started; ` +
        `the deployment will be verified automatically (reconciling).\n`,
      "warn",
    );
    return {
      status: "reconciling",
      summary: {
        total: ordered.length,
        successful,
        failed: failed.length,
        indeterminate: indeterminate.length,
        failedServices: failedNames,
      },
      services: results,
      warning: `Connection lost — verifying ${indeterminate.length} service(s): ${names}`,
      publicUrl: firstPublicUrl,
    };
  }

  if (successful === ordered.length) {
    logger.step("deploy", "completed", `All ${ordered.length} services deployed.`);
  } else if (successful > 0) {
    logger.step(
      "deploy",
      "completed",
      `Deployed ${successful}/${ordered.length} services. ${failed.length} service${failed.length === 1 ? "" : "s"} still need attention.`,
    );
    logger.log(`Deployment completed with warnings: ${warning}\n`, "warn");
  } else {
    logger.step(
      "deploy",
      "failed",
      `${failed.length}/${ordered.length} services failed to deploy.`,
    );
  }

  return {
    status: successful > 0 ? "ready" : "failed",
    summary: {
      total: ordered.length,
      successful,
      failed: failed.length,
      indeterminate: 0,
      failedServices: failedNames,
    },
    services: results,
    warning,
    error: successful > 0 ? undefined : (firstFailure ?? "No services deployed successfully"),
    publicUrl: firstPublicUrl,
  };
}
