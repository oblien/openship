import type { Domain, Project, Service } from "@repo/db";
import { SYSTEM, resolveServiceHostnameLabel } from "@repo/core";
import { getRoutingBaseDomain } from "./routing-domains";
import { resolveServicePort, serviceKind } from "./deployable-service";
import { env } from "../config/env";

// OpenResty management port (packages/adapters openresty-lua.ts OPENRESTY_MGMT_PORT).
// Hardcoded here so this leaf module doesn't pull the adapters barrel or the
// env module (whose boot guards throw at import time under test).
const OPENRESTY_MGMT_PORT = 9145;

/**
 * Ports a tenant route must NEVER proxy at over the host loopback: the
 * control-plane API, the dashboard, and the UNAUTHENTICATED OpenResty
 * management port (9145). On a bare/self-hosted edge these live on the host's
 * 127.0.0.1, so a public route pointed at 127.0.0.1:<one of these> would expose
 * an internal service (admin API / edge rules-mgmt) to the internet. Only ever
 * applied to a LOOPBACK upstream — a container's own IP:9145 is the app's port,
 * not ours. See resolveTargetUrl in project-route.service.ts. Ports read from
 * process.env directly (raw, no validated `env` import) to keep this leaf light.
 */
export function isReservedLoopbackPort(port: number): boolean {
  const apiPort = env.PORT;
  const dashboardPort = env.OPENSHIP_DASHBOARD_PORT;
  return port === apiPort || port === dashboardPort || port === OPENRESTY_MGMT_PORT;
}

/** True for a loopback host (the only place isReservedLoopbackPort applies). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

export interface StoredPublicEndpoint {
  port?: number;
  targetPath?: string;
  domain?: string;
  customDomain?: string;
  domainType: "free" | "custom";
}

type StoredPublicEndpointInput = {
  port?: number | string | null;
  targetPath?: string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: "free" | "custom" | null;
};

export type ProjectDomainRow = Pick<
  Domain,
  "hostname" | "isPrimary" | "verified" | "serviceId" | "targetPort" | "targetPath" | "domainType"
>;

function normalizePort(port: number | string | null | undefined): number | null {
  const numericPort = typeof port === "string" ? Number(port) : port;
  if (!Number.isFinite(numericPort)) return null;
  if (numericPort! < 1 || numericPort! > 65535) return null;
  return numericPort!;
}

function normalizeSlug(slug: string | null | undefined): string | undefined {
  const normalized = slug?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeCustomDomain(domain: string | null | undefined): string | undefined {
  const normalized = domain?.trim().toLowerCase();
  return normalized || undefined;
}

export function normalizeTargetPath(targetPath: string | null | undefined): string | undefined {
  const normalized = targetPath?.trim().replace(/\\/g, "/");
  if (!normalized) return undefined;

  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.some((segment) => segment === "..")) {
    return undefined;
  }

  const cleanSegments = segments.filter((segment) => segment !== ".");
  return cleanSegments.length > 0 ? `/${cleanSegments.join("/")}` : "/";
}

function managedHostnameSuffix(): string {
  return `.${getRoutingBaseDomain().trim().toLowerCase()}`;
}

export function managedHostnameToSlug(hostname: string): string | undefined {
  const normalized = normalizeCustomDomain(hostname);
  const suffix = managedHostnameSuffix();
  if (!normalized?.endsWith(suffix)) return undefined;

  const slug = normalized.slice(0, -suffix.length);
  return slug || undefined;
}

export function inferPublicRouteDomainType(
  hostname: string,
  explicit?: string | null,
): "free" | "custom" {
  if (explicit === "free" || explicit === "custom") {
    return explicit;
  }

  return managedHostnameToSlug(hostname) ? "free" : "custom";
}

export function publicEndpointHostname(
  endpoint: Pick<StoredPublicEndpoint, "domainType" | "domain" | "customDomain">,
): string | undefined {
  if (endpoint.domainType === "custom") {
    return normalizeCustomDomain(endpoint.customDomain);
  }

  const slug = normalizeSlug(endpoint.domain);
  return slug ? `${slug}${managedHostnameSuffix()}` : undefined;
}

/**
 * Map ONE project-level domain row to a public endpoint: normalize hostname/port/
 * path, enforce the port-XOR-path rule, and resolve free→slug / custom→hostname.
 * Shared by routeRowsToPublicEndpoints (stored config) and the live-route mapper
 * in project-route.service, so the domain-row → endpoint rule lives in one place.
 * Caller is responsible for excluding service-scoped rows.
 */
