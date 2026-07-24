import { repos, type Domain, type Project } from "@repo/db";
import {
  isLoopbackHost,
  isReservedLoopbackPort,
  managedHostnameToSlug,
  publicEndpointHostname,
  routeDomainRowToPublicEndpoint,
  syncStoredPublicEndpoints,
  type StoredPublicEndpoint,
} from "../../lib/public-endpoints";
import { resolveUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";
import { syncProjectPublicRoutes } from "../../lib/project-route-store";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { pushProjectRules } from "../route-rules/route-rule.service";
import {
  reconcileProjectRoutes,
  type RouteRegister,
  type RouteRemove,
} from "../../lib/route-apply.service";

type ProjectRouteProject = Pick<Project, "id" | "slug">;
type RouteStateProject = Pick<Project, "slug">;
type NextPublicEndpointsInput = Parameters<typeof syncStoredPublicEndpoints>[0]["next"];

export interface ProjectRouteEndpoint extends StoredPublicEndpoint {
  id?: string;
  hostname: string;
  isPrimary: boolean;
}

export interface ProjectRouteState {
  projectDomains: Domain[];
  publicEndpoints: ProjectRouteEndpoint[];
  primarySlug: string;
  primaryCustomDomain?: string;
  primaryDomainType: "free" | "custom";
}

export function deriveEnvironmentPublicEndpoints(
  publicEndpoints: Array<Pick<StoredPublicEndpoint, "port" | "targetPath">>,
  slug: string,
): StoredPublicEndpoint[] {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) return [];

  const primaryEndpoint = publicEndpoints[0];
  if (!primaryEndpoint) return [];

  if (primaryEndpoint.targetPath) {
    return [{
      targetPath: primaryEndpoint.targetPath,
      domain: normalizedSlug,
      domainType: "free",
    }];
  }

  if (primaryEndpoint.port !== undefined) {
    return [{
      port: primaryEndpoint.port,
      domain: normalizedSlug,
      domainType: "free",
    }];
  }

  return [];
}

function normalizeProjectRouteRows(projectDomains: Domain[]): Domain[] {
  return projectDomains
    .filter((domain) => !domain.serviceId)
    .sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }

      return left.hostname.localeCompare(right.hostname);
    });
}

function draftEndpointsWithIds(
  projectDomains: Domain[],
  endpoints: StoredPublicEndpoint[],
): ProjectRouteEndpoint[] {
  const idByHostname = new Map(
    normalizeProjectRouteRows(projectDomains).map((domain) => [domain.hostname.toLowerCase(), domain.id]),
  );

  return endpoints.map((endpoint, index) => {
    const hostname = publicEndpointHostname(endpoint) ?? "";
    return {
      ...endpoint,
      id: hostname ? idByHostname.get(hostname.toLowerCase()) : undefined,
      hostname,
      isPrimary: index === 0,
    } satisfies ProjectRouteEndpoint;
  });
}

function routeRowToEndpoint(domain: Domain): ProjectRouteEndpoint | null {
  // Service-scoped rows are per-service routes, not project-level endpoints.
  if (domain.serviceId) return null;
  // Shared domain-row → endpoint rule (port XOR path, free→slug / custom→host).
  const endpoint = routeDomainRowToPublicEndpoint(domain);
  if (!endpoint) return null;
  const hostname = publicEndpointHostname(endpoint);
  if (!hostname) return null;

  return {
    ...endpoint,
    id: domain.id,
    hostname,
    isPrimary: domain.isPrimary,
  } satisfies ProjectRouteEndpoint;
}

function buildRouteState(
  project: RouteStateProject,
  projectDomains: Domain[],
  publicEndpoints: ProjectRouteEndpoint[],
): ProjectRouteState {
  const primaryEndpoint = publicEndpoints[0];

  return {
    projectDomains,
    publicEndpoints,
    primarySlug:
      primaryEndpoint?.domainType === "free"
        ? (primaryEndpoint.domain ?? project.slug ?? "project")
        : (project.slug ?? "project"),
    primaryCustomDomain:
      primaryEndpoint?.domainType === "custom" ? primaryEndpoint.customDomain : undefined,
    primaryDomainType: primaryEndpoint?.domainType ?? "free",
  };
}

export async function listProjectRouteRows(projectId: string): Promise<Domain[]> {
  return repos.domain.listByProject(projectId);
}

export function deriveProjectRouteState(
  project: RouteStateProject,
  opts?: { projectDomains?: Domain[] },
): ProjectRouteState {
  const projectDomains = normalizeProjectRouteRows(opts?.projectDomains ?? []);
  const publicEndpoints = projectDomains
    .map((domain) => routeRowToEndpoint(domain))
    .filter((endpoint): endpoint is ProjectRouteEndpoint => endpoint !== null);

  return buildRouteState(project, projectDomains, publicEndpoints);
}

