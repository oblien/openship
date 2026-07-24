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
import {
  SYSTEM,
  resolveServiceHostnameLabel,
  resolvePublicUrlPlaceholders,
  getAppPrepareSteps,
  type ComposeAdvanced,
} from "@repo/core";
import { getRuntimeTemplate } from "../../apps/catalog-source";
import {
  BuildLogger,
  DEFAULT_RESOURCE_CONFIG,
  DockerRuntime,
  allocateHostPort,
  runDeployPipeline,
  type CommandExecutor,
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
import { decryptEnvMap, encrypt } from "../../../lib/encryption";
import { resolveServerHost } from "../../../lib/server-target";
import { containerIdForService } from "../../services/service-container";
import { isConnectionLoss } from "../../../lib/remote-state";
import {
  buildServiceRouteDomains,
  createTrackedSslProvider,
  ensureRouteDomainRecord,
  toRoutedDomainInputs,
  type PlannedRouteDomain,
} from "../../../lib/routing-domains";
import { resolveServiceEndpointUrls, resolveServicePublicEndpoints } from "../../../lib/public-endpoints";
import { ensureManagedEdgeProxy } from "../../../lib/managed-edge-proxy";
import * as sessionManager from "../session-manager";
import { auditPorts } from "../port-audit.service";
import type { PortCheckResult } from "../../../lib/deployment-runtime";
import { resolveServicePort } from "./domain-helpers";
import { buildCompositeRegistration } from "./composite-route";
import { serviceKind } from "./project-services";
import { buildUpstreamUrl, resolveRouteStrategy } from "../../../lib/upstream-url";
import { withLoopbackPublish } from "../../../lib/loopback-publish";

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
  /** Per-domain routing failures on an otherwise-successful deploy (domains are
   *  optional — a routing failure never fails a compose deploy). Surfaced as the
   *  project "routing action required" signal. Empty/absent = all routes OK. */
  routeWarnings?: string[];
  error?: string;
  publicUrl?: string;
  /** Advisory per-service port-probe results (exposed services only). */
  portChecks?: PortCheckResult[];
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

/** Host ports a service publishes via fixed `host:container` mappings. A
 *  container-only spec ("3000") gets a random host port we can't know up front,
 *  so it's skipped. Used to give port-only (no-domain) services a reachable
 *  `http://host:port` fallback for `{{publicUrl:…}}`. */
function hostPublishedPorts(service: Service): number[] {
  const out: number[] = [];
  for (const spec of (service.ports as string[] | null) ?? []) {
    const parts = String(spec).split(":");
    if (parts.length < 2) continue;
    const host = Number(parts[parts.length - 2]);
    if (Number.isFinite(host)) out.push(host);
  }
  return out;
}

/**
 * Persistent on-host root for app template config files bind-mounted into
 * service containers (Kong's `kong.yml`, Postgres init `.sql`). Sibling of the
 * other openship host state (`/var/lib/openship/ssh-keys`); overridable for
 * hosts that keep openship state elsewhere. Files land at
 * `<root>/<projectId>/<service>/<container-path>` — the executor creates parent
 * dirs — and the container-absolute path is appended verbatim so binds are
 * unique and self-describing.
 */
const APP_CONFIG_HOST_ROOT = process.env.OPENSHIP_APP_CONFIG_DIR || "/var/lib/openship/app-config";

function appConfigHostPath(projectId: string, serviceName: string, containerPath: string): string {
  const safeSvc = serviceName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const rel = containerPath.replace(/^\/+/, "");
  // Reject `..` traversal: `rel` is a template-supplied path written on the HOST
  // (and bind-mounted), so a crafted `../../etc/...` must not escape the root.
  if (rel.split("/").some((seg) => seg === "..")) {
    throw new Error(`Unsafe app-config path (directory traversal): ${containerPath}`);
  }
  return `${APP_CONFIG_HOST_ROOT}/${projectId}/${safeSvc}/${rel}`;
}

/** A service's public endpoints as DeployConfig entries (free slug resolved via
 *  the hostname-label default, custom hostname passed through). */
function serviceDeployPublicEndpoints(
  project: Project,
  service: Service,
): Array<{ port: number; domain?: string; customDomain?: string; domainType: "free" | "custom" }> {
  const out: Array<{
    port: number;
    domain?: string;
    customDomain?: string;
    domainType: "free" | "custom";
  }> = [];
  for (const endpoint of resolveServicePublicEndpoints(service)) {
    if (endpoint.port === undefined) continue;
    if (endpoint.domainType === "custom") {
      out.push({ port: endpoint.port, customDomain: endpoint.customDomain, domainType: "custom" });
      continue;
    }
    const slug = resolveServiceHostnameLabel(
      project.slug ?? project.name,
      service.name,
      endpoint.domain ?? undefined,
      serviceKind(service),
    );
    out.push({ port: endpoint.port, domain: slug, domainType: "free" });
  }
  return out;
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
  /** Previous deployment's workspace id (cloud) — reuse to keep the disk. */
  previousWorkspaceId?: string;
}): MultiServiceDeployConfig {
  const { project, dep, service, image, environment, resources, previousWorkspaceId } = opts;
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
    // "update" trigger → force a fresh pull so a moved mutable tag (:latest/:1)
    // actually rolls forward. Every other trigger stays pull-if-missing.
    forcePull: dep.trigger === "update",
    advanced: service.advanced ?? undefined,
    resources,
    expose: service.exposed,
    publicPort: resolveServicePublicPort(service),
    publicSlug: resolveServicePublicSlug(project, service),
    customDomain: resolveServiceCustomDomain(service),
    previousWorkspaceId,
    dependsOn: (service.dependsOn as string[]) ?? undefined,
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
  const publicSlug = resolveServicePublicSlug(project, service);
  const servicePublicEndpoints = service.exposed
    ? serviceDeployPublicEndpoints(project, service)
    : [];

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
    publicEndpoints: servicePublicEndpoints.length > 0 ? servicePublicEndpoints : undefined,
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

async function prepareServiceRoutes(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  routeContext?: ServiceRouteContext;
  logger: BuildLogger;
}): Promise<{ routes: PlannedRouteDomain[]; warnings: string[] }> {
  const { project, service, runtimeName, routeContext, logger } = opts;
  if (!routeContext) return { routes: [], warnings: [] };

  // One route per public endpoint (a multi-port service gets several). Ensure a
  // domain record for each before it's registered.
  const routes = buildServiceRouteDomains({
    project,
    service,
    runtimeName,
    usesManagedRouting: routeContext.usesManagedRouting,
    domainByHostname: routeContext.domainByHostname,
  });

  const ensured: PlannedRouteDomain[] = [];
  const warnings: string[] = [];
  for (const route of routes) {
    const domainKey = route.hostname.toLowerCase();
    const beforeRecord = routeContext.domainByHostname.get(domainKey);
    try {
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
      ensured.push(route);
    } catch (err) {
      // Owned by another project / unclaimable → skip it entirely (NOT routed,
      // or we'd hijack their hostname). Domains are optional — never fatal.
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.log(
        `Skipping domain "${route.hostname}" for "${service.name}" (not routed — ${message}).\n`,
        "warn",
        { serviceName: service.name },
      );
      warnings.push(`${route.hostname}: ${message}`);
    }
  }

  return { routes: ensured, warnings };
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
    /** Decoupled single-service provision (add/Start one app, reusing the
     *  ACTIVE deployment id — not a fresh one). Strictly scopes the run to
     *  `targetServiceIds`: non-targets are never (re)deployed, marked
     *  unavailable, or reaped, and the target's row is UPSERTed (the reused
     *  deployment id may already carry a row for it). Never set by the full/
     *  partial deploy pipeline (which always runs against a fresh deployment). */
    strictScope?: boolean;
    routeOptions?: RouteRegistrationOptions;
    /** Target host command executor (SSH for a server, local for this machine).
     *  Used to write an app template's generated config files (`advanced.files`)
     *  onto the Docker host so they can be bind-mounted read-only into the
     *  service. Null on cloud (no host bind-mount) → file services are skipped. */
    executor?: CommandExecutor | null;
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

  // The project's existing domain rows, keyed by hostname. This drives per-host
  // SSL gating in BOTH the toolchain preflight (below) and the per-service route
  // reconcile (routeContext), so it MUST be built before the preflight — the
  // preflight needs to see a verified custom domain to install certbot (a mapless
  // build would report provisionSsl=false and skip the ssl feature, leaving a
  // verified custom service domain stuck on HTTP with no recovery path).
  const needsDomainMap =
    !!opts?.system ||
    (!!opts?.routing && !!opts.ssl && typeof opts?.usesManagedRouting === "boolean");
  const domainByHostname: Map<string, Domain> = needsDomainMap
    ? new Map(
        (await repos.domain.listByProject(project.id)).map((d) => [d.hostname.toLowerCase(), d]),
      )
    : new Map();

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
    const plannedRoutes = enabled.flatMap((svc) =>
      buildServiceRouteDomains({
        project,
        service: svc,
        runtimeName: runtime.name,
        usesManagedRouting: opts.usesManagedRouting ?? false,
        domainByHostname,
      }),
    );

    await opts.system.ensureFeature("deploy", systemLog);
    // Routing/SSL toolchain is best-effort — domains are optional, so failing to
    // install OpenResty/certbot must NOT fail the deploy. The services still run;
    // routing is flagged action-required and retried later.
    try {
      if (plannedRoutes.length > 0) {
        await opts.system.ensureFeature("routing", systemLog);
      }
      if (plannedRoutes.some((route) => route.provisionSsl)) {
        await opts.system.ensureFeature("ssl", systemLog);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.log(
        `Edge/routing setup failed — deploy continues; services run and routing is retried later: ${message}\n`,
        "warn",
      );
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
    if (dep.trigger === "update") return false; // update = force re-pull + recreate every image service
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
    // Reuses the map built above (needsDomainMap covers this branch).
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
  const portChecks: PortCheckResult[] = [];
  // Per-domain routing failures across all services (domains are optional —
  // never fatal). Aggregated into the deployment's routing action-required signal.
  const composeRouteWarnings: string[] = [];
  let successful = 0;
  let firstPublicUrl: string | undefined;
  const seenRouteDomains = new Set<string>();
  const unavailableServiceNames = new Set<string>();
  // Services whose container STARTED but whose outcome we couldn't confirm
  // because the connection dropped mid-deploy. Not counted as failed — the
  // deploy resolves to `reconciling` and reconciliation reads the true state.
  const indeterminateServiceNames = new Set<string>();

  // Each exposed service's assigned public URL, resolved up front so catalog-app
  // env placeholders like `{{publicUrl:backend}}` can be substituted per service
  // (Convex origins, dashboard→backend, Ghost/n8n URLs).
  // Keyed by `name` (the service's PRIMARY route → the no-port token) AND
  // `name:port` (each endpoint → `{{publicUrl:svc:port}}`), so Convex can wire
  // CLOUD_ORIGIN→:3210 and SITE_ORIGIN→:3211.
  const publicUrlByService = new Map<string, string>();
  for (const s of ordered) {
    const endpointUrls = resolveServiceEndpointUrls(project, s);
    if (endpointUrls.length === 0) continue;
    publicUrlByService.set(s.name, endpointUrls[0].url);
    for (const { port, url } of endpointUrls) {
      publicUrlByService.set(`${s.name}:${port}`, url);
    }
  }
  // Port-only (no-domain) fallback: a service with no public URL but a fixed
  // published host port still resolves `{{publicUrl:…}}` to its reachable
  // `http://host:port` (so e.g. Convex's own CONVEX_CLOUD_ORIGIN and the
  // dashboard's NEXT_PUBLIC_DEPLOYMENT_URL aren't blanked out on a no-domain
  // install). Deterministic host port from the mapping, resolved up front so
  // self-references resolve at env-substitution time.
  const serverHost = await resolveServerHost(dep.organizationId, opts?.serverId).catch(() => null);
  if (serverHost) {
    for (const s of ordered) {
      if (publicUrlByService.has(s.name)) continue;
      const hostPorts = hostPublishedPorts(s);
      if (hostPorts.length === 0) continue;
      const primary = Number(s.exposedPort) || hostPorts[0];
      publicUrlByService.set(s.name, `http://${serverHost}:${primary}`);
      for (const p of hostPorts)
        publicUrlByService.set(`${s.name}:${p}`, `http://${serverHost}:${p}`);
    }
  }

  // loopback-port routing (compose): host ports pinned this deploy, so two
  // services in the same pass never collide on an allocation. Seed with every
  // previous service's port so a fresh allocation never lands on one that a
  // later service is about to reuse.
  const usedHostPorts = new Set<number>();
  for (const prev of previousByServiceId.values()) {
    if (prev.hostPort) usedHostPorts.add(prev.hostPort);
  }

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
        // Decoupled single-service add on a mesh runtime (cloud): this peer is
        // carried (not redeployed), so it's absent from the group's in-memory
        // mesh state. Seed it so the finalize pass rewrites the FULL mesh and
        // the newly-added service and this peer can resolve each other by name.
        // No-op on Docker (live DNS) — registerExistingWorkload is cloud-only.
        if (opts?.strictScope) {
          runtime.registerExistingWorkload?.(group, {
            serviceName: svc.name,
            workspaceId: carried.containerId,
            ip: carriedIp ?? undefined,
            portSpecs: (svc.ports as string[] | null) ?? undefined,
          });
        }
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

    // Strict per-service scope (decoupled single-service provision): never
    // deploy, fail, or mark unavailable a service we weren't asked to touch. A
    // live sibling was already carried forward above; anything else (no prior
    // row, or a dead container) is left exactly as-is — not redeployed. This
    // is what keeps adding one app from re-deploying a freshly-added sibling
    // (→ UNIQUE(deploymentId,serviceId) violation) or bouncing an unrelated one.
    if (opts?.strictScope && opts.targetServiceIds && !opts.targetServiceIds.has(svc.id)) {
      continue;
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
    // Then resolve `{{publicUrl:<service>}}` placeholders to the assigned public URLs.
    const mergedEnv: Record<string, string> = resolvePublicUrlPlaceholders(
      {
        ...decryptedProjectEnv,
        ...depEnv,
        ...((svc.environment as Record<string, string>) ?? {}),
        ...decryptedServiceEnv,
      },
      (name, port) => publicUrlByService.get(port !== undefined ? `${name}:${port}` : name),
    );

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
    const droppedAdvancedKeys = (
      Object.keys(svc.advanced ?? {}) as (keyof ComposeAdvanced)[]
    ).filter((key) => runtime.unsupportedComposeKeys.has(key));
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
      // Cloud stores the workspace id as the service's containerId. Reuse the
      // previous deployment's workspace so its disk (volume data) survives the
      // redeploy. Only meaningful on cloud; docker recreates containers.
      previousWorkspaceId:
        runtime.name === "cloud"
          ? (previousByServiceId.get(svc.id)?.containerId ?? undefined)
          : undefined,
    });

    // Generated config files (app template `advanced.files`): write each onto
    // the Docker host and bind-mount it read-only. `{{publicUrl:…}}` in content
    // resolves the same way as env. Needs a host executor + a runtime that
    // bind-mounts host paths — cloud has neither, so warn-and-skip there.
    const advancedFiles = (svc.advanced as ComposeAdvanced | null)?.files ?? [];
    if (advancedFiles.length > 0) {
      if (runtime.name === "cloud" || !opts?.executor) {
        logger.log(
          `Service "${svc.name}": ${advancedFiles.length} config file(s) require a self-hosted host mount — skipping on the ${runtime.name} runtime.\n`,
          "warn",
          { serviceName: svc.name },
        );
      } else {
        for (const file of advancedFiles) {
          const content = resolvePublicUrlPlaceholders({ __c: file.content }, (name, port) =>
            publicUrlByService.get(port !== undefined ? `${name}:${port}` : name),
          ).__c;
          const hostPath = appConfigHostPath(project.id, svc.name, file.path);
          await opts.executor.writeFile(hostPath, content);
          serviceRuntimeConfig.volumes = [
            ...serviceRuntimeConfig.volumes,
            `${hostPath}:${file.path}:ro`,
          ];
        }
        logger.log(
          `Service "${svc.name}": mounted ${advancedFiles.length} generated config file(s).\n`,
          "info",
          { serviceName: svc.name },
        );
      }
    }

    const serviceDeployConfig = createServiceDeployConfig({
      project,
      dep,
      service: svc,
      image,
      environment: mergedEnv,
      resources: opts?.resources,
      buildSessionId: opts?.buildSessionId,
    });
    const { routes: preparedRoutes, warnings: routeClaimWarnings } = await prepareServiceRoutes({
      project,
      service: svc,
      runtimeName: runtime.name,
      routeContext,
      logger,
    });
    composeRouteWarnings.push(...routeClaimWarnings);
    // Drop hostnames already claimed earlier in this deployment (two services
    // can't share a domain).
    const routes = preparedRoutes.filter((route) => {
      const routeKey = route.hostname.toLowerCase();
      if (seenRouteDomains.has(routeKey)) {
        logger.log(
          `Skipping route for service "${svc.name}" - ${route.hostname} is already assigned in this deployment.\n`,
          "warn",
          { serviceName: svc.name },
        );
        return false;
      }
      seenRouteDomains.add(routeKey);
      return true;
    });
    // Self-hosted proxy routes need a container port (cloud handles exposure via
    // the runtime config). The pipeline fans out one upstream per distinct port.
    const proxyRoutes =
      runtime.name !== "cloud" ? routes.filter((route) => route.targetPort !== undefined) : [];
    if (runtime.name !== "cloud" && routes.length > 0 && proxyRoutes.length === 0) {
      logger.log(
        `Skipping routes for service "${svc.name}" - no routable port configured.\n`,
        "warn",
        { serviceName: svc.name },
      );
    }

    // loopback-port routing (compose parity, mirrors single-app): republish the
    // PRIMARY routed container port on `127.0.0.1:<pinnedHostPort>` so the edge
    // reaches it on loopback and it isn't network-exposed. We OWN the pinned
    // port (reuse the carried one, else allocate avoiding this deploy's picks),
    // so the route resolves to it deterministically — no reading it back from
    // the daemon's ambiguous first-binding. Port-only bindings the user declared
    // for direct access are preserved. Cloud handles exposure itself; bare/no-
    // executor can't publish → skip (route falls back to container-IP/loopback).
    const composeRouteStrategy = resolveRouteStrategy(project.routeStrategy);
    const routedContainerPort = proxyRoutes[0]?.targetPort;
    let servicePinnedHostPort: number | undefined;
    if (
      composeRouteStrategy === "loopback-port" &&
      runtime.name !== "cloud" &&
      routedContainerPort !== undefined &&
      opts?.executor
    ) {
      servicePinnedHostPort =
        previousByServiceId.get(svc.id)?.hostPort ??
        (await allocateHostPort(opts.executor, { avoid: usedHostPorts }));
      usedHostPorts.add(servicePinnedHostPort);
      serviceRuntimeConfig.ports = withLoopbackPublish(
        serviceRuntimeConfig.ports,
        routedContainerPort,
        servicePinnedHostPort,
      );
    }

    let deployedContainerId: string | undefined;
    let deployedContainerCleaned = false;
    try {
      const previous = previousByServiceId.get(svc.id);
      let serviceResult: MultiServiceDeployResult | undefined;
      const serviceLogger = createServicePipelineLogger(logger, svc.name, svc.id);
      const routeDomains = toRoutedDomainInputs(proxyRoutes);
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
          proxyRoutes.length > 0
            ? async (containerId, port) => {
                const strategy = resolveRouteStrategy(project.routeStrategy);
                const sameSvc = serviceResult?.containerId === containerId;
                // Prefer the port WE pinned+published this deploy (deterministic);
                // fall back to the port reported by the deploy result otherwise.
                const hostPort =
                  servicePinnedHostPort ?? (sameSvc ? serviceResult?.hostPort : undefined);
                // loopback-port → the service's published host port; else the
                // container IP (cached from the deploy result when we can).
                if (strategy === "loopback-port" && hostPort) {
                  return buildUpstreamUrl({ strategy, hostPort, containerPort: port });
                }
                const ip = sameSvc ? serviceResult?.ip : await runtime.getContainerIp(containerId);
                return buildUpstreamUrl({ strategy, ip, hostPort, containerPort: port });
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

      // Best-effort routes: a per-domain registration failure is collected, not
      // fatal — the service container is up. Feeds the action-required signal.
      if (deployResult.routeWarnings?.length) {
        composeRouteWarnings.push(...deployResult.routeWarnings);
      }

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
      // The pinned loopback port we published+routed wins over whatever docker
      // happened to report first, so the persisted value matches the live route
      // and the next redeploy reuses the same target.
      const persistedHostPort = servicePinnedHostPort ?? result.hostPort ?? null;

      if (opts?.strictScope) {
        // Reused (active) deployment id → a row for this service may already
        // exist; upsert instead of INSERT to avoid a UNIQUE violation.
        await repos.service.upsertServiceDeployment({
          deploymentId: dep.id,
          serviceId: svc.id,
          serviceName: svc.name,
          containerId: result.containerId,
          status: "success",
          imageRef: image,
          imageDigest: result.imageDigest ?? null,
          hostPort: persistedHostPort,
          ip: result.ip ?? null,
        });
      } else {
        await repos.service.createServiceDeployment({
          deploymentId: dep.id,
          serviceId: svc.id,
          containerId: result.containerId,
          status: "success",
          imageRef: image,
          imageDigest: result.imageDigest ?? null,
          hostPort: persistedHostPort,
          ip: result.ip ?? null,
        });
      }

      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        containerId: result.containerId,
        status: result.status,
        ip: result.ip,
        hostPort: persistedHostPort ?? undefined,
      });
      successful += 1;

      // Broadcast per-service "running" status to SSE subscribers
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "running",
        containerId: result.containerId,
        hostPort: persistedHostPort ?? undefined,
      });

      logger.log(`Service "${svc.name}" deployed successfully.\n`, "info", {
        serviceName: svc.name,
      });

      // Advisory: confirm an exposed service is actually listening on its public
      // port, probed from inside its container/workspace. Never throws; only
      // exposed services with a resolvable public port are probed + recorded.
      const auditPort = resolveServicePublicPort(svc);
      if (auditPort !== undefined && result.containerId) {
        const [pc] = await auditPorts(runtime, result.containerId, [auditPort], logger);
        if (pc) portChecks.push({ ...pc, serviceId: svc.id, serviceName: svc.name });
      }

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

      // Sync the managed edge proxy for EACH free .opsh.io route (a multi-port
      // service has several). Best-effort: the container is already running and
      // any custom domain is routed locally; the edge proxy only wires up the
      // free URL via Openship Cloud, so a failure here (403, slug taken,
      // unreachable) must not flip a healthy service to "failed".
      const managedRoutes = proxyRoutes.filter((r) => r.isCloud && r.managedSubdomain);
      if (routeContext?.usesManagedRouting && managedRoutes.length > 0) {
        for (const managedRoute of managedRoutes) {
          logger.log(`Syncing managed edge proxy for ${managedRoute.hostname}...\n`, "info", {
            serviceName: svc.name,
          });
          try {
            await ensureManagedEdgeProxy(
              routeContext.organizationId,
              managedRoute.managedSubdomain!,
              {
                serverId: routeContext.serverId,
              },
            );
          } catch (edgeErr) {
            const edgeMessage = edgeErr instanceof Error ? edgeErr.message : "Unknown error";
            logger.log(
              `Warning: could not sync managed edge proxy for ${managedRoute.hostname}: ${edgeMessage}. ` +
                `The service is live; this only affects the free ${managedRoute.hostname} URL.\n`,
              "warn",
              { serviceName: svc.name },
            );
          }
        }
      }

      firstPublicUrl ??= proxyRoutes[0]
        ? `https://${proxyRoutes[0].hostname}`
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
            const destroyMessage =
              destroyErr instanceof Error ? destroyErr.message : "Unknown error";
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

  // ── Cross-project service links (internal / shared-network mode) ────────────
  // If this project consumes database apps over the INTERNAL mode, attach its
  // containers to each source app's `openship-<slug>` network so they resolve
  // the DB service alias (e.g. mongo:27017) with no public port. Advisory —
  // mirrors routing/prepare; a link networking failure never fails the deploy.
  if (runtime.attachToExternalNetworks) {
    try {
      const links = await repos.projectConnection.listByTarget(project.id);
      const nets: string[] = [];
      for (const link of links) {
        if (link.mode !== "internal") continue;
        const src = await repos.project.findById(link.sourceProjectId);
        if (src?.slug) nets.push(`openship-${src.slug}`);
      }
      if (nets.length > 0) {
        await runtime.attachToExternalNetworks(project.id, nets);
        logger.log(`Attached to ${nets.length} connected service network(s).\n`, "info");
      }
    } catch (err) {
      logger.log(
        `Warning: could not attach linked service networks: ${err instanceof Error ? err.message : String(err)}\n`,
        "warn",
      );
    }
  }

  // ── App post-deploy prepare steps ──────────────────────────────────────────
  // Run any template-declared prepare command INSIDE the target service's
  // container (e.g. Convex mints its admin key from INSTANCE_SECRET+INSTANCE_NAME)
  // and persist the captured value as a service env var, so the app's Connection
  // card can surface it — the user never shells in. Advisory: mirrors the port
  // audit; a failure is logged and never fails the deploy.
  if (project.appTemplateId) {
    const template = getRuntimeTemplate(project.appTemplateId);
    for (const step of template ? getAppPrepareSteps(template) : []) {
      try {
        const service = services.find((s) => s.name === step.service);
        const result = service ? results.find((r) => r.serviceId === service.id) : undefined;
        if (!service || !result?.containerId) continue;

        // `once`: skip when the value was already captured on a prior deploy.
        if (step.once && step.persistAs) {
          const existing = await repos.project
            .getEnvMap(project.id, dep.environment, service.id)
            .catch(() => ({}) as Record<string, string>);
          if (existing[step.persistAs.key]) continue;
        }

        const containerId = await containerIdForService(dep, service);
        const exec = containerId ? await runtime.inContainerExecutor?.(containerId) : null;
        if (!exec) continue;

        // The backend may still be finishing startup right after "running", so
        // retry a few times until the in-container command succeeds.
        let stdout = "";
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            stdout = await exec.exec(step.command, { timeout: 15_000 });
            break;
          } catch (e) {
            if (attempt === 5) throw e;
            await new Promise((r) => setTimeout(r, 3_000));
          }
        }

        const value = step.capturePattern
          ? (new RegExp(step.capturePattern).exec(stdout)?.[1] ?? "").trim()
          : stdout.trim();
        if (!value) {
          logger.log(`Warning: prepare step "${step.capture}" produced no output\n`, "warn");
          continue;
        }
        if (step.persistAs) {
          await repos.project.mergeEnvVars(
            project.id,
            dep.environment,
            [
              {
                key: step.persistAs.key,
                value: encrypt(value),
                isSecret: step.persistAs.secret ?? false,
              },
            ],
            [],
            service.id,
          );
          logger.log(`Prepared ${step.capture} → ${step.persistAs.key}\n`, "info");
        }
      } catch (err) {
        logger.log(
          `Warning: app prepare step "${step.capture}" failed: ${err instanceof Error ? err.message : String(err)}\n`,
          "warn",
        );
      }
    }
  }

  // Final service-mesh convergence pass (cloud only — docker has live DNS and
  // implements no finalize). Now that every service's workspace exists, this
  // re-resolves any late-assigned private IP and rewrites the full mesh
  // (/etc/hosts + private links + ingress) so every peer is reachable by name —
  // the per-service sync inside the loop only ever saw the IPs known at its
  // moment, so a slow-to-assign IP would otherwise stay missing from the mesh.
  if (runtime.finalizeServiceGroup) {
    try {
      await runtime.finalizeServiceGroup(group, logger.callback);
    } catch (err) {
      logger.log(
        `Warning: service mesh finalize failed: ${err instanceof Error ? err.message : String(err)}\n`,
        "warn",
      );
    }
  }

  // Vercel-style single-domain composition: when the monorepo is exactly one
  // static frontend + one server backend, serve both on ONE domain (frontend at
  // `/`, backend reverse-proxied at `/api/` or the vercel.json rewrite prefix).
  // Best-effort + additive: it only fires when every piece resolves (frontend
  // IP+port+domain, backend IP+port) on a self-hosted runtime, and any failure
  // just leaves the per-service routes already registered in the loop. NOTE:
  // the static frontend must be exposed with a routable port for this to form
  // (otherwise buildServiceRouteDomain/port resolution yields nothing and we
  // no-op) — verify end-to-end on a live self-hosted deploy.
  if (routeContext?.routing && runtime.name !== "cloud") {
    try {
      // Reusable routing core (shared with the routing API): resolve each
      // service's live upstream from this deploy's results + its public domain.
      const composite = buildCompositeRegistration({
        services: enabled,
        routingConfig: project.routingConfig,
        resolveTargetUrl: (serviceId) => {
          const svc = enabled.find((s) => s.id === serviceId);
          const res = results.find((r) => r.serviceId === serviceId);
          const port = svc ? resolveServicePublicPort(svc) : undefined;
          if (!port) return null;
          return buildUpstreamUrl({
            strategy: resolveRouteStrategy(project.routeStrategy),
            ip: res?.ip,
            hostPort: res?.hostPort,
            containerPort: port,
          });
        },
        resolveDomain: (serviceId) => {
          const svc = enabled.find((s) => s.id === serviceId);
          // Composite (vercel-style single-domain) uses the service's PRIMARY route.
          const domain = svc
            ? (buildServiceRouteDomains({
                project,
                service: svc,
                runtimeName: runtime.name,
                usesManagedRouting: routeContext.usesManagedRouting,
              })[0] ?? null)
            : null;
          return domain
            ? { hostname: domain.hostname, isCustomDomain: domain.domainType === "custom" }
            : null;
        },
      });
      if (composite) {
        const r = composite.register;
        await routeContext.routing.registerRoute({
          domain: r.hostname,
          tls: true,
          targetUrl: r.targetUrl!,
          ...(r.proxyLocations?.length ? { proxyLocations: r.proxyLocations } : {}),
          ...(r.redirects?.length ? { redirects: r.redirects } : {}),
          ...(r.headerRules?.length ? { headerRules: r.headerRules } : {}),
        });
        logger.log(
          `Composed single domain ${r.hostname}: frontend at "/", backend proxied per vercel.json.\n`,
        );
      }
    } catch (err) {
      logger.log(
        `Single-domain composition skipped: ${err instanceof Error ? err.message : "error"} (services remain on their own routes).\n`,
        "warn",
      );
    }
  }

  // Skip all reaping under strict scope: adding/starting ONE service must never
  // destroy another service's (or the main app's) container as a side effect.
  if (!opts?.strictScope) {
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
  }

  // Reap a previous SINGLE-APP container when switching single→multi. The
  // loop above only handles the prior deployment's service_deployment rows;
  // a single-app predecessor has none, leaving its lone container
  // (deployment.containerId) with no owner. Destroy it unless it's the
  // "compose" sentinel or one of the per-service containers already handled
  // (the compose→compose case, where prevDep.containerId IS a service row).
  if (project.activeDeploymentId && !opts?.strictScope) {
    const prevDep = await repos.deployment.findById(project.activeDeploymentId);
    const prevContainerId = prevDep?.containerId;
    // Only reap when the predecessor was a GENUINE single-app deploy. If that
    // deployment has any service_deployment rows, it was already a services
    // deploy — its `containerId` is a SERVICE container (or the "compose"
    // sentinel), NOT a lone single-app container. Stopping it here would kill a
    // running service (e.g. a per-service Start/redeploy stopping its own
    // container). This is what made adding a service to a single-app project
    // stop the service it had just started.
    const prevWasServices = prevDep
      ? (await repos.service.listByDeployment(prevDep.id).catch(() => [])).length > 0
      : false;
    const handledContainerIds = new Set(
      previousServiceDeps.map((row) => row.containerId).filter((id): id is string => !!id),
    );
    if (
      prevContainerId &&
      prevContainerId !== "compose" &&
      !prevWasServices &&
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
      portChecks,
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
    ...(composeRouteWarnings.length ? { routeWarnings: composeRouteWarnings } : {}),
    error: successful > 0 ? undefined : (firstFailure ?? "No services deployed successfully"),
    publicUrl: firstPublicUrl,
    portChecks,
  };
}
