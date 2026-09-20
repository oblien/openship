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
  CloudRuntime,
  CloudDockerRuntime,
  edgeProxyFor,
  PAGE_CONTAINER_PREFIX,
  compileRoutingToOblien,
  type OblienRoutingContext,
} from "@repo/adapters";
import { platform } from "../../lib/platform-config";
import {
  disposePlatform,
  resolveDeploymentPlatform,
  usesManagedRouting,
  type DeploymentMeta,
  type ResolvedDeploymentPlatform,
} from "../../lib/deployment-runtime";
import { reconcileProjectRoutes } from "../../lib/route-apply.service";
import { compileProjectRoutingFields } from "../../lib/project-routing-fields";
import { resolveServicePort } from "../../lib/deployable-service";
import { isArtifactRef } from "../../lib/container-ref";
import { buildProjectRouteDomains, buildServiceRouteDomain, buildServiceRouteDomains } from "../../lib/routing-domains";
import { pickProjectPortOwner } from "../../lib/project-service-upstream";
import { resolveRouteRedirect } from "../../lib/domain-redirect";
import {
  buildCompositeRegistration,
  buildDomainFanoutRegistrations,
  planCompositeRoute,
} from "../deployments/compose/composite-route";
import { resolveLiveUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";
import {
  observedLoopbackPublishFromUrl,
  type ObservedLoopbackPublish,
} from "../deployments/observed-host-port-claims";

export async function applyProjectRouting(
  projectId: string,
  options: { onWarning?: (message: string) => void } = {},
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
    const liveRows = await repos.service.listByDeployment(deployment.id);

    // Cloud: apply the vercel routing at the Oblien edge (no OpenResty).
    if (runtime instanceof CloudRuntime || runtime instanceof CloudDockerRuntime) {
      await applyCloudRouting({ project, runtime, defs, liveRows, usesManaged: managed });
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
    const serviceRoutePlans = defs
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
    const resolveTargetUrl = (serviceId: string) => {
      const def = defs.find((candidate) => candidate.id === serviceId);
      const port = def ? resolveServicePort(def, project.port) : null;
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
      if (!redirectHost && !staticRoot && !targetUrl) return [];
      const observed = targetUrl
        ? observedLoopbackPublishFromUrl({
            targetUrl,
            serviceId: def.id,
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
      routes: project.compositeRoutes,
      resolveTargetUrl,
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
    // Last-writer order is part of the routing contract. A composite/fan-out
    // registration is richer than a service's base vhost, so it must overwrite
    // the service register when they intentionally share a hostname.
    const registers = [...serviceRegisters, ...topologyRegisters];
    if (registers.length > 0) {
      await reconcileProjectRoutes(project, {
        onWarning: options.onWarning,
        deployment,
        routing,
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

/**
 * Cloud edge routing uses live workspace targets. Docker services publish
 * distinct host ports on one VM; native services retain separate workspaces.
 * Assemble each hostname's complete table before replacing its edge routes.
 */
export async function applyCloudRouting(opts: {
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>;
  runtime: CloudRuntime | CloudDockerRuntime;
  defs: Awaited<ReturnType<typeof repos.service.listByProject>>;
  liveRows: Awaited<ReturnType<typeof repos.service.listByDeployment>>;
  usesManaged: boolean;
}): Promise<void> {
  const { project, runtime, defs, liveRows, usesManaged } = opts;
  if (runtime instanceof CloudDockerRuntime) {
    const domainRows = await repos.domain.listByProject(project.id);
    const domainByHostname = new Map(domainRows.map(row => [row.hostname.toLowerCase(), row]));
    const rowByService = new Map(liveRows.map(row => [row.serviceId, row]));
    const plan = planCompositeRoute(defs, { rewrites: project.routingConfig?.rewrites });
    const servicePlans = defs.filter(service => service.enabled).flatMap(service =>
      buildServiceRouteDomains({ project, service, runtimeName: "cloud", usesManagedRouting: true, domainByHostname })
        .map(route => ({ service, route })));
    const projectPlans = buildProjectRouteDomains({ project, projectDomains: domainRows, runtimeName: "cloud", usesManagedRouting: true });
    const hostnames = [...servicePlans.map(item => item.route.hostname), ...projectPlans.map(route => route.hostname),
      ...(project.compositeRoutes ?? []).map(route => route.hostname)];
    const errors = new Map<string, string>();
    const targets = new Map<string, ReturnType<CloudDockerRuntime["resolveRoutingTarget"]>>();
    const serviceTarget = async (serviceId: string, port?: number) => {
      const service = defs.find(def => def.id === serviceId && def.enabled);
      const live = rowByService.get(serviceId);
      const containerPort = port ?? (service && resolveServicePort(service, project.port));
      if (!service || !live?.containerId || !containerPort) throw new Error("Service has no live cloud routing target");
      const key = `${serviceId}:${containerPort}`;
      if (!targets.has(key)) targets.set(key, runtime.resolveRoutingTarget(live.containerId, containerPort));
      return targets.get(key)!;
    };
    const rulesFor = async (serviceId: string, root: Awaited<ReturnType<typeof serviceTarget>>) => {
      const backend = plan?.frontendServiceId === serviceId ? await serviceTarget(plan.backendServiceId) : undefined;
      const input = compileRoutingToOblien(project.routingConfig ?? {}, { root, backend });
      if (backend && !input.routes.some(rule => rule.action.kind === "proxy" && rule.action.workspace === backend.workspace && rule.action.port === backend.port)) {
        const catchAll = input.routes.findIndex(rule => rule.action.kind === "proxy" && rule.match.path === "/");
        input.routes.splice(catchAll < 0 ? 0 : catchAll, 0, { match: { path: plan!.backendPathPrefix, type: "prefix" },
          action: { kind: "proxy", ...backend } });
      }
      return input;
    };
    const tables = new Map<string, {
      hostname: string; custom: boolean; serviceId: string; port?: number;
      domain?: (typeof projectPlans)[number];
      locations?: NonNullable<typeof project.compositeRoutes>[number]["locations"];
    }>();
    for (const { service, route } of servicePlans) {
      if (route.targetPort) tables.set(route.hostname.toLowerCase(), { hostname: route.hostname, custom: !route.isCloud,
        serviceId: service.id, port: route.targetPort, domain: route });
    }
    for (const route of projectPlans) {
      if (!route.targetPort || tables.has(route.hostname.toLowerCase())) continue;
      const owner = pickProjectPortOwner({ port: route.targetPort, services: defs, rowByService, domainRows });
      if (owner) tables.set(route.hostname.toLowerCase(), { hostname: route.hostname, custom: !route.isCloud,
        serviceId: owner.serviceId, port: owner.containerPort, domain: route });
      else errors.set(route.hostname.toLowerCase(), "No service owns the configured cloud route port");
    }
    for (const route of project.compositeRoutes ?? []) {
      const key = route.hostname.toLowerCase();
      tables.set(key, { hostname: route.hostname, custom: route.isCustomDomain, serviceId: route.rootServiceId,
        domain: tables.get(key)?.domain, locations: route.locations });
      errors.delete(key);
    }
    for (const [key, table] of tables) {
      try {
        const root = await serviceTarget(table.serviceId, table.port);
        const input = await rulesFor(table.serviceId, root);
        const locations = [...(table.locations ?? [])].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length || Number(b.exact ?? false) - Number(a.exact ?? false));
        const proxies = await Promise.all(locations.map(async location => ({
          match: { path: location.pathPrefix, type: location.exact ? "exact" as const : "prefix" as const },
          action: { kind: "proxy" as const, ...await serviceTarget(location.serviceId) },
        })));
        const firstProxy = input.routes.findIndex(rule => rule.action.kind === "proxy");
        input.routes.splice(firstProxy < 0 ? 0 : firstProxy, 0, ...proxies);
        const redirect = table.domain && resolveRouteRedirect(table.domain, hostnames);
        if (redirect) input.routes.unshift({ match: { path: "/(.*)", type: "wildcard" },
          action: { kind: "redirect", status: redirect.statusCode, to: `https://${redirect.target}/$1` } });
        // A missing composite target leaves the existing full table untouched;
        // never publish a root-only intermediate table during a live edit.
        await runtime.publishRoute(table.hostname, root.port, table.custom, input);
      } catch (error) { errors.set(key, safeErrorMessage(error)); }
    }
    if (errors.size) throw new Error([...errors].map(([hostname, message]) => `${hostname}: ${message}`).join("\n"));
    return;
  }
  if (!project.routingConfig) return;

  const plan = planCompositeRoute(defs, { rewrites: project.routingConfig.rewrites });
  if (!plan) return;

  const rowByService = new Map(liveRows.map((row) => [row.serviceId, row]));
  const front = rowByService.get(plan.frontendServiceId);
  const back = rowByService.get(plan.backendServiceId);
  const frontDef = defs.find((s) => s.id === plan.frontendServiceId);
  const backDef = defs.find((s) => s.id === plan.backendServiceId);
  const frontPort = frontDef ? resolveServicePort(frontDef, project.port) : null;
  const backPort = backDef ? resolveServicePort(backDef, project.port) : null;

  const domain = frontDef
    ? buildServiceRouteDomain({
        project,
        service: frontDef,
        runtimeName: runtime.name,
        usesManagedRouting: usesManaged,
      })
    : null;

  if (!front?.containerId || !back?.containerId || !backPort || !domain?.hostname) return;

  // The frontend backs `/`: a Page (containerId "page:<slug>") via the CDN + SPA
  // fallback, or a workspace container via a catch-all proxy.
  let ctx: OblienRoutingContext;
  if (front.containerId.startsWith(PAGE_CONTAINER_PREFIX)) {
    ctx = {
      staticPage: front.containerId.slice(PAGE_CONTAINER_PREFIX.length),
      backend: await runtime.resolveRoutingTarget(back.containerId, backPort),
    };
  } else if (frontPort) {
    ctx = {
      root: await runtime.resolveRoutingTarget(front.containerId, frontPort),
      backend: await runtime.resolveRoutingTarget(back.containerId, backPort),
    };
  } else {
    return;
  }

  const input = compileRoutingToOblien(project.routingConfig, ctx);
  await runtime.setDomainRoutes(domain.hostname, input);
}
