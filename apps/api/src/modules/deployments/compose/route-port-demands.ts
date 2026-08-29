import type { Domain, Project, Service, ServiceDeployment } from "@repo/db";

import { resolveServicePort } from "../../../lib/deployable-service";
import {
  pickProjectPortOwner,
  type UpstreamCandidateRow,
} from "../../../lib/project-service-upstream";
import { buildProjectRouteDomains, buildServiceRouteDomains } from "../../../lib/routing-domains";
import { planCompositeRoute } from "./composite-route";

export type ComposeRoutePortDemands = Map<string, Set<number>>;

/**
 * Every container port a self-hosted vhost can dial during a services deploy.
 *
 * Service domains are only one source. Project-level domains may target an
 * unexposed service, while the vercel-style composite and migration fan-out
 * vhosts can reach services which own no hostname of their own. Allocation must
 * see the union before Docker starts; discovering one of these routes afterwards
 * leaves a vhost pointing at an unclaimed port that can later be recycled.
 */
export function collectComposeRoutePortDemands(opts: {
  project: Project;
  services: Service[];
  domainRows: Domain[];
  previousRows?: ServiceDeployment[];
  runtimeName: string;
  usesManagedRouting: boolean;
}): ComposeRoutePortDemands {
  const {
    project,
    services,
    domainRows,
    previousRows = [],
    runtimeName,
    usesManagedRouting,
  } = opts;
  const demands: ComposeRoutePortDemands = new Map();
  const add = (serviceId: string, containerPort: number | null | undefined) => {
    if (
      containerPort == null ||
      !Number.isSafeInteger(containerPort) ||
      containerPort < 1 ||
      containerPort > 65_535
    ) {
      return;
    }
    const ports = demands.get(serviceId) ?? new Set<number>();
    ports.add(containerPort);
    demands.set(serviceId, ports);
  };

  const domainByHostname = new Map(domainRows.map((row) => [row.hostname.toLowerCase(), row]));
  for (const service of services) {
    for (const route of buildServiceRouteDomains({
      project,
      service,
      runtimeName,
      usesManagedRouting,
      domainByHostname,
    })) {
      add(service.id, route.targetPort);
    }
  }

  // `pickProjectPortOwner` deliberately requires a container-backed candidate on
  // live route paths. During planning the new containers do not exist yet, so a
  // sentinel marks every enabled definition as available while the previous row
  // contributes any durable host-side mapping the operator may have selected.
  const previousByService = new Map(previousRows.map((row) => [row.serviceId, row]));
  const plannedRows = new Map<string, UpstreamCandidateRow>(
    services.map((service) => {
      const previous = previousByService.get(service.id);
      return [
        service.id,
        {
          serviceId: service.id,
          containerId: previous?.containerId ?? `planned:${service.id}`,
          hostPort: previous?.hostPort,
          hostPorts: previous?.hostPorts,
        },
      ];
    }),
  );
  const projectRoutes = buildProjectRouteDomains({
    project,
    projectDomains: domainRows,
    runtimeName,
    usesManagedRouting,
  });
  for (const route of projectRoutes) {
    if (route.targetPort == null) continue;
    const owner = pickProjectPortOwner({
      port: route.targetPort,
      services,
      rowByService: plannedRows,
      domainRows,
    });
    if (owner) add(owner.serviceId, owner.containerPort);
  }

  // A composite's backend is always proxied even though the static frontend is
  // served from disk. The persisted fan-out is explicit routing configuration:
  // root and path services are route demands independently of `service.exposed`.
  const composite = planCompositeRoute(services, {
    rewrites: project.routingConfig?.rewrites,
  });
  if (composite) {
    const backend = services.find((service) => service.id === composite.backendServiceId);
    if (backend) add(backend.id, resolveServicePort(backend, project.port));
  }
  for (const route of project.compositeRoutes ?? []) {
    for (const serviceId of [route.rootServiceId, ...route.locations.map((loc) => loc.serviceId)]) {
      const service = services.find((candidate) => candidate.id === serviceId);
      if (service) add(service.id, resolveServicePort(service, project.port));
    }
  }

  return demands;
}
