"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ResourceIcon } from "./ResourceIcon";
import { REGIONS, type DatabaseKind } from "./topology";
import type { ClusterMember } from "./clusterTopology";

export type ClusterFlowNode = Node<
  {
    member: ClusterMember;
    kind: DatabaseKind;
    connected: boolean;
    slots: { start: number; end: number } | null;
  },
  "clusterMember"
>;

export const ClusterNode = memo(function ClusterNode({
  data: { member, kind, connected, slots },
  selected,
  isConnectable,
}: NodeProps<ClusterFlowNode>) {
  const primary = member.role === "primary";
  return (
    <div
      className="scale-resource-tone scale-resource-node w-[224px] rounded-2xl border p-4 text-start"
      data-kind={kind}
      data-selected={selected}
    >
      {!primary && (
        <Handle type="target" position={Position.Left} id="in" isConnectable={isConnectable} />
      )}
      <div className="flex items-center gap-2.5">
        <div className="scale-resource-icon flex size-8 shrink-0 items-center justify-center rounded-lg">
          <ResourceIcon kind={kind} className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground" title={member.name}>
            {member.name}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {primary ? "Primary · Read / write" : "Replica · Read only"}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <UiIcon name="git-branch" className="size-3 shrink-0" />
        {slots ? (
          <span className="tabular-nums">
            Slots {slots.start}–{slots.end}
          </span>
        ) : (
          <span>
            {primary
              ? "Replication source"
              : connected
                ? "Streaming replication"
                : "No replication source"}
          </span>
        )}
      </div>
      <div className="mt-3 flex items-center gap-1.5 border-t border-border/50 pt-3 text-xs text-muted-foreground/70">
        <UiIcon name="map-pin" className="size-3" />
        <span>{REGIONS.find((region) => region.id === member.region)?.short}</span>
        {!primary && !connected && <span className="ms-auto text-warning">Unconnected</span>}
      </div>
      {(primary || kind === "postgres") && (
        <Handle type="source" position={Position.Right} id="out" isConnectable={isConnectable} />
      )}
    </div>
  );
});
