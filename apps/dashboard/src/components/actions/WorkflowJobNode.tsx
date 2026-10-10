"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Icon } from "@repo/ui/icons";
import type { TopologyNodeProps } from "@/components/topology/TopologyCanvas";
import type { TopologyNodeLayout } from "@/components/topology/model";

export const WORKFLOW_NODE_LAYOUT: TopologyNodeLayout = {
  width: 240,
  height: 64,
  gapX: 72,
  gapY: 40,
};

/** Compact job rows use the shared canvas, selection and dependency controls. */
export const WorkflowJobNode = memo(function WorkflowJobNode({ data }: TopologyNodeProps) {
  const { resource, action } = data;
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
      className={`relative flex items-center gap-2.5 rounded-lg border px-3 text-start transition-colors ${action?.selected ? "border-info/50 ring-2 ring-info/10" : "border-border/80 hover:border-foreground/30"}`}
      style={{
        width: WORKFLOW_NODE_LAYOUT.width,
        height: WORKFLOW_NODE_LAYOUT.height,
        background: "var(--th-card-on-page)",
      }}
      data-workflow-state={resource.state}
      aria-label={`${resource.name}${action?.statusLabel ? `, ${action.statusLabel}` : ""}`}
    >
      <Handle
        className="topology-port"
        type="target"
        position={Position.Left}
        isConnectable={!!action?.connectable}
      />
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
      {!action?.readOnly && (
        <Icon
          name="chevron-right"
          className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
        />
      )}
      <Handle
        className="topology-port"
        type="source"
        position={Position.Right}
        isConnectable={!!action?.connectable}
      />
    </article>
  );
});
