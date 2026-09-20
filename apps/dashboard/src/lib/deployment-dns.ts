import { normalizeCustomHostname } from "@repo/core";

import type { DeploymentConfig, PublicEndpoint } from "@/context/deployment/types";

export interface DeploymentDnsTarget {
  hostname: string;
  includeWww: boolean;
  domainId?: string | null;
}

interface PersistedDomainIdentity {
  id?: unknown;
  hostname?: unknown;
}

interface AppInstallRouteForDns {
  mode?: string;
  customDomain?: string | null;
}

function customHostname(endpoint: Pick<PublicEndpoint, "domainType" | "customDomain">) {
  return endpoint.domainType === "custom"
    ? normalizeCustomHostname(endpoint.customDomain)
    : "";
}

/**
 * Attach real domain-row ids without mutating the caller's targets. A draft
 * endpoint id is not a domain id, so the hostname join is the only safe bridge
 * between pre-deploy configuration and the persisted rows used by Auto DNS.
 */
export function attachDeploymentDomainIds(
  targets: readonly DeploymentDnsTarget[],
  domains: readonly PersistedDomainIdentity[],
): DeploymentDnsTarget[] {
  const idByHostname = new Map<string, string>();
  for (const domain of domains) {
    if (typeof domain.hostname !== "string" || typeof domain.id !== "string") continue;
    const hostname = normalizeCustomHostname(domain.hostname);
    if (hostname) idByHostname.set(hostname, domain.id);
  }

  return targets.flatMap((target) => {
    const hostname = normalizeCustomHostname(target.hostname);
    // Never trust an id carried by an editable/draft target; only a row returned
    // by the server is proof that `/domains/:id/*` is a valid destination.
    const domainId = idByHostname.get(hostname) ?? null;
    if (!target.includeWww) return [{ ...target, hostname, domainId }];

    // `www` is an independent domain row with its own Auto-DNS operation. Once
    // persisted identities are available, expand the preview-only grouping so
    // both records can be planned/applied instead of configuring only the apex.
    const wwwHostname = `www.${hostname}`;
    const wwwDomainId = idByHostname.get(wwwHostname) ?? null;
    if (domainId || wwwDomainId) {
      return [
        { hostname, includeWww: false, domainId },
        { hostname: wwwHostname, includeWww: false, domainId: wwwDomainId },
      ];
    }

    return [{ ...target, hostname, domainId: null }];
  });
}

/** Custom-domain targets selected in the catalog app installer. */
export function appInstallDnsTargets(
  routes: readonly AppInstallRouteForDns[],
): DeploymentDnsTarget[] {
  const hostnames = routes
    .filter((route) => route.mode === "custom")
    .map((route) => normalizeCustomHostname(route.customDomain ?? ""));
  return groupCustomHostnames(hostnames);
}

function groupCustomHostnames(hostnames: readonly string[]): DeploymentDnsTarget[] {
  const unique = hostnames.filter(
    (hostname, index) => hostname && hostnames.indexOf(hostname) === index,
  );
  const set = new Set(unique);
  const consumed = new Set<string>();
  const targets: DeploymentDnsTarget[] = [];
  for (const hostname of unique) {
    if (consumed.has(hostname)) continue;
    const www = `www.${hostname}`;
    if (!hostname.startsWith("www.") && set.has(www)) {
      targets.push({ hostname, includeWww: true });
      consumed.add(www);
    } else {
      targets.push({ hostname, includeWww: false });
    }
    consumed.add(hostname);
  }
  return targets;
}

/**
 * Every custom hostname the deployment wizard is about to publish.
 *
 * Single apps and monorepos store routes in `config.publicEndpoints`; Compose
 * stores them per service, either in `publicEndpoints` (multi-route) or in the
 * legacy scalar fields. Keeping this traversal here prevents pre-deploy gates
 * from accidentally supporting only one deployment shape (#663).
 */
export function deploymentDnsTargets(
  config: Pick<DeploymentConfig, "publicEndpoints" | "services">,
): DeploymentDnsTarget[] {
  const hostnames: string[] = [];
  const add = (hostname: string) => {
    if (hostname && !hostnames.includes(hostname)) hostnames.push(hostname);
  };

  for (const endpoint of config.publicEndpoints ?? []) add(customHostname(endpoint));

  for (const service of config.services ?? []) {
    if (!service.exposed) continue;
    if (service.publicEndpoints?.length) {
      for (const endpoint of service.publicEndpoints) add(customHostname(endpoint));
      continue;
    }
    if (service.domainType === "custom") add(normalizeCustomHostname(service.customDomain ?? ""));
  }

  return groupCustomHostnames(hostnames);
}
