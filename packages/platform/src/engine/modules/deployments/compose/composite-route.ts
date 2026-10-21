/**
 * Vercel-style single-domain composition for a monorepo.
 *
 * When a monorepo resolves to exactly ONE static frontend + ONE server backend,
 * we serve them on a SINGLE domain: the frontend at `/` and the backend
 * reverse-proxied at a path prefix (default `/api/`, or derived from the repo's
 * `vercel.json` `rewrites`). This mirrors how Vercel routes a static build +
 * serverless `api/` under one deployment.
 *
 * The functions here are PURE (no I/O) so the routing decision is unit-testable;
 * the deploy service resolves container IPs and registers the composite route.
 */

import { compileVercelRouting, type RouteProxyLocation } from "@repo/adapters";
import { isStaticService, serviceKind } from "../../../lib/deployable-service";
import type { RouteRegister } from "../../../lib/route-apply.service";
import type { DeploymentRewrite, RoutingConfig, ProjectCompositeRoute } from "@repo/core";
import type { Domain, Service } from "@repo/db";
import { publicEndpointHostname, resolveServicePublicEndpoints } from "../../../lib/public-endpoints";

interface CompositeCandidate {
  id: string;
  name: string;
  kind?: string | null;
  framework?: string | null;
  startCommand?: string | null;
  enabled?: boolean;
}

export interface CompositePlan {
  /** The static sub-app served at `/`. */
  frontendServiceId: string;
  /** The server sub-app reverse-proxied at `backendPathPrefix`. */
  backendServiceId: string;
  /** nginx location prefix for the backend, e.g. "/api/". */
  backendPathPrefix: string;
}

/**
 * Derive the backend path prefix from `vercel.json` rewrites: the first rewrite
 * whose destination is NOT the SPA index fallback contributes its literal source
 * prefix (`/api/(.*)` → `/api/`). Returns null when no usable rewrite exists, so
 * the caller can fall back to the `/api` convention.
 */
