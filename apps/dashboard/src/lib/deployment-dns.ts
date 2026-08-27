import { normalizeCustomHostname } from "@repo/core";

import type { DeploymentConfig, PublicEndpoint } from "@/context/deployment/types";

export interface DeploymentDnsTarget {
  hostname: string;
  includeWww: boolean;
}

function customHostname(endpoint: Pick<PublicEndpoint, "domainType" | "customDomain">) {
  return endpoint.domainType === "custom"
    ? normalizeCustomHostname(endpoint.customDomain)
    : "";
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

  const set = new Set(hostnames);
  const consumed = new Set<string>();
  const targets: DeploymentDnsTarget[] = [];
  for (const hostname of hostnames) {
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
