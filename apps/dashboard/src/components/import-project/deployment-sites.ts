import { usesServiceDeployment, type DeploymentConfig, type ServiceDeployStatus } from "@/context/deployment/types";
import { resolvePublicEndpointHostname } from "@/lib/public-endpoint-payload";

export interface DeploymentSite {
  hostname: string;
  serviceNames: string[];
}

/** Public destinations for this deployment, with aliases deduplicated by hostname. */
export function getDeploymentSites(
  config: DeploymentConfig,
  services: ServiceDeployStatus[],
  baseDomain: string,
): DeploymentSite[] {
  const sites = new Map<string, DeploymentSite>();
  const add = (endpoint: Parameters<typeof resolvePublicEndpointHostname>[0], serviceName?: string) => {
    if (!endpoint.hostname && endpoint.domainType !== "custom" && !baseDomain) return;
    const hostname = resolvePublicEndpointHostname(endpoint, baseDomain);
    // A wildcard route needs a concrete subdomain before it can be opened.
    if (!hostname || hostname.includes("*")) return;
    const site = sites.get(hostname) ?? { hostname, serviceNames: [] };
    if (serviceName && !site.serviceNames.includes(serviceName)) site.serviceNames.push(serviceName);
    sites.set(hostname, site);
  };

  if (usesServiceDeployment(config)) {
    const failedServices = new Set(services.filter(service => service.status === "failed").map(service => service.serviceName));
    for (const service of config.services) {
      if (!service.exposed || failedServices.has(service.name)) continue;
      for (const endpoint of service.publicEndpoints?.length ? service.publicEndpoints : [service]) {
        add(endpoint, service.name);
      }
    }
  } else if (!config.noPublicRoute) {
    for (const endpoint of config.publicEndpoints) add(endpoint);
  }

  return [...sites.values()];
}
