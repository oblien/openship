import { repos, type Domain, type Project, type Service } from "@repo/db";
import type { RoutedDomainInput, SslProvider, SslResult } from "@repo/adapters";
import { SYSTEM, resolveServiceHostnameLabel } from "@repo/core";
import { env } from "../config/env";
import { resolveServicePort, serviceKind } from "./deployable-service";
import { resolveSslPatch } from "./domain-ssl";

export interface PlannedRouteDomain {
  hostname: string;
  tls: true;
  provisionSsl: boolean;
  isCloud: boolean;
  targetPort?: number;
  targetPath?: string;
  domainType?: "free" | "custom";
  managedSubdomain?: string;
  serviceId?: string;
  isPrimary?: boolean;
  createIfMissing?: boolean;
  verified?: boolean;
}

export function getRoutingBaseDomain(): string {
  return env.HOST_DOMAIN || SYSTEM.DOMAINS.CLOUD_DOMAIN;
}

/**
 * Self-hosted runtimes whose custom-domain routes are fronted by OpenResty
 * and need a certbot-issued cert (the NginxProvider SSL path). Both `bare`
 * and `docker` self-hosted deploys go through the SAME OpenResty + certbot
 * provider (see platform.ts → createInfraProvider, which returns NginxProvider
 * regardless of runtime mode). `cloud` uses managed SSL; `desktop` (bare +
 * noop infra) has no real SSL provider. Historically this was gated to `bare`
 * only, which silently skipped SSL for every Docker deployment — a custom
 * domain on a Docker app would stay on HTTP forever.
 */
function usesCertbotSsl(runtimeName: string): boolean {
  return runtimeName === "bare" || runtimeName === "docker";
}

function resolveManagedHostname(hostname: string): { isManaged: boolean; subdomain?: string } {
  const baseDomain = getRoutingBaseDomain().toLowerCase();
  const normalized = hostname.trim().toLowerCase();
  const suffix = `.${baseDomain}`;

  if (!normalized.endsWith(suffix)) {
    return { isManaged: false };
  }

  const subdomain = normalized.slice(0, -suffix.length);
  return {
    isManaged: subdomain.length > 0,
    subdomain: subdomain || undefined,
  };
}

