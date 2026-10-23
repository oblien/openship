import type { RouteConfig, RoutingProvider } from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import { resolveProjectRouteProtection, withRouteProtectionLock } from "./route-protection";
import { AppError, resolveDomainProxySettings, sanitizeDomainProxySettings } from "@repo/core";

/** Project-owned routes apply saved policies on deploy, retry, and live edits. */
export async function registerProjectRoute(
  project: Pick<Project, "id">,
  routing: Pick<RoutingProvider, "registerRoute" | "supportsDomainProxy">,
  route: RouteConfig,
): Promise<void> {
  await withRouteProtectionLock(project.id, async () => {
    // Deployment callers may already hold host-port ownership. Keep the policy
    // lock inside that scope instead of acquiring the outer runtime lock here.
    const current = await repos.project.findById(project.id);
    if (!current || current.deletionInProgress)
      throw new AppError(
        "Project cleanup is pending; its route was not published.",
        409,
        "PROJECT_DELETION_PENDING",
      );
    const domains = await repos.domain.listByProject(current.id);
    const domain = domains.find((row) => row.hostname.toLowerCase() === route.domain.toLowerCase());
    if (sanitizeDomainProxySettings(domain?.proxy) && routing.supportsDomainProxy !== true)
      throw new AppError(
        "Per-domain request body limits are only supported on self-hosted nginx/OpenResty edges.",
        400,
        "DOMAIN_PROXY_SETTINGS_UNSUPPORTED",
      );
    const proxy = resolveDomainProxySettings(current.routingConfig?.proxy, domain?.proxy);
    const { routeOptions, onApplied } = await resolveProjectRouteProtection(
      project.id,
      route.domain,
    );
    await routing.registerRoute({ ...route, proxy, ...routeOptions });
    await onApplied?.();
  });
}

/** Adapt project registration to consumers that only need to publish routes. */
export function createProjectRouteRegistrar(
  project: Pick<Project, "id">,
  routing?: Pick<RoutingProvider, "registerRoute" | "supportsDomainProxy">,
): Pick<RoutingProvider, "registerRoute" | "supportsDomainProxy"> | undefined {
  return routing
    ? {
        supportsDomainProxy: routing.supportsDomainProxy,
        registerRoute: (route) => registerProjectRoute(project, routing, route),
      }
    : undefined;
}
