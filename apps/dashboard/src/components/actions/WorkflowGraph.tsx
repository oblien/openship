"use client";

import { useMemo } from "react";
import { Icon } from "@repo/ui/icons";
import dynamic from "next/dynamic";
import type { ActionPlanView, ActionRunView } from "@repo/contracts";
import type { Connection } from "@xyflow/react";
import type { TopologyNodeAction, TopologySelection } from "@/components/topology/TopologyCanvas";
import { useI18n } from "@/components/i18n-provider";
import { workflowGraph, workflowGroupStatus } from "./workflow-graph";

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
  className?: string;
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
              label: editor ? t.actions.editor.editJob : t.actions.openJob,
              ariaLabel: `${editor ? t.actions.editor.editJob : t.actions.openJob}: ${node.name}`,
              selected: editor
                ? editor.selection?.kind === "node" && editor.selection.id === node.id
                : run?.jobs.find((job) => job.id === selected)?.jobKey === node.id,
              readOnly: !editor && (!jobs.length || !onSelect),
              connectable: !!editor,
              statusLabel: status
                ? t.actions.status[status as keyof typeof t.actions.status]
                : run
                  ? t.actions.waitingDependency
                  : undefined,
            } satisfies TopologyNodeAction,
          ];
        }),
      ),
    [graph, run, selected, onSelect, editor, t.actions],
  );
  const open = (id: string) => {
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
  };
  const selectedNode = run?.jobs.find((job) => job.id === selected)?.jobKey;
  return (
    <div
      className={className ?? "h-[380px] min-w-0 overflow-hidden rounded-2xl bg-card sm:h-[440px]"}
      data-testid="workflow-graph"
    >
      <Canvas
        layoutKey={null}
        graph={graph}
        selection={editor?.selection ?? (selectedNode ? { kind: "node", id: selectedNode } : null)}
        fullscreen={false}
        inert={false}
        onSelect={editor?.onSelect ?? select}
        onOpen={open}
        onConnect={editor?.onConnect}
        nodeActions={actions}
        ariaLabel={t.actions.graph}
      />
    </div>
  );
}