export function buildProjectRouteDomains(opts: {
  project: Project;
  projectDomains: Domain[];
  managedSlug?: string;
  publicEndpoints?: Array<{
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  runtimeName: string;
  usesManagedRouting: boolean;
}): PlannedRouteDomain[] {
  const { projectDomains, managedSlug, publicEndpoints, runtimeName, usesManagedRouting } = opts;
  const baseDomain = getRoutingBaseDomain();
  const seen = new Set<string>();
  const planned: PlannedRouteDomain[] = [];
  const domainByHostname = new Map(
    projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
  );

  // Push a single planned route. A route MUST target exactly one
  // destination (port or path) — calls without one are silently ignored.
  // SSL is provisioned only for DNS-verified custom domains on the bare
  // runtime: free managed (*.opsh.io) routes skip certbot (we own that
  // DNS), and a pending custom domain gets an HTTP-only route until
  // /verify issues its cert (see domain.service.ts → verifyDomain). When
  // isPrimary is omitted, the first route added wins.
  const add = (
    hostname: string,
    route: {
      domainType: "free" | "custom";
      destination?: { targetPort?: number; targetPath?: string };
      skipSsl?: boolean;
      isPrimary?: boolean;
      verified?: boolean;
    },
  ) => {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    if (!route.destination?.targetPath && route.destination?.targetPort === undefined) return;
    seen.add(normalized);

    const managed = resolveManagedHostname(normalized);
    const isVerified = managed.isManaged
      ? true
      : route.verified ?? domainByHostname.get(normalized)?.verified ?? false;

    planned.push({
      hostname: normalized,
      tls: true,
      provisionSsl: usesCertbotSsl(runtimeName) && !managed.isManaged && !route.skipSsl && isVerified,
      isCloud: managed.isManaged,
      ...(route.destination?.targetPort !== undefined
        ? { targetPort: route.destination.targetPort }
        : {}),
      ...(route.destination?.targetPath ? { targetPath: route.destination.targetPath } : {}),
      domainType: route.domainType,
      managedSubdomain: managed.subdomain,
      isPrimary: route.isPrimary ?? planned.length === 0,
      createIfMissing: true,
      verified: isVerified,
    });
  };

  if (publicEndpoints?.length) {
    for (const [index, endpoint] of publicEndpoints.entries()) {
      const destination = endpoint.targetPath
        ? { targetPath: endpoint.targetPath }
        : endpoint.port !== undefined
          ? { targetPort: endpoint.port }
          : undefined;

      if (!destination) {
        continue;
      }

      // Attach EITHER the operator's custom domain OR a free
      // <slug>.opsh.io fallback — never both. The free managed URL is
      // served by Openship Cloud's edge (runPostDeploySync →
      // ensureManagedEdgeProxy), so a self-hosted box can't serve it
      // alone; once the operator points their own domain at the box, that
      // domain is the deploy URL and a free slug they never asked for is
      // just an unservable route plus a failing edge sync. Same rule as
      // preflight.ts. The chosen route is primary for the first endpoint
      // (deploy URL, analytics, etc.).
      if (endpoint.domainType === "custom" && endpoint.customDomain) {
        add(endpoint.customDomain, { domainType: "custom", destination, isPrimary: index === 0 });
        continue;
      }

      const routeSlug = endpoint.domain || managedSlug;
      if (routeSlug && usesManagedRouting) {
        add(`${routeSlug}.${baseDomain}`, {
          domainType: "free",
          destination,
          skipSsl: true,
          isPrimary: index === 0,
        });
      }
    }

    return planned;
  }

  // No public endpoints: route the project's own domain rows directly. A
  // domain only routes if its row carries a destination (port or path) —
  // add() ignores the rest. Pending custom domains still get an HTTP-only
  // route so certbot --webroot can answer the ACME challenge; add() gates
  // SSL on domain.verified.
  for (const domain of projectDomains) {
    if (domain.serviceId) continue;
    if (domain.domainType === "free" && !domain.verified) continue;
    add(domain.hostname, {
      domainType: domain.domainType === "free" ? "free" : "custom",
      skipSsl: domain.domainType === "free",
      destination: domain.targetPath
        ? { targetPath: domain.targetPath }
        : domain.targetPort !== null && domain.targetPort !== undefined
          ? { targetPort: domain.targetPort }
          : undefined,
      isPrimary: domain.isPrimary,
      verified: domain.verified,
    });
  }

  return planned;
}

export function buildServiceRouteDomain(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  usesManagedRouting: boolean;
}): PlannedRouteDomain | null {
  const { project, service, runtimeName, usesManagedRouting } = opts;
  if (!service.exposed) return null;

  // Use the canonical port resolver so we honor `ports[]` too - not just
  // `exposedPort`.
  const resolvedPort = resolveServicePort(service);
  const targetPort = resolvedPort ?? undefined;

  // Monorepo sub-apps always get a namespaced hostname (`<project>-<app>`).
  // Compose services keep the "frontend"/"web"/"app" → bare-project-label
  // shortcut. See defaultServiceHostnameLabel for why.
  const hostname = service.domainType === "custom"
    ? service.customDomain?.trim().toLowerCase()
    : usesManagedRouting
      ? `${resolveServiceHostnameLabel(project.slug ?? project.name, service.name, service.domain, serviceKind(service))}.${getRoutingBaseDomain()}`
      : null;

  if (!hostname) return null;

  const managed = resolveManagedHostname(hostname);
  return {
    hostname,
    tls: true,
    provisionSsl: usesCertbotSsl(runtimeName) && service.domainType === "custom",
    isCloud: managed.isManaged,
    targetPort: Number.isFinite(targetPort) ? targetPort : undefined,
    domainType: service.domainType === "custom" ? "custom" : "free",
    managedSubdomain: managed.subdomain,
    serviceId: service.id,
    isPrimary: false,
    createIfMissing: true,
  };
}

