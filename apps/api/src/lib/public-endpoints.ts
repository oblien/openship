import type { Domain, Project, Service, ServicePublicEndpoint } from "@repo/db";
import {
  SYSTEM,
  ValidationError,
  resolveServiceHostnameLabel,
  resolveRedirectStatus,
  normalizeCustomHostname,
} from "@repo/core";
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
  /** Canonical redirect to another hostname of the same project instead of
   *  serving the app — see lib/domain-redirect.ts. Absent = serves the app. */
  redirectTo?: string;
  /** 301 | 302 | 307 | 308; absent = 301. Only meaningful with `redirectTo`. */
  redirectStatus?: number;
}

type StoredPublicEndpointInput = {
  port?: number | string | null;
  targetPath?: string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: "free" | "custom" | null;
  redirectTo?: string | null;
  redirectStatus?: number | string | null;
};

export type ProjectDomainRow = Pick<
  Domain,
  | "hostname"
  | "isPrimary"
  | "verified"
  | "serviceId"
  | "targetPort"
  | "targetPath"
  | "domainType"
  | "redirectTo"
  | "redirectStatus"
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

/**
 * Canonical stored form of a project route's hostname. Delegates to the SHARED
 * `normalizeCustomHostname` so all three custom-domain write paths agree: this one
 * used to only trim + lowercase, so a pasted `https://example.com` was stored
 * verbatim here while POST /domains and the service path both stored
 * `example.com` — the same input accepted on two paths and rejected on the third.
 */
