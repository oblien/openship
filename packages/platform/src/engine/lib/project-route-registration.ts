import type { RouteConfig, RoutingProvider } from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import { resolveProjectRouteProtection, withRouteProtectionLock } from "./route-protection";
import { AppError } from "@repo/core";

/** Project-owned routes apply saved policies on deploy, retry, and live edits. */
export async function registerProjectRoute(
  project: Pick<Project, "id">,
  routing: Pick<RoutingProvider, "registerRoute">,
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
    const { routeOptions, onApplied } = await resolveProjectRouteProtection(
      project.id,
      route.domain,
    );
    await routing.registerRoute({ ...route, ...routeOptions });
    await onApplied?.();
  });
}

/** Adapt project registration to consumers that only need to publish routes. */
export function createProjectRouteRegistrar(
  project: Pick<Project, "id">,
  routing?: Pick<RoutingProvider, "registerRoute">,
): Pick<RoutingProvider, "registerRoute"> | undefined {
  return routing
    ? { registerRoute: (route) => registerProjectRoute(project, routing, route) }
    : undefined;
}