export function routeDomainRowToPublicEndpoint(
  domain: ProjectDomainRow,
): StoredPublicEndpoint | null {
  const hostname = normalizeCustomDomain(domain.hostname);
  if (!hostname) return null;

  const port = normalizePort(domain.targetPort) ?? undefined;
  const targetPath = normalizeTargetPath(domain.targetPath);
  const domainType = inferPublicRouteDomainType(hostname, domain.domainType);

  // Exactly one of port / targetPath must be set (proxy vs static).
  if ((port !== undefined) === Boolean(targetPath)) {
    return null;
  }

  if (domainType === "free") {
    const slug = managedHostnameToSlug(hostname);
    if (!slug) return null;

    return {
      ...(port !== undefined ? { port } : {}),
      ...(targetPath ? { targetPath } : {}),
      domain: slug,
      domainType,
    } satisfies StoredPublicEndpoint;
  }

  return {
    ...(port !== undefined ? { port } : {}),
    ...(targetPath ? { targetPath } : {}),
    customDomain: hostname,
    domainType,
  } satisfies StoredPublicEndpoint;
}

function routeRowsToPublicEndpoints(
  projectDomains: ProjectDomainRow[] | null | undefined,
): StoredPublicEndpoint[] {
  return (projectDomains ?? [])
    .filter((domain) => !domain.serviceId)
    .sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }

      return left.hostname.localeCompare(right.hostname);
    })
    .map(routeDomainRowToPublicEndpoint)
    .filter((endpoint): endpoint is StoredPublicEndpoint => endpoint !== null);
}

function primaryProjectDomain(projectDomains?: ProjectDomainRow[] | null): string | undefined {
  const projectLevelDomains = (projectDomains ?? []).filter(
    (domain) => !domain.serviceId && inferPublicRouteDomainType(domain.hostname, domain.domainType) === "custom",
  );
  const primaryDomain = projectLevelDomains.find((domain) => domain.isPrimary)
    ?? projectLevelDomains.find((domain) => domain.verified)
    ?? projectLevelDomains[0];

  return normalizeCustomDomain(primaryDomain?.hostname);
}

interface NormalizeStoredPublicEndpointsOptions {
  primaryFreeDomainFallback?: string;
}

function normalizeStoredPublicEndpoint(
  endpoint: StoredPublicEndpointInput,
  opts?: { freeDomainFallback?: string },
): StoredPublicEndpoint | null {
  const port = normalizePort(endpoint.port);
  const targetPath = normalizeTargetPath(endpoint.targetPath);
  const domainType = endpoint.domainType === "custom" ? "custom" : "free";
  const domain = domainType === "free"
    ? normalizeSlug(endpoint.domain ?? opts?.freeDomainFallback)
    : undefined;
  const customDomain = domainType === "custom"
    ? normalizeCustomDomain(endpoint.customDomain)
    : undefined;
  const hasPortTarget = port !== null;
  const hasPathTarget = Boolean(targetPath);

  if (domainType === "free" && !domain) return null;
  if (domainType === "custom" && !customDomain) return null;
  if (hasPortTarget === hasPathTarget) return null;

  return {
    ...(port !== null ? { port } : {}),
    ...(targetPath ? { targetPath } : {}),
    domain,
    customDomain,
    domainType,
  } satisfies StoredPublicEndpoint;
}

