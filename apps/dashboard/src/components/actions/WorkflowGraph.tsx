"use client";

import { useMemo } from "react";
import { Icon } from "@repo/ui/icons";
import dynamic from "next/dynamic";
import type { ActionPlanView, ActionRunView } from "@repo/contracts";
import type { Connection } from "@xyflow/react";
import type { TopologyNodeAction, TopologySelection } from "@/components/topology/TopologyCanvas";
import { useI18n } from "@/components/i18n-provider";
import {
  workflowGraph,
  workflowDetailGraph,
  workflowGroupStatus,
  workflowStepNodeId,
  WORKFLOW_NODE_LAYOUT,
} from "./workflow-graph";
import { WorkflowJobNode, WorkflowNodeDetails } from "./WorkflowJobNode";
import type { workflowJobs } from "./workflow-editor";
import type { WorkflowStepTarget } from "./WorkflowSteps";

const Canvas = dynamic(
  () => import("@/components/topology/TopologyCanvas").then((module) => module.TopologyCanvas),
  { ssr: false, loading: CanvasLoading },
);
function CanvasLoading() {
  const { t } = useI18n();
  return (
    <div
      className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <Icon name="spinner" className="size-4 animate-spin" />
      {t.actions.integration.loading}
    </div>
  );
}
export function WorkflowGraph({
  plan,
  run,
  selected,
  onSelect,
  editor,
  jobDetails,
  className,
}: {
  plan: ActionPlanView;
  run?: ActionRunView;
  selected?: string | null;
  onSelect?: (id: string) => void;
  editor?: {
    selection: TopologySelection;
    onSelect: (selection: TopologySelection) => void;
    onConnect: (connection: Connection) => void;
  };
  jobDetails?: {
    jobs: ReturnType<typeof workflowJobs>;
    expandedJobs: string[];
    onToggleJob: (id: string) => void;
    onSelectStep: (jobId: string, index: number) => void;
    selectedStep: WorkflowStepTarget | null;
  };
  className?: string;
}) {
  const { t } = useI18n();
  const details = useMemo(
    () =>
      jobDetails
        ? {
            ...jobDetails,
            steps: new Map(
              jobDetails.jobs.map((job) => [
                job.id,
                Array.isArray(job.value.steps) ? job.value.steps : [],
              ]),
            ),
          }
        : null,
    [jobDetails],
  );
  const graph = useMemo(() => {
    const graph = workflowGraph(plan, run, t.actions.matrix, t.actions.controller.reusable);
    return jobDetails
      ? workflowDetailGraph(
          graph,
          jobDetails.jobs,
          jobDetails.expandedJobs,
          t.actions.editor.command,
        )
      : graph;
  }, [
    plan,
    run,
    t.actions.matrix,
    t.actions.controller.reusable,
    t.actions.editor.command,
    jobDetails,
  ]);
  const selectedNode = run?.jobs.find((job) => job.id === selected)?.jobKey;
  const step = jobDetails?.selectedStep;
  const selectedStepId = step && workflowStepNodeId(step.jobId, step.index);
  const selection: TopologySelection = editor
    ? editor.selection?.kind === "node" &&
      step?.jobId === editor.selection.id &&
      graph.nodes.some((node) => node.id === selectedStepId)
      ? { kind: "node", id: selectedStepId! }
      : editor.selection
    : selectedNode
      ? { kind: "node", id: selectedNode }
      : null;
  const actions = useMemo(
    () =>
      Object.fromEntries(
        graph.nodes.map((node) => {
          const jobs = run?.jobs.filter((job) => job.jobKey === node.id) ?? [];
          const status = workflowGroupStatus(jobs);
          const label = node.workflowStep
            ? t.actions.editor.editStep
            : editor
              ? t.actions.editor.editJob
              : t.actions.openJob;
          return [
            node.id,
            {
              kind: "open",
              label,
              ariaLabel: `${label}: ${node.name}`,
              selected: selection?.kind === "node" && selection.id === node.id,
              readOnly: !editor && (!jobs.length || !onSelect),
              connectable: !!editor && !node.workflowStep,
              statusLabel: status
                ? t.actions.status[status as keyof typeof t.actions.status]
                : run
                  ? t.actions.waitingDependency
                  : undefined,
            } satisfies TopologyNodeAction,
          ];
        }),
      ),
    [graph, run, selection?.kind, selection?.id, onSelect, editor, t.actions],
  );
  const open = (id: string) => {
    const step = graph.nodes.find((node) => node.id === id)?.workflowStep;
    if (step && jobDetails) {
      jobDetails.onSelectStep(step.jobId, step.index);
      return;
    }
    if (editor) {
      editor.onSelect({ kind: "node", id });
      return;
    }
    const jobs = run?.jobs.filter((job) => job.jobKey === id) ?? [];
    const job =
      jobs.find((job) => job.id === selected) ??
      jobs.find((job) => job.status === "running") ??
      jobs.find((job) => job.status === "failure") ??
      jobs[0];
    if (job) onSelect?.(job.id);
  };
  const select = (selection: TopologySelection) => {
    if (selection?.kind === "node") open(selection.id);
    else editor?.onSelect(selection);
  };
  return (
    <div
      className={className ?? "h-[380px] min-w-0 overflow-hidden rounded-2xl bg-card sm:h-[440px]"}
      data-testid="workflow-graph"
    >
      <WorkflowNodeDetails.Provider value={details}>
        <Canvas
          layoutKey={null}
          graph={graph}
          selection={selection}
          fullscreen={false}
          inert={false}
          onSelect={select}
          onOpen={open}
          onConnect={editor?.onConnect}
          nodeActions={actions}
          nodeComponent={WorkflowJobNode}
          nodeLayout={WORKFLOW_NODE_LAYOUT}
          ariaLabel={t.actions.graph}
        />
      </WorkflowNodeDetails.Provider>
    </div>
  );
}
