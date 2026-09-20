"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import type { ClusterNetworkReport } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { BlurIp } from "@/components/BlurIp";
import { InfrastructureProviderLogo } from "@/components/servers/InfrastructureProviderLogo";
import { NetworkDiagnosticText } from "./NetworkSetupProgress";
import {
  networkNodePositions,
  type NetworkTopologyLink,
  type NetworkTopologyMember,
} from "./network-topology";
import "@xyflow/react/dist/style.css";

type ServerNode = Node<
  { member: NetworkTopologyMember; state: "passed" | "failed" | "unchecked" },
  "server"
>;
type ConnectionEdge = Edge<
  { link: NetworkTopologyLink; label: string; showLabel: boolean; onSelect(): void },
  "connection"
>;
const sides = [Position.Left, Position.Right, Position.Top, Position.Bottom];
const ServerNodeView = memo(function ServerNodeView({ data, selected }: NodeProps<ServerNode>) {
  const { t } = useI18n();
  const c = t.servers.networks;
  return (
    <article
      className={`w-[220px] rounded-2xl border bg-popover p-4 text-start ${selected ? "border-primary" : "border-border/60"}`}
    >
      {sides.flatMap((side) => [
        <Handle
          key={`${side}-out`}
          id={`${side}-out`}
          type="source"
          position={side}
          isConnectable={false}
          className="!size-1 !border-0 !opacity-0"
        />,
        <Handle
          key={`${side}-in`}
          id={`${side}-in`}
          type="target"
          position={side}
          isConnectable={false}
          className="!size-1 !border-0 !opacity-0"
        />,
      ])}
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted/40">
          <InfrastructureProviderLogo providerId={data.member.providerId} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            <NetworkDiagnosticText value={data.member.name} />
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            <BlurIp>{data.member.privateIp || data.member.endpoint || "—"}</BlurIp>
          </p>
        </div>
      </div>
      <p
        className={`mt-3 flex items-center gap-1.5 text-xs ${data.member.progress?.state === "restored" ? "text-warning" : data.state === "passed" ? "text-success" : data.state === "failed" ? "text-danger" : data.member.progress?.state === "running" ? "text-primary" : "text-muted-foreground"}`}
      >
        {data.member.progress?.state === "running" ? (
          <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
        )}
        {data.member.progress?.label ??
          (data.state === "passed"
            ? c.interfaceVerified
            : data.state === "failed"
              ? c.failed
              : c.diagnostics.notTested)}
      </p>
    </article>
  );
});
const ConnectionEdgeView = memo(function ConnectionEdgeView(props: EdgeProps<ConnectionEdge>) {
  const { data, selected, id } = props;
  const [path, x, y] = getBezierPath(props);
  const color =
    data?.link.state === "failed"
      ? "var(--danger)"
      : data?.link.state === "passed"
        ? "var(--success)"
        : "var(--th-on-30)";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        interactionWidth={24}
        style={{
          stroke: color,
          strokeWidth: selected ? 2.5 : 1.5,
          opacity: selected ? 1 : 0.65,
          strokeDasharray: data?.link.state === "unchecked" ? "5 5" : undefined,
        }}
      />
      {(data?.showLabel || selected) && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={data?.onSelect}
            className={`nodrag nopan absolute rounded-lg bg-popover px-2 py-1 text-xs tabular-nums text-foreground ${selected ? "ring-1 ring-primary/40" : ""}`}
            style={{
              pointerEvents: "all",
              transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
            }}
            aria-label={`${data?.link.source.name} ${data?.link.accessMode === "forward" ? "→" : data?.link.accessMode === "reverse" ? "←" : data?.link.connected ? "↔" : "—"} ${data?.link.target.name}`}
          >
            {data?.label}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
const nodeTypes = { server: ServerNodeView };
const edgeTypes = { connection: ConnectionEdgeView };

export function FitNetworkView() {
  const ready = useNodesInitialized();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (ready && width && height) void fitView({ padding: 0.2, maxZoom: 1 });
  }, [ready, width, height, fitView]);
  return null;
}

export function ClusterNetworkTopology({
  members,
  links,
  report,
  selected,
  focusedServer,
  onSelect,
  onFocus,
}: {
  members: NetworkTopologyMember[];
  links: NetworkTopologyLink[];
  report?: ClusterNetworkReport | null;
  selected: string | null;
  focusedServer: string | null;
  onSelect(id: string): void;
  onFocus(serverId: string): void;
}) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  // Controlled, read-only nodes still need their measured dimensions retained so
  // viewport fitting works after a container resize or a live status update.
  const onNodesChange = useCallback((changes: NodeChange<ServerNode>[]) => {
    const sizes = changes.filter((change) => change.type === "dimensions" && change.dimensions);
    if (!sizes.length) return;
    setMeasurements((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const change of sizes) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const size = change.dimensions;
        if (
          previous[change.id]?.width !== size.width ||
          previous[change.id]?.height !== size.height
        ) {
          next[change.id] = size;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, []);
  const nodes = useMemo<ServerNode[]>(() => {
    const positions = networkNodePositions(members.length);
    return members.map((member, i) => {
      const host = report?.hosts.find((item) => item.serverId === member.serverId);
      const state = member.progress?.state;
      return {
        id: member.serverId,
        type: "server",
        position: positions[i]!,
        measured: measurements[member.serverId],
        selected: focusedServer === member.serverId,
        data: {
          member,
          state: state
            ? state === "completed"
              ? "passed"
              : state === "failed"
                ? "failed"
                : "unchecked"
            : host?.ok === true
              ? "passed"
              : host?.ok === false
                ? "failed"
                : "unchecked",
        },
      };
    });
  }, [members, report, focusedServer, measurements]);
  const edges: ConnectionEdge[] = links
    .filter(
      (link) =>
        (link.connected || link.state === "failed") &&
        (!focusedServer ||
          link.source.serverId === focusedServer ||
          link.target.serverId === focusedServer),
    )
    .map((link) => {
      const source = nodes.find((node) => node.id === link.source.serverId)!;
      const target = nodes.find((node) => node.id === link.target.serverId)!;
      const dx = target.position.x - source.position.x,
        dy = target.position.y - source.position.y;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const from = horizontal ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
      const to = horizontal ? (dx > 0 ? "left" : "right") : dy > 0 ? "top" : "bottom";
      return {
        id: link.id,
        type: "connection",
        source: source.id,
        target: target.id,
        sourceHandle: `${from}-out`,
        targetHandle: `${to}-in`,
        selected: selected === link.id,
        markerStart:
          link.accessMode === "reverse"
            ? {
                type: MarkerType.ArrowClosed,
                width: 18,
                height: 18,
                color:
                  link.state === "failed"
                    ? "var(--danger)"
                    : link.state === "passed"
                      ? "var(--success)"
                      : "var(--th-on-30)",
              }
            : undefined,
        markerEnd:
          link.accessMode === "forward"
            ? {
                type: MarkerType.ArrowClosed,
                width: 18,
                height: 18,
                color:
                  link.state === "failed"
                    ? "var(--danger)"
                    : link.state === "passed"
                      ? "var(--success)"
                      : "var(--th-on-30)",
              }
            : undefined,
        data: {
          link,
          label:
            link.latencyMs !== null
              ? `${link.latencyMs.toLocaleString(undefined, { maximumFractionDigits: 2 })} ms`
              : link.state === "failed"
                ? c.failed
                : c.diagnostics.notTested,
          showLabel: members.length <= 5,
          onSelect: () => onSelect(link.id),
        },
      };
    });
  return (
    <div
      className="h-[360px] w-full min-w-0 rounded-2xl bg-muted/15 sm:h-[430px]"
      aria-label={c.diagnostics.title}
    >
      <ReactFlow<ServerNode, ConnectionEdge>
        nodes={nodes}
        onNodesChange={onNodesChange}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, node) => onFocus(node.id)}
        onEdgeClick={(_, edge) => onSelect(edge.id)}
        nodesConnectable={false}
        nodesDraggable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={1.5}
        panOnScroll={false}
        zoomOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <FitNetworkView />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--th-on-10)" />
        <Controls
          showInteractive={false}
          className="!overflow-hidden !rounded-xl !border-0 !shadow-none [&>button]:!border-border/30 [&>button]:!bg-popover [&>button]:!text-foreground [&_svg]:!fill-current"
        />
      </ReactFlow>
    </div>
  );
}
