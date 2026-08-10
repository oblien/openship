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
  normalizeServiceLabel,
  buildPublicUrlLookup,
  servicePortPairs,
  resolvePublicUrlTemplate,
  getAppPrepareSteps,
  resolveProjectVolumes,
  sanitizeProxySettings,
  UNLIMITED_RESOURCES,
  type ComposeAdvanced,
  type ProxySettings,
} from "@repo/core";
import { getTemplateForOrg } from "../../apps/catalog-source";
import { attachLinkedNetworks } from "../attach-linked-networks";
import {
  BuildLogger,
  DockerRuntime,
  allocateHostPort,
  elevatedExecutor,
  resolveEnvironment,
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
import { isLoopbackHost, resolveServerHost } from "../../../lib/server-target";
import { resolveEdgeTargetHost } from "../../../lib/edge-target";
import { containerIdForService } from "../../services/service-container";
import { isConnectionLoss } from "../../../lib/remote-state";
import {
  buildServiceRouteDomains,
  createTrackedSslProvider,
  ensureRouteDomainRecord,
  hostTerminatesTlsLocally,
  toRoutedDomainInputs,
  type PlannedRouteDomain,
} from "../../../lib/routing-domains";
import { resolveServiceEndpointUrls, resolveServicePublicEndpoints } from "../../../lib/public-endpoints";
import { ensureManagedEdgeProxy } from "../../../lib/managed-edge-proxy";
import { ensureRoutingReady } from "../../../lib/edge-reconcile";
import * as sessionManager from "../session-manager";
import { isStaticService, parseServicePort } from "../../../lib/deployable-service";
import { computeKeepSet } from "../image-gc";
import { auditPorts } from "../port-audit.service";
import {
  recordUnstableServices,
  verifyDeployedContainers,
  type StabilityTarget,
} from "../stability-audit.service";
import { resolveReadinessGate, type ResolvedReadinessGate } from "../readiness-gate";
import type { PortCheckResult } from "../../../lib/deployment-runtime";
import { resolveServicePort } from "./domain-helpers";
import { buildCompositeRegistration, buildDomainFanoutRegistrations } from "./composite-route";
import { newerThanRestoredRelease, serviceKind } from "./project-services";
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
    /**
     * Host directory this service's built files live in — set INSTEAD of
     * containerId/ip/hostPort for a self-hosted static sub-app, which the edge
     * serves from disk rather than proxying to a container. Consumed by the
     * composite route resolver.
     */
    staticRoot?: string;
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

/**
 * Every `{{publicUrl:…}}` key for a deploy: `<name>` (the service's primary URL)
 * and `<name>:<port>` for each ROUTED container port plus each published
 * host/container port. Two sources only — a PERSISTED route (a hostname a human
 * chose) and the honest `http://<host>:<hostPort>` a published port answers on —
 * and a route always wins the port it owns.
 *
 * Per-port entries are filled for EVERY service, including one that already has a
 * primary URL. Convex routes :3210 to a chosen domain and leaves :3211 port-only;
 * skipping the whole service once :3210 resolved left `{{publicUrl:backend:3211}}`
 * with no entry at all, which became `CONVEX_SITE_ORIGIN=""` in the container.
 */
export function buildServicePublicUrlMap(
  project: Project,
  services: readonly Service[],
  host: string | null,
): Map<string, string> {
  return buildPublicUrlLookup(
    services.map((svc) => ({
      name: svc.name,
      routedUrls: new Map(
        resolveServiceEndpointUrls(project, svc).map(({ port, url }) => [port, url]),
      ),
      portPairs: servicePortPairs(svc.ports as string[] | null),
      primaryPort: parseServicePort(svc.exposedPort) ?? undefined,
    })),
    host,
  );
}

/** One env key whose `{{publicUrl:…}}` token(s) resolved to nothing. */
export interface UnresolvedEnvPublicUrl {
  key: string;
  tokens: string[];
}

/**
 * Substitute `{{publicUrl:…}}` across a merged env map, REPORTING every key that
 * couldn't be resolved and OMITTING it.
 *
 * A half-resolved origin is not a value. `CONVEX_SITE_ORIGIN=""` reads as
 * "configured, deliberately blank" to the container and there is nothing in it
 * that says otherwise, so the variable is left UNSET (the image's own default
 * applies) and the caller warns loudly instead.
 */
export function resolveEnvPublicUrls(
  env: Record<string, string>,
  urlForService: (serviceName: string, port?: number) => string | undefined,
): { env: Record<string, string>; unresolved: UnresolvedEnvPublicUrl[] } {
  const out: Record<string, string> = {};
  const unresolved: UnresolvedEnvPublicUrl[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    const resolved = resolvePublicUrlTemplate(value, urlForService);
    if (resolved.unresolved.length > 0) {
      unresolved.push({ key, tokens: resolved.unresolved.map((p) => p.token) });
      continue;
    }
    out[key] = resolved.value;
  }
  return { env: out, unresolved };
}

/** The four env layers a compose service is deployed with, before token resolution. */
export interface ServiceEnvLayers {
  /** Project-scoped rows, live. */
  project: Record<string, string>;
  /** This deployment's frozen capture (`dep.envVars`, decrypted). Flat, unscoped. */
  frozen: Record<string, string>;
  /** The compose file's inline `environment:` for this service. */
  inline: Record<string, string>;
  /** Service-scoped rows for this service, live. */
  service: Record<string, string>;
}

/**
 * Layer a service's env. Service rows beat inline compose env beats project rows,
 * so the compose UI can override a global per service.
 *
 * `frozenWins` moves the frozen layer LAST, which is what makes a rollback replay
 * the release it restores instead of running old code against today's config —
 * the one combination nobody ever ran. It is layered last rather than used alone
 * because `dep.envVars` is flat and unscoped: it cannot express "this key was
 * never set here", so dropping the live layers would delete keys the snapshot
 * never captured. Last-wins shadows exactly the keys the release had.
 *
 * It shadows inline and service-scoped values too, which for a key that was
 * project-scoped at capture and is service-scoped now means one value lands on
 * every service. That case is unresolvable from a flat map, so it is surfaced per
 * key as `scopeAmbiguous` in the rollback confirm diff rather than hidden.
 */
export function mergeServiceDeployEnv(
  layers: ServiceEnvLayers,
  frozenWins: boolean,
): Record<string, string> {
  return {
    ...layers.project,
    ...(frozenWins ? {} : layers.frozen),
    ...layers.inline,
    ...layers.service,
    ...(frozenWins ? layers.frozen : {}),
  };
}

/**
 * Host a CONTAINER may dial to reach a published HOST port on the box this deploy
 * targets, or `{ host: null, reason }`.
 *
 * A server row's `sshHost` is display-only for the local "This Server" row —
 * self-server.ts writes `127.0.0.1` there when no public address was known — and
 * inside a container `127.0.0.1` is the container itself, so injecting it hands
 * the app a self-referential origin. Loopback is therefore treated as UNKNOWN and
 * the one edge-target resolver is asked for this box's real address rather than a
 * host being invented here. Cloud publishes no host port to dial, so it stays
 * unresolved there (the reason is surfaced in the deploy log).
 */
export async function resolvePortOnlyEnvHost(
  organizationId: string,
  opts: { serverId?: string; cloudRuntime?: boolean } = {},
): Promise<{ host: string | null; reason?: string }> {
  const stored = await resolveServerHost(organizationId, opts.serverId).catch(() => null);
  if (stored && !isLoopbackHost(stored)) return { host: stored };
  if (opts.cloudRuntime) {
    return { host: null, reason: "the cloud runtime publishes no host port to dial" };
  }
  const edge = await resolveEdgeTargetHost(organizationId, { serverId: opts.serverId }).catch(
    () => null,
  );
  if (edge?.host) return { host: edge.host };
  return {
    host: null,
    reason:
      edge?.reason ??
      (stored
        ? `the target server's only known address is ${stored}, which inside a container is the container itself`
        : "no address is known for the target server"),
  };
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

/**
 * Wall-clock ceiling for the whole advisory port audit of a stack.
 *
 * The audit is always-on (it's the source of the dashboard's "is that the right
 * port?" hint), so unlike the opt-in readiness gate it can't be turned off — which
 * means it must be bounded. Mirrors `PORT_CHECK_BUDGET_MS` in
 * projects/port-check.service.ts, which bounds the same probe for the same reason:
 * past the budget, degrade to no hint, never to a stalled deploy.
 */
const PORT_AUDIT_BUDGET_MS = 8000;

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

/**
 * Persistent mounts for one row in the fan-out.
 *
 * A row's own `volumes` always wins. The fallback covers ONE case: the #231
 * materialized app row — the single app's own service row, created when the
 * project gained its first sidecar. Its build fields deliberately inherit from
 * the project snapshot rather than being copied, and storage inherits the same
 * way, so the project's "persistent storage" setting keeps reaching the app
 * after a sidecar is added instead of freezing at whatever it was that day.
 *
 * Deliberately keyed on the app row (a `monorepo` row named after the project)
 * and not on every inheriting row: a real monorepo's sub-apps would otherwise
 * all mount the SAME volume at the same path.
 */
function appRowVolumes(project: Project, service: Service): string[] {
  const own = (service.volumes as string[] | null) ?? [];
  if (own.length > 0) return own;
  const isAppRow = serviceKind(service) === "monorepo" && service.name === project.slug;
  if (!isAppRow) return [];
  return resolveProjectVolumes(project.volumes as string[] | null, project.framework);
}

/**
 * Effective caps for ONE service: its own compose-authored limits override the
 * project-wide config field by field, so a service that declares only
 * `mem_limit` keeps the project's CPU setting.
 *
 * Before this, an uploaded compose file's `mem_limit` / `deploy.resources.limits`
 * were parsed nowhere and silently discarded — a service asking for 4 GB got
 * whatever the project was set to.
 */
function resolveServiceResources(
  service: Service,
  projectResources: ResourceConfig | undefined,
): ResourceConfig | undefined {
  const own = (service.advanced as ComposeAdvanced | null)?.resources;
  if (!own || (own.cpuCores === undefined && own.memoryMb === undefined)) {
    return projectResources;
  }
  const base = projectResources ?? UNLIMITED_RESOURCES;
  return {
    cpuCores: own.cpuCores ?? base.cpuCores,
    memoryMb: own.memoryMb ?? base.memoryMb,
    diskMb: base.diskMb,
  };
}

/** Normalized custom alias(es) for a compose service, drawn from
 *  `service.advanced.alias`. Returns undefined when unset or when it collapses
 *  to the service's own name (the default alias already covers that). */
function aliasExtras(service: Service): string[] | undefined {
  const raw = (service.advanced as ComposeAdvanced | null | undefined)?.alias;
  if (!raw) return undefined;
  const alias = normalizeServiceLabel(raw);
  if (!alias || alias === normalizeServiceLabel(service.name)) return undefined;
  return [alias];
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
  // #332: pass the structured argv for a compose `command` (docker-compose Cmd,
  // no `sh -c`). Only for compose rows — a monorepo sub-app's `startCommand` is a
  // shell string, so force null there to keep the legacy `sh -c` shell behavior.
  const commandArgv = service.startCommand
    ? null
    : ((service.commandArgv as string[] | null) ?? null);
  return {
    deploymentId: dep.id,
    projectId: project.id,
    slug: project.slug,
    serviceName: service.name,
    image,
    ports: (service.ports as string[]) ?? [],
    environment,
    volumes: appRowVolumes(project, service),
    namespaceVolumes: service.namespaceVolumes,
    command: runtimeCommand,
    commandArgv,
    restart: service.restart ?? "unless-stopped",
    // "update" trigger → force a fresh pull so a moved mutable tag (:latest/:1)
    // actually rolls forward. Every other trigger stays pull-if-missing.
    forcePull: dep.trigger === "update",
    advanced: service.advanced ?? undefined,
    // Operator-chosen east-west alias (service.advanced.alias) resolving
    // alongside the default service name. Normalized here; skipped when it
    // collapses to the service name (no extra alias needed).
    extraAliases: aliasExtras(service),
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
    // No fallback tier. An absent config means "no limit" (the runtime omits
    // Memory/NanoCpus entirely) — substituting the cloud free tier here is what
    // capped every compose container at 512 MB regardless of project settings.
    // Cloud callers resolve a concrete tier before reaching this function.
    resources: resources ?? UNLIMITED_RESOURCES,
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
  /**
   * The project's reverse-proxy tunables, sanitized once. Lives on the context
   * because a compose project writes vhosts from FOUR places (per-service
   * container via the deploy pipeline, static service, composite single-domain,
   * path fan-out) and every one of them omitted it — the main app honoured a
   * 50 MB upload limit while the service's own domain 413'd at nginx's 1 MB.
   */
  proxy?: ProxySettings;
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
        // Components + edge convergence as ONE step — see ensureRoutingReady for why
        // the second half can't live inside ensureFeature. Without an executor
        // there's no box to converge (cloud), so components alone are correct.
        if (opts.executor) {
          await ensureRoutingReady(opts.executor, opts.system, {
            onLog: systemLog,
          });
        } else {
          await opts.system.ensureFeature("routing", systemLog);
        }
      }
      // Pending custom routes deliberately skip issuance, but their first
      // deploy must still prepare certbot so automatic/manual verification can
      // issue later without asking for a redeploy.
      if (plannedRoutes.some((route) => route.requiresSslTooling)) {
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

  // A rollback replays a release, so the env frozen with it wins over today's
  // rows (see `mergeServiceDeployEnv`). Derived here from the trigger so no
  // caller and no option has to opt in. The rollback confirm dialog shows which
  // keys this shadows, by key and direction, before the operator commits.
  const frozenEnvWins = dep.trigger === "rollback" && Object.keys(depEnv).length > 0;
  if (frozenEnvWins) {
    logger.log(
      `Rollback: replaying the ${Object.keys(depEnv).length} environment variable(s) frozen with this release; they override current project/service values.\n`,
      "info",
    );
  }

  // 4. Load previous service containers so each service is replaced in-place
  //    instead of tearing down the whole app before the first deploy attempt.
  const previousServiceDeps = project.activeDeploymentId
    ? await repos.service.listByDeployment(project.activeDeploymentId)
    : [];
  const previousByServiceId = new Map(previousServiceDeps.map((row) => [row.serviceId, row]));
  const enabledServiceIds = new Set(enabled.map((svc) => svc.id));

  // Images every retained release still needs (active + pinned + the newest
  // `rollbackWindow` deployments, per service). Loaded lazily and ONCE per
  // deploy — it's only consulted when a service actually supersedes an image,
  // and the same keep set the image GC and retention prune use, so "what is
  // still restorable" has exactly one definition.
  let keepSetPromise: Promise<Set<string>> | null = null;
  const retentionKeepSet = () => {
    keepSetPromise ??= computeKeepSet(project).catch(() => new Set<string>());
    return keepSetPromise;
  };

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

  // Rollback: a service added after the release being restored is carried
  // forward, not recreated (see newerThanRestoredRelease).
  const isNewerThanRelease = newerThanRestoredRelease(dep);

  // Sanitized rather than passed through: this reaches generated nginx config, and
  // the row can also carry a value seeded from a repo config, not just the API.
  // Resolved HERE, not at the callers, so neither of them (`compose/pipeline.ts`,
  // `service.service.ts`) can forget it — the per-service add path passed no
  // routeOptions at all.
  const proxySettings = sanitizeProxySettings(project.routingConfig?.proxy);

  let routeContext: ServiceRouteContext | undefined;
  if (opts?.routing && opts.ssl && typeof opts.usesManagedRouting === "boolean") {
    // Reuses the map built above (needsDomainMap covers this branch).
    routeContext = {
      routing: opts.routing,
      trackedSsl: createTrackedSslProvider(opts.ssl, domainByHostname, (m) => logger.log(`${m}\n`)),
      usesManagedRouting: opts.usesManagedRouting,
      organizationId: dep.organizationId,
      serverId: opts.serverId,
      ...(opts.routeOptions || proxySettings
        ? {
            routeOptions: {
              ...opts.routeOptions,
              ...(proxySettings ? { proxy: proxySettings } : {}),
            },
          }
        : {}),
      domainByHostname,
      ...(proxySettings ? { proxy: proxySettings } : {}),
    };
  }

  const results: ComposeDeployResult["services"] = [];
  const portChecks: PortCheckResult[] = [];
  /** Exposed services to port-probe, collected in the deploy loop and run together
   *  after it (see the concurrent audit below). */
  const portAuditTargets: Array<{
    containerId: string;
    port: number;
    serviceId?: string;
    serviceName: string;
  }> = [];
  // Containers THIS deploy created, watched for stability once the whole stack
  // is up. Carried-forward and static services are deliberately absent: a
  // pre-existing container's health isn't this deploy's verdict to give.
  const stabilityTargets: StabilityTarget[] = [];
  /** serviceId → its EFFECTIVE readiness gate (own `advanced.readiness`, else the
   *  project's). Filled as each service starts; read by the watch below. */
  const readinessByServiceId = new Map<string, ResolvedReadinessGate>();
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

  // Each service's public URL keys, resolved up front so catalog-app env
  // placeholders like `{{publicUrl:backend}}` / `{{publicUrl:backend:3211}}` can be
  // substituted per service (Convex origins, dashboard→backend, Ghost/n8n URLs).
  // Persisted route first, then the honest `http://<host>:<hostPort>` of a
  // published port — PER PORT, so a service with a domain on one port still
  // resolves its other ports.
  const { host: serverHost, reason: serverHostReason } = await resolvePortOnlyEnvHost(
    dep.organizationId,
    { serverId: opts?.serverId, cloudRuntime: runtime.name === "cloud" },
  );
  const publicUrlByService = buildServicePublicUrlMap(project, ordered, serverHost);
  const urlForPublicUrlToken = (name: string, port?: number) =>
    publicUrlByService.get(port !== undefined ? `${name}:${port}` : name);
  /** A `{{publicUrl:…}}` token with no URL behind it is never silent: it lands in
   *  the deploy log AND in the routing warnings that raise action-required. */
  const warnUnresolvedPublicUrl = (serviceName: string, detail: string) => {
    const message =
      `Service "${serviceName}": ${detail}` +
      `${serverHostReason ? ` (${serverHostReason})` : ""}. ` +
      `Assign a domain to the referenced service, or publish a fixed host port for it, then redeploy.`;
    logger.log(`${message}\n`, "warn", { serviceName });
    composeRouteWarnings.push(message);
  };

  // loopback-port routing (compose): host ports pinned this deploy, so two
  // services in the same pass never collide on an allocation. Seed with every
  // previous service's port so a fresh allocation never lands on one that a
  // later service is about to reuse.
  const usedHostPorts = new Set<number>();
  for (const prev of previousByServiceId.values()) {
    if (prev.hostPort) usedHostPorts.add(prev.hostPort);
  }

  // #438: app-template config files (`advanced.files`) are host-side state living
  // under `/var/lib/openship`, the root-owned tree the edge's own vhosts sit in.
  // The deploy executor connects to the host as an UNPRIVILEGED user (e.g.
  // `ubuntu` over host.docker.internal on a Compose install), which cannot
  // `mkdir` under root-owned `/var/lib/openship` — so a plain `writeFile` fails
  // with the reported "No such file". Write these through an elevated (`sudo -n`)
  // executor when the target is a non-root user with passwordless sudo — exactly
  // how the edge writes its own root-owned config. Resolved lazily and cached, so
  // privilege detection is skipped entirely for deploys that ship no config files
  // and never re-run per service.
  let hostConfigWriter: Promise<CommandExecutor> | null = null;
  const resolveHostConfigWriter = (executor: CommandExecutor): Promise<CommandExecutor> => {
    hostConfigWriter ??= (async () => {
      try {
        const env = await resolveEnvironment(executor);
        if (!env.isRoot && env.canSudo) return elevatedExecutor(executor);
      } catch {
        // Privilege probe failed — fall back to the plain executor. A root or
        // already-writable target still succeeds; a locked-down one fails loudly
        // at write time, exactly as it did before this guard.
      }
      return executor;
    })();
    return hostConfigWriter;
  };

  for (const svc of ordered) {
    // Ownership guard - ensure this service actually belongs to the project
    if (svc.projectId !== project.id) continue;

    // Leave a service running exactly as-is (carry its previous runtime row
    // forward under THIS deployment id) instead of recreating it, in three cases:
    //   1. Smart (partial) redeploy — it's not in the target subset.
    //   2. Full/forceAll deploy — it's an unchanged image-only external (isExternalUnchanged).
    //   3. Rollback — it was added AFTER the release being restored.
    // Either way we don't rebuild, recreate, or re-register its route (register
    // is additive; nothing tears it down); it stays in `enabledServiceIds` (so
    // the de-listed reaper won't kill it) and out of `unavailableServiceNames`
    // (so dependents aren't blocked). The liveness check below still redeploys
    // it if its container turns out to be gone.
    const carried =
      (opts?.targetServiceIds && !opts.targetServiceIds.has(svc.id)) ||
      isExternalUnchanged(svc) ||
      isNewerThanRelease(svc)
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
        serviceName: svc.name,
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

    // Layer the env (see `mergeServiceDeployEnv` for the ordering and why a
    // rollback moves the frozen layer last), THEN resolve
    // `{{publicUrl:<service>}}` against live routing — which is why a frozen
    // token still points at today's hostname rather than the release's.
    const { env: mergedEnv, unresolved: unresolvedEnvUrls } = resolveEnvPublicUrls(
      mergeServiceDeployEnv(
        {
          project: decryptedProjectEnv,
          frozen: depEnv,
          inline: (svc.environment as Record<string, string>) ?? {},
          service: decryptedServiceEnv,
        },
        frozenEnvWins,
      ),
      urlForPublicUrlToken,
    );
    if (unresolvedEnvUrls.length > 0) {
      warnUnresolvedPublicUrl(
        svc.name,
        `no public URL is known for ${unresolvedEnvUrls
          .map((u) => `${u.key}=${u.tokens.join("")}`)
          .join(", ")} — ${unresolvedEnvUrls.length === 1 ? "that variable is" : "those variables are"} left UNSET rather than blank`,
      );
    }

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
        serviceName: svc.name,
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
        serviceName: svc.name,
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

    // ── Static sub-app: files on the host, served by the edge ──────────────
    // `image` is a DIRECTORY here, not a tag — the batch builder extracted the
    // build output (staticExtractOnly). There is no container to create, no port
    // to publish and no health check to run: the edge serves the files with
    // `root`. This replaces containerizing an nginx image whose only job was to
    // hand the same files to the edge one hop later.
    //
    // Cloud never reaches this branch: `staticExtractOnly` isn't set there (no host
    // directory to serve), so `image` is a tag and the service deploys as a proxied
    // container exactly as before.
    if (isStaticService(svc) && image.startsWith("/")) {
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "deploying",
      });
      logger.log(`Serving static files for "${svc.name}" from ${image}\n`, "info", {
        serviceName: svc.name,
      });

      // Per-service routes point at the DIRECTORY. Best-effort, matching the rest
      // of routing: a registration failure never fails the deploy.
      if (routeContext?.routing) {
        const { routes: staticRoutes } = await prepareServiceRoutes({
          project,
          service: svc,
          runtimeName: runtime.name,
          routeContext,
          logger,
        });
        for (const route of staticRoutes) {
          const routeKey = route.hostname.toLowerCase();
          if (seenRouteDomains.has(routeKey)) continue;
          seenRouteDomains.add(routeKey);
          await routeContext.routing
            .registerRoute({
              domain: route.hostname,
              staticRoot: image,
              tls: true,
              terminatesTlsLocally: hostTerminatesTlsLocally(
                route.hostname,
                routeContext.domainByHostname.get(routeKey),
              ),
              ...(routeContext.proxy ? { proxy: routeContext.proxy } : {}),
            })
            .catch((err) => {
              composeRouteWarnings.push(
                `${route.hostname}: ${err instanceof Error ? err.message : "route registration failed"}`,
              );
            });
        }
      }

      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        serviceName: svc.name,
        status: "success",
        imageRef: image,
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "running",
        staticRoot: image,
      });
      successful += 1;
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "running",
      });
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
      resources: resolveServiceResources(svc, opts?.resources),
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
        const writer = await resolveHostConfigWriter(opts.executor);
        for (const file of advancedFiles) {
          // Token-local on purpose: one unresolved URL must not blank the whole
          // file (the mount is required — a missing kong.yml is a dead service),
          // so the file is still written and the gap is reported loudly instead.
          const resolved = resolvePublicUrlTemplate(file.content, urlForPublicUrlToken);
          if (resolved.unresolved.length > 0) {
            warnUnresolvedPublicUrl(
              svc.name,
              `generated config ${file.path} references ${resolved.unresolved
                .map((p) => p.token)
                .join(", ")} and no public URL is known for it — that value is written EMPTY`,
            );
          }
          const hostPath = appConfigHostPath(project.id, svc.name, file.path);
          await writer.writeFile(hostPath, resolved.value);
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
      resources: resolveServiceResources(svc, opts?.resources),
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
          serviceName: svc.name,
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
      if (result.containerId) {
        stabilityTargets.push({
          serviceId: svc.id,
          serviceName: svc.name,
          containerId: result.containerId,
          startedAtMs: Date.now(),
        });
        // Effective gate for THIS service: its own `advanced.readiness` when it
        // declares one, else the project's. Captured here because `svc.advanced` is
        // in hand; the watch itself runs after the whole stack is up.
        readinessByServiceId.set(
          svc.id,
          resolveReadinessGate(
            (svc.advanced as ComposeAdvanced | null)?.readiness ?? project.readiness,
          ),
        );
      }

      // Broadcast per-service "running" status to SSE subscribers
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "running",
        containerId: result.containerId,
        hostPort: persistedHostPort ?? undefined,
      });

      // "Started" — not yet "stayed up". The stabilization watch after the loop
      // is what can still demote this to failed.
      logger.log(`Service "${svc.name}" started.\n`, "info", {
        serviceName: svc.name,
      });

      // Advisory: confirm an exposed service is actually listening on its public
      // port. Only COLLECTED here — the probes run together after the loop, since
      // each one can wait up to PORT_AUDIT_TIMEOUT_MS for a port that will never
      // come up, and probing them one-at-a-time inside the loop made a stack of N
      // wrong-port services cost N × that window on the deploy's critical path.
      const auditPort = resolveServicePublicPort(svc);
      if (auditPort !== undefined && result.containerId) {
        portAuditTargets.push({
          containerId: result.containerId,
          port: auditPort,
          serviceId: svc.id,
          serviceName: svc.name,
        });
      }

      // Reclaim the image this service just moved off — UNLESS it's still in the
      // retention keep set. A rollback restore re-deploys a past release's own
      // tag, so two deployment rows legitimately reference one image; removing
      // "the previous one" then deletes an image another retained release (or the
      // one we just restored FROM, if the user rolls forward again) still needs.
      if (previous?.imageRef && previous.imageRef !== image && runtime instanceof DockerRuntime) {
        const keep = await retentionKeepSet();
        if (keep.has(previous.imageRef)) {
          logger.log(
            `Keeping previous image for "${svc.name}" — still within the rollback window.\n`,
            "info",
            { serviceName: svc.name },
          );
        } else {
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
          serviceName: svc.name,
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
          serviceName: svc.name,
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

  // ── Advisory port audit, all services at once ──────────────────────────────
  // Concurrent + budget-capped, because this is the one post-start wait that is
  // NOT opt-in: it's how the dashboard learns to offer "is that the right port?",
  // so it stays on by default — but it must not be able to dominate a deploy.
  // Sequentially inside the loop, a stack whose services never bind cost one full
  // probe window EACH; concurrently the whole audit costs one window, and the
  // budget caps even that. Every probe is guaranteed non-throwing (auditPorts
  // resolves to `checked:false` rather than rejecting), so the only thing the race
  // can lose is the hint itself — never the deploy.
  if (portAuditTargets.length > 0) {
    const probes = Promise.all(
      portAuditTargets.map(async (target) => {
        const [pc] = await auditPorts(runtime, target.containerId, [target.port], logger);
        return pc
          ? { ...pc, serviceId: target.serviceId, serviceName: target.serviceName }
          : null;
      }),
    );
    const audited = await Promise.race([
      probes,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PORT_AUDIT_BUDGET_MS)),
    ]);
    if (audited) {
      for (const pc of audited) if (pc) portChecks.push(pc);
    } else {
      logger.log(
        `Port check: skipped the "is that the right port?" hint for ` +
          `${portAuditTargets.length} service(s) — the probes didn't finish within ` +
          `${Math.round(PORT_AUDIT_BUDGET_MS / 1000)}s. The deploy is unaffected.\n`,
        "warn",
      );
    }
  }

  // ── Cross-project service links (internal / shared-network mode) ────────────
  // Attach this consumer's containers to each internally-linked source app's
  // `openship-<slug>` network so injected internal hosts resolve (see the shared
  // helper). Advisory — a link-networking failure never fails the deploy.
  await attachLinkedNetworks(project.id, runtime, (m, level) => logger.log(`${m}\n`, level));

  // ── Stabilization: did the containers we just created STAY up? ───────────────
  // Up to here "success" meant docker accepted the create+start call, which a
  // container whose command dies instantly also does — and `restart: always`
  // then hides the crash behind a bounce loop that every status read shows as
  // "Up 1 second". So watch them for a window and demote what didn't hold.
  //
  // Runs HERE, after every container exists and the linked networks are
  // attached, for a reason: a service that waits on a peer (database still
  // running initdb) legitimately restarts a couple of times, and gating each
  // service inline as it was created would fail the deploy for a stack that
  // converges seconds later. Watching them together, after the stack is whole,
  // separates "bouncing hard" from "waited, then settled".
  // Gated on the opt-in readiness gate, PER SERVICE: a service's own
  // `advanced.readiness` wins, else the project's. resolveReadinessGate is the one
  // place that policy lives, so this and the single-app path can't drift. Default
  // is OFF — the stack reports what docker reported, while each service's own
  // Docker HEALTHCHECK (`advanced.healthcheck`) keeps running regardless, since
  // the daemon owns that one and it never gates a deploy.
  const watched = stabilityTargets.filter(
    (t) => t.serviceId && readinessByServiceId.get(t.serviceId)?.stabilization.enabled,
  );
  const stabilityWarnings: string[] = [];
  if (watched.length > 0) {
    // One wall-clock window covers every container (verifyDeployedContainers
    // watches them concurrently), so take the longest any watched service asked
    // for rather than running the audit once per distinct window.
    const windowMs = Math.max(
      ...watched.map((t) => readinessByServiceId.get(t.serviceId!)!.stabilization.windowMs),
    );
    const findings = await verifyDeployedContainers(runtime, watched, logger, { windowMs });
    for (const finding of findings) {
      if (finding.verdict.ok && finding.verdict.warning) {
        stabilityWarnings.push(`${finding.target.serviceName}: ${finding.verdict.warning}`);
      }
    }

    // Failure action is per service too: one service may veto the deploy while
    // another only warns.
    const vetoing = findings.filter(
      (f) =>
        !f.verdict.ok &&
        f.target.serviceId &&
        readinessByServiceId.get(f.target.serviceId)?.onFailure === "fail",
    );
    for (const finding of findings.filter(
      (f) => !f.verdict.ok && !vetoing.includes(f),
    )) {
      // "warn": say what didn't hold, but leave the service's deploy result alone
      // so the stack stays up. Opting into the watch to get the signal must not
      // also opt into a veto.
      stabilityWarnings.push(`${finding.target.serviceName}: ${finding.verdict.reason}`);
    }

    if (vetoing.length > 0) {
      // Rows + SSE are the audit's business; this loop only reconciles the
      // in-memory result set the summary below is computed from.
      const demoted = await recordUnstableServices({
        deploymentId: dep.id,
        findings: vetoing,
        logger,
      });
      for (const result of results) {
        const finding = result.serviceId ? demoted.get(result.serviceId) : undefined;
        if (!finding || result.status === "failed") continue;
        result.status = "failed";
        // `detail` (headline + log tail), not the headline alone: when every
        // service crash-loops this becomes the DEPLOYMENT's errorMessage, and the
        // whole point is that it answers "why" without an SSH session.
        result.error = finding.detail;
        successful = Math.max(0, successful - 1);
        unavailableServiceNames.add(finding.target.serviceName);
      }
    }
  }

  // Services phase closes here (before app-setup) so the stepper never marks
  // services done AFTER setup ran. successful===0 ⇒ nothing came up ⇒ failed.
  sessionManager.broadcastInstallPhase(dep.id, {
    id: "services",
    status: successful > 0 ? "done" : "failed",
  });

  // ── App prepare steps (in-container lifecycle hooks) ────────────────────────
  // Run template-declared prepare commands INSIDE the target service's container
  // (e.g. Convex mints its admin key from INSTANCE_SECRET+INSTANCE_NAME) and
  // persist the captured value as a service env var, so the app's Connection card
  // can surface it — the user never shells in. All execution is strictly
  // in-container. `phase`: "post-start" (default) runs once the container is up;
  // "post-ready" waits on a readiness probe first; "pre-deploy" is reserved (no
  // init-container yet) and skipped with a notice. Advisory by default (failure
  // logged, deploy unaffected); a `mustSucceed` step fails the deploy.
  let prepareFailure: string | null = null;
  if (project.appTemplateId) {
    const template = await getTemplateForOrg(project.organizationId, project.appTemplateId);
    const prepareSteps = template ? getAppPrepareSteps(template) : [];
    if (prepareSteps.length > 0) {
      sessionManager.broadcastInstallPhase(dep.id, { id: "app-setup", status: "active" });
    }
    for (const step of prepareSteps) {
      const phase = step.phase ?? "post-start";
      if (phase === "pre-deploy") {
        logger.log(
          `Skipping prepare step "${step.capture}": phase "pre-deploy" isn't supported yet ` +
            `(use files + dependsOn + healthcheck for pre-run init).\n`,
          "warn",
        );
        continue;
      }
      try {
        const service = services.find((s) => s.name === step.service);
        const result = service ? results.find((r) => r.serviceId === service.id) : undefined;
        if (!service || !result?.containerId) continue;
        // Don't exec into a container the stabilization watch just failed: a
        // `mustSucceed` step would report ITS timeout as the deploy's cause and
        // bury the crash loop that actually explains everything.
        if (result.status === "failed") continue;

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

        // phase:"post-ready" — gate on the readiness probe passing (a real
        // signal) before running the command, rather than the fixed retry below.
        if (phase === "post-ready" && step.readiness) {
          const { test, interval = 3_000, retries = 10 } = step.readiness;
          let ready = false;
          for (let i = 0; i < retries; i++) {
            try {
              await exec.exec(test, { timeout: 15_000 });
              ready = true;
              break;
            } catch {
              await new Promise((r) => setTimeout(r, interval));
            }
          }
          if (!ready) throw new Error("readiness probe never passed");
        }

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
          if (step.mustSucceed) throw new Error("produced no output");
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
        const detail = err instanceof Error ? err.message : String(err);
        if (step.mustSucceed) {
          // Critical init failed → fail the deploy. Return BEFORE the container
          // reaping below so a redeploy's previous version isn't torn down.
          prepareFailure = `Required app setup step "${step.capture}" failed: ${detail}`;
          logger.log(`${prepareFailure}\n`, "error");
          break;
        }
        logger.log(`Warning: app prepare step "${step.capture}" failed: ${detail}\n`, "warn");
      }
    }
    if (prepareSteps.length > 0 && !prepareFailure) {
      sessionManager.broadcastInstallPhase(dep.id, { id: "app-setup", status: "done" });
    }
  }
  if (prepareFailure) {
    sessionManager.broadcastInstallPhase(dep.id, { id: "app-setup", status: "failed" });
    const failedNow = results.filter((r) => r.status === "failed");
    logger.step("deploy", "failed", prepareFailure);
    return {
      status: "failed",
      summary: {
        total: ordered.length,
        successful,
        failed: failedNow.length,
        indeterminate: 0,
        failedServices: failedNow.map((r) => r.serviceName),
      },
      services: results,
      error: prepareFailure,
      publicUrl: firstPublicUrl,
      portChecks,
    };
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
  // Best-effort + additive: it only fires when every piece resolves on a
  // self-hosted runtime, and any failure just leaves the per-service routes already
  // registered in the loop.
  //
  // The frontend resolves as a DOC ROOT (its extracted host directory), so it needs
  // no port and no container — the vhost is `root` at `/` plus the backend proxied
  // at the prefix. It previously required the static frontend to be exposed on a
  // routable port, which meant containerizing an nginx image purely to satisfy the
  // "every target is a URL" assumption.
  if (routeContext?.routing && runtime.name !== "cloud") {
    try {
      // Reusable routing core (shared with the routing API): resolve each
      // service's live upstream from this deploy's results.
      const resolveTargetUrl = (serviceId: string) => {
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
      };
      const composite = buildCompositeRegistration({
        services: enabled,
        routingConfig: project.routingConfig,
        resolveTargetUrl,
        // A static frontend has no upstream — the composite serves it from disk and
        // still proxies the backend at the prefix, in the same vhost.
        resolveStaticRoot: (serviceId) =>
          results.find((r) => r.serviceId === serviceId)?.staticRoot ?? null,
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
          terminatesTlsLocally: hostTerminatesTlsLocally(
            r.hostname,
            routeContext.domainByHostname.get(r.hostname.toLowerCase()),
          ),
          targetUrl: r.targetUrl!,
          ...(r.proxyLocations?.length ? { proxyLocations: r.proxyLocations } : {}),
          ...(r.redirects?.length ? { redirects: r.redirects } : {}),
          ...(r.headerRules?.length ? { headerRules: r.headerRules } : {}),
          ...(routeContext.proxy ? { proxy: routeContext.proxy } : {}),
        });
        logger.log(
          `Composed single domain ${r.hostname}: frontend at "/", backend proxied per vercel.json.\n`,
        );
      }

      // Re-emit any migration path-fan-out domains (a domain whose paths route to
      // DIFFERENT services) from this deploy's live upstreams — persisted on the
      // project so a redeploy reproduces `/v3 → api` instead of dropping it.
      for (const reg of buildDomainFanoutRegistrations({
        routes: project.compositeRoutes,
        resolveTargetUrl,
      })) {
        await routeContext.routing.registerRoute({
          domain: reg.hostname,
          tls: true,
          terminatesTlsLocally: hostTerminatesTlsLocally(
            reg.hostname,
            routeContext.domainByHostname.get(reg.hostname.toLowerCase()),
          ),
          targetUrl: reg.targetUrl!,
          ...(reg.proxyLocations?.length ? { proxyLocations: reg.proxyLocations } : {}),
          ...(routeContext.proxy ? { proxy: routeContext.proxy } : {}),
        });
        logger.log(
          `Composed path-routed domain ${reg.hostname}: ${reg.proxyLocations?.length ?? 0} extra path location(s).\n`,
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
      : // Nothing failed, but something bounced on its way up — worth saying,
        // since a service that restarted twice at boot often restarts in prod.
        stabilityWarnings.length > 0
        ? stabilityWarnings.join("; ")
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