export function createTrackedSslProvider(
  ssl: SslProvider,
  domainByHostname: Map<string, Domain>,
): SslProvider {
  // Persist via the shared no-clobber resolver: a verified cert → "active"; a
  // genuinely missing cert → "provisioning"; a transient read failure leaves the
  // row alone (so a redeploy that can't momentarily read an existing cert can't
  // downgrade a live "active" → "provisioning"). Same rule the on-demand path uses.
  const persist = async (hostname: string, result: SslResult) => {
    const domainRecord = domainByHostname.get(hostname.toLowerCase());
    if (domainRecord) {
      const patch = resolveSslPatch(domainRecord.sslStatus, result);
      if (patch) await repos.domain.updateSsl(domainRecord.id, patch);
    }
    return result;
  };

  return {
    provisionCert: async (hostname: string) => persist(hostname, await ssl.provisionCert(hostname)),
    renewCert: async (hostname: string) => persist(hostname, await ssl.renewCert(hostname)),
    verifyCert: async (hostname: string) => persist(hostname, await ssl.verifyCert(hostname)),
  };
}

export async function ensureRouteDomainRecord(opts: {
  projectId: string;
  route: PlannedRouteDomain;
  domainByHostname: Map<string, Domain>;
}): Promise<Domain | null> {
  const { projectId, route, domainByHostname } = opts;
  const key = route.hostname.toLowerCase();
  const existing = domainByHostname.get(key);
  // Primary (DB isPrimary) is owned by explicit setPrimary — the deploy must not
  // re-derive it from endpoint order; only a new domain may claim it, when none exists.
  const hasExistingPrimary = [...domainByHostname.values()].some((d) => d.isPrimary);
  if (existing) {
    const patch: Record<string, unknown> = {};
    const expectedDomainType = route.domainType ?? null;
    const expectedTargetPort = route.targetPort ?? null;
    const expectedTargetPath = route.targetPath ?? null;
    const expectedServiceId = route.serviceId ?? null;

    if ((existing.domainType ?? null) !== expectedDomainType) patch.domainType = expectedDomainType;
    if ((existing.targetPort ?? null) !== expectedTargetPort) patch.targetPort = expectedTargetPort;
    if ((existing.targetPath ?? null) !== expectedTargetPath) patch.targetPath = expectedTargetPath;
    if ((existing.serviceId ?? null) !== expectedServiceId) patch.serviceId = expectedServiceId;
    // isPrimary intentionally NOT patched — preserve the user's stored selection.
    if (!existing.verified) {
      patch.verified = true;
      patch.verifiedAt = new Date();
    }
    if (existing.status !== "active") patch.status = "active";

    if (Object.keys(patch).length > 0) {
      await repos.domain.update(existing.id, patch);
      const updated = { ...existing, ...patch } as Domain;
      domainByHostname.set(key, updated);
      return updated;
    }

    return existing;
  }

  if (!route.createIfMissing) {
    return null;
  }

  const created = await repos.domain.findOrCreate({
    projectId,
    serviceId: route.serviceId,
    hostname: route.hostname,
    targetPort: route.targetPort,
    targetPath: route.targetPath,
    domainType: route.domainType,
    isPrimary: hasExistingPrimary
      ? false
      : (route.isPrimary ?? (!route.serviceId && domainByHostname.size === 0)),
    status: "active",
    verified: true,
    verifiedAt: new Date(),
  });
  domainByHostname.set(key, created);
  return created;
}

export function toRoutedDomainInputs(domains: PlannedRouteDomain[]): RoutedDomainInput[] {
  return domains.map((domain) => ({
    hostname: domain.hostname,
    tls: domain.tls,
    provisionSsl: domain.provisionSsl,
    targetPort: domain.targetPort,
    targetPath: domain.targetPath,
  }));
}
