import type { Service } from "@/lib/api/services";

export interface ProjectDomainLike {
  serviceId?: string | null;
  targetPort?: number | string | null;
  targetPath?: string | null;
  hostname?: string;
  domain?: string;
}

function validPort(value: number | string | null | undefined): number | null {
  if (value == null || (typeof value === "string" && !/^\d+$/.test(value.trim()))) {
    return null;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function serviceMatchesPort(
  service: Pick<Service, "ports" | "exposedPort">,
  port: number | string,
): boolean {
  const p = validPort(port);
  if (p === null) return false;
  return [service.exposedPort, ...(service.ports ?? [])].some((spec) => {
    if (!spec) return false;
    const [mapping, protocol] = spec.trim().split("/");
    if (protocol && protocol !== "tcp") return false;
    const parts = mapping.split(":");
    return parts.slice(-2).some((part) => validPort(part) === p);
  });
}

export function hasConnectedDomain(
  service: Service,
  domains?: ProjectDomainLike[] | null,
  projectPort?: number | string | null,
): boolean {
  if (domains && domains.length > 0) {
    const hasMatchingDomain = domains.some((d) => {
      const hostname = (d.hostname ?? d.domain ?? "").trim();
      if (!hostname) return false;
      // Explicit ownership wins over coincidentally shared ports. Project routes
      // can serve an unexposed service and legacy rows fall back to project.port.
      if (d.serviceId) return d.serviceId === service.id;
      if (d.targetPath) return false;
      const port = d.targetPort ?? projectPort;
      return port != null && serviceMatchesPort(service, port);
    });
    if (hasMatchingDomain) return true;
  }

  if (!service.exposed) return false;

  if (service.publicEndpoints && service.publicEndpoints.length > 0) {
    const hasEndpointDomain = service.publicEndpoints.some((ep) =>
      ep.domainType === "custom" ? Boolean(ep.customDomain?.trim()) : Boolean(ep.domain?.trim()),
    );
    if (hasEndpointDomain) return true;
  }

  if (service.domainType === "custom") return Boolean(service.customDomain?.trim());
  // The deploy preflight synthesizes the free hostname from the project/service
  // names when no explicit slug was chosen (resolveServiceRouteHostname).
  return Boolean(service.domain?.trim() || service.name?.trim());
}

export function isPotentiallyPublicService(service: Service): boolean {
  return service.enabled && (service.ports?.length ?? 0) > 0;
}

export function shouldWarnAboutUnreachableServices(
  services: Service[],
  domains?: ProjectDomainLike[] | null,
  projectPort?: number | string | null,
): boolean {
  const candidateServices = services.filter(isPotentiallyPublicService);
  if (candidateServices.length === 0) return false;
  return candidateServices.every((service) => !hasConnectedDomain(service, domains, projectPort));
}