function normalizeCustomDomain(domain: string | null | undefined): string | undefined {
  const normalized = domain ? normalizeCustomHostname(domain) : "";
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

/**
 * Redirect fields for an endpoint, omitted entirely when there's no redirect — so
 * a serving route's stored shape is byte-identical to what it was before redirects
 * existed.
 *
 * This is the READ/normalize path, so an unusable status is coerced rather than
 * rejected (`resolveRedirectStatus`, the same coercion the edge renderer uses).
 * Refusing a bad one is the write path's job — see lib/domain-redirect.ts.
 */
function normalizeRedirectFields(
  redirectTo: string | null | undefined,
  redirectStatus: number | string | null | undefined,
): { redirectTo?: string; redirectStatus?: number } {
  const target = redirectTo ? normalizeCustomDomain(redirectTo) : undefined;
  if (!target) return {};
  const raw = typeof redirectStatus === "string" ? Number(redirectStatus) : redirectStatus;
  return { redirectTo: target, redirectStatus: resolveRedirectStatus(raw) };
}

function managedHostnameSuffix(): string {
  return `.${getRoutingBaseDomain().trim().toLowerCase()}`;
}

/**
 * True when `hostname` sits under the ACTUAL Openship Cloud domain — the only
 * suffix whose DNS and edge we operate, and therefore the only one that needs a
 * Cloud connection to resolve.
 *
 * Deliberately NOT the routing base domain: that is `HOST_DOMAIN || CLOUD_DOMAIN`,
 * so on a box with `HOST_DOMAIN=example.com` a managed route `api` composes to
 * api.example.com — served by the operator's OWN edge, needing nothing from us.
 * Keying the Cloud requirement on the routing base 403'd exactly that supported
 * self-hosted config.
 */
export function isCloudManagedHostname(hostname: string): boolean {
  const normalized = normalizeCustomDomain(hostname);
  if (!normalized) return false;
  const suffix = `.${SYSTEM.DOMAINS.CLOUD_DOMAIN.trim().toLowerCase()}`;
  return normalized.length > suffix.length && normalized.endsWith(suffix);
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

  // Exactly one of port / targetPath must be set (proxy vs static). A redirecting
  // host is no exception: it keeps its destination so that dropping the redirect
  // restores a serving route with no re-entry of the port/path.
  if ((port !== undefined) === Boolean(targetPath)) {
    return null;
  }

  const redirect = normalizeRedirectFields(domain.redirectTo, domain.redirectStatus);

  if (domainType === "free") {
    const slug = managedHostnameToSlug(hostname);
    if (!slug) return null;

    return {
      ...(port !== undefined ? { port } : {}),
      ...(targetPath ? { targetPath } : {}),
      domain: slug,
      domainType,
      ...redirect,
    } satisfies StoredPublicEndpoint;
  }

  return {
    ...(port !== undefined ? { port } : {}),
    ...(targetPath ? { targetPath } : {}),
    customDomain: hostname,
    domainType,
    ...redirect,
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
    ...normalizeRedirectFields(endpoint.redirectTo, endpoint.redirectStatus),
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

  // Last resort: a managed route on the project's own slug. Reachable ONLY with an
  // explicit port/path target, which the single production caller
  // (syncStoredPublicEndpoints) never passes — so nothing here can invent a route
  // for a project the operator gave no target. No slug → no hostname to key it on;
  // the name is never manufactured (there was a `?? "project"` here, dead for the
  // same reason, which would have invented `project.<base>`).
  const slug = normalizeSlug(opts.slug);
  if (!explicitTarget || !slug) {
    return [];
  }

  return [{
    ...explicitTarget,
    domain: slug,
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
  // `domainType` is intentionally NOT read below — classification is purely by
  // hostname truth (customDomain / domain). Accepting it as OPTIONAL lets deploy
  // preflight and stale/migrated rows (domainType absent) reuse this one predicate.
  endpoints?:
    | Array<Partial<Pick<StoredPublicEndpoint, "domainType" | "domain" | "customDomain">>>
    | null,
): boolean {
  if (!endpoints?.length) return false;
  // Classify by the HOSTNAME's physical truth, never a bare `domainType` string.
  // Only a subdomain of the CLOUD domain resolves behind the Cloud edge, so only
  // that actually needs Cloud. A real custom host routes on our OWN edge and never
  // does — even when a migrated/stale row left its domainType unset or wrong
  // (which is exactly what made removing a custom-domain route demand Cloud) — and
  // neither does a managed subdomain of the operator's own HOST_DOMAIN.
  return endpoints.some((endpoint) => {
    const custom = normalizeCustomDomain(endpoint.customDomain);
    if (custom) return isCloudManagedHostname(custom);
    const slug = normalizeSlug(endpoint.domain);
    if (!slug) return false; // nothing routable → nothing to gate
    // A bare slug is a managed subdomain of the ROUTING base (that's where it will
    // actually be registered); a dotted value here is a misfiled custom host
    // (e.g. a migrated api.example.com) that routes on our edge either way.
    const hostname = slug.includes(".") ? slug : `${slug}${managedHostnameSuffix()}`;
    return isCloudManagedHostname(hostname);
  });
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

/** The routing keys a create/update payload may carry. A key that is `undefined`
 *  was NOT sent and inherits from the stored row. */
export interface ServiceRoutingPatch {
  exposed?: boolean | null;
  exposedPort?: string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: string | null;
  publicEndpoints?: Array<{
    port?: number | string | null;
    domain?: string | null;
    customDomain?: string | null;
    domainType?: string | null;
  }> | null;
}

export type StoredServiceRouting = Pick<
  Service,
  "exposed" | "exposedPort" | "ports" | "domain" | "customDomain" | "domainType" | "publicEndpoints"
>;

function normalizeServiceRoute(input: {
  port?: number | string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: string | null;
}): ServicePublicEndpoint | null {
  const port = normalizePort(input.port);
  if (port === null) return null;
  if (input.domainType === "custom") {
    const customDomain = normalizeCustomDomain(input.customDomain);
    return customDomain ? { port, domainType: "custom", customDomain } : null;
  }
  const domain = normalizeSlug(input.domain);
  return domain ? { port, domainType: "free", domain } : null;
}

/** Two routes with this same key resolve to the SAME hostname. */
function routeIdentity(route: ServicePublicEndpoint): string {
  return route.domainType === "custom" ? `custom:${route.customDomain}` : `free:${route.domain}`;
}

/** The service's route set as CONFIGURED — deliberately not gated on `exposed`
 *  (unlike resolveServicePublicEndpoints), so re-exposing a paused multi-route
 *  service doesn't lose its siblings. */
function storedServiceRoutes(stored?: StoredServiceRouting | null): ServicePublicEndpoint[] {
  if (!stored) return [];
  if (stored.publicEndpoints?.length) {
    return stored.publicEndpoints
      .map((endpoint) => normalizeServiceRoute(endpoint))
      .filter((route): route is ServicePublicEndpoint => route !== null);
  }
  const port = resolveServicePort(stored);
  if (port === null) return [];
  const route = normalizeServiceRoute({
    port,
    domain: stored.domain,
    customDomain: stored.customDomain,
    domainType: stored.domainType === "custom" ? "custom" : "free",
  });
  return route ? [route] : [];
}

/**
 * Fold a service routing patch into the row's EXISTING route set and return the
 * fields to persist (feed straight into `normalizeRoutingFields`).
 *
 * Why this exists: the scalar columns describe ONE route (the primary), while
 * `publicEndpoints` holds the whole set — and `normalizeRoutingFields` lets a
 * non-empty array win outright. So a scalar-only patch against a multi-route
 * service used to be DISCARDED: the stored primary's values were written back,
 * the user's chosen custom domain vanished, and the free-domain cloud gate then
 * judged a "free" route nobody had asked for (a 403 on a custom-domain save).
 * Collapsing to the scalars instead would be the opposite bug — it would delete
 * the sibling routes that "Add route" just created.
 *
 * The rule, applied identically on create (`stored: null`) and update:
 *
 *   • explicit `publicEndpoints` wins outright — that is how the whole set is
 *     edited (`[]` clears the extras).
 *   • `exposed` is a GATE and nothing else: it decides whether the set is SERVED,
 *     never what the set is. Unexposing therefore pauses routing and keeps every
 *     route (see normalizeRoutingFields for why that's inert).
 *   • otherwise the scalars are an UPSERT OF ONE ROUTE keyed by port. Target
 *     port: `patch.exposedPort` → `stored.exposedPort` → stored primary's port
 *     → first container port from `ports`. An entry on that port is replaced in
 *     place (the primary stays primary); otherwise the route is appended.
 *     Routes on OTHER ports survive.
 *   • a hostname can only point at one port, so any other entry resolving to the
 *     upserted route's hostname is dropped — this is what makes changing only the
 *     port MOVE a route instead of cloning its hostname onto two ports. Changing
 *     the port AND the hostname in one scalar patch is therefore an add, not a
 *     move; edit the array to express a move plus a rename.
 *
 * A patch that NAMES a domain scalar but resolves to no usable hostname (subdomain
 * text box cleared, type flipped with no hostname of that kind, no port to key it
 * on) is INCOHERENT: it used to come out as an empty route set, so the caller
 * de-registered the live vhosts and deleted the verified domain row on an HTTP 200.
 * It throws instead. A patch that names nothing routable at all (a bare
 * `{ exposed }` toggle) returns the stored set UNCHANGED.
 *
 * The array is materialized only when the set needs more than one entry;
 * a single route stays in the scalar columns, exactly as before.
 */
export function mergeServiceRoutingPatch(opts: {
  patch: ServiceRoutingPatch;
  stored?: StoredServiceRouting | null;
}): {
  exposed: boolean;
  exposedPort: string | null;
  domain: string | null;
  customDomain: string | null;
  domainType: "free" | "custom";
  publicEndpoints: ServicePublicEndpoint[];
} {
  const { patch, stored } = opts;

  const exposed = patch.exposed ?? stored?.exposed ?? false;
  const exposedPort = patch.exposedPort ?? stored?.exposedPort ?? null;
  const domainType = (patch.domainType ?? stored?.domainType) === "custom" ? "custom" : "free";
  const domain = domainType === "free" ? patch.domain ?? stored?.domain ?? null : null;
  const customDomain =
    domainType === "custom" ? patch.customDomain ?? stored?.customDomain ?? null : null;

  const scalars = { exposed, exposedPort, domain, customDomain, domainType } as const;

  if (patch.publicEndpoints !== undefined) {
    return {
      ...scalars,
      publicEndpoints: (patch.publicEndpoints ?? [])
        .map((endpoint) => normalizeServiceRoute(endpoint))
        .filter((route): route is ServicePublicEndpoint => route !== null),
    };
  }

  const current = storedServiceRoutes(stored);
  const targetPort =
    normalizePort(patch.exposedPort) ??
    normalizePort(stored?.exposedPort) ??
    current[0]?.port ??
    resolveServicePort({ ports: stored?.ports });

  const upserted = normalizeServiceRoute({ port: targetPort, domain, customDomain, domainType });
  if (!upserted) {
    // Nothing to key an upsert on. Whether that's an error depends on whether the
    // caller actually asked for a route change: a bare `{ exposed }` toggle names
    // no hostname, so the stored set is returned untouched (returning [] here is
    // what de-registered live vhosts and deleted verified domain rows on a plain
    // expose toggle). A patch that DID name a domain scalar and still resolves to
    // nothing is incoherent and must not be answered with a silent 200.
    const namesDomain =
      patch.domain !== undefined ||
      patch.customDomain !== undefined ||
      patch.domainType !== undefined;
    // `stored: null` is CREATE: there is no persisted set to destroy, and every
    // create path (installer, compose import, monorepo defaults) synthesizes a
    // `domainType` without a hostname — the row simply comes out internal-only.
    if (!namesDomain || !stored) {
      return { ...scalars, publicEndpoints: current };
    }
    if (domainType === "custom" && !normalizeCustomDomain(customDomain)) {
      throw new ValidationError(
        "A custom route needs a hostname — enter the domain to serve this service on, " +
          "or switch the route back to a free subdomain.",
      );
    }
    if (domainType === "free" && !normalizeSlug(domain)) {
      throw new ValidationError(
        "A free route needs a subdomain — enter one, or switch the route to a custom domain.",
      );
    }
    throw new ValidationError(
      "This route has no target port — set the container port it should serve before saving.",
    );
  }

  // Replace the entry on the target port; failing that, the entry that already
  // owns this hostname (that IS a port change, and replacing it in place keeps
  // the primary primary). Otherwise this is a new route: append.
  const byPort = current.findIndex((route) => route.port === upserted.port);
  const at = byPort >= 0
    ? byPort
    : current.findIndex((route) => routeIdentity(route) === routeIdentity(upserted));
  const next = at >= 0
    ? current.map((route, index) => (index === at ? upserted : route))
    : [...current, upserted];
  const upsertedAt = at >= 0 ? at : next.length - 1;
  // Backstop for a row that already held the same hostname on two ports.
  const deduped = next.filter(
    (route, index) => index === upsertedAt || routeIdentity(route) !== routeIdentity(upserted),
  );

  if (deduped.length <= 1) {
    // One route → the scalar columns ARE the route (unchanged storage shape).
    // Pin the port only when leaving it implicit would move the route: an unset
    // `exposedPort` is re-derived from `ports` at read time, which is a different
    // number than the route set carried.
    const single = deduped[0] ?? upserted;
    const derived = resolveServicePort({ exposedPort, ports: stored?.ports });
    return {
      ...scalars,
      exposedPort: derived === single.port ? exposedPort : String(single.port),
      publicEndpoints: [],
    };
  }

  const primary = deduped[0];
  return {
    exposed,
    exposedPort: String(primary.port),
    domain: primary.domainType === "free" ? primary.domain ?? null : null,
    customDomain: primary.domainType === "custom" ? primary.customDomain ?? null : null,
    domainType: primary.domainType,
    publicEndpoints: deduped,
  };
}

/**
 * Every public endpoint's assigned domain URL for a service, keyed by container
 * port. Free → https://<slug>.<routing base>, custom → https://<customDomain>.
 *
 * The one consumer is the compose deploy's `{{publicUrl:svc[:port]}}` substitution
 * (container env + generated config files — Convex's CONVEX_CLOUD_ORIGIN, a
 * dashboard→backend URL, …). It is NOT a display helper: the dashboard resolves
 * its own hostnames, so nothing here needs to match a card.
 *
 * The free suffix MUST be `getRoutingBaseDomain()`, the same suffix the route,
 * vhost and cert register under (routing-domains.ts resolveServiceEndpointHostname).
 * It used to be CLOUD_DOMAIN, so on a `HOST_DOMAIN=example.com` box the app was
 * handed an *.opsh.io origin the operator's edge never serves — the container
 * booted with a URL that resolves nowhere.
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
    if (slug) urls.push({ port: endpoint.port, url: `https://${slug}.${getRoutingBaseDomain()}` });
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

export type ProjectAccessKind = "custom" | "free" | "local" | "none";

/** The single, server-computed "access URL" for a project — what the dashboard
 *  shows in the sidebar and the Domains card. `url` is a full href; `host` the
 *  bare hostname for display; `urls` every public href (primary first). */
export interface ProjectAccess {
  url: string | null;
  host: string | null;
  kind: ProjectAccessKind;
  isLocal: boolean;
  urls: string[];
}

/** The project's ONE canonical public domain row, chosen over ALL rows
 *  (project-level AND service-scoped): a verified primary, else the first
 *  verified row, else none. The single primary-selection rule the detail Access
 *  URL, the list card's primaryDomain, and the favicon refresh all share, so
 *  those surfaces can never disagree on which domain is "the" one. */
export function pickCanonicalDomainRow<
  T extends Pick<ProjectDomainRow, "verified" | "isPrimary">,
>(rows: T[] | null | undefined): T | null {
  const verified = (rows ?? []).filter((row) => row.verified);
  return verified.find((row) => row.isPrimary) ?? verified[0] ?? null;
}

/**
 * The canonical access URL for a project, computed from ALL its domain rows +
 * the effective deploy target + port. Correct for a project whose only domains
 * are service-scoped — the project-level publicEndpoints resolver excludes those,
 * which is exactly why per-component clients fell back to localhost.
 *
 * Precedence: a verified domain (custom or free) always wins. With none, a
 * purely-local project reads localhost:port; a server/cloud project with no
 * domain reads "none" (never a misleading localhost). Never fabricates a host.
 *
 * Hostname comes straight off the row, NOT the port-XOR-path endpoint mapper, so
 * a verified domain whose port column is momentarily unset still shows its proven
 * hostname — the edge serves it regardless of the DB's port. https for domains
 * (the edge terminates TLS), http for localhost.
 */
export function resolveProjectAccess(input: {
  rows: ProjectDomainRow[] | null | undefined;
  target: "local" | "server" | "cloud";
  port: number | null;
}): ProjectAccess {
  const { rows, target, port } = input;
  const primaryRow = pickCanonicalDomainRow(rows);

  if (primaryRow) {
    const orderedVerified = [
      primaryRow,
      ...(rows ?? []).filter((row) => row.verified && row !== primaryRow),
    ];
    const urls: string[] = [];
    const seen = new Set<string>();
    let host: string | null = null;
    let kind: "custom" | "free" = "custom";
    for (const row of orderedVerified) {
      const h = normalizeCustomDomain(row.hostname);
      if (!h || seen.has(h)) continue;
      seen.add(h);
      urls.push(`https://${h}`);
      if (host === null) {
        host = h;
        kind = inferPublicRouteDomainType(row.hostname, row.domainType);
      }
    }
    if (host) {
      return { url: `https://${host}`, host, kind, isLocal: false, urls };
    }
  }

  if (target === "local") {
    const host = `localhost:${port ?? 3000}`;
    return { url: `http://${host}`, host, kind: "local", isLocal: true, urls: [] };
  }

  return { url: null, host: null, kind: "none", isLocal: false, urls: [] };
}