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
  composeNamespaceDependencies,
  composeNamespaceRef,
  ownsNetworkEndpoint,
  UNLIMITED_RESOURCES,
  safeErrorMessage,
  type ComposeAdvanced,
  type ProxySettings,
} from "@repo/core";
import { getTemplateForOrg } from "../../apps/catalog-source";
import { attachLinkedNetworks } from "../attach-linked-networks";
import {
  auditStaticOutput,
  describeOutputFinding,
  outputFindingIsBroken,
  staticOutputTargets,
} from "../output-audit.service";
import {
  BareRuntime,
  BuildLogger,
  DockerRuntime,
  ensureEdge,
  ownsBuiltImage,
  STATIC_RELEASE_BASE,
  allocateHostPort,
  edgeProxyFor,
  rootOrDegrade,
  resolveEnvironment,
  runDeployPipeline,
  sharedMountExecutor,
  type CommandExecutor,
  type DeployConfig,
  type DeployEnvironment,
  type LogEntry,
  type MultiServiceDeployConfig,
  type MultiServiceDeployResult,
  type MultiServiceRuntimeAdapter,
  type PromptUserFn,
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
import { appConfigHostPath, withAppConfigHost, writeAppConfigFile } from "./app-config-host";
import {
  auditRoutedDomainTls,
  buildProjectRouteDomains,
  buildServiceRouteDomains,
  createTrackedSslProvider,
  ensureRouteDomainRecord,
  hostTerminatesTlsLocally,
  toRoutedDomainInputs,
  withEnsuredDomainRecord,
  type PlannedRouteDomain,
} from "../../../lib/routing-domains";
import {
  pickPrimaryServiceId,
  resolveServiceEndpointUrls,
  resolveServicePublicEndpoints,
} from "../../../lib/public-endpoints";
import { ensureManagedEdgeProxy } from "../../../lib/managed-edge-proxy";
import { ensureRoutingReady } from "../../../lib/edge-reconcile";
import { resolveAcmeProviderOptions } from "../../../lib/acme-config";
import * as sessionManager from "../session-manager";
import {
  isStaticService,
  parseServicePort,
  serviceAliasExtras,
} from "../../../lib/deployable-service";
import { computeKeepSet } from "../image-gc";
import { auditPorts } from "../port-audit.service";
import {
  allocateAndReservePinnedHostPort,
  convergeTargetHostPortClaims,
  convergeTargetHostPortClaimsUnlocked,
  prepareTargetPinnedHostPorts,
  releaseNewPinnedHostPortClaims,
  withHostPortTargetLock,
  type AllocatedPinnedHostPort,
} from "../pinned-host-ports";
import type { HostPortTargetIdentity } from "../../../lib/host-port-target";
import { reserveResolvedLoopbackRoutes } from "../observed-host-port-claims";
import {
  recordUnstableServices,
  verifyDeployedContainers,
  type StabilityFinding,
  type StabilityTarget,
} from "../stability-audit.service";
import { resolveReadinessGate, type ResolvedReadinessGate } from "../readiness-gate";
import { probeDeployedReadiness } from "../readiness-probe";
import { hostChannelDeployNotice, type PortCheckResult } from "../../../lib/deployment-runtime";
import {
  buildProjectServiceUpstream,
  describeCandidatePorts,
} from "../../../lib/project-service-upstream";
import { resolveRouteRedirect } from "../../../lib/domain-redirect";
import { isRealContainerRef } from "../../../lib/container-ref";
import { resolveServicePort } from "./domain-helpers";
import { mergeServiceDeployEnv } from "./service-env-layers";
import { compileProjectRoutingFields } from "../../../lib/project-routing-fields";
import { buildCompositeRegistration, buildDomainFanoutRegistrations } from "./composite-route";
import { collectComposeRoutePortDemands } from "./route-port-demands";
import { newerThanRestoredRelease, serviceKind } from "./project-services";
import {
  OUT_OF_SCOPE_SKIP_REASON,
  isUntargetedAndUndeployable,
  resolveDeployImage,
} from "./service-scope";
import {
  buildUpstreamUrl,
  resolveRouteStrategy,
  usesHostLoopbackUpstream,
} from "../../../lib/upstream-url";
import { withLoopbackPublishAll, upstreamHostPortFor } from "../../../lib/loopback-publish";

export interface ComposeDeployResult {
  /** `reconciling` when at least one service's outcome is UNKNOWN because the
   *  connection dropped after its container started — the deploy can't be
   *  finalized until reconciliation reads the true remote state. */
  status: "ready" | "failed" | "reconciling";
  summary: {
    total: number;
    /** Services that came up — INCLUDING the ones merely carried forward. */
    successful: number;
    /** Services this pass actually (re)created or (re)served. Derived from the
     *  per-service `carried` flag rather than counted alongside `successful`, so a
     *  future success site can't forget to increment it. `deployed === 0` with
     *  `successful > 0` is the all-carried no-op (`composeDeployMadeNoChanges`). */
    deployed: number;
    failed: number;
    /** Services whose container started but whose outcome is unverified
     *  (connection lost mid-deploy). Neither success nor failure yet. */
    indeterminate: number;
    /** This pass changed state OUTSIDE the per-service deploy branch — it reaped a
     *  de-listed container or persisted env. Keeps such a run from being read as a
     *  no-op just because every surviving service was carried. */
    mutated: boolean;
    failedServices: string[];
  };
  /** The container the project's canonical route points at — the primary service's
   *  (`pickPrimaryServiceId`), not `services.find((s) => s.containerId)`, which
   *  follows topoSort order and so named the database an app `dependsOn` (#498).
   *  Undefined when no service came up with a container. */
  primaryContainerId?: string;
  services: Array<{
    serviceId: string;
    serviceName: string;
    containerId?: string;
    status: string;
    ip?: string;
    /** Compatibility scalar for the pinned/primary host port. */
    hostPort?: number;
    /**
     * Every published binding, keyed by CONTAINER port → host port.
     *
     * The scalar above cannot answer "what is port N published on" for a container
     * publishing several: it is the pinned PRIMARY, so a project-level route on any
     * other port was dialed at the primary's publish and reached a different app.
     * Persisted in `service_deployment.host_ports` and also carried on the live
     * result so routing in this pass does not need to read it back.
     */
    hostPortByContainerPort?: Record<number, number>;
    error?: string;
    /** Kept running exactly as-is: nothing built, created, or port-probed. */
    carried?: true;
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
  /**
   * Domains that ARE routed but hold no certificate — `registerRoute` succeeds
   * without one (the edge keeps a bootstrap self-signed cert on :443), so these
   * never appear in `routeWarnings`. Kept as their own list because the remedy is
   * different: point DNS, then Verify — not "retry routing".
   */
  tlsPendingDomains?: string[];
  error?: string;
  publicUrl?: string;
  /** Advisory per-service port-probe results (exposed services only). */
  portChecks?: PortCheckResult[];
}

/**
 * True when this pass created, rebuilt, re-served, reaped and persisted NOTHING —
 * every service was carried forward. Such a run owns no containers and no image of
 * its own, so promoting it to the live release points the project at an empty
 * record (#498).
 *
 * Gated POSITIVELY on `ready` + a non-empty service set rather than on
 * `failed === 0`: the prepare-failure return reports `status: "failed"` with
 * `failed === 0`, and the no-services return reports zeroes for everything, so a
 * negative test would reclassify both as "no changes".
 *
 * Lives here rather than inside `deployComposeServices` because
 * `provisionServiceContainer` calls that directly and needs a genuine failure to
 * keep throwing — only the pipeline settles a deployment row.
 */
export function composeDeployMadeNoChanges(result: ComposeDeployResult): boolean {
  return (
    result.status === "ready" &&
    result.summary.total > 0 &&
    result.summary.deployed === 0 &&
    result.summary.failed === 0 &&
    !result.summary.mutated
  );
}

/**
 * Every service that must be RUNNING before this one is created.
 *
 * `depends_on` is the declared half. The other half is implicit and mandatory: a
 * service sharing a sibling's network or PID namespace resolves to that sibling's
 * container id, and Docker resolves it at create time — so the provider existing
 * is a hard precondition, not a preference. Folding both into one list is what
 * lets the topological sort and the "dependency didn't come up" guard treat them
 * identically, instead of each growing its own idea of what a dependency is.
 */
export function effectiveDependencies(svc: Pick<Service, "dependsOn" | "advanced">): string[] {
  const declared = (svc.dependsOn as string[] | null) ?? [];
  const namespaces = composeNamespaceDependencies(svc.advanced as ComposeAdvanced | null);
  return namespaces.length === 0
    ? declared
    : [...declared, ...namespaces.filter((n) => !declared.includes(n))];
}

export function topoSort(services: Service[]): Service[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const sorted: Service[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(svc: Service) {
    if (visited.has(svc.name)) return;
    if (visiting.has(svc.name)) {
      // Circular dependency — break the cycle by returning, and let this node be
      // emitted by the frame that is ALREADY on the stack for it. Pushing it here
      // instead emitted it twice (once now, once when that frame completed), and a
      // duplicate in `ordered` means the deploy loop runs one service twice —
      // second pass hits the UNIQUE(deploymentId, serviceId) index on its
      // service_deployment row. `visiting` still holds the name, so a deeper
      // re-entry keeps terminating here; there is no order that satisfies a cycle,
      // but every service appears exactly once.
      return;
    }
    visiting.add(svc.name);
    for (const depName of effectiveDependencies(svc)) {
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

/**
 * Turn a service's stored namespace modes into the values Docker takes, or say why
 * it can't be done.
 *
 * `service:<name>` is resolved HERE, against what this deployment actually
 * produced, for two reasons: a reference to a service that isn't in the stack (or
 * that didn't come up) has to fail the dependent rather than reach the daemon as
 * an unresolvable id, and the container id is the unambiguous handle — a name
 * would be re-resolved by the daemon later, after we've stopped watching.
 */
export function resolveServiceNamespaces(
  svc: Pick<Service, "name" | "advanced">,
  containerIdByServiceName: Map<string, string>,
  stackServiceNames: Set<string>,
): { namespaces?: { network?: string; pid?: string }; error?: string } {
  const advanced = svc.advanced as ComposeAdvanced | null;
  const namespaces: { network?: string; pid?: string } = {};

  for (const [key, value, field] of [
    ["network", advanced?.networkMode, "network_mode"],
    ["pid", advanced?.pidMode, "pid"],
  ] as const) {
    const ref = composeNamespaceRef(value, field);
    if (!ref) continue;
    if (ref.kind === "none") {
      namespaces[key] = "none";
      continue;
    }
    if (ref.kind === "container") {
      namespaces[key] = `container:${ref.container}`;
      continue;
    }
    if (ref.service === svc.name) {
      return { error: `${field}: service:${ref.service} refers to itself.` };
    }
    if (!stackServiceNames.has(ref.service)) {
      return {
        error:
          `${field}: service:${ref.service} is not a service in this stack. ` +
          `Reference one of its own services, or use container:<id>.`,
      };
    }
    const containerId = containerIdByServiceName.get(ref.service);
    if (!containerId) {
      return {
        error:
          `${field}: service:${ref.service} has no running container to share, so ` +
          `this service cannot start.`,
      };
    }
    namespaces[key] = `container:${containerId}`;
  }

  return Object.keys(namespaces).length > 0 ? { namespaces } : {};
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
 * Wall-clock ceiling for the whole advisory port audit of a stack.
 *
 * The audit is always-on (it's the source of the dashboard's "is that the right
 * port?" hint), so unlike the opt-in readiness gate it can't be turned off — which
 * means it must be bounded. Mirrors `PORT_CHECK_BUDGET_MS` in
 * projects/port-check.service.ts, which bounds the same probe for the same reason:
 * past the budget, degrade to no hint, never to a stalled deploy.
 */
const PORT_AUDIT_BUDGET_MS = 8000;

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
  for (const endpoint of resolveServicePublicEndpoints(service, {
    projectSlug: project.slug ?? project.name,
  })) {
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

function createServiceRuntimeConfig(opts: {
  project: Project;
  dep: Deployment;
  service: Service;
  image: string;
  environment: Record<string, string>;
  resources?: ResourceConfig;
  /** Docker-ready shared namespaces (`container:<id>` / `none`), pre-resolved. */
  namespaces?: { network?: string; pid?: string };
  /** Previous deployment's workspace id (cloud) — reuse to keep the disk. */
  previousWorkspaceId?: string;
}): MultiServiceDeployConfig {
  const { project, dep, service, image, environment, resources, namespaces, previousWorkspaceId } =
    opts;
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
    extraAliases: serviceAliasExtras(service),
    resources,
    ...(namespaces && { namespaces }),
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
      const ensureResult = await ensureRouteDomainRecord({
        projectId: project.id,
        route,
        domainByHostname: routeContext.domainByHostname,
      });
      const domainRecord = ensureResult.domain;
      if (ensureResult.created && domainRecord) {
        logger.log(`Created domain record for "${route.hostname}".\n`, "info", {
          serviceName: service.name,
        });
      }
      // Re-resolve the SSL gate against the row that exists NOW. The plan above
      // was built from the rows read BEFORE this loop, so a hostname this deploy
      // mints itself was planned with no row at all and came out
      // `provisionSsl: false` — see withEnsuredDomainRecord. A compose service's
      // row is ALWAYS minted here (syncFromCompose writes routing columns and no
      // domain row), so without this a compose custom domain never attempted a
      // certificate on the deploy that created it.
      ensured.push(withEnsuredDomainRecord(route, domainRecord));
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

export interface ComposeDeployOptions {
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
  /** The deploy target is the machine this process runs on (`platform.localHost`).
   *  Host-path writes then go through the host channel instead of `executor`,
   *  which for a plain local target is a LocalExecutor — the CONTAINER's own
   *  filesystem on a Compose install. */
  localHost?: boolean;
  /** Physical TCP bind namespace resolved from the actual deployment target. */
  hostPortTarget?: HostPortTargetIdentity | null;
  /** Interactive edge-conflict hold for a full project deploy. Direct service
   *  starts omit it and fail closed instead of guessing about a foreign proxy. */
  promptUser?: PromptUserFn;
}

/**
 * Deploy all services for a compose project.
 * Called from the compose pipeline after the build phase.
 *
 * Allocation, Docker bind, route registration, and persistence are one
 * target-serialized critical section. This wrapper is intentionally the lock
 * boundary so direct single-service Start/Add calls cannot bypass it.
 */
export async function deployComposeServices(
  project: Project,
  dep: Deployment,
  runtime: MultiServiceRuntimeAdapter,
  logger: BuildLogger,
  opts?: ComposeDeployOptions,
): Promise<ComposeDeployResult> {
  const needsHostPortLock = usesHostLoopbackUpstream(
    resolveRouteStrategy(project.routeStrategy),
    runtime,
  );
  if (!needsHostPortLock) {
    return deployComposeServicesUnlocked(project, dep, runtime, logger, opts);
  }
  if (!opts?.executor) {
    throw new Error("Cannot deploy loopback-routed services without a physical target executor");
  }
  const target = opts?.hostPortTarget;
  if (!target) {
    throw new Error("Cannot deploy loopback-routed services without a physical host identity");
  }
  return withHostPortTargetLock(target, () =>
    deployComposeServicesUnlocked(project, dep, runtime, logger, opts),
  );
}

async function deployComposeServicesUnlocked(
  project: Project,
  dep: Deployment,
  runtime: MultiServiceRuntimeAdapter,
  logger: BuildLogger,
  opts?: ComposeDeployOptions,
): Promise<ComposeDeployResult> {
  // Generated app secrets, BEFORE any env is read below. A catalog app whose install died
  // part-way keeps a service row with the generated values missing, and the installer only
  // writes them for services it created — so webmail reached the container with no
  // SESSION_ENCRYPTION_KEY and crash-looped (#566). The install path repairs that, but
  // Redeploy / Start / a webhook push all arrive HERE without passing through it, and that
  // Redeploy button is the natural next click after seeing a bouncing container.
  //
  // Idempotent (a stored value is reused, never rotated) and best-effort: a repair we
  // could not make must not fail a deploy that would otherwise run.
  if (project.appTemplateId) {
    try {
      const template = await getTemplateForOrg(project.organizationId, project.appTemplateId);
      if (template) {
        // Dynamic: a static import would pull the app-install service — and through it the
        // whole services/auth layer — into every module that imports this one. Same reason
        // mail.service.ts imports deployment-runtime lazily.
        const { ensureGeneratedAppSecrets } = await import("../../apps/app-install.service");
        await ensureGeneratedAppSecrets(project.id, template);
      }
    } catch (err) {
      logger.log(
        `Could not check this app's generated secrets: ${safeErrorMessage(err)}\n`,
        "warn",
      );
    }
  }

  const services = await repos.service.listByProject(project.id);
  const enabled = services.filter((s) => s.enabled);

  if (enabled.length === 0) {
    const hasServices = services.length > 0;
    return {
      status: "failed",
      summary: {
        total: 0,
        successful: 0,
        deployed: 0,
        failed: 0,
        indeterminate: 0,
        mutated: false,
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

  // Say ONCE, up front, that this box can't drive its host (#509). Every host
  // touchpoint below absorbs the refusal on its own terms — the port scan reports
  // "couldn't read occupancy" (and only under loopback-port routing), the routing
  // preflight logs "deploy continues" — so without this the operator's first legible
  // symptom is a service that dies later over a config file that never landed.
  const hostNotice = hostChannelDeployNotice(opts?.executor);
  if (hostNotice) logger.log(`${hostNotice}\n`, "warn");

  const routeStrategy = resolveRouteStrategy(project.routeStrategy);
  const usesHostLoopback = usesHostLoopbackUpstream(routeStrategy, runtime);
  // All route writers use the same effective topology that drove the pre-bind
  // lock, inventory, and allocation. The stored preference can say
  // `container-ip` while a bare/no-containerIp runtime still requires loopback.
  const upstreamStrategy = usesHostLoopback ? "loopback-port" : "container-ip";

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
    const plannedRoutes = [
      ...enabled.flatMap((svc) =>
        buildServiceRouteDomains({
          project,
          service: svc,
          runtimeName: runtime.name,
          usesManagedRouting: opts.usesManagedRouting ?? false,
          domainByHostname,
        }),
      ),
      // PROJECT-LEVEL rows count too. They are registered (and certed) further down,
      // and adoption leaves every service UNEXPOSED on purpose — so the exact shape
      // that needs a project-level route is the one where `buildServiceRouteDomains`
      // returns [] for everything, leaving this preflight to skip the edge and certbot
      // and the registration below to run against a box that has neither.
      ...buildProjectRouteDomains({
        project,
        projectDomains: [...domainByHostname.values()],
        runtimeName: runtime.name,
        usesManagedRouting: opts.usesManagedRouting ?? false,
      }),
    ];
    const needsStrictLoopbackInventory = usesHostLoopback && Boolean(opts.executor);

    await opts.system.ensureFeature("deploy", systemLog);
    // Routing/SSL toolchain is best-effort — domains are optional, so failing to
    // install OpenResty/certbot must NOT fail the deploy. The services still run;
    // routing is flagged action-required and retried later.
    try {
      if (plannedRoutes.length > 0 || needsStrictLoopbackInventory) {
        // Components + edge convergence as ONE step — see ensureRoutingReady for why
        // the second half can't live inside ensureFeature. Without an executor
        // there's no box to converge (cloud), so components alone are correct.
        if (opts.executor) {
          const edge = await ensureEdge(
            opts.executor,
            (promptUser) =>
              ensureRoutingReady(opts.executor!, opts.system!, {
                onLog: systemLog,
                promptUser,
              }),
            {
              promptUser: opts.promptUser,
              onLog: systemLog,
              nginx: resolveAcmeProviderOptions(),
            },
          );
          if (edge.migrated && !edge.ok) {
            logger.log(
              "Edge migration failed and the previous proxy was restored. " +
                "Loopback-routed services will not allocate a port unless its routes can be inventoried safely.\n",
              "warn",
            );
          }
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

  // Service-scoped rows are loaded separately below and must not leak into the
  // project layer or another service.
  const projectEnvMap = await repos.project.getEnvMap(project.id, dep.environment, null);
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
    // A rollback REPLAYS a release: its frozen env (`frozenEnvWins` above) and its
    // pinned images only reach the container by recreating it. Carrying an
    // external forward instead applies neither, so the restore reports success
    // having changed nothing — the same silent-no-op `newerThanRestoredRelease`
    // guards against from the other direction.
    if (dep.trigger === "rollback") return false;
    if (opts?.targetServiceIds) return false; // smart subset already carries non-targets forward
    if (!carryAnchor) return false; // never deployed → deploy it
    if (svc.build || !svc.image) return false; // must be image-only (external); buildables always rebuild
    if (svc.updatedAt > carryAnchor) return false; // image/command/ports/volumes/… changed
    if (carryProjectEnvChanged || carryEnvChangedServiceIds.has(svc.id)) return false; // env changed
    const prev = previousByServiceId.get(svc.id);
    if (!prev?.containerId) return false; // nothing running to carry
    // Against the image this deploy INTENDS, not the service row's: a pinned ref
    // (a rollback replay, a migration cutover's `handoverImages`) arrives via
    // `builtImages` and is first read PAST the carry `continue`, so comparing
    // `svc.image` carried a service whose intended image differed from the running
    // one — comparing the row against itself.
    const intended = opts?.builtImages?.get(svc.id) ?? svc.image;
    if (prev.imageRef && prev.imageRef !== intended) return false;
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

  // Compiled ONCE per deploy, for the same reason `proxySettings` is: it is a property of
  // the project, so every registration below wants the identical object. The static loop
  // recompiled it per route, per service.
  const routingFields = compileProjectRoutingFields(project.routingConfig);

  // Everything a per-service registration carries that belongs to the PROJECT rather than
  // to one upstream. Assembled HERE for the same reason `proxySettings` is, and it is what
  // finally gives a PROXIED compose service its vercel.json rules: the static branch below
  // spreads `routingFields` onto its own registerRoute call, and the composite path compiles
  // its own, but a containerized service routes through `runDeployPipeline` — which only
  // ever saw webhook + proxy here, so a redirect declared for the project applied on every
  // deploy mode EXCEPT this one.
  //
  // Safe against the composite: `registerRoute` is last-writer-wins per hostname and the
  // composite registers AFTER this loop, so a composite domain still ends up with the
  // topology-aware compile (the one that resolves `/api/` to the real backend) rather than
  // the backend-free subset here.
  const serviceRouteOptions: RouteRegistrationOptions = {
    ...opts?.routeOptions,
    ...(proxySettings ? { proxy: proxySettings } : {}),
    ...routingFields,
  };

  let routeContext: ServiceRouteContext | undefined;
  if (opts?.routing && opts.ssl && typeof opts.usesManagedRouting === "boolean") {
    // Reuses the map built above (needsDomainMap covers this branch).
    routeContext = {
      routing: opts.routing,
      trackedSsl: createTrackedSslProvider(opts.ssl, domainByHostname, (m) => logger.log(`${m}\n`)),
      usesManagedRouting: opts.usesManagedRouting,
      organizationId: dep.organizationId,
      serverId: opts.serverId,
      // Omitted entirely when there is nothing to carry, so a project with no webhook, no
      // proxy tunables and no vercel.json keeps passing `undefined` rather than an empty
      // object into the pipeline.
      ...(Object.keys(serviceRouteOptions).length ? { routeOptions: serviceRouteOptions } : {}),
      domainByHostname,
      ...(proxySettings ? { proxy: proxySettings } : {}),
    };
  }

  // Compute the COMPLETE loopback demand before any container starts. Service
  // hostnames are only one source: project domains, the monorepo composite, and
  // migration fan-out can all dial an otherwise-unexposed service. Those routes
  // are registered after the service loop, which is too late to add a publish or
  // reserve it safely; their ports must enter the same allocation path now.
  const hostLoopbackRoutePortDemands =
    routeContext && usesHostLoopback
      ? collectComposeRoutePortDemands({
          project,
          services: enabled,
          domainRows: [...domainByHostname.values()],
          previousRows: previousServiceDeps,
          runtimeName: runtime.name,
          usesManagedRouting: routeContext.usesManagedRouting,
        })
      : new Map<string, Set<number>>();

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
  let hostPortClaimWarning: string | undefined;
  // Claim convergence is the final ownership cutover. If an obsolete
  // workload cannot be stopped, its route may still be restored later, so its
  // host-port ownership must remain reserved even though the new routes are up.
  let hostPortClaimReapSafe = true;
  let successful = 0;
  /**
   * Names of services a scoped deploy left alone because it did not target them and they
   * have no image to bring up (#585). Not failures — but not silent either: they are
   * folded into the deploy's `warning` below, so an operator who added a service and then
   * pushed a change to a DIFFERENT one still learns it never came up, without the
   * untargeted service hijacking the deployment's status.
   */
  const skippedOutOfScope: string[] = [];
  /** Set by the state this pass changed OUTSIDE the per-service deploy branch — a
   *  reaped container, persisted env. See `ComposeDeployResult.summary.mutated`. */
  let mutated = false;
  let firstPublicUrl: string | undefined;
  const seenRouteDomains = new Set<string>();
  /**
   * Routes this pass really put on the edge, across all services. Read once at the
   * end by the TLS audit — a registered route with no certificate is the one
   * routing outcome nothing used to report.
   *
   * Only ever appended AFTER the registration it describes succeeded, because the
   * audit's claim ("this IS routed, and has no cert") is false for anything else.
   * The proxied path registers inside `runDeployPipeline`, which throws on a failed
   * health gate with `routeWarnings` unset — so a pre-emptive push there produced
   * exactly that false claim, with no warning for the audit's exclusion to
   * subtract. `auditRoutedDomainTls` still subtracts warned hostnames on top, for
   * the per-domain failures the pipeline DOES report while its other routes land.
   */
  const registeredRoutes: PlannedRouteDomain[] = [];
  const unavailableServiceNames = new Set<string>();
  /**
   * serviceName → the container id currently backing it, for resolving a sibling's
   * `network_mode: service:<name>` / `pid: service:<name>`. Filled as each service
   * settles — both the ones this deploy created and the ones it carried forward,
   * since a namespace provider left running is just as valid a target. The topo
   * sort guarantees a provider is visited before its dependents, so a miss here
   * means the provider genuinely has no container, not that we asked too early.
   */
  const containerIdByServiceName = new Map<string, string>();
  /**
   * Services this pass REPLACED the container of, rather than carrying forward.
   * Read only to decide whether a namespace dependent may still be carried — see
   * the carry-forward guard in the loop.
   */
  const recreatedServiceNames = new Set<string>();
  /**
   * Names in THIS stack — the boundary a `service:` reference may not cross.
   *
   * Every service, not just the enabled ones: a reference to a DISABLED sibling is
   * in-stack but unsatisfiable, and it should say so ("no running container to
   * share") rather than claim the service doesn't exist, which would send the
   * operator looking for a typo they didn't make.
   */
  const stackServiceNames = new Set(services.map((s) => s.name));
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

  // Durable claims cover stopped/crashed containers that a live socket scan
  // cannot see. They are host-scoped: two different servers may safely use the
  // same loopback port. Allocations from THIS pass are tracked separately so a
  // carried claim can be released only for its owner without erasing a sibling.
  const hostPortTarget = opts?.hostPortTarget ?? null;
  const pinnedHostPortClaims =
    usesHostLoopback && opts?.executor
      ? hostPortTarget
        ? await prepareTargetPinnedHostPorts({
            target: hostPortTarget,
            edgeProxy: edgeProxyFor(opts.executor, "openresty", { ours: true }),
          })
        : (() => {
            throw new Error(
              "Cannot allocate a loopback-routed service port without a physical host identity",
            );
          })()
      : [];
  const allocatedHostPorts = new Set<number>();

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
  // Through the shared gate rather than an inline copy of it. This was the only
  // `elevatedExecutor` call site in apps/*, and it re-derived the decision that
  // `rootOrDegrade` exists to own: same sudo arm, but it also REPORTS when the login can
  // neither be root nor sudo, instead of silently handing back the plain executor and
  // letting the write fail later as "No such file". Still lazy and still cached, so a
  // deploy that ships no config files never probes privileges.
  let hostConfigWriter: Promise<CommandExecutor> | null = null;
  const resolveHostConfigWriter = (executor: CommandExecutor): Promise<CommandExecutor> => {
    hostConfigWriter ??= rootOrDegrade(executor, {
      purpose: "Writing generated app config files to the host",
      consequence:
        "A config file the app needs may be missing, so the service can start misconfigured " +
        "or fail outright.",
      report: (message) => logger.log(`${message}\n`, "warn"),
    });
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
    //
    // Unless its NAMESPACE PROVIDER was just recreated. A container joined to
    // another's netns is bound to that specific container, so when the provider is
    // replaced the dependent keeps a handle on a destroyed namespace — it loses
    // networking entirely while still reporting `running`, so the liveness check
    // below waves it through and the deploy calls it "unchanged - kept running".
    // That is #533's exact failure (a sidecar silently off its tunnel) arriving
    // through the partial-deploy path, so the dependent is recreated too. Safe to
    // read here: topoSort visits providers first, so the answer is already known.
    const providerRecreated = composeNamespaceDependencies(
      svc.advanced as ComposeAdvanced | null,
    ).some((name) => recreatedServiceNames.has(name));
    const carried =
      !providerRecreated &&
      ((opts?.targetServiceIds && !opts.targetServiceIds.has(svc.id)) ||
        isExternalUnchanged(svc) ||
        isNewerThanRelease(svc))
        ? previousByServiceId.get(svc.id)
        : undefined;
    if (providerRecreated) {
      logger.log(
        `Service "${svc.name}" shares a namespace with a service that was just recreated — ` +
          `recreating it too so it isn't left attached to a destroyed namespace.\n`,
        "info",
        { serviceName: svc.name },
      );
    }
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
        //
        // An inspect that ANSWERED is authoritative about whether the container
        // publishes anything at all: no binding → CLEAR the row rather than carry
        // a port nothing listens on, which is what left migrated workloads routed
        // at a dead 127.0.0.1:<port> (#506). Which port it is stays the carried
        // (pinned) value — docker's first-binding is ambiguous once the operator
        // has declared extra ports. `live === undefined | null` = couldn't ask, so
        // the row stays as the last-known value.
        const carriedIp = live ? (live.ip ?? null) : (carried.ip ?? null);
        const carriedHostPort = live
          ? live.hostPort === undefined
            ? null
            : (carried.hostPort ?? live.hostPort)
          : (carried.hostPort ?? null);
        const carriedHostPorts = live
          ? Object.keys(live.hostPortByContainerPort ?? {}).length > 0
            ? (live.hostPortByContainerPort ?? null)
            : null
          : (carried.hostPorts ?? null);
        await repos.service.upsertServiceDeployment({
          deploymentId: dep.id,
          serviceId: svc.id,
          serviceName: svc.name,
          containerId: carried.containerId,
          status: "success",
          imageRef: carried.imageRef ?? null,
          hostPort: carriedHostPort,
          hostPorts: carriedHostPorts,
          ip: carriedIp,
        });
        // The #506 correction above has to land on the ACTIVE deployment's row too:
        // that is the row the next deploy reads (`previousByServiceId`), and an
        // all-carried pass never becomes active — so writing it only under `dep.id`
        // discards the fix and the stale binding comes back next time.
        //
        // A NARROW write, not an upsert: `upsertServiceDeployment` sets every
        // column, so omitting `imageDigest` would null the anchor the update
        // scanner needs to see a moved mutable tag — on the LIVE release's row.
        if (
          project.activeDeploymentId !== dep.id &&
          (carriedIp !== (carried.ip ?? null) ||
            carriedHostPort !== (carried.hostPort ?? null) ||
            JSON.stringify(carriedHostPorts ?? {}) !== JSON.stringify(carried.hostPorts ?? {}))
        ) {
          await repos.service
            .updateServiceDeployment(carried.id, {
              ip: carriedIp,
              hostPort: carriedHostPort,
              hostPorts: carriedHostPorts,
            })
            .catch(() => {});
        }
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
          ...(carriedHostPorts
            ? { hostPortByContainerPort: carriedHostPorts as Record<number, number> }
            : {}),
          carried: true,
        });
        // A carried-forward container is a valid namespace provider — it's running,
        // which is the only thing a dependent needs from it.
        containerIdByServiceName.set(svc.name, carried.containerId);
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

    // Prefer a freshly-built image; else the service's configured image
    // (pulled/external); else — for an env-only REFRESH (recreated but not
    // rebuilt) or the revive of a dead container above — reuse the previous
    // deployment's image so it comes back with fresh env and no build.
    //
    // Resolved HERE rather than at the create site further down so the scope gate
    // immediately below and the "no image available" failure it guards read the same
    // answer. They are two verdicts on one question and must not drift.
    const image = resolveDeployImage({
      builtImage: opts?.builtImages?.get(svc.id),
      rowImage: svc.image,
      previousImageRef: previousByServiceId.get(svc.id)?.imageRef,
    });

    // Out of a scoped deploy's subset AND nothing to bring it up with (#585). Record it
    // SKIPPED and move on: this deploy was never asked to touch it, and failing it here
    // rolled the whole deployment up to `partial_failure` ("Action Required") over a
    // service the operator never targeted — and, because a failure also lands in
    // `unavailableServiceNames`, blocked any TARGETED service that `depends_on` it, so
    // the one service `--service-ids` named never deployed at all.
    //
    // Deliberately NOT added to `unavailableServiceNames`: a dependent must not be
    // blocked by a sibling this pass declined to consider. A `service:` namespace
    // dependent still self-guards — it resolves through `containerIdByServiceName`, which
    // has no entry for a service that produced no container.
    //
    // Nothing is pushed to `results`, matching the strictScope skip above: `deployed`
    // counts non-carried result entries, so a phantom entry here would make an otherwise
    // all-carried pass look like it changed something and defeat the #498 no-op guard.
    if (
      isUntargetedAndUndeployable({
        serviceId: svc.id,
        image,
        targetServiceIds: opts?.targetServiceIds,
      })
    ) {
      logger.log(
        `Service "${svc.name}" is not part of this deploy and has no image to start from — ` +
          `leaving it untouched.\n`,
        "info",
        { serviceName: svc.name },
      );
      await repos.service
        .markServiceDeploymentSkipped({
          deploymentId: dep.id,
          serviceId: svc.id,
          serviceName: svc.name,
          reason: OUT_OF_SCOPE_SKIP_REASON,
        })
        .catch((err) => {
          // Bookkeeping for a service we are deliberately not touching must never be the
          // thing that fails the deploy — that is the whole shape of the bug this closes.
          logger.log(
            `Warning: could not record "${svc.name}" as skipped: ${safeErrorMessage(err)}\n`,
            "warn",
            { serviceName: svc.name },
          );
        });
      skippedOutOfScope.push(svc.name);
      continue;
    }

    // Includes the namespace provider: a service whose netns/pidns host failed is
    // not "degraded", it cannot be created at all.
    const blockedDependencies = effectiveDependencies(svc).filter((dependency) =>
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
      await repos.service.markServiceDeploymentFailed({
        deploymentId: dep.id,
        serviceId: svc.id,
        serviceName: svc.name,
        imageRef: opts?.builtImages?.get(svc.id) ?? svc.image ?? null,
        errorMessage: message,
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
    const layered = mergeServiceDeployEnv(
      {
        project: decryptedProjectEnv,
        frozen: depEnv,
        inline: (svc.environment as Record<string, string>) ?? {},
        templateKeys: svc.advanced?.environmentTemplateKeys,
        service: decryptedServiceEnv,
      },
      frozenEnvWins,
    );
    if (layered.missingRequired.length > 0) {
      const names = [...new Set(layered.missingRequired.map((item) => item.variable))];
      const message =
        `Required Compose environment ${names.length === 1 ? "variable is" : "variables are"} ` +
        `not configured: ${names.join(", ")}`;
      logger.log(`Service "${svc.name}" failed: ${message}\n`, "error", {
        serviceName: svc.name,
      });
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });
      await repos.service.markServiceDeploymentFailed({
        deploymentId: dep.id,
        serviceId: svc.id,
        serviceName: svc.name,
        imageRef: opts?.builtImages?.get(svc.id) ?? svc.image ?? null,
        errorMessage: message,
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
    // Say so when a variable is not what any UI shows. The service Env tab and
    // the wizard both keep rendering the empty value this merge ignored, so the
    // deploy log is the only surface that can explain the container — same
    // reason `resolveEnvPublicUrls` reports what it omitted just below. Names
    // only: values are output-masked everywhere else.
    if (layered.deferredEmpty.length > 0) {
      logger.log(
        `Service "${svc.name}": ${layered.deferredEmpty.join(", ")} ${
          layered.deferredEmpty.length === 1 ? "is" : "are"
        } empty in the compose config — using the configured value instead. ` +
          `(An empty compose value never clears a configured one; to force a variable blank here, set it empty as a service-scoped variable.)\n`,
        "info",
        { serviceName: svc.name },
      );
    }
    const { env: mergedEnv, unresolved: unresolvedEnvUrls } = resolveEnvPublicUrls(
      layered.env,
      urlForPublicUrlToken,
    );
    if (unresolvedEnvUrls.length > 0) {
      warnUnresolvedPublicUrl(
        svc.name,
        `no public URL is known for ${unresolvedEnvUrls
          .map((u) => `${u.key}=${u.tokens.join("")}`)
          .join(
            ", ",
          )} — ${unresolvedEnvUrls.length === 1 ? "that variable is" : "those variables are"} left UNSET rather than blank`,
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
      await repos.service.markServiceDeploymentFailed({
        deploymentId: dep.id,
        serviceId: svc.id,
        serviceName: svc.name,
        imageRef: svc.image ?? null,
        errorMessage: buildFailure,
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

    // `image` was resolved before the scope gate above. Reaching here with none means this
    // service IS in scope (or this is a full deploy) and genuinely cannot be brought up.
    if (!image) {
      const message = `No image available for service "${svc.name}"`;
      logger.log(`${message}\n`, "error", { serviceName: svc.name });
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });
      await repos.service.markServiceDeploymentFailed({
        deploymentId: dep.id,
        serviceId: svc.id,
        serviceName: svc.name,
        errorMessage: message,
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

      // Promote the extract out of its `.builds/<session>-<svc>` staging dir into
      // a stable release dir, exactly as the single-app static path does. Two
      // reasons this is not optional:
      //   • It is the only HARD output gate a static deploy has (the release root
      //     must exist and be non-empty). Registering a vhost straight at the
      //     staging dir skipped it, so an extract that produced nothing deployed
      //     green and 404'd every request.
      //   • It gives the doc-root an owner. A per-build-session directory is
      //     nobody's release: superseded copies accumulated forever and the
      //     deployment-scoped cleanup had nothing stable to reclaim.
      // Keyed `<deploymentId>-<serviceId>` so each static sub-app owns its own
      // release under one compose deployment.
      let staticRoot: string;
      try {
        const staticExecutor = await sharedMountExecutor({
          localHost: Boolean(opts?.localHost),
          executor: opts?.executor ?? null,
        });
        const previousStatic = previousByServiceId.get(svc.id);
        staticRoot = await new BareRuntime({
          workDir: STATIC_RELEASE_BASE,
          executor: staticExecutor ?? undefined,
        }).promoteStaticRelease({
          artifactPath: image,
          releaseId: `${dep.id}-${svc.id}`,
          // Only pass a predecessor when it really was a promoted release path —
          // an older row's imageRef may still be a staging dir, and rsync's
          // --link-dest against a directory that no longer exists just loses the
          // dedup, but against the WRONG one would hard-link stale files in.
          previousReleaseId:
            previousStatic?.deploymentId && previousStatic.serviceId
              ? `${previousStatic.deploymentId}-${previousStatic.serviceId}`
              : undefined,
          // The Docker sandbox already extracted the doc-root's CONTENTS, so the
          // release root IS the doc root (same contract as moveStaticBuildToHost).
          outputDirectory: "",
        });
      } catch (err) {
        // The promote's validation is a real gate: the release root does not exist,
        // or exists and is empty. Both mean every request to this sub-app would
        // 404, so this service FAILS rather than deploying green — the same shape
        // as a build failure above, and `markServiceDeploymentFailed` upserts
        // because a scoped deploy may have pre-created this row (#585).
        const detail = safeErrorMessage(err);
        logger.log(`Static output for "${svc.name}" is not servable: ${detail}\n`, "error", {
          serviceName: svc.name,
        });
        sessionManager.broadcastServiceStatus(dep.id, {
          serviceName: svc.name,
          serviceId: svc.id,
          status: "failed",
          error: detail,
        });
        await repos.service.markServiceDeploymentFailed({
          deploymentId: dep.id,
          serviceId: svc.id,
          serviceName: svc.name,
          imageRef: image,
          errorMessage: detail,
        });
        results.push({
          serviceId: svc.id,
          serviceName: svc.name,
          status: "failed",
          error: detail,
        });
        unavailableServiceNames.add(svc.name);
        continue;
      }

      logger.log(`Serving static files for "${svc.name}" from ${staticRoot}\n`, "info", {
        serviceName: svc.name,
      });

      // Endpoints whose vhost this deploy actually WROTE, captured for the output
      // audit below. Only registered routes go in: a host skipped as a duplicate
      // isn't ours to audit, and one whose registration failed is already reported —
      // auditing it too would report the same problem twice, in different words.
      const staticAuditRoutes: Array<{
        targetPath?: string | null;
        hostname?: string;
        isPrimary?: boolean;
      }> = [];

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
          try {
            await routeContext.routing.registerRoute({
              domain: route.hostname,
              staticRoot,
              tls: true,
              terminatesTlsLocally: hostTerminatesTlsLocally(
                route.hostname,
                routeContext.domainByHostname.get(routeKey),
              ),
              // registerRoute REPLACES the vhost, so omitting these would not leave the
              // project's vercel.json rules alone — it would delete whatever a live
              // re-apply installed. This is also the only place a plain static deploy
              // ever gets cleanUrls/trailingSlash, so without it the flags never applied.
              ...routingFields,
              ...(routeContext.proxy ? { proxy: routeContext.proxy } : {}),
            });
          } catch (err) {
            composeRouteWarnings.push(
              `${route.hostname}: ${err instanceof Error ? err.message : "route registration failed"}`,
            );
            // No vhost → nothing for ACME to answer the challenge on. Attempting a
            // cert here would burn a guaranteed-failed Let's Encrypt attempt.
            continue;
          }
          // Past the register: this route really is on the edge, so the TLS audit
          // and the output audit may both ask about it.
          registeredRoutes.push(route);
          staticAuditRoutes.push({
            targetPath: route.targetPath ?? "/",
            hostname: route.hostname,
            isPrimary: route.isPrimary,
          });

          // SSL parity with a PROXIED service. A proxied route goes through
          // `registerResolvedRoutes`, which owns the `provisionSsl` step; this
          // branch calls `registerRoute` directly, so it owned no SSL step at all —
          // a static compose sub-app on a custom domain got a vhost and never a
          // certificate, on this deploy or any later one.
          //
          // Same contract as the proxied path: the HTTP route is already on disk and
          // is what answers the ACME challenge, so a failed cert is a follow-up (the
          // tracked provider records it as Action Required), never a failed deploy.
          // Kept OUT of the try above so a cert failure can never be reported as a
          // route-registration failure.
          if (route.provisionSsl) {
            logger.log(`Checking SSL for ${route.hostname}...\n`, "info", {
              serviceName: svc.name,
            });
            await routeContext.trackedSsl.provisionCert(route.hostname).catch((err) => {
              logger.log(
                `SSL provisioning failed for ${route.hostname} (route is up on HTTP, retry from ` +
                  `the Domains tab): ${safeErrorMessage(err)}\n`,
                "warn",
                { serviceName: svc.name },
              );
            });
          }
        }
      }

      // UPSERT, not insert: a scoped deploy pre-creates a `skipped` row for every service
      // it did not target (service-checks.ts), and a static service is never carried
      // forward — it owns no container, so the carry branch above can't keep it — which
      // means an untargeted static sub-app ALWAYS arrives here and a plain insert violated
      // UNIQUE(deploymentId, serviceId), throwing out of this function to kill the whole
      // deploy on its own bookkeeping (#585).
      // The route-aware output audit — the one check a compose static sub-app never
      // had. The promote above proves the release root is non-empty; this proves
      // each ROUTED path actually serves, from the edge's own vantage point and
      // (when a hostname is routed) with a real HTTP request. Advisory, exactly as
      // on the single-app path: `composeRouteWarnings` already flows into
      // `routeWarnings` → `deployWarning` + `edgeUnsynced`, so a finding surfaces as
      // "Action Required" with no new meta key, and never fails the deploy.
      if (routeContext?.routing) {
        const findings = await auditStaticOutput(
          // No runtime fallback: `runtime` here is the compose DockerRuntime and a
          // static sub-app owns no container, so `inContainerExecutor` has nothing
          // to enter. The edge is the only vantage point that exists for these
          // files, and an absent one correctly yields "no signal".
          { routing: routeContext.routing, containerId: null },
          staticOutputTargets(staticRoot, staticAuditRoutes),
          logger,
        );
        for (const finding of findings.filter(outputFindingIsBroken)) {
          composeRouteWarnings.push(`${svc.name} ${describeOutputFinding(finding)}`);
        }
      }

      // `imageRef` is the PROMOTED release dir, not the staging dir the builder
      // wrote. It is the only handle anything downstream has on this sub-app's
      // files: project teardown classifies it as an artifact and removes it
      // (issue #640), and the per-deployment cleanup reclaims it — under keep-set
      // protection — when this release is superseded and pruned.
      await repos.service.upsertServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        serviceName: svc.name,
        status: "success",
        imageRef: staticRoot,
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "running",
        staticRoot,
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
    // Past every skip path: this service's container is about to be replaced
    // (deployServiceWorkload removes the same-named one first), so any dependent
    // sharing its namespace must be recreated rather than carried.
    recreatedServiceNames.add(svc.name);

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

    // Shared namespaces, resolved against what this deployment actually produced.
    // Skipped entirely on a runtime that can't honor them — the warn-and-drop above
    // already told the operator, and resolving a reference we're about to discard
    // would only manufacture a failure (a "provider has no container" error on
    // cloud, where no container exists by design).
    const namespacesUnsupported =
      runtime.unsupportedComposeKeys.has("networkMode") ||
      runtime.unsupportedComposeKeys.has("pidMode");
    const resolvedNamespaces = namespacesUnsupported
      ? {}
      : resolveServiceNamespaces(svc, containerIdByServiceName, stackServiceNames);
    if (resolvedNamespaces.error) {
      // A namespace it can't get is fatal for THIS service, not the stack: same
      // shape as a blocked dependency, so dependents of this one are held back too.
      const message = resolvedNamespaces.error;
      logger.log(`Service "${svc.name}" skipped: ${message}\n`, "warn", { serviceName: svc.name });
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });
      await repos.service.markServiceDeploymentFailed({
        deploymentId: dep.id,
        serviceId: svc.id,
        serviceName: svc.name,
        imageRef: image ?? null,
        errorMessage: message,
      });
      results.push({ serviceId: svc.id, serviceName: svc.name, status: "failed", error: message });
      unavailableServiceNames.add(svc.name);
      continue;
    }
    // Its ports and domains are inert the moment it has no endpoint of its own —
    // whether because another container owns the interfaces or because there are
    // none (`network_mode: none`). Traffic has to be published and routed on the
    // PROVIDER. Derived from the RESOLVED mode, the same value the runtime keys its
    // own suppression on, so the two can't disagree about which services are
    // routable (see ownsNetworkEndpoint).
    const hasNoRoutableAddress = !ownsNetworkEndpoint(resolvedNamespaces.namespaces?.network);

    const serviceRuntimeConfig = createServiceRuntimeConfig({
      project,
      dep,
      service: svc,
      image,
      environment: mergedEnv,
      resources: resolveServiceResources(svc, opts?.resources),
      namespaces: resolvedNamespaces.namespaces,
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
      const writeConfigFiles = async (host: CommandExecutor) => {
        const writer = await resolveHostConfigWriter(host);
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
          await writeAppConfigFile(writer, hostPath, resolved.value, svc.name, file.path);
          serviceRuntimeConfig.volumes = [
            ...serviceRuntimeConfig.volumes,
            `${hostPath}:${file.path}:ro`,
          ];
        }
      };

      // Which executor may write them is the whole question — see `withAppConfigHost`.
      const { ran } = await withAppConfigHost(
        {
          executor: opts?.executor,
          localHost: opts?.localHost,
          isCloud: runtime.name === "cloud",
        },
        writeConfigFiles,
      );
      logger.log(
        ran
          ? `Service "${svc.name}": mounted ${advancedFiles.length} generated config file(s).\n`
          : `Service "${svc.name}": ${advancedFiles.length} config file(s) require a self-hosted host mount — skipping on the ${runtime.name} runtime.\n`,
        ran ? "info" : "warn",
        { serviceName: svc.name },
      );
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
    // Route PREPARATION is skipped outright for a service with no address, not just
    // route registration: prepareServiceRoutes creates and force-activates the
    // domain rows, so filtering afterwards left an active domain in the Domains tab
    // with no vhost behind it — exactly the dishonest state the suppression exists
    // to avoid. The operator setting a domain here isn't a mistake to punish; it
    // just belongs on the service that owns the interfaces, and the log says so.
    if (hasNoRoutableAddress) {
      const providers = composeNamespaceDependencies(svc.advanced as ComposeAdvanced | null);
      const where =
        providers.length > 0
          ? `shares ${providers.join(", ")}'s network namespace`
          : "has no network of its own";
      logger.log(
        `Service "${svc.name}" ${where}, so it has no address to route to — skipping its ` +
          `domains and its published ports. Move them to the service it shares.\n`,
        "warn",
        { serviceName: svc.name },
      );
    }
    const { routes: preparedRoutes, warnings: routeClaimWarnings } = hasNoRoutableAddress
      ? { routes: [] as Awaited<ReturnType<typeof prepareServiceRoutes>>["routes"], warnings: [] }
      : await prepareServiceRoutes({
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

    // loopback-port routing (compose parity, mirrors single-app): republish EVERY
    // routed container port on its OWN `127.0.0.1:<pinnedHostPort>` so the edge
    // reaches each on loopback and none is network-exposed. We OWN the pinned
    // ports (reuse the carried one for the primary, else allocate avoiding this
    // deploy's picks), so each route resolves deterministically — no reading it
    // back from the daemon's ambiguous first-binding. Port-only bindings the user
    // declared for direct access are preserved. Cloud handles exposure itself;
    // bare/no-executor can't publish → skip (route falls back to container-IP).
    //
    // ONE HOST PORT PER ROUTED PORT, not one per service: a service can carry
    // several routes (minio's console + `s3` API, convex's API + `http`), and
    // pinning only `proxyRoutes[0]` while `resolveTargetUrl` returned that single
    // port for every route made each extra subdomain silently proxy to the FIRST
    // route's port. minio's s3 host served the console; convex's http host served
    // the 3210 API. Every mapping is now claimed and persisted, so stopped
    // secondary routes are just as durable as the primary.
    const routedContainerPorts = [
      ...new Set(
        [
          ...proxyRoutes.map((route) => route.targetPort),
          ...(hostLoopbackRoutePortDemands.get(svc.id) ?? []),
        ].filter((port): port is number => typeof port === "number" && port > 0),
      ),
    ];
    const primaryRoutedPort = routedContainerPorts[0];
    /** routed container port → the loopback host port WE pinned for it. */
    const pinnedHostPortByContainerPort = new Map<number, number>();
    const serviceHostPortAllocations: Array<
      Pick<AllocatedPinnedHostPort, "claim" | "previousClaim">
    > = [];
    let servicePinnedHostPort: number | undefined;
    if (
      usesHostLoopback &&
      primaryRoutedPort !== undefined &&
      // A container with no endpoint of its own publishes nothing — allocating a
      // host port would burn it and pin a route to an upstream that never binds.
      !hasNoRoutableAddress &&
      opts?.executor
    ) {
      try {
        for (const containerPort of routedContainerPorts) {
          // Every routed port is persisted now. Legacy releases know only the
          // primary scalar, so that remains the fallback for old rows.
          const previousRow = previousByServiceId.get(svc.id);
          const owner = {
            projectId: project.id,
            serviceId: svc.id,
            containerPort,
          } as const;
          const mapped = previousRow?.hostPorts?.[String(containerPort)];
          const cachedPreferred =
            typeof mapped === "number" && mapped > 0
              ? mapped
              : containerPort === primaryRoutedPort
                ? previousRow?.hostPort
                : undefined;
          /**
           * A carried port is a PREFERENCE, never a given.
           *
           * It used to be taken verbatim whenever one existed, which is right for the case it was
           * written for — a redeploy on the same host, where the port was ours and still is. It is
           * wrong the moment the host changes: a MIGRATION carries the source's port to a target
           * that knows nothing about it, and if anything there holds it Docker refuses the bind
           * with "port is already allocated" and the service (plus everything depending on it)
           * fails. A host port is a property of the HOST, not of the project, so it cannot travel
           * with one.
           *
           * `preferred` is the allocator's own word for exactly this: keep it if it's free, pick
           * another if it isn't. Passing it there rather than branching around the allocator means
           * one rule for both cases and no second place that decides what a free port is.
           */
          const allocation = await allocateAndReservePinnedHostPort({
            target: hostPortTarget!,
            claims: pinnedHostPortClaims,
            owner,
            cachedPreferred,
            // A scalar has no container-port identity. It represented the primary
            // route historically, so never let it stand in for a secondary route.
            allowLegacyContainerPort: containerPort === primaryRoutedPort,
            additionalAvoid: allocatedHostPorts,
            allocate: (allocationOptions) => allocateHostPort(opts.executor!, allocationOptions),
          });
          serviceHostPortAllocations.push(allocation);
          const carried = allocation.preferred;
          const hostPort = allocation.port;
          if (carried && hostPort !== carried) {
            logger.log(
              `Host port ${carried} for ${svc.name} is taken on this server — using ${hostPort}. ` +
                `(Expected when a project moves to a different host.)\n`,
            );
          }
          // "Couldn't read occupancy" is not "nothing is listening" — without this the
          // bind failure that follows blames Docker for an unreachable host (#490).
          if (!allocation.scanned) {
            logger.log(
              `Couldn't read live port occupancy on the target, so ${allocation.port} for ` +
                `${svc.name} avoids database-pinned ports and ports this deploy already took. ` +
                `If publishing it fails ` +
                `as "already allocated", check that Openship can reach this host ` +
                `(Servers → this box).\n`,
              "warn",
            );
          }

          // Keep this pass's newly committed claim visible to the next service.
          pinnedHostPortClaims.push(allocation.claim);
          allocatedHostPorts.add(hostPort);
          pinnedHostPortByContainerPort.set(containerPort, hostPort);
        }
      } catch (allocationError) {
        // No container or route exists yet. Roll back only reservations this
        // attempt created; carried claims may still protect an older vhost.
        await releaseNewPinnedHostPortClaims(hostPortTarget!, serviceHostPortAllocations).catch(
          (releaseError) =>
            logger.log(
              `Warning: failed to release unrouted host-port reservations for "${svc.name}": ` +
                `${safeErrorMessage(releaseError)}\n`,
              "warn",
              { serviceName: svc.name },
            ),
        );
        throw allocationError;
      }
      serviceRuntimeConfig.ports = withLoopbackPublishAll(
        serviceRuntimeConfig.ports,
        pinnedHostPortByContainerPort,
      );
      servicePinnedHostPort = pinnedHostPortByContainerPort.get(primaryRoutedPort);
    }

    let deployedContainerId: string | undefined;
    let deployedContainerCleaned = false;
    // Kept outside the try so a connection loss after Docker returned can still
    // persist every binding reported before the transport disappeared.
    let serviceResult: MultiServiceDeployResult | undefined;
    let pipelineReachedReady = false;
    try {
      const previous = previousByServiceId.get(svc.id);
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
                const sameSvc = serviceResult?.containerId === containerId;
                // Prefer the port WE pinned+published for THIS container port
                // (deterministic); fall back to the port the deploy result
                // reported. That fallback is a single scalar read off the daemon,
                // so it is only meaningful for the primary route — applying it to
                // a secondary port is the collapse this map exists to prevent.
                const hostPort = upstreamHostPortFor({
                  port,
                  pinned: pinnedHostPortByContainerPort,
                  primaryPort: primaryRoutedPort,
                  resultHostPort: serviceResult?.hostPort,
                  sameService: sameSvc,
                });
                // The effective topology, not only the stored preference, decides
                // whether to dial the reserved publish or the container IP.
                const targetUrl =
                  usesHostLoopback && hostPort
                    ? buildUpstreamUrl({
                        strategy: upstreamStrategy,
                        hostPort,
                        containerPort: port,
                      })
                    : buildUpstreamUrl({
                        strategy: upstreamStrategy,
                        ip: sameSvc ? serviceResult?.ip : await runtime.getContainerIp(containerId),
                        hostPort,
                        containerPort: port,
                      });
                await reserveResolvedLoopbackRoutes({
                  target: hostPortTarget,
                  projectId: project.id,
                  routes: [{ targetUrl, serviceId: svc.id, containerPort: port }],
                });
                return targetUrl;
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

      // Recorded as attempted ONLY now. `registerResolvedRoutes` runs inside the
      // pipeline, after activate + the health gate — so a service that fails the
      // health gate throws below with `routeWarnings` UNSET and no vhost written.
      // Pushing before the call meant the TLS audit saw that hostname as routed and
      // reported "routed but no HTTPS" for a domain that was never routed at all,
      // with no route warning for the audit's exclusion to subtract.
      if (deployResult.status !== "failed") {
        registeredRoutes.push(...proxyRoutes);
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
      pipelineReachedReady = true;

      const result = serviceResult ?? {
        containerId: deployResult.containerId!,
        status: "running",
      };
      // The pinned loopback port we published+routed wins over whatever docker
      // happened to report first, so the persisted value matches the live route
      // and the next redeploy reuses the same target.
      const persistedHostPort = servicePinnedHostPort ?? result.hostPort ?? null;
      const persistedHostPorts: Record<number, number> = {
        ...(serviceResult?.hostPortByContainerPort ?? {}),
        ...Object.fromEntries(pinnedHostPortByContainerPort),
      };

      // UPSERT, never a plain insert — a row for this (deployment, service) pair may
      // already exist by the time we get here, from either of two writers:
      //   • strictScope reuses the ACTIVE deployment id, which can already carry one;
      //   • a scoped deploy pre-creates a `skipped` row for every UNTARGETED service
      //     (service-checks.ts), and an untargeted service still reaches this create site
      //     when its container turned out to be gone and the carry above revived it.
      // A plain insert there violated UNIQUE(deploymentId, serviceId) and threw out of
      // this function, failing the whole deploy on its own bookkeeping (#585). Passing the
      // full runtime picture is what makes the full-row upsert the right writer here.
      await repos.service.upsertServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        serviceName: svc.name,
        containerId: result.containerId,
        status: "success",
        imageRef: image,
        imageDigest: result.imageDigest ?? null,
        hostPort: persistedHostPort,
        hostPorts: Object.keys(persistedHostPorts).length > 0 ? persistedHostPorts : null,
        ip: result.ip ?? null,
      });

      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        containerId: result.containerId,
        status: result.status,
        ip: result.ip,
        hostPort: persistedHostPort ?? undefined,
        // The per-port map the runtime reported, UNIONED with the pins this pass
        // published — the pins are what the vhosts dial, and they are the answer for
        // any port docker had not bound yet when it was inspected.
        ...(Object.keys(persistedHostPorts).length > 0
          ? { hostPortByContainerPort: persistedHostPorts }
          : {}),
      });
      // Now resolvable as a namespace provider for the services after it. Set only
      // on success: a dependent must never be pointed at a container that failed.
      if (result.containerId) containerIdByServiceName.set(svc.name, result.containerId);
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
      if (
        previous?.imageRef &&
        previous.imageRef !== image &&
        runtime instanceof DockerRuntime &&
        ownsBuiltImage(previous.imageRef)
      ) {
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
        // Upsert for the same reason as the success write above: this pair may already
        // carry a pre-created `skipped` row, and a unique violation here would replace an
        // unknown-but-probably-fine outcome with a hard deploy failure.
        const indeterminateHostPorts: Record<number, number> = {
          ...(serviceResult?.hostPortByContainerPort ?? {}),
          ...Object.fromEntries(pinnedHostPortByContainerPort),
        };
        const indeterminateHostPort = servicePinnedHostPort ?? serviceResult?.hostPort ?? null;
        await repos.service.upsertServiceDeployment({
          deploymentId: dep.id,
          serviceId: svc.id,
          serviceName: svc.name,
          containerId: deployedContainerId,
          status: "indeterminate",
          imageRef: image,
          hostPort: indeterminateHostPort,
          hostPorts: Object.keys(indeterminateHostPorts).length > 0 ? indeterminateHostPorts : null,
        });
        results.push({
          serviceId: svc.id,
          serviceName: svc.name,
          containerId: deployedContainerId,
          status: "indeterminate",
          hostPort: indeterminateHostPort ?? undefined,
          ...(Object.keys(indeterminateHostPorts).length > 0
            ? { hostPortByContainerPort: indeterminateHostPorts }
            : {}),
        });
        indeterminateServiceNames.add(svc.name);
      } else {
        if (deployedContainerId && !deployedContainerCleaned) {
          try {
            await runtime.destroy(deployedContainerId);
            deployedContainerCleaned = true;
          } catch (destroyErr) {
            hostPortClaimReapSafe = false;
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
        if (!pipelineReachedReady && hostPortTarget && serviceHostPortAllocations.length > 0) {
          if (!deployedContainerId) {
            // Activation never returned a workload id, so no route could have
            // been resolved or written. This is the one post-allocation failure
            // boundary where direct rollback is provably pre-route.
            await releaseNewPinnedHostPortClaims(hostPortTarget, serviceHostPortAllocations).catch(
              (releaseError) =>
                logger.log(
                  `Warning: failed to release unrouted host-port reservations for "${svc.name}": ` +
                    `${safeErrorMessage(releaseError)}\n`,
                  "warn",
                  { serviceName: svc.name },
                ),
            );
          } else {
            // Once activation returned, retain the reservation even when the
            // best-effort destroy succeeded. A later full strict convergence
            // can prove the edge/workload transition; this catch block cannot.
            logger.log(
              `Host-port reservations for "${svc.name}" were retained until the next successful reconciliation.\n`,
              "warn",
              { serviceName: svc.name },
            );
          }
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

        await repos.service.markServiceDeploymentFailed({
          deploymentId: dep.id,
          serviceId: svc.id,
          serviceName: svc.name,
          imageRef: image,
          errorMessage: message,
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
        return pc ? { ...pc, serviceId: target.serviceId, serviceName: target.serviceName } : null;
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

  /**
   * Turn vetoing post-start findings into failures: rows + SSE through
   * `recordUnstableServices`, then reconcile the in-memory result set the summary
   * below is computed from.
   *
   * Shared by both halves of the gate (the stabilization watch and the readiness
   * probe) so a veto means the identical thing either way — the second caller is
   * where a hand-copied version would have started drifting.
   */
  const demoteVetoedServices = async (findings: StabilityFinding[]): Promise<void> => {
    const demoted = await recordUnstableServices({
      deploymentId: dep.id,
      findings,
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
  };
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
    for (const finding of findings.filter((f) => !f.verdict.ok && !vetoing.includes(f))) {
      // "warn": say what didn't hold, but leave the service's deploy result alone
      // so the stack stays up. Opting into the watch to get the signal must not
      // also opt into a veto.
      stabilityWarnings.push(`${finding.target.serviceName}: ${finding.verdict.reason}`);
    }

    if (vetoing.length > 0) await demoteVetoedServices(vetoing);
  }

  // ── Readiness PROBE, per service ─────────────────────────────────────────────
  // The other half of the same opt-in gate, and it was missing entirely: this path
  // read `stabilization` and `onFailure` out of `readinessByServiceId` and never
  // looked at `probe`, so a compose project that set `readiness: { enabled: true,
  // path: "/ready" }` got a silent no-op while the identical config on a single-app
  // project was enforced. Found alongside GH-583.
  //
  // After the stabilization watch, for the same reason that runs after the whole
  // stack is up: a service that depends on a sibling isn't expected to answer until
  // the sibling exists, and probing inline as each container was created would fail
  // a stack that converges seconds later.
  const probed = stabilityTargets.filter(
    (t) => t.serviceId && readinessByServiceId.get(t.serviceId)?.probe.enabled,
  );
  if (probed.length > 0) {
    // Concurrently: these are independent waits on a timeout each, so running them
    // in sequence would make a 3-service stack wait 3 × the window it asked for.
    const verdicts = await Promise.all(
      probed.map(async (target) => {
        const gate = readinessByServiceId.get(target.serviceId!)!;
        const svc = enabled.find((s) => s.id === target.serviceId);
        // The service's OWN port — `resolveReadinessTarget` maps it to whatever the
        // container actually published. An explicit `readiness.port` wins; otherwise
        // the row's exposed/first port.
        const primaryPort = gate.probe.port ?? (svc ? resolveServicePort(svc) : null);
        if (!primaryPort) {
          // Nothing to dial and nothing declared to dial: report it through the same
          // "couldn't ask" channel a refused forward uses, so it warns instead of
          // failing a service whose config simply names no port.
          return {
            target,
            gate,
            verdict: {
              failure: null,
              skipped:
                "this service declares no port, and its health check does not name one, " +
                "so there is no address to dial.",
            },
          };
        }
        const verdict = await probeDeployedReadiness({
          runtime,
          containerId: target.containerId,
          primaryPort,
          probe: gate.probe,
          targetExecutor: opts?.executor ?? null,
          log: (message, level) => logger.log(message, level, { serviceName: target.serviceName }),
          subject: `"${target.serviceName}"`,
        });
        return { target, gate, verdict };
      }),
    );

    const probeVetoes: StabilityFinding[] = [];
    for (const { target, gate, verdict } of verdicts) {
      if (verdict.skipped) {
        // Could not ASK. Never a veto — see probeDeployedReadiness.
        logger.log(
          `Health check SKIPPED for "${target.serviceName}": ${verdict.skipped} ` +
            `The service is left live and unverified.\n`,
          "warn",
          { serviceName: target.serviceName },
        );
        continue;
      }
      if (!verdict.failure) continue;
      if (gate.onFailure !== "fail") {
        stabilityWarnings.push(`${target.serviceName}: ${verdict.failure}`);
        continue;
      }
      // Reusing the stabilization recorder: despite the name it is the generic
      // "this service failed a post-start check" writer (failure row + SSE), and a
      // probe failure is exactly that. `summary` is the headline, `detail` becomes
      // the deployment's errorMessage when nothing came up.
      probeVetoes.push({
        target,
        // `unhealthy` out of the StabilityStatus vocabulary, and it is the accurate
        // one: the container is up, it just isn't answering. Not `exited`/`dead`
        // (it's running) and not `missing` (we found it).
        verdict: { status: "unhealthy", ok: false, reason: verdict.failure },
        summary: `Health check failed for "${target.serviceName}"`,
        detail: verdict.failure,
      });
    }
    if (probeVetoes.length > 0) await demoteVetoedServices(probeVetoes);
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
          mutated = true;
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
  const deployed = results.filter((r) => r.status !== "failed" && !r.carried).length;

  if (prepareFailure) {
    sessionManager.broadcastInstallPhase(dep.id, { id: "app-setup", status: "failed" });
    const failedNow = results.filter((r) => r.status === "failed");
    logger.step("deploy", "failed", prepareFailure);
    return {
      status: "failed",
      summary: {
        total: ordered.length,
        successful,
        deployed,
        failed: failedNow.length,
        indeterminate: 0,
        mutated,
        failedServices: failedNow.map((r) => r.serviceName),
      },
      services: results,
      // No primary container: this return goes to onFailure, which ignores it —
      // resolving one would cost a domain query on the failure path for nothing.
      error: prepareFailure,
      publicUrl: firstPublicUrl,
      portChecks,
    };
  }

  // The container a project-level question resolves to, picked the same way the
  // access URL is — and over `enabled`, NOT `ordered`: `pickPrimaryServiceId`'s
  // last resort is the first element, and `ordered` is topo-sorted, so for a
  // port-only project (nothing `exposed`, no verified domain) that first element
  // is the dependency — the database — which is the very thing #498 is about. The
  // read paths pass `listByProject` order, so passing `enabled` also keeps write
  // and read agreeing on one answer. Narrowed to the services that actually came
  // up with a container, so a static-served or failed primary defers to a real one.
  const primaryContainerId = await (async () => {
    const withContainer = results.filter((r) => r.containerId);
    if (withContainer.length === 0) return undefined;
    const domainRows = needsDomainMap
      ? [...domainByHostname.values()]
      : await repos.domain.listByProject(project.id).catch(() => []);
    const candidates = enabled.filter((svc) => withContainer.some((r) => r.serviceId === svc.id));
    const primaryId = pickPrimaryServiceId(candidates, domainRows);
    return (
      withContainer.find((r) => r.serviceId === primaryId)?.containerId ??
      withContainer[0].containerId
    );
  })();

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
    // Its OWN try: the composite's catch below reports "Single-domain composition
    // skipped", which would be a wrong account of a project-level failure.
    try {
      /**
       * PROJECT-LEVEL domain rows (`domains.service_id IS NULL`) — the project's own
       * hostnames, as opposed to a service's.
       *
       * Planned by `buildProjectRouteDomains`, the SAME planner the single-app deploy
       * uses, so the two cannot drift on tls / verified gating / SSL. It was simply
       * unreachable from here: this pipeline returns before `executeServerDeploy`, so
       * for a compose release these rows were planned by NOTHING on deploy and only the
       * live re-apply ever wrote their vhost. That asymmetry is #618's whole class — a
       * route that works after a domain save and vanishes from the deploy's account of
       * itself — and it is why the fix could not stop at the live path.
       *
       * Registered BEFORE the composite and the fan-out below: `registerRoute` is
       * last-writer-wins per hostname, and both of those compile a richer,
       * topology-aware config for the hostnames they own.
       */
      const projectDomainRows = [...routeContext.domainByHostname.values()];
      const projectLevelRoutes = buildProjectRouteDomains({
        project,
        projectDomains: projectDomainRows,
        runtimeName: runtime.name,
        usesManagedRouting: routeContext.usesManagedRouting,
      });
      const projectUpstreamRows = new Map(
        results.map((r) => [
          r.serviceId,
          {
            serviceId: r.serviceId,
            containerId: r.containerId,
            ip: r.ip,
            hostPort: r.hostPort,
            // The per-port picture this pass observed + pinned. With it a route on a
            // service's SECOND port dials that port's own publish; without it the
            // resolver refuses to attribute the scalar and falls back to the container
            // IP rather than reaching a sibling app.
            ...(r.hostPortByContainerPort
              ? { hostPortByContainerPort: r.hostPortByContainerPort }
              : {}),
          },
        ]),
      );
      // A redirect only goes live when its target is a hostname this project actually
      // routes — the same gate, and the same hostname set, the live re-apply applies.
      const projectLevelHostnames = projectLevelRoutes.map((r) => r.hostname);
      for (const route of projectLevelRoutes) {
        const routeKey = route.hostname.toLowerCase();
        // A hostname a SERVICE already registered this pass is that service's, not the
        // project's — never overwrite the more specific answer with a broader one.
        if (seenRouteDomains.has(routeKey) || route.targetPort === undefined) continue;
        // Built from THIS deploy's results, not a fresh daemon read: the containers were
        // just created and their publishing is what is about to be persisted. The port's
        // owning service is picked by the resolver the live re-apply shares.
        const resolved = buildProjectServiceUpstream({
          strategy: upstreamStrategy,
          port: route.targetPort,
          services: enabled,
          rowByService: projectUpstreamRows,
          domainRows: projectDomainRows,
        });
        if (!resolved) {
          // A SCOPED pass (per-service Start / add) holds results only for what it
          // touched, so it may never have seen the service that owns this hostname — it
          // is not the authority on that route and says nothing about it either way.
          if (opts?.targetServiceIds || opts?.strictScope) continue;
          logger.log(
            `Domain ${route.hostname} not routed — no service offers port ${route.targetPort} ` +
              `(${describeCandidatePorts({ services: enabled, rowByService: projectUpstreamRows })}).\n`,
            "warn",
          );
          composeRouteWarnings.push(
            `${route.hostname}: no service offers port ${route.targetPort}`,
          );
          continue;
        }
        // A canonical redirect (the `www` sibling "Include www" mints) is served INSTEAD
        // of the app. Omitting it is not "leaving it alone": `registerRoute` replaces the
        // whole vhost, so a redeploy would have converted every redirect host into a
        // second copy of the app — and silently, since the row still reads Live.
        const redirectHost = resolveRouteRedirect(
          {
            hostname: route.hostname,
            redirectTo: route.redirectTo,
            redirectStatus: route.redirectStatus,
          },
          projectLevelHostnames,
        );
        seenRouteDomains.add(routeKey);
        try {
          await reserveResolvedLoopbackRoutes({
            target: hostPortTarget,
            projectId: project.id,
            routes: [
              {
                targetUrl: resolved.url,
                serviceId: resolved.owner.serviceId,
                containerPort: resolved.owner.containerPort,
              },
            ],
          });
          await routeContext.routing.registerRoute({
            domain: route.hostname,
            targetUrl: resolved.url,
            tls: route.tls,
            terminatesTlsLocally: hostTerminatesTlsLocally(
              route.hostname,
              routeContext.domainByHostname.get(routeKey),
            ),
            ...routingFields,
            ...(redirectHost ? { redirectHost } : {}),
            ...(routeContext.proxy ? { proxy: routeContext.proxy } : {}),
          });
        } catch (err) {
          composeRouteWarnings.push(
            `${route.hostname}: ${err instanceof Error ? err.message : "route registration failed"}`,
          );
          // No vhost → nothing for ACME to answer the challenge on, so a cert attempt
          // here would burn a guaranteed-failed Let's Encrypt issuance.
          continue;
        }
        logger.log(
          `Routed ${route.hostname} → service "${resolved.owner.serviceName}" at ${resolved.url} ` +
            `(port ${route.targetPort}, matched by ${resolved.owner.via}).\n`,
        );
        registeredRoutes.push(route);
        // A free *.opsh.io hostname resolves ONLY through Openship Cloud's edge, so the
        // local vhost above is half of it — the same pairing the per-service loop does
        // for its own free routes. Without this the project's free URL would have a
        // working origin and no route pointing at it.
        if (routeContext.usesManagedRouting && route.isCloud && route.managedSubdomain) {
          await ensureManagedEdgeProxy(routeContext.organizationId, route.managedSubdomain, {
            serverId: routeContext.serverId,
          }).catch((edgeErr) => {
            logger.log(
              `Warning: could not sync managed edge proxy for ${route.hostname}: ` +
                `${safeErrorMessage(edgeErr)}. The app is live; this only affects that free URL.\n`,
              "warn",
            );
          });
        }
        // Same contract as every other route here: the HTTP vhost is already on disk and
        // is what answers the challenge, so a failed cert is a follow-up the tracked
        // provider records as Action Required — never a failed deploy.
        if (route.provisionSsl) {
          await routeContext.trackedSsl.provisionCert(route.hostname).catch((err) => {
            logger.log(
              `SSL provisioning failed for ${route.hostname} (route is up on HTTP, retry from ` +
                `the Domains tab): ${safeErrorMessage(err)}\n`,
              "warn",
            );
          });
        }
      }
    } catch (err) {
      // Best-effort like every routing step: the project's own domains are optional and
      // a failure here never fails a deploy (see domains-never-fail-deploy).
      logger.log(
        `Project domain routing skipped: ${err instanceof Error ? err.message : "error"}.\n`,
        "warn",
      );
    }

    try {
      // Reusable routing core (shared with the routing API): resolve each
      // service's live upstream from this deploy's results.
      const resolvedRouteOwners = new Map<
        string,
        {
          targetUrl: string;
          serviceId: string;
          containerPort: number;
        }
      >();
      const resolveTargetUrl = (serviceId: string) => {
        const svc = enabled.find((s) => s.id === serviceId);
        const res = results.find((r) => r.serviceId === serviceId);
        // Composite/fan-out config itself is the exposure demand. Do not gate it
        // on the service owning a separate hostname (`service.exposed`): project
        // routes intentionally reach internal services.
        const port = svc ? (resolveServicePort(svc, project.port) ?? undefined) : undefined;
        if (!port) return null;
        const targetUrl = buildUpstreamUrl({
          strategy: upstreamStrategy,
          ip: res?.ip,
          hostPort: res?.hostPort,
          hostPorts: res?.hostPortByContainerPort,
          containerPort: port,
        });
        if (targetUrl) {
          resolvedRouteOwners.set(`${serviceId}\0${port}`, {
            targetUrl,
            serviceId,
            containerPort: port,
          });
        }
        return targetUrl;
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
      const fanoutRegistrations = buildDomainFanoutRegistrations({
        routes: project.compositeRoutes,
        resolveTargetUrl,
      });
      // Resolve every topology-aware target first, then validate the complete
      // set before the first vhost is mutated. A conflict cannot leave half of a
      // composite/fan-out route set pointing at an unowned loopback port.
      await reserveResolvedLoopbackRoutes({
        target: hostPortTarget,
        projectId: project.id,
        routes: resolvedRouteOwners.values(),
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
          // staticRoot wins when present — the same rule route-apply.service applies.
          // `buildCompositeRegistration` returns one OR the other, and hardcoding
          // targetUrl threw `Invalid proxy target: undefined` for every static-frontend
          // composite (which is all of them self-hosted, since build.service sets
          // staticExtractOnly whenever the runtime isn't cloud) — so the flagship
          // monorepo shape never got a composite vhost at all.
          ...(r.staticRoot ? { staticRoot: r.staticRoot } : { targetUrl: r.targetUrl! }),
          ...(r.proxyLocations?.length ? { proxyLocations: r.proxyLocations } : {}),
          ...(r.redirects?.length ? { redirects: r.redirects } : {}),
          ...(r.headerRules?.length ? { headerRules: r.headerRules } : {}),
          ...(r.cleanUrls ? { cleanUrls: true } : {}),
          ...(r.trailingSlash === undefined ? {} : { trailingSlash: r.trailingSlash }),
          ...(routeContext.proxy ? { proxy: routeContext.proxy } : {}),
        });
        logger.log(
          `Composed single domain ${r.hostname}: frontend at "/", backend proxied per vercel.json.\n`,
        );
        // A rule we could not translate is NOT live. Say so here rather than letting it
        // disappear — the deploy log is where someone looks after changing vercel.json.
        for (const note of composite.skipped) {
          logger.log(`vercel.json rule not applied — ${note}\n`, "warn");
        }
      }

      // Re-emit any migration path-fan-out domains (a domain whose paths route to
      // DIFFERENT services) from this deploy's live upstreams — persisted on the
      // project so a redeploy reproduces `/v3 → api` instead of dropping it.
      // These hostnames ARE project domains, so the live path (project-route.service) puts
      // the project's vercel.json rules on them. Spread them here too or the deploy would
      // strip what a live re-apply installed.
      for (const reg of fanoutRegistrations) {
        // CONCATENATED, not overwritten: spreading the fan-out's locations after the
        // compiled ones would ASSIGN over them, silently dropping a vercel.json external
        // rewrite on a path-routed domain. Fan-out first, so its explicit per-path
        // upstreams are matched ahead of a broader compiled rule.
        const proxyLocations = [
          ...(reg.proxyLocations ?? []),
          ...(routingFields.proxyLocations ?? []),
        ];
        await routeContext.routing.registerRoute({
          domain: reg.hostname,
          tls: true,
          terminatesTlsLocally: hostTerminatesTlsLocally(
            reg.hostname,
            routeContext.domainByHostname.get(reg.hostname.toLowerCase()),
          ),
          targetUrl: reg.targetUrl!,
          ...routingFields,
          ...(proxyLocations.length ? { proxyLocations } : {}),
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
        mutated = true;
        logger.log(`Stopped disabled service container (${previous.containerId.slice(0, 12)}).\n`);
      } catch (err) {
        hostPortClaimReapSafe = false;
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
      isRealContainerRef(prevContainerId) &&
      !prevWasServices &&
      !handledContainerIds.has(prevContainerId)
    ) {
      try {
        await runtime.destroy(prevContainerId);
        mutated = true;
        logger.log(`Stopped previous single-app container (${prevContainerId.slice(0, 12)}).\n`);
      } catch (err) {
        hostPortClaimReapSafe = false;
        const message = err instanceof Error ? err.message : "Unknown error";
        logger.log(`Warning: failed to stop previous single-app container: ${message}\n`, "warn");
      }
    }
  }

  // Every route writer and every old-workload reap has now settled. Only here
  // can a superseded claim be released: before this point an old vhost can still
  // dial its port, or a failed reap can leave a workload that a later repair may
  // put back behind that vhost.
  //
  // Do not converge an indeterminate deployment. A dropped connection means we
  // do not know which route writes reached the target, so retaining every claim
  // until reconciliation is the only safe answer.
  const hasIndeterminateHostPortOutcome = results.some(
    (result) => result.status === "indeterminate",
  );
  if (hostPortTarget && opts?.executor && successful > 0 && !opts?.strictScope) {
    if (hasIndeterminateHostPortOutcome) {
      logger.log(
        "Host-port reservation cleanup deferred until deployment reconciliation; all reservations were retained.\n",
        "warn",
      );
    } else if (!hostPortClaimReapSafe) {
      hostPortClaimWarning =
        "Host-port reservation cleanup was deferred because an obsolete workload could not be stopped; reservations were retained safely.";
      logger.log(`${hostPortClaimWarning}\n`, "warn");
    } else {
      // Build the desired set only after the final successful route writers and
      // reaps. A result recorded earlier is not sufficient authority to release
      // ownership while either of those later stages is still pending.
      const resultByServiceId = new Map(results.map((result) => [result.serviceId, result]));
      const desiredPublishes = usesHostLoopback
        ? [...hostLoopbackRoutePortDemands].flatMap(([serviceId, containerPorts]) => {
            const result = resultByServiceId.get(serviceId);
            if (!result || result.status === "failed") return [];
            return [...containerPorts].flatMap((containerPort, index) => {
              const mappedHostPort = result.hostPortByContainerPort?.[containerPort];
              // Legacy releases persisted only one scalar. It is attributable
              // only when this service has exactly one routed demand; with two
              // or more ports there is no safe way to know which one it means.
              const hostPort =
                mappedHostPort ??
                (containerPorts.size === 1 && index === 0 ? result.hostPort : undefined);
              return hostPort !== undefined ? [{ serviceId, containerPort, hostPort }] : [];
            });
          })
        : [];
      const convergence = {
        target: hostPortTarget,
        projectId: project.id,
        desiredPublishes,
        edgeProxy: edgeProxyFor(opts.executor, "openresty", { ours: true }),
      };
      try {
        // The public wrapper took the target lock for the current loopback
        // topology. A container-IP/static transition did not, and must acquire
        // it here while converging to an intentionally empty desired set.
        const converged = usesHostLoopback
          ? await convergeTargetHostPortClaimsUnlocked(convergence)
          : await convergeTargetHostPortClaims(convergence);
        if (converged.released > 0) {
          logger.log(
            `Released ${converged.released} obsolete host-port reservation${converged.released === 1 ? "" : "s"}.\n`,
          );
        }
      } catch (error) {
        hostPortClaimWarning =
          "Host-port reservation cleanup was deferred; uncertain reservations were retained safely.";
        logger.log(`${hostPortClaimWarning} ${safeErrorMessage(error)}\n`, "warn");
      }
    }
  }

  // Routed, but is it actually serving HTTPS? One shared auditor with the
  // single-app pipeline — `composeRouteWarnings` is passed so a host already
  // reported as UNROUTED isn't also reported as routed-without-a-cert.
  const tlsPendingDomains = await auditRoutedDomainTls({
    projectId: project.id,
    routes: registeredRoutes,
    routeWarnings: composeRouteWarnings,
    log: (message) => logger.log(`${message}\n`, "warn"),
  });

  const failed = results.filter((r) => r.status === "failed");
  const failedNames = failed.map((r) => r.serviceName);
  const indeterminate = results.filter((r) => r.status === "indeterminate");
  const skipped = skippedOutOfScope.length;
  // A service this pass declined to consider is not a failure — but it isn't nothing
  // either. Saying so here is what keeps the skip from being silent: an operator who adds
  // a service and then pushes a change to a DIFFERENT one still learns the new one never
  // came up, without it hijacking the deployment's status the way a `failure` row did.
  const skipNotice =
    skipped > 0
      ? `${skipped} service${skipped === 1 ? " was" : "s were"} left out of this deploy and ` +
        `${skipped === 1 ? "has" : "have"} no image to start from: ${skippedOutOfScope.join(", ")}. ` +
        `Redeploy ${skipped === 1 ? "it" : "them"} to bring ${skipped === 1 ? "it" : "them"} up.`
      : undefined;
  const warning =
    [
      failed.length > 0
        ? `${failed.length}/${ordered.length} services failed: ${failedNames.join(", ")}`
        : // Nothing failed, but something bounced on its way up — worth saying,
          // since a service that restarted twice at boot often restarts in prod.
          stabilityWarnings.length > 0
          ? stabilityWarnings.join("; ")
          : undefined,
      skipNotice,
      hostPortClaimWarning,
    ]
      .filter(Boolean)
      .join("; ") || undefined;
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
        deployed,
        failed: failed.length,
        indeterminate: indeterminate.length,
        mutated,
        failedServices: failedNames,
      },
      services: results,
      primaryContainerId,
      warning: `Connection lost — verifying ${indeterminate.length} service(s): ${names}`,
      publicUrl: firstPublicUrl,
      portChecks,
    };
  }

  // `successful + skipped` accounts for the whole enabled set: a service left out of a
  // scoped deploy is accounted for, just not deployed, so it must not read as a shortfall
  // that "needs attention".
  if (failed.length === 0 && successful + skipped === ordered.length) {
    logger.step(
      "deploy",
      "completed",
      skipped > 0
        ? `Deployed ${successful}/${ordered.length} services (${skipped} not part of this deploy).`
        : `All ${ordered.length} services deployed.`,
    );
  } else if (successful > 0) {
    logger.step(
      "deploy",
      "completed",
      `Deployed ${successful}/${ordered.length} services. ${failed.length} service${failed.length === 1 ? "" : "s"} still need attention.`,
    );
  } else {
    logger.step(
      "deploy",
      "failed",
      `${failed.length}/${ordered.length} services failed to deploy.`,
    );
  }
  // Lifted out of the partial branch it used to live in, because that branch is no longer
  // the only one that can carry a warning: an all-successful deploy can have a stability
  // warning (which reached the deployment's meta while the persisted log said nothing), and
  // a skip notice belongs on an otherwise clean pass. Guarded on `warning` because the
  // shortfall may now be skips rather than failures — unguarded it interpolated a literal
  // `undefined` — and on `successful > 0` because nothing "completed" on a total failure
  // (the step above already says so, and `error` carries the reason).
  if (warning && successful > 0) {
    logger.log(`Deployment completed with warnings: ${warning}\n`, "warn");
  }

  return {
    status: successful > 0 ? "ready" : "failed",
    summary: {
      total: ordered.length,
      successful,
      deployed,
      failed: failed.length,
      indeterminate: 0,
      mutated,
      failedServices: failedNames,
    },
    services: results,
    primaryContainerId,
    warning,
    ...(composeRouteWarnings.length ? { routeWarnings: composeRouteWarnings } : {}),
    ...(tlsPendingDomains.length ? { tlsPendingDomains } : {}),
    // `skipNotice` before the generic: when a scoped deploy named no enabled service, every
    // service is out of scope and nothing failed — so "No services deployed successfully"
    // is true but useless, while the notice names what was left out and what to do.
    error:
      successful > 0
        ? undefined
        : (firstFailure ?? skipNotice ?? "No services deployed successfully"),
    publicUrl: firstPublicUrl,
    portChecks,
  };
}
