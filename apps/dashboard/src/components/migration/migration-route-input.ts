import type { MigrationRouteSpec } from "@repo/contracts";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";
import type { DiscoveredService } from "@/lib/api/server-migration";

export type RouteMode = "keep" | "free" | "custom" | "none";

export const hasKeepableRoute = (service: Pick<DiscoveredService, "existingRoute">) =>
  !!service.existingRoute?.some((route) => route.domains.length > 0);

export function firstContainerPort(service: DiscoveredService): string {
  const port = service.ports[0];
  return port?.split("/")[0]?.split(":").pop() ?? "";
}

/** Switching presentations must not discard additional domains or detected paths. */
export function editableServiceRoutes(
  service: DiscoveredService,
  routes: PublicEndpoint[] | undefined,
  mode: "free" | "custom",
): PublicEndpoint[] {
  const kept = keptServiceRoutes(service, firstContainerPort(service));
  const current = routes?.length
    ? routes
    : kept.length
      ? kept
      : [createPublicEndpoint({ port: firstContainerPort(service) })];
  return current.map((route) => ({ ...route, domainType: mode }));
}

/** A deliberate public-route choice cannot silently become an internal service. */
export function hasIncompleteServiceRoutes(
  mode: RouteMode,
  routes: PublicEndpoint[] | undefined,
): boolean {
  if (mode !== "free" && mode !== "custom") return false;
  return (
    !routes?.length ||
    routes.some((route) => {
      const domain = (route.domainType === "custom" ? route.customDomain : route.domain).trim();
      const port = route.port.trim();
      return (
        !domain || (!!port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
      );
    })
  );
}

/** Keep every detected hostname/path and the matched container listen port. */
export function keptServiceRoutes(
  service: DiscoveredService,
  fallbackPort: string,
): PublicEndpoint[] {
  return (service.existingRoute ?? []).flatMap((route) =>
    route.domains.map((domain) =>
      createPublicEndpoint({
        port: String(route.containerPort ?? fallbackPort),
        domainType: "custom",
        customDomain: domain,
        ...(route.path && (route.path !== "/" || route.exact) ? { targetPath: route.path } : {}),
        ...(route.exact ? { exact: true } : {}),
      }),
    ),
  );
}

/** Preserve all reviewed routes across the dashboard → engine boundary. */
export function toServerRoutes(
  routes: Record<string, PublicEndpoint[]> | undefined,
): Record<string, MigrationRouteSpec[]> | undefined {
  if (!routes) return undefined;
  const out: Record<string, MigrationRouteSpec[]> = {};
  for (const [key, endpoints] of Object.entries(routes)) {
    const selected = endpoints.flatMap((endpoint): MigrationRouteSpec[] => {
      const domain = (endpoint.domainType === "custom" ? endpoint.customDomain : endpoint.domain)
        ?.trim()
        .toLowerCase();
      if (!domain) return [];
      const targetPath = endpoint.targetPath?.trim();
      return [
        {
          domainType: endpoint.domainType === "custom" ? "custom" : "free",
          ...(endpoint.domainType === "custom" ? { customDomain: domain } : { domain }),
          ...(endpoint.port ? { exposedPort: String(endpoint.port) } : {}),
          ...(targetPath && (targetPath !== "/" || endpoint.exact) ? { targetPath } : {}),
          ...(endpoint.exact ? { exact: true } : {}),
        },
      ];
    });
    if (selected.length) out[key] = selected;
  }
  return Object.keys(out).length ? out : undefined;
}