export function deriveNextProjectRouteState(
  project: RouteStateProject,
  input: {
    projectDomains?: Domain[];
    nextPublicEndpoints?: NextPublicEndpointsInput;
    slug?: string | null;
    customDomain?: string | null;
  },
): ProjectRouteState {
  const currentState = deriveProjectRouteState(project, {
    projectDomains: input.projectDomains,
  });
  const routing = syncStoredPublicEndpoints({
    current: currentState.publicEndpoints,
    next: input.nextPublicEndpoints,
    slug: input.slug ?? project.slug,
    customDomain: input.customDomain,
    projectDomains: currentState.projectDomains,
  });

  return buildRouteState(
    project,
    currentState.projectDomains,
    draftEndpointsWithIds(currentState.projectDomains, routing.publicEndpoints),
  );
}

export async function resolveProjectRouteState(
  project: ProjectRouteProject,
  opts?: { projectDomains?: Domain[] },
): Promise<ProjectRouteState> {
  const projectDomains = opts?.projectDomains ?? await listProjectRouteRows(project.id);
  return deriveProjectRouteState(project, { projectDomains });
}

export async function persistProjectRouteState(
  projectId: string,
  publicEndpoints: StoredPublicEndpoint[],
  projectDomains?: Domain[],
): Promise<void> {
  await syncProjectPublicRoutes({
    projectId,
    endpoints: publicEndpoints,
    currentDomains: projectDomains,
  });
}

export async function syncProjectRouteState(
  project: ProjectRouteProject,
  input: {
    projectDomains?: Domain[];
    nextPublicEndpoints?: NextPublicEndpointsInput;
    slug?: string | null;
    customDomain?: string | null;
  },
): Promise<ProjectRouteState> {
  const projectDomains = input.projectDomains ?? await listProjectRouteRows(project.id);
  const nextState = deriveNextProjectRouteState(project, {
    ...input,
    projectDomains,
  });

  await persistProjectRouteState(project.id, nextState.publicEndpoints, projectDomains);
  const refreshedDomains = await listProjectRouteRows(project.id);
  return deriveProjectRouteState(project, { projectDomains: refreshedDomains });
}

/**
 * Re-apply a single-app project's LIVE routes after a domain/port edit so the
 * change takes effect immediately instead of waiting for the next deploy
 * (`syncProjectRouteState` only writes DB rows). Best-effort: the rows are
 * already committed, so a routing failure just defers to the next deploy.
 *
 * `previousHostnames` are the hostnames tracked BEFORE the edit; any that are
 * gone now get their live route torn down.
 *
 * Self-hosted uses the routing provider (nginx/openresty), resolving the
 * upstream from the active deployment's container (docker) or the host (bare).
 * Cloud re-applies via the runtime's page/workspace primitives.
 *
 * Static-path routes (served straight from the web root) are left to the next
 * deploy — they have no live upstream to point at here.
 */
export interface ReapplyProjectLiveRoutesOptions {
  /**
   * The self-app (control plane) project legitimately routes its public
   * hostname to its OWN dashboard port on loopback — that's the whole point
   * of self-deploy.ts. Only self-deploy.ts's own call sites may pass this;
   * it must never be derived from `project.appTemplateId`, which is
   * client-writable via the ordinary create/update project APIs and would
   * let any project forge its way past the reserved-port guard.
   */
  isSelfApp?: boolean;
}

/**
 * True when a resolved upstream must NOT be used for a public route: a
 * loopback host pointed at a reserved control-plane/mgmt port (the admin
 * API, the dashboard, or the unauthenticated OpenResty mgmt port) would
 * expose an internal service to the internet. `isSelfApp` is the one
 * exception — the control-plane project's own route to itself.
 */
export function shouldRefuseLoopbackRoute(
  host: string,
  port: number,
  opts: ReapplyProjectLiveRoutesOptions = {},
): boolean {
  return isLoopbackHost(host) && isReservedLoopbackPort(port) && !opts.isSelfApp;
}

