/**
 * Apply a project's vercel.json-derived routing to its LIVE deployment WITHOUT a
 * rebuild — the counterpart to the deploy-time composite registration, used when
 * the user edits routing from the Routing/Domains tab (`PUT /projects/:id/routing`).
 *
 * Two emitters over the persisted live topology:
 *   - Self-hosted → canonical service-owned routes followed by composite and
 *     migration fan-out overlays → OpenResty through `reconcileProjectRoutes`.
 *   - Cloud → `compileRoutingToOblien` → the Oblien edge via `routes.set`.
 * `routes.set` ATOMICALLY REPLACES a hostname's edge behavior, so the cloud path
 * always compiles the COMPLETE table (what backs `/` + overrides) — never a
 * partial one. Both paths are best-effort: the project edit is already persisted
 * by the caller, so a live-apply failure logs and defers to the next deploy.
 */

import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import {
  CloudInfraProvider,
  edgeProxyFor,
  compileRoutingToOblien,
  resolveServedStaticPath,
} from "@repo/adapters";
import { platform } from "../../lib/platform-config";
import {
  disposePlatform,
  resolveDeploymentPlatform,
  resolveDeploymentStaticRoot,
  usesManagedRouting,
  type DeploymentMeta,
  type ResolvedDeploymentPlatform,
} from "../../lib/deployment-runtime";
import { reconcileProjectRoutes } from "../../lib/route-apply.service";
import { recoverProjectRouteCleanup } from "../../lib/project-route-recovery";
import { compileProjectRoutingFields } from "../../lib/project-routing-fields";
import { resolveServicePort } from "../../lib/deployable-service";
import { isArtifactRef } from "../../lib/container-ref";
import {
  buildProjectRouteDomains,
  buildServiceRouteDomain,
  buildServiceRouteDomains,
  ensureRouteDomainRecord,
} from "../../lib/routing-domains";
import {
  pickProjectPortOwner,
  withServiceRuntimeOverride,
  type ServiceRuntimeOverride,
} from "../../lib/project-service-upstream";
import { resolveRouteRedirect } from "../../lib/domain-redirect";
import {
  buildCompositeRegistration,
  buildDomainFanoutRegistrations,
  planCompositeRoute,
  resolveDomainFanoutRoutes,
} from "../deployments/compose/composite-route";
import { resolveLiveUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";
import {
  observedLoopbackPublishFromUrl,
  type ObservedLoopbackPublish,
} from "../deployments/observed-host-port-claims";

export async function applyProjectRouting(
  projectId: string,
  options: {
    onWarning?: (message: string) => void;
    onLog?: (message: string) => void;
    serviceRuntime?: ServiceRuntimeOverride;
  } = {},
): Promise<void> {
  const warn = (message: string) => {
    console.warn(message);
    options.onWarning?.(message);
  };
  const project = await repos.project.findById(projectId);
  if (!project) return;

  // No active deployment → the persisted routingConfig applies on the next deploy.
  if (!project.activeDeploymentId) return;

  // Held for the `finally`: a remote-server platform binds a Docker-over-SSH
  // loopback bridge that only `dispose` closes, and this ran on every live route
  // edit. Releasing it leaves `routing` fully usable — the bridge is the docker
  // transport, while routing drives the box through the pooled SSH executor.
  let resolved: ResolvedDeploymentPlatform | null = null;
  try {
    const deployment = await findActiveDeployment(project);
    if (!deployment) return;

    resolved = await resolveDeploymentPlatform((deployment.meta ?? {}) as DeploymentMeta, {
      organizationId: deployment.organizationId,
    });
    const { routing, runtime } = resolved.platform;
    const managed = usesManagedRouting(platform().target, resolved.effectiveTarget);
    const defs = await repos.service.listByProject(project.id);
    const liveRows = withServiceRuntimeOverride(
      await repos.service.listByDeployment(deployment.id),
      options.serviceRuntime,
    );

    // Cloud: apply the vercel routing at the Oblien edge (no OpenResty).
    if (routing instanceof CloudInfraProvider) {
      await applyCloudRouting({ project, routing, defs, liveRows, deployment });
      return;
    }

    // Self-hosted: compile to OpenResty locations and reconcile the domain.
    if (!routing) return;
    const domainRows = await repos.domain.listByProject(project.id);
    const rowByService = new Map(liveRows.map((row) => [row.serviceId, row]));
    const domainByHostname = new Map(
      domainRows.map((domain) => [domain.hostname.toLowerCase(), domain]),
    );
    const routeStrategy = resolveRouteStrategy(project.routeStrategy);
    const observedByUrl = new Map<string, ObservedLoopbackPublish[]>();
    const rememberObservedPublish = (
      serviceId: string,
      containerPort: number,
      targetUrl: string | null | undefined,
    ) => {
      const observed = observedLoopbackPublishFromUrl({
        targetUrl,
        serviceId,
        containerId: rowByService.get(serviceId)?.containerId,
        containerPort,
      });
      if (!observed || !targetUrl) return;
      const current = observedByUrl.get(targetUrl) ?? [];
      if (
        !current.some(
          (item) =>
            item.serviceId === observed.serviceId && item.containerPort === observed.containerPort,
        )
      ) {
        current.push(observed);
        observedByUrl.set(targetUrl, current);
      }
    };

    // Build service-owned routes with the same canonical planner used by deploy
    // and service edits. A strategy-only project save must rewrite these vhosts
    // too; otherwise an unchanged Compose service can be carried forever behind
    // the old topology.
    const plannedServiceRoutes = defs
      .filter((def) => def.enabled)
      .flatMap((def) =>
        buildServiceRouteDomains({
          project,
          service: def,
          runtimeName: runtime.name,
          usesManagedRouting: managed,
          domainByHostname,
        }).map((route) => ({ def, route })),
      );
    const serviceRoutePlans: typeof plannedServiceRoutes = [];
    const blockedHostnames = new Set<string>();
    await recoverProjectRouteCleanup({
      project,
      deployment,
      resolved,
      hostnames: [
        ...domainRows.map((row) => row.hostname),
        ...plannedServiceRoutes.map(({ route }) => route.hostname),
      ],
      onLog: options.onLog,
    });
    for (const plan of plannedServiceRoutes) {
      try {
        // A route needs a durable owner and verification row as well as a
        // vhost. Repair old service-only imports through the deploy planner's
        // same ownership check, without claiming another project's hostname.
        await ensureRouteDomainRecord({ projectId, route: plan.route, domainByHostname });
        serviceRoutePlans.push(plan);
      } catch (error) {
        blockedHostnames.add(plan.route.hostname.toLowerCase());
        warn(`${plan.route.hostname}: ${safeErrorMessage(error)}`);
      }
    }
    const liveServiceHostnames = serviceRoutePlans.map(({ route }) => route.hostname);

    // One live-upstream inventory, shared by service routes, the vercel
    // composite, and migration fan-out. Resolve every distinct (service, port)
    // up front because the composite/fan-out builders take a synchronous resolver.
    // Live observation is mandatory: cached bridge IPs and host ports can be
    // reassigned after a container disappears.
    const portsByService = new Map<string, Set<number>>();
    const requirePort = (serviceId: string, port: number | null | undefined) => {
      if (!port) return;
      const ports = portsByService.get(serviceId) ?? new Set<number>();
      ports.add(port);
      portsByService.set(serviceId, ports);
    };
    for (const { def, route } of serviceRoutePlans) requirePort(def.id, route.targetPort);
    for (const def of defs) requirePort(def.id, resolveServicePort(def, project.port));
    const fanoutRoutes = resolveDomainFanoutRoutes({
      routes: project.compositeRoutes,
      services: defs,
      domainByHostname,
    });
    for (const route of fanoutRoutes) {
      requirePort(route.rootServiceId, route.rootPort);
      for (const location of route.locations) requirePort(location.serviceId, location.port);
    }

    const upstreamKey = (serviceId: string, containerPort: number) =>
      `${serviceId}\0${containerPort}`;
    const liveUpstreams = new Map<string, string | null>();
    await Promise.all(
      [...portsByService].flatMap(([serviceId, ports]) => {
        const row = rowByService.get(serviceId);
        if (!row?.containerId) return [];
        return [...ports].map(async (containerPort) => {
          liveUpstreams.set(
            upstreamKey(serviceId, containerPort),
            await resolveLiveUpstreamUrl({
              strategy: routeStrategy,
              runtime,
              containerId: row.containerId!,
              containerPort,
              stored: { ip: row.ip, hostPort: row.hostPort, hostPorts: row.hostPorts },
              requireLiveObservation: true,
            }),
          );
        });
      }),
    );

    const resolveTargetUrlForPort = (serviceId: string, containerPort: number) => {
      const targetUrl = liveUpstreams.get(upstreamKey(serviceId, containerPort)) ?? null;
      rememberObservedPublish(serviceId, containerPort, targetUrl);
      return targetUrl;
    };
    const resolveTargetUrl = (serviceId: string, requestedPort?: number) => {
      const def = defs.find((candidate) => candidate.id === serviceId);
      const port = def?.enabled ? (requestedPort ?? resolveServicePort(def, project.port)) : null;
      return port ? resolveTargetUrlForPort(serviceId, port) : null;
    };

    /**
     * A compose static sub-app is served from a host DIRECTORY, and that directory
     * is the whole handle: it owns no container, no port and no upstream. The deploy
     * path reads it from the release it just promoted; here it comes off the active
     * deployment's `service_deployment.image_ref`, which is where that promote wrote
     * it (a leading-slash path in a column that otherwise holds image tags — the
     * `isArtifactRef` rule).
     *
     * Without this the frontend resolved to no upstream, `buildCompositeRegistration`
     * returned null, and a live routing save emitted NOTHING for the flagship
     * monorepo shape while reporting success — the vhost could only be produced by a
     * full deploy, so the Retry-routing button could not repair a lost route.
     */
    const resolveStaticRoot = (serviceId: string) => {
      const ref = rowByService.get(serviceId)?.imageRef;
      return isArtifactRef(ref) ? ref!.trim() : null;
    };

    const routingFields = compileProjectRoutingFields(project.routingConfig);
    const serviceRegisters = serviceRoutePlans.flatMap(({ def, route }) => {
      if (!route.targetPort) return [];
      const redirectHost = resolveRouteRedirect(route, liveServiceHostnames);
      const staticRoot = resolveStaticRoot(def.id);
      const targetUrl = staticRoot ? null : resolveTargetUrlForPort(def.id, route.targetPort);
      // A failed live inspection is not authority to replace a working vhost
      // with a cached address. Leave this one untouched; a later retry/deploy can
      // re-observe it. Static services are authoritative through their release dir.
      if (!redirectHost && !staticRoot && !targetUrl) {
        warn(
          `${route.hostname}: ${def.name} has no live upstream on port ${route.targetPort}; its route was not replaced.`,
        );
        return [];
      }
      const observed = targetUrl
        ? observedLoopbackPublishFromUrl({
            targetUrl,
            serviceId: def.id,
            containerId: rowByService.get(def.id)?.containerId,
            containerPort: route.targetPort,
          })
        : null;
      return [
        {
          ...routingFields,
          hostname: route.hostname,
          port: route.targetPort,
          isCustomDomain: route.domainType === "custom",
          ...(staticRoot ? { staticRoot } : targetUrl ? { targetUrl } : {}),
          ...(redirectHost ? { redirectHost } : {}),
          // Redirect vhosts render no upstream at all. Do not describe the
          // service's otherwise-live target as dialled ownership; the shared
          // reconciler also filters this defensively from rendered URLs.
          ...(!redirectHost && observed ? { observedLoopbackPublishes: [observed] } : {}),
        },
      ];
    });

    const composite = buildCompositeRegistration({
      services: defs,
      routingConfig: project.routingConfig,
      resolveTargetUrl,
      resolveStaticRoot,
      resolveDomain: (serviceId) => {
        const domain = serviceRoutePlans.find(({ def }) => def.id === serviceId)?.route ?? null;
        return domain
          ? { hostname: domain.hostname, isCustomDomain: domain.domainType === "custom" }
          : null;
      },
    });

    // A composite the builder REFUSED is the one outcome this function used to hide:
    // it returned null for a missing upstream, static root or domain, `registers`
    // came out empty, and the caller (a routing save, or the Retry-routing button)
    // reported success having written no vhost. Name the missing input instead — the
    // operator's route is not live and the log is where they look.
    //
    // Logged, not thrown: a paused project legitimately has no live upstream, and
    // throwing would turn that into an "Action Required" warning on a stack nobody
    // asked to be running.
    if (!composite) {
      const plan = planCompositeRoute(defs, { rewrites: project.routingConfig?.rewrites });
      if (plan) {
        const frontendRoute = serviceRoutePlans.find(
          ({ def }) => def.id === plan.frontendServiceId,
        )?.route;
        if (frontendRoute) blockedHostnames.add(frontendRoute.hostname.toLowerCase());
        const missing = [
          !resolveStaticRoot(plan.frontendServiceId) && !resolveTargetUrl(plan.frontendServiceId)
            ? "the frontend has neither a static root nor a live upstream"
            : null,
          !resolveTargetUrl(plan.backendServiceId) ? "the backend has no live upstream" : null,
        ].filter(Boolean);
        warn(
          `[routing-apply] ${project.slug}: composite vhost not emitted — ` +
            `${missing.length ? missing.join("; ") : "no routable domain for the frontend"}. ` +
            `Redeploy to rebuild it.`,
        );
      }
    }

    // Re-emit any migration path-fan-out domains from live upstreams (a domain
    // whose paths route to different services) — persisted so it survives here.
    //
    // They carry the project's compiled vercel.json rules because this is the LAST
    // writer for those hostnames on the live path (callers run
    // `reapplyProjectLiveRoutes` first, this second) and `registerRoute` REPLACES the
    // vhost — so without them a routing save applied its redirects to every domain
    // EXCEPT the fan-out one, and the deploy path (which does carry them) then
    // disagreed with the live path about the same vhost. The composite is left alone:
    // it compiles its own topology-aware superset with the backend it resolved.
    const fanout = buildDomainFanoutRegistrations({
      routes: fanoutRoutes,
      resolveTargetUrl,
      onWarning: warn,
    }).map((reg) => {
      // CONCATENATED, not overwritten — same rule and same order as the deploy path:
      // the fan-out's explicit per-path upstreams first, then the compiled rules, or
      // the spread would ASSIGN over them and drop a vercel.json external rewrite.
      const proxyLocations = [
        ...(reg.proxyLocations ?? []),
        ...(routingFields.proxyLocations ?? []),
      ];
      return { ...reg, ...routingFields, ...(proxyLocations.length ? { proxyLocations } : {}) };
    });

    // A refused topology must not fall back to the service's simpler vhost.
    // Keep the currently served table until every configured path can resolve.
    const completeFanoutHostnames = new Set(fanout.map((route) => route.hostname.toLowerCase()));
    for (const route of fanoutRoutes) {
      if (!completeFanoutHostnames.has(route.hostname.toLowerCase())) {
        blockedHostnames.add(route.hostname.toLowerCase());
      }
    }

    const topologyRegisters = [...(composite ? [composite.register] : []), ...fanout].map(
      (register) => {
        const observedLoopbackPublishes = register.redirectHost
          ? []
          : [
              register.targetUrl,
              ...(register.proxyLocations?.map((location) => location.targetUrl) ?? []),
            ].flatMap((url) => (url ? (observedByUrl.get(url) ?? []) : []));
        return observedLoopbackPublishes.length > 0
          ? { ...register, observedLoopbackPublishes }
          : register;
      },
    );
    // Resolve precedence BEFORE writing. Publishing the base vhost and then its
    // topology exposes an incomplete table between reloads (or permanently if
    // the second write fails). Each hostname gets one complete configuration.
    const registers = [
      ...new Map(
        [...serviceRegisters, ...topologyRegisters].map((register) => [
          register.hostname.toLowerCase(),
          register,
        ]),
      ).values(),
    ].filter((register) => !blockedHostnames.has(register.hostname.toLowerCase()));
    if (registers.length > 0) {
      await reconcileProjectRoutes(project, {
        onWarning: options.onWarning,
        onLog: options.onLog,
        deployment,
        routing,
        runtime,
        hostPortTarget: resolved.hostPortTarget,
        ...(resolved.platform.executor
          ? { edgeProxy: edgeProxyFor(resolved.platform.executor, "openresty", { ours: true }) }
          : {}),
        registers,
      });
    }
  } catch (err) {
    const warning = `[routing-apply] ${project.slug}: live routing re-apply failed (non-fatal, applies next deploy): ${safeErrorMessage(err)}`;
    warn(warning);
  } finally {
    disposePlatform(resolved);
  }
}

/** Apply each hostname's complete edge table to the project's managed server. */
export async function applyCloudRouting(opts: {
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>;
  routing: CloudInfraProvider;
  defs: Awaited<ReturnType<typeof repos.service.listByProject>>;
  liveRows: Awaited<ReturnType<typeof repos.service.listByDeployment>>;
  deployment?: NonNullable<Awaited<ReturnType<typeof findActiveDeployment>>>;
}): Promise<void> {
  const { project, routing, defs, liveRows } = opts;
  const domainRows = await repos.domain.listByProject(project.id);
  const domainByHostname = new Map(domainRows.map((row) => [row.hostname.toLowerCase(), row]));
  const errors = new Map<string, string>();
  const singleHostnames = new Set<string>();
  const compositeHostnames = new Set(project.compositeRoutes?.map(route => route.hostname.toLowerCase()));
  const singleApp = opts.deployment &&
    ((opts.deployment.meta as DeploymentMeta)?.serviceDeploymentMode === "single" || defs.length === 0);
  if (singleApp) {
    const deployment = opts.deployment!;
    const staticRoot = resolveDeploymentStaticRoot(deployment, project);
    const domains = buildProjectRouteDomains({
      project,
      projectDomains: domainRows,
      runtimeName: (deployment.meta as DeploymentMeta)?.runtimeMode ?? "docker",
      certificateManagement: routing.certificateManagement,
      usesManagedRouting: true,
      isStatic: !!staticRoot,
    });
    const routingFields = compileProjectRoutingFields(project.routingConfig);
    for (const route of domains) {
      if (compositeHostnames.has(route.hostname.toLowerCase())) continue;
      singleHostnames.add(route.hostname.toLowerCase());
      try {
        await ensureRouteDomainRecord({ projectId: project.id, route, domainByHostname });
        const redirectHost = resolveRouteRedirect(route, domains.map(item => item.hostname));
        if (staticRoot) {
          await routing.registerRoute({
            ...routingFields, domain: route.hostname, tls: true, redirectHost: redirectHost ?? undefined,
            staticRoot: resolveServedStaticPath(staticRoot, route.targetPath ?? "/"),
          });
        } else {
          if (!deployment.containerId || !route.targetPort)
            throw new Error("This route has no deployed process or target port");
          const target = await routing.resolveRoutingTarget(deployment.containerId, route.targetPort);
          await routing.registerRoute({
            ...routingFields, domain: route.hostname, tls: true, redirectHost: redirectHost ?? undefined,
            targetUrl: `http://127.0.0.1:${target.port}`,
          });
        }
      } catch (error) { errors.set(route.hostname, safeErrorMessage(error)); }
    }
  }
  const rowByService = new Map(liveRows.map((row) => [row.serviceId, row]));
  const plan = planCompositeRoute(defs, { rewrites: project.routingConfig?.rewrites });
  const servicePlans = defs
    .filter((service) => service.enabled)
    .flatMap((service) =>
      buildServiceRouteDomains({
        project,
        service,
        runtimeName: "docker",
        certificateManagement: routing.certificateManagement,
        usesManagedRouting: true,
        domainByHostname,
      }).filter(route => !singleHostnames.has(route.hostname.toLowerCase())).map((route) => ({ service, route })),
    );
  const projectPlans = singleApp ? [] : buildProjectRouteDomains({
    project,
    projectDomains: domainRows,
    runtimeName: "docker",
    certificateManagement: routing.certificateManagement,
    usesManagedRouting: true,
  });
  const fanoutRoutes = resolveDomainFanoutRoutes({
    routes: project.compositeRoutes,
    services: defs,
    domainByHostname,
  });
  const hostnames = [
    ...servicePlans.map((item) => item.route.hostname),
    ...projectPlans.map((route) => route.hostname),
    ...fanoutRoutes.map((route) => route.hostname),
  ];
  const targets = new Map<string, ReturnType<CloudInfraProvider["resolveRoutingTarget"]>>();
  const serviceTarget = async (serviceId: string, port?: number) => {
    const service = defs.find((def) => def.id === serviceId && def.enabled);
    const live = rowByService.get(serviceId);
    const containerPort = port ?? (service && resolveServicePort(service, project.port));
    if (!service || !live?.containerId || !containerPort)
      throw new Error("Service has no live cloud routing target");
    const key = `${serviceId}:${containerPort}`;
    if (!targets.has(key))
      targets.set(key, routing.resolveRoutingTarget(live.containerId, containerPort));
    return targets.get(key)!;
  };
  const rulesFor = async (serviceId: string, root: Awaited<ReturnType<typeof serviceTarget>>) => {
    const backend =
      plan?.frontendServiceId === serviceId
        ? await serviceTarget(plan.backendServiceId)
        : undefined;
    const input = compileRoutingToOblien(project.routingConfig ?? {}, { root, backend });
    if (
      backend &&
      !input.routes.some(
        (rule) =>
          rule.action.kind === "proxy" &&
          rule.action.workspace === backend.workspace &&
          rule.action.port === backend.port,
      )
    ) {
      const catchAll = input.routes.findIndex(
        (rule) => rule.action.kind === "proxy" && rule.match.path === "/",
      );
      input.routes.splice(catchAll < 0 ? 0 : catchAll, 0, {
        match: { path: plan!.backendPathPrefix, type: "prefix" },
        action: { kind: "proxy", ...backend },
      });
    }
    return input;
  };
  const tables = new Map<
    string,
    {
      hostname: string;
      custom: boolean;
      serviceId: string;
      port?: number;
      domain?: (typeof projectPlans)[number];
      locations?: NonNullable<typeof project.compositeRoutes>[number]["locations"];
    }
  >();
  for (const { service, route } of servicePlans) {
    if (route.targetPort)
      tables.set(route.hostname.toLowerCase(), {
        hostname: route.hostname,
        custom: !route.isCloud,
        serviceId: service.id,
        port: route.targetPort,
        domain: route,
      });
  }
  for (const route of projectPlans) {
    if (!route.targetPort || tables.has(route.hostname.toLowerCase())) continue;
    const owner = pickProjectPortOwner({
      port: route.targetPort,
      services: defs,
      rowByService,
      domainRows,
    });
    if (owner)
      tables.set(route.hostname.toLowerCase(), {
        hostname: route.hostname,
        custom: !route.isCloud,
        serviceId: owner.serviceId,
        port: owner.containerPort,
        domain: route,
      });
    else
      errors.set(route.hostname.toLowerCase(), "No service owns the configured cloud route port");
  }
  for (const route of fanoutRoutes) {
    const key = route.hostname.toLowerCase();
    tables.set(key, {
      hostname: route.hostname,
      custom: route.isCustomDomain,
      serviceId: route.rootServiceId,
      port: route.rootPort,
      domain: tables.get(key)?.domain,
      locations: route.locations,
    });
    errors.delete(key);
  }
  for (const [key, table] of tables) {
    try {
      if (table.domain)
        await ensureRouteDomainRecord({ projectId: project.id, route: table.domain, domainByHostname });
      const root = await serviceTarget(table.serviceId, table.port);
      const input = await rulesFor(table.serviceId, root);
      const locations = [...(table.locations ?? [])].sort(
        (a, b) =>
          b.pathPrefix.length - a.pathPrefix.length ||
          Number(b.exact ?? false) - Number(a.exact ?? false),
      );
      const proxies = await Promise.all(
        locations.map(async (location) => ({
          match: {
            path: location.pathPrefix,
            type: location.exact ? ("exact" as const) : ("prefix" as const),
          },
          action: {
            kind: "proxy" as const,
            ...(await serviceTarget(location.serviceId, location.port)),
          },
        })),
      );
      const firstProxy = input.routes.findIndex((rule) => rule.action.kind === "proxy");
      input.routes.splice(firstProxy < 0 ? 0 : firstProxy, 0, ...proxies);
      const redirect = table.domain && resolveRouteRedirect(table.domain, hostnames);
      if (redirect)
        input.routes.unshift({
          match: { path: "/(.*)", type: "wildcard" },
          action: {
            kind: "redirect",
            status: redirect.statusCode,
            to: `https://${redirect.target}/$1`,
          },
        });
      // A missing composite target leaves the existing full table untouched;
      // never publish a root-only intermediate table during a live edit.
      await routing.publishRoute(table.hostname, root.port, table.custom, input);
    } catch (error) {
      errors.set(key, safeErrorMessage(error));
    }
  }
  if (errors.size)
    throw new Error(
      [...errors].map(([hostname, message]) => `${hostname}: ${message}`).join("\n"),
    );
}
