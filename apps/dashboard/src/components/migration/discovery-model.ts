import type { DiscoveredGroup, DiscoveredService } from "@/lib/api/server-migration";
import { servicePresentation, type ProjectTopologyGraph } from "@/components/topology/model";

/** Selection is container-scoped: service names repeat across Compose projects. */
export const svcUid = (service: DiscoveredService) => service.containerId ?? service.name;
export const STANDALONE = "__standalone__";
export const groupKey = (group: DiscoveredGroup) => group.project ?? STANDALONE;
export const isBlocked = (service: DiscoveredService) => Boolean(service.build) && !service.image;
export const isProxy = (service: DiscoveredService) => Boolean(service.proxyKind);
export const isExcluded = (service: DiscoveredService) => isBlocked(service) || isProxy(service);

export const selectableServices = (
  group: DiscoveredGroup,
  projectId: string,
  claimedBy: ReadonlyMap<string, string>,
) =>
  group.services.filter(
    (service) =>
      !isExcluded(service) && (claimedBy.get(svcUid(service)) ?? projectId) === projectId,
  );

/** Removing the initially chosen group must not leave its name on another stack. */
export function selectedGroupKey(
  groups: DiscoveredGroup[],
  services: ReadonlySet<string>,
  preferred: string | null,
): string | null {
  const selected = groups.filter((group) =>
    group.services.some((service) => services.has(svcUid(service))),
  );
  return selected.some((group) => groupKey(group) === preferred)
    ? preferred
    : selected[0]
      ? groupKey(selected[0])
      : null;
}

/** Project topology's visual model, projected from this scan only. No configuration
 * or environment values enter the graph, and dependencies stay inside their group. */
export function discoveryGraph(
  group: DiscoveredGroup,
  dependencyLabel: string,
): ProjectTopologyGraph {
  const byName = new Map<string, DiscoveredService[]>();
  for (const service of group.services) {
    for (const name of new Set([
      service.name,
      service.containerName?.replace(/^\//, ""),
      service.containerId,
    ])) {
      if (name) byName.set(name, [...(byName.get(name) ?? []), service]);
    }
  }
  const nodes = group.services.map((service) => ({
    id: svcUid(service),
    kind: "service" as const,
    projectId: groupKey(group),
    name: service.name,
    image: service.image,
    description: service.image ?? service.build ?? "",
    tone: servicePresentation({ image: service.image ?? null, build: service.build ?? null }).tone,
    state: service.running ? ("running" as const) : ("stopped" as const),
  }));
  const edges = new Map<string, ProjectTopologyGraph["edges"][number]>();
  for (const service of group.services) {
    for (const dependency of service.dependsOn) {
      for (const target of byName.get(dependency) ?? []) {
        const sourceId = svcUid(service);
        const targetId = svcUid(target);
        if (sourceId === targetId) continue;
        const id = JSON.stringify([sourceId, targetId]);
        edges.set(id, {
          id,
          source: sourceId,
          target: targetId,
          kind: "dependency",
          label: dependencyLabel,
          description: `${service.name} → ${target.name}`,
        });
      }
    }
  }
  return { nodes, edges: [...edges.values()] };
}
