import type { ActionJobView, ActionPlanView, ActionRunView } from "@repo/contracts";
import type {
  ProjectTopologyGraph,
  TopologyState,
  TopologyNodeLayout,
  TopologyResource,
} from "@/components/topology/model";
import { topologyPositions } from "@/components/topology/model";
import { workflowStepTitle, type workflowJobs } from "./workflow-editor";
import { workflowEventConfig as object } from "./workflow-yaml";

export const WORKFLOW_NODE_LAYOUT: TopologyNodeLayout = {
  width: 240,
  height: 64,
  gapX: 72,
  gapY: 40,
  align: "start",
};
export const WORKFLOW_STEP_LAYOUT = {
  width: 240,
  height: 64,
  gapX: 44,
  gapY: 36,
  top: 112,
};
type WorkflowViewport = { width: number; height: number };
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

function workflowJobSize(count: number, columns: number) {
  if (!count) return { width: WORKFLOW_NODE_LAYOUT.width, height: WORKFLOW_NODE_LAYOUT.height };
  columns = Math.min(columns, count);
  const rows = Math.ceil(count / columns);
  return {
    width: Math.max(
      WORKFLOW_NODE_LAYOUT.width,
      columns * WORKFLOW_STEP_LAYOUT.width + (columns - 1) * WORKFLOW_STEP_LAYOUT.gapX,
    ),
    height:
      WORKFLOW_STEP_LAYOUT.top +
      rows * WORKFLOW_STEP_LAYOUT.height +
      (rows - 1) * WORKFLOW_STEP_LAYOUT.gapY,
  };
}

function workflowStepPosition(count: number, index: number, columns: number) {
  columns = Math.max(1, Math.min(columns, count));
  const row = Math.floor(index / columns);
  const column = row % 2 ? columns - 1 - (index % columns) : index % columns;
  return {
    x: column * (WORKFLOW_STEP_LAYOUT.width + WORKFLOW_STEP_LAYOUT.gapX),
    y: WORKFLOW_STEP_LAYOUT.top + row * (WORKFLOW_STEP_LAYOUT.height + WORKFLOW_STEP_LAYOUT.gapY),
  };
}

/** Compare complete workflow footprints, so parallel jobs and dependencies
 * share the available space instead of forcing every job into two columns. */
function workflowPlacement(
  graph: ProjectTopologyGraph,
  counts: ReadonlyMap<string, number>,
  viewport: WorkflowViewport,
) {
  const width = Math.max(WORKFLOW_NODE_LAYOUT.width, viewport.width - 64);
  const height = Math.max(WORKFLOW_NODE_LAYOUT.height, viewport.height - 96);
  const largest = Math.max(0, ...counts.values());
  const candidates = Math.max(1, Math.min(largest, Math.ceil(Math.sqrt(largest) * 2)));
  let best:
    | {
        columns: number;
        positions: ReturnType<typeof topologyPositions>;
        zoom: number;
        shape: number;
      }
    | undefined;
  for (let columns = 1; columns <= candidates; columns++) {
    const footprints = graph.nodes.map((node) => {
      const size = workflowJobSize(counts.get(node.id) ?? 0, columns);
      return { ...node, layoutWidth: size.width, layoutHeight: size.height };
    });
    const positions = topologyPositions({ ...graph, nodes: footprints }, WORKFLOW_NODE_LAYOUT);
    const left = Math.min(0, ...footprints.map((node) => positions[node.id].x));
    const top = Math.min(0, ...footprints.map((node) => positions[node.id].y));
    const right = Math.max(0, ...footprints.map((node) => positions[node.id].x + node.layoutWidth));
    const bottom = Math.max(
      0,
      ...footprints.map((node) => positions[node.id].y + node.layoutHeight),
    );
    const graphWidth = Math.max(1, right - left);
    const graphHeight = Math.max(1, bottom - top);
    const zoom = Math.min(1, width / graphWidth, height / graphHeight);
    const shape = Math.abs(Math.log(graphWidth / graphHeight / (width / height)));
    if (!best || zoom > best.zoom || (zoom === best.zoom && shape < best.shape))
      best = { columns, positions, zoom, shape };
  }
  return best!;
}

/** Step order is projected from YAML; only job-to-job dependencies are editable edges. */
export function workflowDetailGraph(
  graph: ProjectTopologyGraph,
  jobs: ReturnType<typeof workflowJobs>,
  expanded: readonly string[],
  fallback: string,
  viewport: WorkflowViewport = { width: 900, height: 640 },
): ProjectTopologyGraph {
  const definitions = new Map(jobs.map((job) => [job.id, job.value]));
  const counts = new Map(
    graph.nodes.map((node) => {
      const steps = definitions.get(node.id)?.steps;
      return [node.id, expanded.includes(node.id) && Array.isArray(steps) ? steps.length : 0];
    }),
  );
  const { columns, positions } = workflowPlacement(graph, counts, viewport);
  const stepNodes: TopologyResource[] = [];
  const edges = [...graph.edges];
  const nodes = graph.nodes.map((node) => {
    const value = definitions.get(node.id)?.steps;
    const steps = Array.isArray(value) ? value : [];
    const positioned = { ...node, layoutPosition: positions[node.id] };
    if (!counts.get(node.id)) return positioned;
    steps.forEach((raw, index) => {
      const id = workflowStepNodeId(node.id, index);
      const position = workflowStepPosition(steps.length, index, columns);
      stepNodes.push({
        id,
        kind: "workflow-step",
        projectId: node.projectId,
        name: workflowStepTitle(raw, fallback),
        description: "",
        tone: "service",
        state: "configured",
        layoutPosition: {
          x: positions[node.id].x + position.x,
          y: positions[node.id].y + position.y,
        },
        layoutWidth: WORKFLOW_STEP_LAYOUT.width,
        layoutHeight: WORKFLOW_STEP_LAYOUT.height,
        workflowStep: {
          jobId: node.id,
          index,
          kind: Object.hasOwn(object(raw), "uses") ? "action" : "command",
        },
      });
      const previous = index ? workflowStepPosition(steps.length, index - 1, columns) : null;
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
    return positioned;
  });
  return { nodes: [...nodes, ...stepNodes], edges };
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
      targetGutter: WORKFLOW_NODE_LAYOUT.gapX / 2,
      label: "",
      description: `${source} → ${job.id}`,
    })),
  );
  return { nodes, edges };
}
