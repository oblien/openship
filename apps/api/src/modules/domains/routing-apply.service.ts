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
import {
  CloudRuntime,
  PAGE_CONTAINER_PREFIX,
  compileRoutingToOblien,
  type OblienRoutingContext,
} from "@repo/adapters";
import { platform } from "../../lib/controller-helpers";
import { resolveDeploymentRuntime, usesManagedRouting } from "../../lib/deployment-runtime";
import { reconcileProjectRoutes } from "../../lib/route-apply.service";
import { resolveServicePort } from "../../lib/deployable-service";
import { buildServiceRouteDomain } from "../../lib/routing-domains";
import { buildCompositeRegistration, planCompositeRoute } from "../deployments/compose/composite-route";
import { buildUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";

export async function applyProjectRouting(projectId: string): Promise<void> {
  const project = await repos.project.findById(projectId);
  if (!project) return;

  // No active deployment → the persisted routingConfig applies on the next deploy.
  if (!project.activeDeploymentId) return;

  try {
    const deployment = await repos.deployment.findById(project.activeDeploymentId);
    if (!deployment) return;

    const { routing, runtime, effectiveTarget } = await resolveDeploymentRuntime(deployment);
    const managed = usesManagedRouting(platform().target, effectiveTarget);
    const defs = await repos.service.listByProject(project.id);
    const liveRows = await repos.service.listByDeployment(project.activeDeploymentId);

    // Cloud: apply the vercel routing at the Oblien edge (no OpenResty).
    if (runtime instanceof CloudRuntime) {
      await applyCloudRouting({ project, runtime, defs, liveRows, usesManaged: managed });
      return;
    }

    // Self-hosted: compile to OpenResty locations and reconcile the domain.
    if (!routing) return;
    const rowByService = new Map(liveRows.map((row) => [row.serviceId, row]));
    const routeStrategy = resolveRouteStrategy(project.routeStrategy);

    const composite = buildCompositeRegistration({
      services: defs,
      routingConfig: project.routingConfig,
      resolveTargetUrl: (serviceId) => {
        const def = defs.find((s) => s.id === serviceId);
        const row = rowByService.get(serviceId);
        const port = def ? resolveServicePort(def, project.port) : null;
        if (!port) return null;
        return buildUpstreamUrl({ strategy: routeStrategy, ip: row?.ip, hostPort: row?.hostPort, containerPort: port });
      },
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

    if (composite) {
      await reconcileProjectRoutes(project, {
        deployment,
        routing,
        registers: [composite.register],
      });
    }
  } catch (err) {
    console.warn(
      `[routing-apply] ${project.slug}: live routing re-apply failed (non-fatal, applies next deploy): ${safeErrorMessage(err)}`,
    );
  }
}

/**
 * Cloud edge routing: resolve the monorepo composite's frontend + backend to
 * their live Oblien workspaces (or a Page for a static frontend) and set ONE
 * hostname's edge table via `routes.set`. Same 1-static + 1-server shape the
 * self-hosted path handles; other shapes no-op (services keep their own
 * subdomains) until the cloud composite deploy topology lands.
 */
async function applyCloudRouting(opts: {
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>;
  runtime: CloudRuntime;
  defs: Awaited<ReturnType<typeof repos.service.listByProject>>;
  liveRows: Awaited<ReturnType<typeof repos.service.listByDeployment>>;
  usesManaged: boolean;
}): Promise<void> {
  const { project, runtime, defs, liveRows, usesManaged } = opts;
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
      backend: { workspace: back.containerId, port: backPort },
    };
  } else if (frontPort) {
    ctx = {
      root: { workspace: front.containerId, port: frontPort },
      backend: { workspace: back.containerId, port: backPort },
    };
  } else {
    return;
  }

  const input = compileRoutingToOblien(project.routingConfig, ctx);
  await runtime.setDomainRoutes(domain.hostname, input);
}
