/**
 * Apply a project's vercel.json-derived routing to its LIVE deployment WITHOUT a
 * rebuild — the counterpart to the deploy-time composite registration, used when
 * the user edits routing from the Routing/Domains tab (`PUT /projects/:id/routing`).
 *
 * Two emitters over one parsed `RoutingConfig`:
 *   - Self-hosted → `buildCompositeRegistration` → OpenResty via the shared
 *     `reconcileProjectRoutes` dispatch.
 *   - Cloud → `compileRoutingToOblien` → the Oblien edge via `routes.set`.
 * `routes.set` ATOMICALLY REPLACES a hostname's edge behavior, so the cloud path
 * always compiles the COMPLETE table (what backs `/` + overrides) — never a
 * partial one. Both paths cover the same shape (the 1-static + 1-server monorepo
 * composite) and are best-effort: the config row is already persisted by the
 * caller, so a live-apply failure logs and defers to the next deploy.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { platform } from "../../lib/controller-helpers";
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
import { buildServiceRouteDomain } from "../../lib/routing-domains";
import {
  buildCompositeRegistration,
  buildDomainFanoutRegistrations,
  planCompositeRoute,
} from "../deployments/compose/composite-route";
import {
  buildUpstreamUrl,
  resolveLiveUpstreamUrl,
  resolveRouteStrategy,
} from "../../lib/upstream-url";

export async function applyProjectRouting(projectId: string): Promise<void> {
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
    const deployment = await repos.deployment.findById(project.activeDeploymentId);
    if (!deployment) return;

    resolved = await resolveDeploymentPlatform((deployment.meta ?? {}) as DeploymentMeta, {
      organizationId: deployment.organizationId,
    });
    const { routing, runtime } = resolved.platform;
    const managed = usesManagedRouting(platform().target, resolved.effectiveTarget);
    const defs = await repos.service.listByProject(project.id);
    const liveRows = await repos.service.listByDeployment(project.activeDeploymentId);

    // Self-hosted: compile to OpenResty locations and reconcile the domain.
    if (!routing) return;
    const rowByService = new Map(liveRows.map((row) => [row.serviceId, row]));
    const routeStrategy = resolveRouteStrategy(project.routeStrategy);

    // One live-upstream resolver, shared by the vercel composite AND the migration
    // path-fan-out. Resolved from the LIVE container (not the service_deployment
    // row) so a workload with no loopback publish — migrated, adopted in place —
    // routes at its container IP instead of a dead 127.0.0.1:<port>. Awaited up
    // front because the composite/fan-out builders take a sync resolver.
    const liveUpstreams = new Map<string, string | null>();
    await Promise.all(
      defs.map(async (def) => {
        const row = rowByService.get(def.id);
        const port = resolveServicePort(def, project.port);
        if (!port || !row?.containerId) return;
        liveUpstreams.set(
          def.id,
          await resolveLiveUpstreamUrl({
            strategy: routeStrategy,
            runtime,
            containerId: row.containerId,
            containerPort: port,
            stored: { ip: row.ip, hostPort: row.hostPort },
          }),
        );
      }),
    );

    const resolveTargetUrl = (serviceId: string) => {
      // A service with no container to inspect (cloud peer, not yet deployed)
      // still resolves from its persisted row.
      const live = liveUpstreams.get(serviceId);
      if (live !== undefined) return live;
      const def = defs.find((s) => s.id === serviceId);
      const row = rowByService.get(serviceId);
      const port = def ? resolveServicePort(def, project.port) : null;
      if (!port) return null;
      return buildUpstreamUrl({ strategy: routeStrategy, ip: row?.ip, hostPort: row?.hostPort, containerPort: port });
    };

    const composite = buildCompositeRegistration({
      services: defs,
      routingConfig: project.routingConfig,
      resolveTargetUrl,
      resolveDomain: (serviceId) => {
        const def = defs.find((s) => s.id === serviceId);
        const domain = def
          ? buildServiceRouteDomain({
              project,
              service: def,
              runtimeName: runtime.name,
              usesManagedRouting: managed,
            })
          : null;
        return domain
          ? { hostname: domain.hostname, isCustomDomain: domain.domainType === "custom" }
          : null;
      },
    });

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
    const routingFields = compileProjectRoutingFields(project.routingConfig);
    const fanout = buildDomainFanoutRegistrations({
      routes: project.compositeRoutes,
      resolveTargetUrl,
    }).map((reg) => {
      // CONCATENATED, not overwritten — same rule and same order as the deploy path:
      // the fan-out's explicit per-path upstreams first, then the compiled rules, or
      // the spread would ASSIGN over them and drop a vercel.json external rewrite.
      const proxyLocations = [...(reg.proxyLocations ?? []), ...(routingFields.proxyLocations ?? [])];
      return { ...reg, ...routingFields, ...(proxyLocations.length ? { proxyLocations } : {}) };
    });

    const registers = [...(composite ? [composite.register] : []), ...fanout];
    if (registers.length > 0) {
      await reconcileProjectRoutes(project, { deployment, routing, registers });
    }
  } catch (err) {
    console.warn(
      `[routing-apply] ${project.slug}: live routing re-apply failed (non-fatal, applies next deploy): ${safeErrorMessage(err)}`,
    );
  } finally {
    disposePlatform(resolved);
  }
}
