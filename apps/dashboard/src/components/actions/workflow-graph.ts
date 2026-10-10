import type { ActionJobView, ActionPlanView, ActionRunView } from "@repo/contracts";
import type {
  ProjectTopologyGraph,
  TopologyState,
  TopologyNodeLayout,
  TopologyResource,
} from "@/components/topology/model";
import { workflowStepTitle, type workflowJobs } from "./workflow-editor";
import { workflowEventConfig as object } from "./workflow-yaml";

export const WORKFLOW_NODE_LAYOUT: TopologyNodeLayout = {
  width: 240,
  height: 64,
  gapX: 72,
  gapY: 40,
};
export const WORKFLOW_STEP_LAYOUT = {
  width: 188,
  height: 64,
  gapX: 44,
  gapY: 36,
  padding: 20,
  top: 88,
};
export const workflowStepNodeId = (jobId: string, index: number) => `${jobId}:step:${index}`;

export function workflowJobTargetLabel(
  job: Pick<ActionPlanView["jobs"][number], "runsOn" | "uses">,
  reusableLabel: string,
) {
  if (job.uses) return reusableLabel;
  return typeof job.runsOn === "string"
    ? job.runsOn
    : Array.isArray(job.runsOn)
      ? job.runsOn.join(" · ")
      : "runs-on";
}

export function workflowJobSize(count: number) {
  if (!count) return { width: WORKFLOW_NODE_LAYOUT.width, height: WORKFLOW_NODE_LAYOUT.height };
  const columns = Math.min(2, count);
  const rows = Math.ceil(count / columns);
  return {
    width: Math.max(
      WORKFLOW_NODE_LAYOUT.width,
      columns * WORKFLOW_STEP_LAYOUT.width +
        (columns - 1) * WORKFLOW_STEP_LAYOUT.gapX +
        2 * WORKFLOW_STEP_LAYOUT.padding,
    ),
    height:
      WORKFLOW_STEP_LAYOUT.top +
      rows * WORKFLOW_STEP_LAYOUT.height +
      (rows - 1) * WORKFLOW_STEP_LAYOUT.gapY +
      WORKFLOW_STEP_LAYOUT.padding,
  };
}

export function workflowStepPosition(count: number, index: number) {
  const columns = Math.max(1, Math.min(2, count));
  const { width } = workflowJobSize(count);
  const row = Math.floor(index / columns);
  const column = row % 2 ? columns - 1 - (index % columns) : index % columns;
  return {
    x:
      (width - columns * WORKFLOW_STEP_LAYOUT.width - (columns - 1) * WORKFLOW_STEP_LAYOUT.gapX) /
        2 +
      column * (WORKFLOW_STEP_LAYOUT.width + WORKFLOW_STEP_LAYOUT.gapX),
    y: WORKFLOW_STEP_LAYOUT.top + row * (WORKFLOW_STEP_LAYOUT.height + WORKFLOW_STEP_LAYOUT.gapY),
  };
}

/** Step order is projected from YAML; only job-to-job dependencies are editable edges. */
export function workflowDetailGraph(
  graph: ProjectTopologyGraph,
  jobs: ReturnType<typeof workflowJobs>,
  expanded: readonly string[],
  fallback: string,
): ProjectTopologyGraph {
  const definitions = new Map(jobs.map((job) => [job.id, job.value]));
  const children: TopologyResource[] = [];
  const edges = [...graph.edges];
  const nodes = graph.nodes.map((node) => {
    const value = definitions.get(node.id)?.steps;
    const steps = Array.isArray(value) ? value : [];
    if (!expanded.includes(node.id) || !steps.length) return node;
    const size = workflowJobSize(steps.length);
    steps.forEach((raw, index) => {
      const id = workflowStepNodeId(node.id, index);
      const position = workflowStepPosition(steps.length, index);
      children.push({
        id,
        parentId: node.id,
        kind: "workflow-step",
        projectId: node.projectId,
        name: workflowStepTitle(raw, fallback),
        description: "",
        tone: "service",
        state: "configured",
        layoutPosition: position,
        layoutWidth: WORKFLOW_STEP_LAYOUT.width,
        layoutHeight: WORKFLOW_STEP_LAYOUT.height,
        workflowStep: {
          jobId: node.id,
          index,
          kind: Object.hasOwn(object(raw), "uses") ? "action" : "command",
        },
      });
      const previous = index ? workflowStepPosition(steps.length, index - 1) : null;
      const direction =
        previous && previous.y === position.y
          ? previous.x < position.x
            ? "right"
            : "left"
          : "bottom";
      const target = direction === "right" ? "left" : direction === "left" ? "right" : "top";
      edges.push({
        id: `${node.id}:step-order:${index}`,
        source: index ? workflowStepNodeId(node.id, index - 1) : node.id,
        target: id,
        sourceHandle: index ? `${direction}-out` : "steps",
        targetHandle: `${target}-in`,
        kind: "sequence",
        readOnly: true,
        label: "",
        description: `${node.name} · ${index + 1}`,
      });
    });
    return { ...node, layoutWidth: size.width, layoutHeight: size.height };
  });
  return { nodes: [...nodes, ...children], edges };
}

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
  reusableLabel = "Reusable workflow",
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
    const labels = jobs[0]?.labels.join(" · ") || workflowJobTargetLabel(definition, reusableLabel);
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