export async function reapplyProjectLiveRoutes(
  project: Pick<
    Project,
    | "id"
    | "slug"
    | "port"
    | "cloudWorkspaceId"
    | "activeDeploymentId"
    | "organizationId"
    | "webhookDomain"
    | "routeStrategy"
  >,
  previousHostnames: string[],
  opts: ReapplyProjectLiveRoutesOptions = {},
): Promise<void> {
  const isCloud = !!project.cloudWorkspaceId;
  if (!isCloud && !project.activeDeploymentId) return;

  const state = await resolveProjectRouteState({ id: project.id, slug: project.slug });
  const current = normalizeProjectRouteRows(state.projectDomains);
  const currentHostnames = new Set(current.map((d) => d.hostname.toLowerCase()));
  // domainType isn't retained for a dropped row — infer managed vs custom from
  // the base-domain suffix so cloud teardown targets the right primitive.
  const removes: RouteRemove[] = previousHostnames
    .filter((h) => !currentHostnames.has(h.toLowerCase()))
    .map((hostname) => ({ hostname, isCustomDomain: !managedHostnameToSlug(hostname) }));

  // Cloud: no upstream resolution — the workspace/page owns routing by port.
  if (isCloud) {
    const registers: RouteRegister[] = current
      .filter((domain) => !domain.targetPath)
      .map((domain) => ({
        hostname: domain.hostname,
        port: domain.targetPort ?? project.port ?? undefined,
        // Infer from the hostname suffix (same signal the removes use) so a
        // legacy null `domainType` row still resolves the right cloud primitive.
        isCustomDomain: !managedHostnameToSlug(domain.hostname),
      }));
    await reconcileProjectRoutes(project, { registers, removes });
    return;
  }

  // Self-hosted: resolve the deployment's routing + runtime ONCE (the same
  // resolver deploy/delete use), then compute each upstream from the container.
  const deployment = await repos.deployment.findById(project.activeDeploymentId!);
  if (!deployment) {
    console.warn(
      `[project-route] ${project.slug}: no active deployment row — skipping live route re-apply`,
    );
    return;
  }
  const { routing, runtime, effectiveTarget, serverId } =
    await resolveDeploymentRuntime(deployment);

  const containerId = deployment.containerId;
  if (!containerId) {
    // Compose/multi-service deployments track containers per-service, so the
    // parent deployment row has no containerId — nothing to point a single-app
    // route at (per-service routes are handled in updateService). Still tear
    // down any dropped hostnames on the correct host.
    console.warn(
      `[project-route] ${project.slug}: deployment ${deployment.id} has no containerId (target=${effectiveTarget}) — skipping single-app route registration`,
    );
    await reconcileProjectRoutes(project, { routing, removes });
    await pushProjectRules(project.id, serverId ?? null, previousHostnames).catch(() => {});
    return;
  }

  const resolveTargetUrl = async (port: number): Promise<string | null> => {
    const strategy = resolveRouteStrategy(project.routeStrategy);
    // loopback-port: dial the container's published loopback host port (read
    // live). Bare / no-host-port fall back to container IP (or 127.0.0.1 bare).
    let hostPort: number | undefined;
    if (strategy === "loopback-port" && runtime.name !== "bare") {
      hostPort = (await runtime.getContainerInfo?.(containerId).catch(() => null))?.hostPort ?? undefined;
    }
    const url = await resolveUpstreamUrl({ strategy, runtime, containerId, containerPort: port, hostPort });
    if (!url) {
      console.warn(
        `[project-route] ${project.slug}: could not resolve upstream for ${containerId} (target=${effectiveTarget}, server=${serverId ?? "local"})`,
      );
      return null;
    }
    // Never proxy a public route at a reserved control-plane/mgmt port on the
    // host loopback — that would expose the admin API (env.PORT) or the
    // unauthenticated OpenResty mgmt port (9145). Only guards loopback: a
    // container's own bridge IP:<port> is the app's, not ours. The self-app is
    // exempt (see ReapplyProjectLiveRoutesOptions.isSelfApp).
    const m = url.match(/^https?:\/\/([^:/]+):(\d+)$/);
    if (m && shouldRefuseLoopbackRoute(m[1], Number(m[2]), opts)) {
      console.warn(
        `[project-route] ${project.slug}: refusing reserved loopback upstream port ${m[2]} for a public route`,
      );
      return null;
    }
    return url;
  };

  const registers: RouteRegister[] = [];
  for (const domain of current) {
    if (domain.targetPath) continue;
    const port = domain.targetPort ?? project.port;
    if (!port) {
      console.warn(`[project-route] ${project.slug}: no port for ${domain.hostname} — skipping`);
      continue;
    }
    const targetUrl = await resolveTargetUrl(port);
    if (!targetUrl) continue;
    registers.push({
      hostname: domain.hostname,
      targetUrl,
      isCustomDomain: domain.domainType === "custom",
    });
  }

  // The webhook-proxy location is re-attached automatically for the project's
  // webhookDomain inside reconcileProjectRoutes.
  await reconcileProjectRoutes(project, { routing, registers, removes });

  // Re-sync per-route edge rules (rate-limit / ban / allow-deny) for the current
  // hostnames. Best-effort — the DB is the source of truth; a failure defers to
  // the next reconcile. previousHostnames clears rules for any dropped hostname.
  await pushProjectRules(project.id, serverId ?? null, previousHostnames).catch(() => {});
}