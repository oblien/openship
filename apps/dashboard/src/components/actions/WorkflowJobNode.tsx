"use client";

import { createContext, memo, useContext } from "react";
import { Handle, Position } from "@xyflow/react";
import { Icon } from "@repo/ui/icons";
import type { TopologyNodeProps } from "@/components/topology/TopologyCanvas";
import { useI18n } from "@/components/i18n-provider";
import { WORKFLOW_NODE_LAYOUT, WORKFLOW_STEP_LAYOUT } from "./workflow-graph";

export const WorkflowNodeDetails = createContext<{
  steps: ReadonlyMap<string, unknown[]>;
  expandedJobs: string[];
  onToggleJob: (id: string) => void;
} | null>(null);

/** Jobs and steps are separate cards on the same canvas. */
export const WorkflowJobNode = memo(function WorkflowJobNode(props: TopologyNodeProps) {
  return props.data.resource.workflowStep ? (
    <WorkflowStepNode {...props} />
  ) : (
    <JobNode {...props} />
  );
});

function JobNode({ data }: TopologyNodeProps) {
  const { resource, action } = data;
  const { t } = useI18n();
  const e = t.actions.editor;
  const details = useContext(WorkflowNodeDetails);
  const steps = details?.steps.get(resource.id) ?? [];
  const expanded = !!steps.length && !!details?.expandedJobs.includes(resource.id);
  const active = ["running", "starting", "restarting"].includes(resource.state);
  const success = resource.state === "succeeded";
  const failed = resource.state === "failed";
  const tone = success
    ? "text-success"
    : failed
      ? "text-danger"
      : active
        ? "text-info"
        : resource.state === "configured"
          ? "text-info/80"
          : "text-muted-foreground";
  return (
    <article
      className={`relative rounded-lg border text-start transition-colors ${action?.selected ? "border-info/50 ring-2 ring-info/10" : "border-border/80 hover:border-foreground/30"}`}
      style={{
        width: resource.layoutWidth ?? WORKFLOW_NODE_LAYOUT.width,
        height: resource.layoutHeight ?? WORKFLOW_NODE_LAYOUT.height,
        background: "var(--th-card-on-page)",
      }}
      data-workflow-state={resource.state}
      data-picked={action?.selected || undefined}
      aria-label={`${resource.name}${action?.statusLabel ? `, ${action.statusLabel}` : ""}`}
    >
      <Handle
        className="topology-port"
        type="target"
        position={Position.Left}
        style={{ top: WORKFLOW_NODE_LAYOUT.height / 2 }}
        isConnectable={!!action?.connectable}
      />
      <div className="flex h-full items-center gap-2.5 rounded-lg px-3">
        <span className={`flex shrink-0 ${tone}`} title={action?.statusLabel}>
          <Icon
            name={
              active
                ? "spinner"
                : success
                  ? "check-circle"
                  : failed
                    ? "x-circle"
                    : resource.state === "configured"
                      ? "play-circle"
                      : "circle"
            }
            className={`size-5 ${active ? "motion-safe:animate-spin" : ""}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-medium text-foreground" title={resource.name}>
            {resource.name}
          </h3>
          <p
            className="mt-0.5 truncate text-[11px] text-muted-foreground"
            title={resource.description}
          >
            {resource.description}
          </p>
        </div>
        {details && steps.length ? (
          <button
            type="button"
            className="nodrag nopan flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`${expanded ? e.collapseJob : e.expandJob}: ${resource.name}`}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              details.onToggleJob(resource.id);
            }}
          >
            {steps.length}
            <Icon name="chevron-down" className={`size-3.5 ${expanded ? "rotate-180" : ""}`} />
          </button>
        ) : (
          !action?.readOnly && (
            <Icon
              name="chevron-right"
              className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
            />
          )
        )}
      </div>
      <Handle
        className="topology-port"
        type="source"
        position={Position.Right}
        style={{ top: WORKFLOW_NODE_LAYOUT.height / 2 }}
        isConnectable={!!action?.connectable}
      />
      {/* React Flow measures handles with the node. Expansion keeps its size
          unchanged, so this anchor must also exist while steps are collapsed. */}
      <Handle
        id="steps"
        type="source"
        position={Position.Bottom}
        className="!pointer-events-none !size-1 !border-0 !opacity-0"
        isConnectable={false}
      />
    </article>
  );
}

function WorkflowStepNode({ data }: TopologyNodeProps) {
  const { resource, action } = data;
  const step = resource.workflowStep!;
  const { t } = useI18n();
  const type = step.kind === "action" ? t.actions.editor.action : t.actions.editor.command;
  return (
    <article
      className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 text-start transition-colors ${action?.selected ? "border-info/50 ring-2 ring-info/10" : "border-border/80 hover:border-info/40"}`}
      style={{
        width: WORKFLOW_STEP_LAYOUT.width,
        height: WORKFLOW_STEP_LAYOUT.height,
        background: "var(--th-card-on-page)",
      }}
      data-workflow-step={`${step.jobId}:${step.index}`}
      data-picked={action?.selected || undefined}
      aria-label={`${t.actions.editor.editStep}: ${resource.name}`}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-info/10 text-info/80">
        <Icon name={step.kind === "action" ? "bolt" : "terminal"} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground" title={resource.name}>
          {resource.name}
        </p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{type}</p>
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">{step.index + 1}</span>
      {Object.entries({
        top: Position.Top,
        right: Position.Right,
        bottom: Position.Bottom,
        left: Position.Left,
      }).flatMap(([side, position]) =>
        (["source", "target"] as const).map((type) => (
          <Handle
            key={`${side}-${type}`}
            id={`${side}-${type === "source" ? "out" : "in"}`}
            type={type}
            position={position}
            className="!pointer-events-none !size-1 !border-0 !opacity-0"
            isConnectable={false}
          />
        )),
      )}
    </article>
  );
}
