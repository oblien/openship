/**
 * Docker attaches these labels to the *task container* it creates for a Swarm
 * service. A task/container is disposable scheduler output, so callers that
 * would normally manage a standalone container must stop at this boundary.
 */
export interface SwarmTaskOwnership {
  serviceId?: string;
  serviceName?: string;
  stackName?: string;
  taskId?: string;
}

export function swarmTaskOwnership(
  labels: Record<string, string> | null | undefined,
): SwarmTaskOwnership | undefined {
  if (!labels) return undefined;

  const serviceId = labels["com.docker.swarm.service.id"]?.trim() || undefined;
  const serviceName = labels["com.docker.swarm.service.name"]?.trim() || undefined;
  const stackName = labels["com.docker.stack.namespace"]?.trim() || undefined;
  const taskId = labels["com.docker.swarm.task.id"]?.trim() || undefined;

  if (!serviceId && !serviceName && !stackName && !taskId) return undefined;
  return { serviceId, serviceName, stackName, taskId };
}

export function isSwarmTaskContainer(
  labels: Record<string, string> | null | undefined,
): boolean {
  return swarmTaskOwnership(labels) !== undefined;
}

/** Human-facing service identity for safe refusal messages. */
export function describeSwarmTaskOwnership(ownership: SwarmTaskOwnership): string {
  const service = ownership.serviceName || ownership.serviceId || "unknown service";
  return ownership.stackName ? `${ownership.stackName}/${service}` : service;
}
