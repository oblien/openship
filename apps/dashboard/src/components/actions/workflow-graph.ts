import type { ActionJobView, ActionPlanView, ActionRunView } from "@repo/contracts";
import type { ProjectTopologyGraph, TopologyState } from "@/components/topology/model";

const states: Record<string, TopologyState> = {
  queued: "pending",
  waiting: "pending",
  running: "running",
  cancelling: "starting",
  success: "succeeded",
  failure: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
  timed_out: "failed",
  provisioning: "starting",
};

export function workflowGroupStatus(jobs: ActionJobView[]): string | undefined {
  if (!jobs.length) return undefined;
  const running = jobs.find((job) => job.status === "running" || job.status === "cancelling");
  if (running) return running.phase === "provisioning" ? "provisioning" : running.status;
  if (jobs.some((job) => job.status === "queued" || job.status === "waiting")) return "queued";
  for (const status of ["failure", "timed_out", "cancelled", "success", "skipped"])
    if (jobs.some((job) => job.status === status)) return status;
}

/** One node per workflow job. Matrix executions stay inspectable in the job
 * list, without rendering a quadratic number of dependency edges. */
export function workflowGraph(
  plan: ActionPlanView,
  run?: ActionRunView,
  matrixLabel = "Matrix",
): ProjectTopologyGraph {
  const definitions = new Map(plan.jobs.map((job) => [job.id, job]));
  const depths = new Map<string, number>();
  const depth = (id: string): number => {
    if (depths.has(id)) return depths.get(id)!;
    depths.set(id, 0);
    const dependencies = definitions.get(id)?.needs ?? [];
    const value = dependencies.length ? Math.max(...dependencies.map(depth)) + 1 : 0;
    depths.set(id, value);
    return value;
  };
  const nodes = plan.jobs.map((definition) => {
    const jobs = run?.jobs.filter((job) => job.jobKey === definition.id) ?? [];
    const status = workflowGroupStatus(jobs);
    const labels =
      jobs[0]?.labels.join(" · ") ||
      (typeof definition.runsOn === "string"
        ? definition.runsOn
        : Array.isArray(definition.runsOn)
          ? definition.runsOn.join(" · ")
          : "runs-on");
    return {
      id: definition.id,
      kind: "workflow-job" as const,
      name: definition.name,
      description: jobs.length > 1 ? `${matrixLabel} × ${jobs.length} · ${labels}` : labels,
      state: status ? states[status] : ("configured" as const),
      tone: "service" as const,
      projectId: run?.id ?? "workflow",
      layoutColumn: depth(definition.id),
    };
  });
  const edges = plan.jobs.flatMap((job) =>
    job.needs.map((source) => ({
      id: `${source}:${job.id}`,
      source,
      target: job.id,
      kind: "dependency" as const,
      label: "",
      description: `${source} → ${job.id}`,
    })),
  );
  return { nodes, edges };
}