export function normalizeStoredPublicEndpoints(
  endpoints?: StoredPublicEndpointInput[] | null,
  opts?: NormalizeStoredPublicEndpointsOptions,
): StoredPublicEndpoint[] {
  if (!endpoints?.length) return [];

  return endpoints
    .map((endpoint, index) => normalizeStoredPublicEndpoint(
      endpoint,
      index === 0 && opts?.primaryFreeDomainFallback
        ? { freeDomainFallback: opts.primaryFreeDomainFallback }
        : undefined,
    ))
    .filter(
    (endpoint): endpoint is StoredPublicEndpoint => endpoint !== null,
  );
}

function alignPrimaryStoredPublicEndpoint(
  endpoint: StoredPublicEndpoint,
  baseSlug: string,
  preserveFreeDomain: boolean,
): StoredPublicEndpoint {
  if (endpoint.domainType === "custom") {
    return {
      ...endpoint,
      domain: undefined,
      customDomain: endpoint.customDomain,
    } satisfies StoredPublicEndpoint;
  }

  return {
    ...endpoint,
    domain: preserveFreeDomain ? (endpoint.domain ?? baseSlug) : baseSlug,
    customDomain: undefined,
  } satisfies StoredPublicEndpoint;
}

export function resolveStoredPublicEndpoints(opts: {
  stored?: StoredPublicEndpointInput[] | null;
  slug?: string | null;
  customDomain?: string | null;
  projectDomains?: ProjectDomainRow[] | null;
  targetPort?: number | string | null;
  targetPath?: string | null;
}): StoredPublicEndpoint[] {
  const explicitCustomDomain = normalizeCustomDomain(opts.customDomain);
  const explicitTargetPort = normalizePort(opts.targetPort);
  const explicitTargetPath = normalizeTargetPath(opts.targetPath);

  const explicitTarget = (explicitTargetPort !== null) !== Boolean(explicitTargetPath)
    ? (explicitTargetPort !== null
        ? { port: explicitTargetPort }
        : { targetPath: explicitTargetPath! })
    : null;

  if (explicitCustomDomain) {
    return explicitTarget
      ? [{
          customDomain: explicitCustomDomain,
          ...explicitTarget,
          domainType: "custom",
        } satisfies StoredPublicEndpoint]
      : [];
  }

  const routed = routeRowsToPublicEndpoints(opts.projectDomains);
  if (routed.length > 0) {
    return routed;
  }

  const stored = normalizeStoredPublicEndpoints(opts.stored);
  if (stored.length > 0) {
    return stored;
  }

  const primaryCustomDomain = primaryProjectDomain(opts.projectDomains);
  if (primaryCustomDomain) {
    return explicitTarget
      ? [{
          customDomain: primaryCustomDomain,
          ...explicitTarget,
          domainType: "custom",
        } satisfies StoredPublicEndpoint]
      : [];
  }

  if (!explicitTarget) {
    return [];
  }

  return [{
    ...explicitTarget,
    domain: normalizeSlug(opts.slug) ?? "project",
    domainType: "free",
  } satisfies StoredPublicEndpoint];
}

export function syncStoredPublicEndpoints(opts: {
  current?: StoredPublicEndpointInput[] | null;
  next?: StoredPublicEndpointInput[] | null;
  slug?: string | null;
  customDomain?: string | null;
  projectDomains?: ProjectDomainRow[] | null;
}): {
  publicEndpoints: StoredPublicEndpoint[];
  slug: string;
} {
  const baseSlug = normalizeSlug(opts.slug) ?? "project";
  const nextProvided = opts.next !== undefined;

  let publicEndpoints = nextProvided
    ? normalizeStoredPublicEndpoints(opts.next, {
        primaryFreeDomainFallback: baseSlug,
      })
    : resolveStoredPublicEndpoints({
        stored: opts.current,
        slug: baseSlug,
        customDomain: opts.customDomain,
        projectDomains: opts.projectDomains,
      });

  if (!nextProvided && publicEndpoints.length === 0) {
    publicEndpoints = resolveStoredPublicEndpoints({
      slug: baseSlug,
      customDomain: opts.customDomain,
      projectDomains: opts.projectDomains,
    });
  }

  if (publicEndpoints.length === 0) {
    return {
      publicEndpoints: [],
      slug: baseSlug,
    };
  }

  const [firstEndpoint, ...remainingEndpoints] = publicEndpoints;
  const primaryEndpoint = alignPrimaryStoredPublicEndpoint(
    firstEndpoint,
    baseSlug,
    nextProvided || opts.slug === undefined,
  );

  return {
    publicEndpoints: [primaryEndpoint, ...remainingEndpoints],
    slug: primaryEndpoint.domainType === "free" ? (primaryEndpoint.domain ?? baseSlug) : baseSlug,
  };
}