export function deriveBackendPrefix(rewrites?: DeploymentRewrite[]): string | null {
  if (!rewrites) return null;
  for (const rewrite of rewrites) {
    if (/index\.html?$/i.test(rewrite.destination.trim())) continue; // SPA fallback
    const match = rewrite.source.match(/^\/[^([:*?\s]*/); // literal leading path
    if (!match) continue;
    let prefix = match[0];
    if (prefix === "/") continue; // the catch-all, not a backend prefix
    if (!prefix.endsWith("/")) prefix += "/";
    return prefix;
  }
  return null;
}

/**
 * Decide whether a monorepo's services compose onto one domain. Only the
 * unambiguous shape — exactly one static frontend sub-app + exactly one server
 * backend sub-app — qualifies; anything else (0/many of either) returns null and
 * the caller keeps the current per-subdomain behavior. Generic: keys off each
 * sub-app's role (static vs server), never repo identity.
 */
export function planCompositeRoute(
  services: CompositeCandidate[],
  opts?: { rewrites?: DeploymentRewrite[] },
): CompositePlan | null {
  const enabled = services.filter((service) => service.enabled !== false);
  const statics = enabled.filter((service) => isStaticService(service));
  const servers = enabled.filter(
    (service) => serviceKind(service) === "monorepo" && !isStaticService(service),
  );
  if (statics.length !== 1 || servers.length !== 1) return null;

  return {
    frontendServiceId: statics[0].id,
    backendServiceId: servers[0].id,
    backendPathPrefix: deriveBackendPrefix(opts?.rewrites) ?? "/api/",
  };
}

/**
 * Build the composite route's extra proxy location (backend at the prefix).
 * The frontend is the route's primary `targetUrl` (set by the caller); this is
 * the `/api/` → backend entry that rides alongside it.
 */
export function buildCompositeProxyLocations(
  plan: CompositePlan,
  backendTargetUrl: string,
): RouteProxyLocation[] {
  return [{ pathPrefix: plan.backendPathPrefix, targetUrl: backendTargetUrl }];
}

export interface CompositeRegistration {
  /** vercel.json rules the compiler could not reproduce, for the caller to LOG. Nothing
   *  read `compiled.skipped` before, so a dropped rule vanished without a word. */
  skipped: string[];
  register: RouteRegister;
  frontendServiceId: string;
  backendServiceId: string;
}

/**
 * The reusable routing core: given a monorepo's services + its routing config +
 * resolvers for each service's upstream URL and public domain, produce the
 * single-domain `RouteRegister` (frontend at `/`, backend proxied per the
 * vercel.json rewrites, plus redirects/headers). Pure — callers supply the
 * live upstreams (the deploy loop from its `results[].ip`, the routing API from
 * `service_deployment.ip`). Returns null when the repo isn't a 1-static +
 * 1-server composite or an upstream/domain can't be resolved.
 */
export function buildCompositeRegistration(input: {
  services: CompositeCandidate[];
  routingConfig?: RoutingConfig | null;
  resolveTargetUrl: (serviceId: string) => string | null | undefined;
  resolveDomain: (serviceId: string) => { hostname: string; isCustomDomain: boolean } | null;
  /**
   * The frontend's built files on the host, when it was extracted rather than
   * containerized (self-hosted static). Present → the domain serves `/` from disk
   * and the frontend needs no container, no port and no upstream at all; the
   * backend still gets its `/api/` proxy location in the SAME vhost.
   *
   * Absent (or null) → the previous behaviour: the frontend is an upstream. That is
   * still the only option on cloud, where Oblien runs the workload and there is no
   * host directory to serve.
   */
  resolveStaticRoot?: (serviceId: string) => string | null | undefined;
}): CompositeRegistration | null {
  const routing = input.routingConfig ?? undefined;
  const plan = planCompositeRoute(input.services, { rewrites: routing?.rewrites });
  if (!plan) return null;

  const frontendStaticRoot = input.resolveStaticRoot?.(plan.frontendServiceId) || null;
  // Only resolve an upstream for the frontend when it isn't served from disk —
  // asking for one would otherwise fail the whole composite for a static frontend
  // that has (correctly) no port.
  const frontendUrl = frontendStaticRoot ? null : input.resolveTargetUrl(plan.frontendServiceId);
  const backendUrl = input.resolveTargetUrl(plan.backendServiceId);
  const domain = input.resolveDomain(plan.frontendServiceId);
  if ((!frontendStaticRoot && !frontendUrl) || !backendUrl || !domain) return null;

  // Compile the full vercel.json routing when present (rewrites → backend proxy
  // locations, redirects, headers); otherwise fall back to the `/api` convention.
  const compiled = routing ? compileVercelRouting(routing, { backendTargetUrl: backendUrl }) : null;
  const proxyLocations =
    compiled && compiled.proxyLocations.length > 0
      ? compiled.proxyLocations
      : buildCompositeProxyLocations(plan, backendUrl);

  return {
    frontendServiceId: plan.frontendServiceId,
    backendServiceId: plan.backendServiceId,
    skipped: compiled?.skipped ?? [],
    register: {
      hostname: domain.hostname,
      isCustomDomain: domain.isCustomDomain,
      // Files at `/`, or an upstream at `/` — never both.
      ...(frontendStaticRoot ? { staticRoot: frontendStaticRoot } : { targetUrl: frontendUrl! }),
      proxyLocations,
      ...(compiled?.redirects.length ? { redirects: compiled.redirects } : {}),
      ...(compiled?.headerRules.length ? { headerRules: compiled.headerRules } : {}),
      ...(compiled?.cleanUrls ? { cleanUrls: true } : {}),
      ...(compiled?.trailingSlash === undefined ? {} : { trailingSlash: compiled.trailingSlash }),
    },
  };
}

/**
 * Migration path-fan-out equivalent of {@link buildCompositeRegistration}: given
 * the project's persisted `compositeRoutes` + a live-upstream resolver, produce
 * one `RouteRegister` per domain (optional root service at `/`, each path prefix
 * proxied to its service). PURE — callers supply the resolver (deploy loop from
 * `results[].ip`, routing API from `service_deployment.ip`). A route with any
 * unresolved upstream is skipped: replacing it with a partial table would send
 * that path to the root service or a 404. Unlike `buildCompositeRegistration` this
 * expresses ARBITRARY multi-service fan-out, not the 1-static + 1-server shape.
 */
type DomainOwners = ReadonlyMap<string, Pick<Domain, "serviceId"> & Partial<Pick<Domain, "boundByDomain" | "targetPort">>>;

/** Resolve stored topology against current endpoint ports and domain ownership. */
export function resolveDomainFanoutRoutes(input: {
  routes: ProjectCompositeRoute[] | null | undefined;
  services: Service[];
  domainByHostname?: DomainOwners;
}): ProjectCompositeRoute[] {
  return (input.routes ?? []).flatMap((stored) => {
    const owner = input.domainByHostname?.get(stored.hostname.toLowerCase());
    // The domain row owns `/`; keep its configured path table when it moves,
    // but never let stale topology reactivate an explicitly unbound hostname.
    if (owner?.boundByDomain && (!owner.serviceId || !owner.targetPort)) return [];
    const route = owner?.boundByDomain
      ? { ...stored, rootServiceId: owner.serviceId!, rootPort: owner.targetPort! }
      : stored;
    if (!route.rootServiceId) {
      // Path-only domains belong to the project, with no implicit service at `/`.
      // Keep the complete table: a missing path target must block replacement.
      if (input.domainByHostname) {
        const owner = input.domainByHostname.get(route.hostname.toLowerCase());
        if (!owner || owner.serviceId) return [];
      }
      return route.locations.length ? [route] : [];
    }
    const service = input.services.find((row) => row.id === route.rootServiceId);
    if (!service?.enabled) return [];
    // A project-level route can target an internal service. Only service-owned
    // domains follow that service's exposure switch.
    if (!service.exposed && input.domainByHostname?.get(route.hostname)?.serviceId === service.id) return [];
    const endpoint = resolveServicePublicEndpoints(service).find(
      (endpoint) => publicEndpointHostname(endpoint) === route.hostname,
    );
    return [{ ...route, rootPort: owner?.boundByDomain ? route.rootPort : endpoint?.port ?? route.rootPort }];
  });
}

export function buildDomainFanoutRegistrations(input: {
  routes: ProjectCompositeRoute[] | null | undefined;
  resolveTargetUrl: (serviceId: string, port?: number) => string | null | undefined;
  services?: Service[];
  domainByHostname?: DomainOwners;
  onWarning?: (message: string) => void;
}): RouteRegister[] {
  const out: RouteRegister[] = [];
  const routes = input.services ? resolveDomainFanoutRoutes({ ...input, services: input.services }) : input.routes ?? [];
  for (const route of routes) {
    const rootUrl = route.rootServiceId
      ? input.resolveTargetUrl(route.rootServiceId, route.rootPort)
      : null;
    if (route.rootServiceId && !rootUrl) {
      input.onWarning?.(`${route.hostname}: the root service has no live upstream; its route was not replaced.`);
      continue;
    }
    const proxyLocations: RouteProxyLocation[] = [];
    let complete = true;
    for (const loc of route.locations) {
      const url = input.resolveTargetUrl(loc.serviceId, loc.port);
      if (url) {
        proxyLocations.push({
          pathPrefix: loc.pathPrefix,
          targetUrl: url,
          ...(loc.exact ? { exact: true } : {}),
        });
      } else {
        complete = false;
        input.onWarning?.(
          `${route.hostname}${loc.pathPrefix}: the service has no live upstream; its domain route was not replaced.`,
        );
      }
    }
    if (!complete) continue;
    if (!rootUrl && proxyLocations.length === 0) continue;
    out.push({
      hostname: route.hostname,
      isCustomDomain: route.isCustomDomain,
      ...(rootUrl ? { targetUrl: rootUrl } : { notFound: true as const }),
      ...(proxyLocations.length ? { proxyLocations } : {}),
    });
  }
  return out;
}
