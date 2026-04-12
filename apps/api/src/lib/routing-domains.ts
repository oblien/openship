import { repos, type Domain, type Project, type Service } from "@repo/db";
import type { RoutedDomainInput, SslProvider } from "@repo/adapters";
import { SYSTEM, resolveServiceHostnameLabel } from "@repo/core";
import { env } from "../config/env";

export interface PlannedRouteDomain {
  hostname: string;
  tls: true;
  provisionSsl: boolean;
  isCloud: boolean;
  managedSubdomain?: string;
  serviceId?: string;
  createIfMissing?: boolean;
}

export function getRoutingBaseDomain(): string {
  return env.HOST_DOMAIN || SYSTEM.DOMAINS.CLOUD_DOMAIN;
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
  customDomain?: string;
  runtimeName: string;
  usesManagedRouting: boolean;
}): PlannedRouteDomain[] {
  const { project, projectDomains, customDomain, runtimeName, usesManagedRouting } = opts;
  const seen = new Set<string>();
  const planned: PlannedRouteDomain[] = [];

  const add = (hostname: string, skipSsl = false) => {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);

    const managed = resolveManagedHostname(normalized);
    planned.push({
      hostname: normalized,
      tls: true,
      provisionSsl: runtimeName === "bare" && !managed.isManaged && !skipSsl,
      isCloud: managed.isManaged,
      managedSubdomain: managed.subdomain,
      createIfMissing: true,
    });
  };

  if (customDomain) add(customDomain);
  for (const domain of projectDomains) {
    if (domain.verified) add(domain.hostname);
  }
  if (project.slug && usesManagedRouting) {
    add(`${project.slug}.${getRoutingBaseDomain()}`, true);
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

  const hostname = service.domainType === "custom"
    ? service.customDomain?.trim().toLowerCase()
    : usesManagedRouting
      ? `${resolveServiceHostnameLabel(project.slug ?? project.name, service.name, service.domain)}.${getRoutingBaseDomain()}`
      : null;

  if (!hostname) return null;

  const managed = resolveManagedHostname(hostname);
  return {
    hostname,
    tls: true,
    provisionSsl: runtimeName === "bare" && service.domainType === "custom",
    isCloud: managed.isManaged,
    managedSubdomain: managed.subdomain,
    serviceId: service.id,
    createIfMissing: true,
  };
}

export function createTrackedSslProvider(
  ssl: SslProvider,
  domainByHostname: Map<string, Domain>,
): SslProvider {
  const persistSslResult = async (hostname: string, result: Awaited<ReturnType<SslProvider["provisionCert"]>>) => {
    const domainRecord = domainByHostname.get(hostname.toLowerCase());

    if (domainRecord) {
      await repos.domain.updateSsl(domainRecord.id, {
        sslStatus: result.expiresAt ? "active" : "provisioning",
        sslIssuer: result.issuer,
        sslExpiresAt: result.expiresAt ? new Date(result.expiresAt) : undefined,
      });
    }

    return result;
  };

  return {
    provisionCert: async (hostname: string) => {
      const result = await ssl.provisionCert(hostname);
      return persistSslResult(hostname, result);
    },
    renewCert: async (hostname: string) => {
      const result = await ssl.renewCert(hostname);
      return persistSslResult(hostname, result);
    },
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
  if (existing || !route.createIfMissing) {
    return existing ?? null;
  }

  const created = await repos.domain.findOrCreate({
    projectId,
    serviceId: route.serviceId,
    hostname: route.hostname,
    isPrimary: !route.serviceId && domainByHostname.size === 0,
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
  }));
}