"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { ActionPlanView, ActionRunView } from "@repo/contracts";
import type { TopologyNodeAction, TopologySelection } from "@/components/topology/TopologyCanvas";
import { useI18n } from "@/components/i18n-provider";
import "@/components/topology/topology.css";
import { workflowGraph, workflowGroupStatus } from "./workflow-graph";

const Canvas = dynamic(
  () => import("@/components/topology/TopologyCanvas").then((module) => module.TopologyCanvas),
  { ssr: false },
);
export function WorkflowGraph({
  plan,
  run,
  selected,
  onSelect,
}: {
  plan: ActionPlanView;
  run?: ActionRunView;
  selected?: string | null;
  onSelect?: (id: string) => void;
}) {
  const { t } = useI18n();
  const graph = useMemo(
    () => workflowGraph(plan, run, t.actions.matrix),
    [plan, run, t.actions.matrix],
  );
  const actions = useMemo(
    () =>
      Object.fromEntries(
        graph.nodes.map((node) => {
          const jobs = run?.jobs.filter((job) => job.jobKey === node.id) ?? [];
          const status = workflowGroupStatus(jobs);
          return [
            node.id,
            {
              kind: "open",
              label: t.actions.openJob,
              ariaLabel: `${t.actions.openJob}: ${node.name}`,
              selected: run?.jobs.find((job) => job.id === selected)?.jobKey === node.id,
              readOnly: !jobs.length || !onSelect,
              statusLabel: status
                ? t.actions.status[status as keyof typeof t.actions.status]
                : run
                  ? t.actions.waitingDependency
                  : t.actions.sourceHint,
            } satisfies TopologyNodeAction,
          ];
        }),
      ),
    [graph, run, selected, onSelect, t.actions],
  );
  const open = (id: string) => {
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
  };
  const selectedNode = run?.jobs.find((job) => job.id === selected)?.jobKey;
  return (
    <div
      className="h-[380px] min-w-0 overflow-hidden rounded-2xl bg-card sm:h-[440px]"
      data-testid="workflow-graph"
    >
      <Canvas
        layoutKey={null}
        graph={graph}
        selection={selectedNode ? { kind: "node", id: selectedNode } : null}
        fullscreen={false}
        inert={false}
        onSelect={select}
        onOpen={open}
        nodeActions={actions}
        ariaLabel={t.actions.graph}
      />
    </div>
  );
}
