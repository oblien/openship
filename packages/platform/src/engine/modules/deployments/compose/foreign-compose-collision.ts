import type { DockerContainerSummary } from "@repo/adapters";

export interface ForeignComposeCollision {
  serviceName: string;
  containerName: string;
}

const PARALLEL_STACK_RESOURCE_STATES = new Set([
  "running",
  "restarting",
  "paused",
  "created",
]);

/**
 * A stopped container is historical state and cannot create a parallel
 * workload or reserve its published ports. Keep the guard fail-closed for
 * containers that can still own resources, including a freshly-created
 * container whose port binding exists before its first start.
 */
function canBlockParallelStack(state: string | undefined): boolean {
  return PARALLEL_STACK_RESOURCE_STATES.has(state?.trim().toLowerCase() ?? "");
}

/**
 * Detect a pre-existing Docker Compose stack which merely shares this project's
 * slug. A normal deployment does not own those containers and must not silently
 * create a parallel Openship-managed stack beside them.
 */
export function findForeignComposeCollisions(input: {
  slug: string;
  serviceNames: Iterable<string>;
  containers: readonly DockerContainerSummary[];
  trackedContainerIds?: Iterable<string>;
}): ForeignComposeCollision[] {
  const services = new Set(input.serviceNames);
  const tracked = new Set(input.trackedContainerIds ?? []);
  return input.containers
    .filter(
      (container) =>
        canBlockParallelStack(container.state) &&
        !tracked.has(container.id) &&
        container.composeProject === input.slug &&
        !!container.composeService &&
        services.has(container.composeService),
    )
    .map((container) => ({
      serviceName: container.composeService!,
      containerName: container.names[0] ?? container.id.slice(0, 12),
    }));
}
