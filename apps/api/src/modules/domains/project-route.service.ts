import { repos, type Domain, type Project } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { resolveServedStaticPath } from "@repo/adapters";
import {
  isLoopbackHost,
  isReservedLoopbackPort,
  managedHostnameToSlug,
  publicEndpointHostname,
  routeDomainRowToPublicEndpoint,
  syncStoredPublicEndpoints,
  type StoredPublicEndpoint,
} from "../../lib/public-endpoints";
import { assertValidCustomDomain, assertValidCustomDomains } from "../../lib/custom-domain-guard";
import { resolveUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";
import { deregisterManagedEdgeRoutes, syncManagedEdgeRoutes } from "../../lib/managed-edge-proxy";
import { syncProjectPublicRoutes } from "../../lib/project-route-store";
import { resolveRouteRedirect } from "../../lib/domain-redirect";
import { resolveDeploymentRuntime, resolveDeploymentStaticRoot } from "../../lib/deployment-runtime";
import { pushProjectRules } from "../route-rules/route-rule.service";
import { pushProjectAnalyticsConfig } from "../analytics/analytics-config.service";
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

  // The one funnel every SUBMITTED project route passes through (project create /
  // ensure / update, POST /deployments/build/access), so the custom-hostname shape
  // gate belongs here rather than in each caller — a new write path can't reopen
  // #342 by forgetting to call it. Only the INCOMING values are checked, and only
  // where they introduce a hostname the project doesn't already have: stored rows
  // arrive through `projectDomains` and are echoed back by every save, so a project
  // holding a bad hostname keeps reading, deploying and editing.
  assertValidCustomDomain(input.customDomain);
  assertValidCustomDomains([{ publicEndpoints: input.nextPublicEndpoints }], {
    known: [
      ...currentState.projectDomains.map((domain) => domain.hostname),
      ...currentState.publicEndpoints.map((endpoint) => endpoint.hostname),
    ],
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
  opts?: { preserveVerifiedCustom?: boolean },
): Promise<void> {
  await syncProjectPublicRoutes({
    projectId,
    endpoints: publicEndpoints,
    currentDomains: projectDomains,
    preserveVerifiedCustom: opts?.preserveVerifiedCustom,
  });
}

export async function syncProjectRouteState(
  project: ProjectRouteProject,
  input: {
    projectDomains?: Domain[];
    nextPublicEndpoints?: NextPublicEndpointsInput;
    slug?: string | null;
    customDomain?: string | null;
    /**
     * Deploy-only: never destroy a verified custom domain during this sync (see
     * syncProjectPublicRoutes). Left unset by the Domains editor so explicit
     * removals still apply.
     */
    preserveVerifiedCustom?: boolean;
  },
): Promise<ProjectRouteState> {
  const projectDomains = input.projectDomains ?? await listProjectRouteRows(project.id);
  const nextState = deriveNextProjectRouteState(project, {
    ...input,
    projectDomains,
  });

  await persistProjectRouteState(project.id, nextState.publicEndpoints, projectDomains, {
    preserveVerifiedCustom: input.preserveVerifiedCustom,
  });
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

  /**
   * The caller runs its own managed-edge (`*.opsh.io`) sync, so skip the one below.
   *
   * Two callers already do — `updateProject` follows with `syncProjectManagedEdge`
   * (which covers ALL of the project's managed hostnames, not just the new ones) and
   * the self-register wizard fronts this with `ensureManagedEdgeProxy`. Without this,
   * a newly-added free domain is synced TWICE per edit, and the two calls overlap
   * because the sync below is fire-and-forget: whichever loses the race issues a
   * second challenge, which RESETS the token upstream and makes the other's check
   * fail against a token that no longer exists. The route ends up fine and the
   * project shows "Action Required" anyway.
   *
   * Default false, deliberately: the callers that own their own sync are the
   * exception (`self-deploy`, the migration orchestrator and the per-service paths
   * all rely on the sync below being the only one), so opting OUT keeps a new caller
   * correct by default.
   */
  managedEdgeSyncedByCaller?: boolean;
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
    // Needed to re-emit a STATIC route live (see resolveLiveStaticRoot): a
    // path-targeted domain serves files, so it needs a doc root, not an upstream.
    | "hasServer"
    | "outputDirectory"
    // Carries `proxy` (upload limit, timeouts) through to reconcileProjectRoutes,
    // so raising a limit applies on save instead of waiting for a redeploy.
    | "routingConfig"
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

  // Self-hosted: a dropped free (*.opsh.io) hostname leaves a stale slug→target
  // route on Openship Cloud's edge. Deregister it (best-effort) so the freed
  // slug is reusable and the old URL stops resolving. Cloud projects route their
  // managed subdomain INTERNALLY (page/workspace), reconciled by the cloud
  // branch below — so this teardown is self-hosted only.
  if (!isCloud) {
    const droppedSlugs = removes
      .map((r) => managedHostnameToSlug(r.hostname))
      .filter((s): s is string => !!s);
    if (droppedSlugs.length > 0) {
      void deregisterManagedEdgeRoutes(droppedSlugs, {
        organizationId: project.organizationId,
      })
        .then(({ failures }) => {
          if (failures.length > 0) {
            console.warn(
              `[project-route] ${project.slug}: managed edge deregister failed for ${failures.join(", ")}`,
            );
          }
        })
        .catch(() => {});
    }
  }

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

  // Register the managed (*.opsh.io) hostnames that are NEW in this edit on
  // Openship Cloud's edge — the "add" half. Oblien's edge has NO route EDIT
  // (only sync + deregister), so a slug change is drop-old (deregistered above)
  // + add-new (here). PER-ROUTE by design: only hostnames absent from
  // `previousHostnames` are synced — symmetric with the dropped-slug deregister
  // above — so editing ONE route never re-hits Oblien (or re-resolves the target
  // host) for the project's OTHER, unchanged routes. A target-host change on an
  // UNCHANGED hostname (e.g. a server move) is re-synced by the deploy path, not
  // here. Best-effort/fire-and-forget: the app is live locally; a failure only
  // delays the free URL (same contract as the deploy path's sync).
  const previouslyPresent = new Set(previousHostnames.map((h) => h.toLowerCase()));
  const syncAddedManagedEdge = () => {
    if (opts.managedEdgeSyncedByCaller) return;
    // NOT filtered by target kind. The edge route is `<slug>.opsh.io` → this
    // server's :80; what the vhost then does with the request — proxy to a
    // container or serve files — is decided locally and is none of Cloud's
    // business. Excluding path targets here meant a free domain on a STATIC
    // project registered nothing on the edge, so the URL resolved to the
    // wildcard with no origin: the free domain worked for proxied projects and
    // silently did nothing for static ones.
    const addedTargets = current
      .filter((d) => !previouslyPresent.has(d.hostname.toLowerCase()))
      .map((d) => ({ hostname: d.hostname, subdomain: managedHostnameToSlug(d.hostname) }))
      .filter((t): t is { hostname: string; subdomain: string } => !!t.subdomain);
    if (addedTargets.length === 0) return;
    void syncManagedEdgeRoutes(addedTargets, {
      organizationId: project.organizationId,
      serverId: serverId ?? undefined,
    })
      .then(({ failures }) => {
        if (failures.length > 0) {
          console.warn(
            `[project-route] ${project.slug}: managed edge sync failed for ${failures.join(", ")}`,
          );
        }
      })
      .catch(() => {});
  };

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
    // Shared-dict state is RAM: the analytics collection switches have to be re-pushed
    // whenever routing is applied, or an nginx restart silently reverts them to off.
    await pushProjectAnalyticsConfig(project.id, serverId ?? null, previousHostnames).catch(() => {});
    syncAddedManagedEdge();
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

  // Where a path-targeted (static) domain serves its files from — the SAME
  // resolver the post-deploy output probe uses, so the vhost and the check that
  // audits it can never disagree about the directory.
  const staticRootBase = resolveDeploymentStaticRoot(deployment, project);

  // A redirect only goes live when its target is one of the hostnames this
  // project currently routes — see resolveRouteRedirect.
  const liveHostnames = current.map((domain) => domain.hostname);
  const registers: RouteRegister[] = [];
  for (const domain of current) {
    const redirectHost = resolveRouteRedirect(domain, liveHostnames);
    const common = {
      hostname: domain.hostname,
      isCustomDomain: domain.domainType === "custom",
      ...(redirectHost ? { redirectHost } : {}),
    };

    // A domain targets a PORT (proxy to the app) or a PATH (serve files) —
    // exactly one, same rule the deploy path enforces. `continue`-ing on
    // targetPath is what left static projects unrouted here: adding a domain to
    // one wrote no vhost at all, so the hostname fell through to
    // default_server, while the deploy path (which does emit a static root)
    // made the same domain work — so it only ever "broke" on edit.
    if (domain.targetPath) {
      if (!staticRootBase) {
        console.warn(
          `[project-route] ${project.slug}: no static root for ${domain.hostname} (path ${domain.targetPath}) — skipping`,
        );
        continue;
      }
      try {
        // Same call the deploy path's route registration and the output probe
        // make — one rule for "which directory does this path serve".
        registers.push({ ...common, staticRoot: resolveServedStaticPath(staticRootBase, domain.targetPath) });
      } catch (err) {
        // A `../` in the operator's route path. Refuse this ONE route; the rest of
        // the re-apply (and the project's other domains) must still go through.
        console.warn(
          `[project-route] ${project.slug}: refusing ${domain.hostname} — ${safeErrorMessage(err)}`,
        );
      }
      continue;
    }

    const port = domain.targetPort ?? project.port;
    if (!port) {
      console.warn(`[project-route] ${project.slug}: no port for ${domain.hostname} — skipping`);
      continue;
    }
    const targetUrl = await resolveTargetUrl(port);
    if (!targetUrl) continue;
    registers.push({ ...common, targetUrl });
  }

  // The webhook-proxy location is re-attached automatically for the project's
  // webhookDomain inside reconcileProjectRoutes.
  await reconcileProjectRoutes(project, { routing, registers, removes });

  // Re-sync per-route edge rules (rate-limit / ban / allow-deny) for the current
  // hostnames. Best-effort — the DB is the source of truth; a failure defers to
  // the next reconcile. previousHostnames clears rules for any dropped hostname.
  await pushProjectRules(project.id, serverId ?? null, previousHostnames).catch(() => {});
    // Shared-dict state is RAM: the analytics collection switches have to be re-pushed
    // whenever routing is applied, or an nginx restart silently reverts them to off.
    await pushProjectAnalyticsConfig(project.id, serverId ?? null, previousHostnames).catch(() => {});

  // Register the newly-added managed slug(s) on the cloud edge (the "add" half
  // of the edit; dropped slugs were deregistered above). Per-route — unchanged
  // hostnames are not re-synced.
  syncAddedManagedEdge();
}