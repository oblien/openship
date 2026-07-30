import type {
  SwarmServiceHealth,
  SwarmServiceState,
  SwarmStackHealth,
  SwarmTaskState,
} from "./types";

function taskTime(task: SwarmTaskState): number {
  const parsed = Date.parse(task.updatedAt ?? task.observedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function currentState(value: string): "running" | "pending" | "failed" | "complete" | "other" {
  const state = value.toLowerCase();
  if (state.startsWith("running")) return "running";
  if (state.startsWith("complete")) return "complete";
  if (state.startsWith("failed") || state.startsWith("rejected") || state.startsWith("shutdown")) return "failed";
  if (state.startsWith("new") || state.startsWith("allocated") || state.startsWith("pending") || state.startsWith("preparing") || state.startsWith("starting")) return "pending";
  return "other";
}

/**
 * Select only the latest desired task per replica slot. Historical rejected
 * tasks are deployment history, not a reason to mark a recovered service down.
 */
export function selectCurrentSwarmTasks(tasks: SwarmTaskState[]): SwarmTaskState[] {
  const bySlot = new Map<string, SwarmTaskState>();
  for (const task of tasks) {
    const key = task.slot === null ? task.id : String(task.slot);
    const previous = bySlot.get(key);
    if (!previous || taskTime(task) > taskTime(previous)) bySlot.set(key, task);
  }
  return Array.from(bySlot.values()).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}

export function deriveSwarmServiceHealth(
  service: SwarmServiceState,
  tasks: SwarmTaskState[],
  options: { eligibleNodeCount?: number } = {},
): SwarmServiceHealth {
  const currentTasks = selectCurrentSwarmTasks(tasks.filter((task) => task.serviceId === service.id));
  const counts = { running: 0, pending: 0, failed: 0, completed: 0 };
  const diagnostics: string[] = [];
  for (const task of currentTasks) {
    switch (currentState(task.currentState)) {
      case "running": counts.running++; break;
      case "pending": counts.pending++; break;
      case "failed":
        counts.failed++;
        if (task.error) diagnostics.push(task.error);
        else diagnostics.push(`${task.serviceName}.${task.slot ?? "?"}: ${task.currentState}`);
        break;
      case "complete": counts.completed++; break;
    }
  }

  const desired = service.mode === "global"
    ? options.eligibleNodeCount ?? null
    : service.desiredReplicas;
  const updateState = service.updateState?.toLowerCase();
  let state: SwarmServiceHealth["state"];
  if (desired === 0) state = "scaled-to-zero";
  else if (updateState === "paused") state = "paused";
  else if (updateState === "updating" || counts.pending > 0) state = "updating";
  else if (counts.failed > 0 && counts.running === 0) state = "failed";
  else if (counts.failed > 0 || (desired !== null && counts.running < desired)) state = "degraded";
  else if (desired !== null && counts.running >= desired) state = "converged";
  else state = "unknown";

  return {
    serviceId: service.id,
    state,
    desired,
    ...counts,
    currentTasks,
    diagnostics: diagnostics.slice(0, 10),
  };
}

export function deriveSwarmStackHealth(input: {
  stackName: string;
  services: SwarmServiceState[];
  tasks: SwarmTaskState[];
  /** Discovery transport failures represent reachability, not scheduler failure. */
  unreachable?: boolean;
  eligibleNodeCount?: number;
}): SwarmStackHealth {
  if (input.unreachable) {
    return { stackName: input.stackName, state: "unreachable", services: [], diagnostics: ["Manager unreachable."] };
  }
  const services = input.services
    .filter((service) => service.stackName === input.stackName)
    .map((service) => deriveSwarmServiceHealth(service, input.tasks, { eligibleNodeCount: input.eligibleNodeCount }));
  if (services.length === 0) return { stackName: input.stackName, state: "empty", services, diagnostics: [] };

  const diagnostics = services.flatMap((service) => service.diagnostics).slice(0, 20);
  const states = new Set(services.map((service) => service.state));
  const state = states.has("failed")
    ? "failed"
    : states.has("degraded") || states.has("paused")
      ? "partial_failure"
      : states.has("updating")
        ? "deploying"
        : states.has("unknown")
          ? "reconciling"
          : "ready";
  return { stackName: input.stackName, state, services, diagnostics };
}