export function storedPublicEndpointsNeedCloud(
  endpoints?: Array<Pick<StoredPublicEndpoint, "domainType">> | null,
): boolean {
  return (endpoints ?? []).some((endpoint) => endpoint.domainType !== "custom");
}

/**
 * A service's public routes as StoredPublicEndpoints (one per routed port).
 * Prefers the explicit `publicEndpoints` array; falls back to synthesizing the
 * single primary route from the scalar routing columns (pre-migration rows /
 * single-route services). Returns [] when the service isn't exposed or has no
 * routable port. This is the ONE place the service→routes rule lives, so the
 * deploy loop and the route builder agree.
 */
export function resolveServicePublicEndpoints(
  service: Pick<
    Service,
    "exposed" | "exposedPort" | "ports" | "domain" | "customDomain" | "domainType" | "publicEndpoints"
  >,
): StoredPublicEndpoint[] {
  if (!service.exposed) return [];

  if (service.publicEndpoints && service.publicEndpoints.length > 0) {
    return normalizeStoredPublicEndpoints(
      service.publicEndpoints.map((endpoint) => ({
        port: endpoint.port,
        domain: endpoint.domain,
        customDomain: endpoint.customDomain,
        domainType: endpoint.domainType,
      })),
    );
  }

  const port = resolveServicePort(service);
  if (port === null) return [];

  return normalizeStoredPublicEndpoints([
    {
      port,
      domain: service.domain,
      customDomain: service.customDomain,
      domainType: service.domainType === "custom" ? "custom" : "free",
    },
  ]);
}

/**
 * Every public endpoint's assigned domain URL for a service, keyed by container
 * port. Free → https://<slug>.<cloud>, custom → https://<customDomain>. The
 * SINGLE source for a service's public URLs, so the deploy that creates a route
 * and any surface that displays it (the app-settings connection card) resolve
 * the SAME URL and can't drift apart.
 */
export function resolveServiceEndpointUrls(
  project: Project,
  service: Service,
): Array<{ port: number; url: string }> {
  const urls: Array<{ port: number; url: string }> = [];
  for (const endpoint of resolveServicePublicEndpoints(service)) {
    if (endpoint.port === undefined) continue;
    if (endpoint.domainType === "custom") {
      if (endpoint.customDomain)
        urls.push({ port: endpoint.port, url: `https://${endpoint.customDomain}` });
      continue;
    }
    const slug = resolveServiceHostnameLabel(
      project.slug ?? project.name,
      service.name,
      endpoint.domain ?? undefined,
      serviceKind(service),
    );
    if (slug)
      urls.push({ port: endpoint.port, url: `https://${slug}.${SYSTEM.DOMAINS.CLOUD_DOMAIN}` });
  }
  return urls;
}

/**
 * Map a service's live domain rows → StoredPublicEndpoints. Mirrors
 * routeRowsToPublicEndpoints but keeps ONLY rows scoped to this serviceId
 * (the project-level mapper excludes service rows).
 */
export function serviceDomainRowsToPublicEndpoints(
  domains: ProjectDomainRow[] | null | undefined,
  serviceId: string,
): StoredPublicEndpoint[] {
  return (domains ?? [])
    .filter((domain) => domain.serviceId === serviceId)
    .sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
      return left.hostname.localeCompare(right.hostname);
    })
    .map(routeDomainRowToPublicEndpoint)
    .filter((endpoint): endpoint is StoredPublicEndpoint => endpoint !== null);
}