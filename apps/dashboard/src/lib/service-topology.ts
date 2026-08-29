export type ServiceTopologyServiceInput = {
  id: string;
  name: string;
  kind?: string | null;
  dependsOn?: readonly string[] | null;
  sortOrder?: number | null;
};

export type ServiceTopologyContainerInput = {
  serviceId: string;
  status: string;
};

export type ServiceTopologyRelation = "depends-on";

export type ServiceTopologyNode = {
  id: string;
  serviceId: string;
  name: string;
  kind: string | null;
  status: string | null;
};

export type ServiceTopologyEdge = {
  id: string;
  dependentId: string;
  dependencyId: string;
  relation: ServiceTopologyRelation;
};

export type UnresolvedDependencyReason = "missing" | "ambiguous";

export type UnresolvedDependency = {
  serviceId: string;
  serviceName: string;
  dependencyName: string;
  reason: UnresolvedDependencyReason;
  candidateServiceIds: string[];
};

export type ServiceTopology = {
  nodes: ServiceTopologyNode[];
  edges: ServiceTopologyEdge[];
  unresolvedDependencies: UnresolvedDependency[];
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareServices(
  left: ServiceTopologyServiceInput,
  right: ServiceTopologyServiceInput,
): number {
  return (
    (left.sortOrder ?? 0) - (right.sortOrder ?? 0) ||
    compareStrings(left.name, right.name) ||
    compareStrings(left.id, right.id)
  );
}

function runtimeStatuses(
  containers: readonly ServiceTopologyContainerInput[] | null | undefined,
): Map<string, string | null> {
  const statusesByService = new Map<string, Set<string>>();

  for (const container of containers ?? []) {
    const statuses = statusesByService.get(container.serviceId) ?? new Set<string>();
    statuses.add(container.status);
    statusesByService.set(container.serviceId, statuses);
  }

  const statuses = new Map<string, string | null>();
  for (const [serviceId, values] of statusesByService) {
    statuses.set(serviceId, values.size === 1 ? (values.values().next().value ?? null) : null);
  }
  return statuses;
}

export function buildServiceTopology(
  services: readonly ServiceTopologyServiceInput[],
  containers?: readonly ServiceTopologyContainerInput[] | null,
): ServiceTopology {
  const statuses = runtimeStatuses(containers);
  const servicesByName = new Map<string, ServiceTopologyServiceInput[]>();

  for (const service of services) {
    const matches = servicesByName.get(service.name) ?? [];
    matches.push(service);
    servicesByName.set(service.name, matches);
  }

  const nodes = [...services].sort(compareServices).map((service) => ({
    id: service.id,
    serviceId: service.id,
    name: service.name,
    kind: service.kind ?? null,
    status: statuses.get(service.id) ?? null,
  }));
  const edges: ServiceTopologyEdge[] = [];
  const unresolvedDependencies: UnresolvedDependency[] = [];

  for (const service of services) {
    const dependencyNames = [...new Set(service.dependsOn ?? [])].sort(compareStrings);

    for (const dependencyName of dependencyNames) {
      const matches = servicesByName.get(dependencyName) ?? [];

      if (matches.length === 1) {
        const dependencyId = matches[0].id;
        edges.push({
          id: `depends-on:${service.id}:${dependencyId}`,
          dependentId: service.id,
          dependencyId,
          relation: "depends-on",
        });
        continue;
      }

      unresolvedDependencies.push({
        serviceId: service.id,
        serviceName: service.name,
        dependencyName,
        reason: matches.length === 0 ? "missing" : "ambiguous",
        candidateServiceIds: matches.map((match) => match.id).sort(compareStrings),
      });
    }
  }

  edges.sort(
    (left, right) =>
      compareStrings(left.dependentId, right.dependentId) ||
      compareStrings(left.dependencyId, right.dependencyId) ||
      compareStrings(left.id, right.id),
  );
  unresolvedDependencies.sort(
    (left, right) =>
      compareStrings(left.serviceId, right.serviceId) ||
      compareStrings(left.dependencyName, right.dependencyName) ||
      compareStrings(left.reason, right.reason),
  );

  return { nodes, edges, unresolvedDependencies };
}
