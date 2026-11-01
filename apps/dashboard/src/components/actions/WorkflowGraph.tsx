"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import dynamic from "next/dynamic";
import type { ActionPlanView, ActionRunView } from "@repo/contracts";
import type { ActionStatus } from "@repo/core";
import type { Connection } from "@xyflow/react";
import type { TopologyNodeAction, TopologySelection } from "@/components/topology/TopologyCanvas";
import { useI18n } from "@/components/i18n-provider";
import { TopologySkeleton } from "@/components/topology/TopologySkeleton";
import {
  workflowGraph,
  workflowDetailGraph,
  workflowGroupStatus,
  workflowStepNodeId,
  WORKFLOW_NODE_LAYOUT,
  workflowVisibleJob,
  type WorkflowGraphJob,
} from "./workflow-graph";
import { WorkflowJobNode, WorkflowNodeDetails } from "./WorkflowJobNode";
import type { WorkflowStepTarget } from "./WorkflowSteps";

const Canvas = dynamic(
  () => import("@/components/topology/TopologyCanvas").then((module) => module.TopologyCanvas),
  { ssr: false, loading: CanvasLoading },
);
function CanvasLoading() {
  return <TopologySkeleton variant="workflow" />;
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
    jobs: readonly WorkflowGraphJob[];
    expandedJobs: string[];
    onToggleJob: (id: string) => void;
    onSelectStep: (jobId: string, index: number) => void;
    selectedStep: Pick<WorkflowStepTarget, "jobId" | "index"> | null;
    stepStatuses?: Readonly<Record<string, ActionStatus>>;
  };
  className?: string;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 900, height: 640 });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width && height)
        setViewport((current) =>
          current.width === width && current.height === height ? current : { width, height },
        );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
    return workflowDetailGraph(
      graph,
      jobDetails?.jobs ?? [],
      jobDetails?.expandedJobs ?? [],
      t.actions.editor.command,
      viewport,
      jobDetails?.stepStatuses,
    );
  }, [
    plan,
    run,
    t.actions.matrix,
    t.actions.controller.reusable,
    t.actions.editor.command,
    jobDetails,
    viewport,
  ]);
  const selectedNode = run?.jobs.find((job) => job.id === selected)?.jobKey;
  const step = jobDetails?.selectedStep;
  const selectedStepId = step && workflowStepNodeId(step.jobId, step.index);
  const jobSelection: TopologySelection = editor
    ? editor.selection
    : selectedNode
      ? { kind: "node", id: selectedNode }
      : null;
  const selection: TopologySelection =
    jobSelection?.kind === "node" &&
    step?.jobId === jobSelection.id &&
    graph.nodes.some((node) => node.id === selectedStepId)
      ? { kind: "node", id: selectedStepId! }
      : jobSelection;
  const actions = useMemo(
    () =>
      Object.fromEntries(
        graph.nodes.map((node) => {
          const jobs = run?.jobs.filter((job) => job.jobKey === node.id) ?? [];
          const status = node.workflowStep
            ? jobDetails?.stepStatuses?.[node.id]
            : workflowGroupStatus(jobs);
          const label = node.workflowStep
            ? editor
              ? t.actions.editor.editStep
              : t.actions.runView.stepLogs
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
              readOnly: !editor && (node.workflowStep ? !jobDetails : !jobs.length || !onSelect),
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
    [graph, run, selection?.kind, selection?.id, onSelect, editor, jobDetails, t.actions],
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
    const job = workflowVisibleJob(run?.jobs ?? [], id, selected);
    if (job) onSelect?.(job.id);
  };
  const select = (selection: TopologySelection) => {
    if (selection?.kind === "node") open(selection.id);
    else editor?.onSelect(selection);
  };
  return (
    <div
      ref={container}
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
          arrangeLabel={t.actions.editor.arrange}
        />
      </WorkflowNodeDetails.Provider>
    </div>
  );
}
