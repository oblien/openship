"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  useViewport,
  type Connection,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  ArrowUpRight,
  Box,
  Boxes,
  Database,
  Globe,
  Layers,
  Maximize,
  Minus,
  Network,
  Plus,
  Server,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TrafficEdge, type ScaleFlowEdge } from "@/components/scale/TrafficEdge";
import { ServiceIcon } from "@/components/services/ServiceIcon";
import {
  topologyPositions,
  type ProjectTopologyGraph,
  type TopologyResource,
  type TopologyState,
} from "./model";
import { readTopologyPositions, saveTopologyPositions } from "./layout";
import "@xyflow/react/dist/style.css";

export type TopologySelection = { kind: "node" | "edge"; id: string } | null;
type ResourceFlowNode = Node<
  { resource: TopologyResource; onOpen: (id: string) => void },
  "resource"
>;

const stateLabels: Record<TopologyState, string> = {
  running: "Running",
  starting: "Starting",
  restarting: "Restarting",
  stopped: "Stopped",
  failed: "Failed",
  unknown: "Status unavailable",
  disabled: "Disabled",
  configured: "Configured",
  pending: "Pending",
};

export function TopologyResourceIcon({
  resource,
  className = "size-5",
}: {
  resource: TopologyResource;
  className?: string;
}) {
  if (resource.service) return <ServiceIcon service={resource.service} className={className} />;
  const Icon =
    resource.kind === "edge"
      ? Globe
      : resource.kind === "linked"
        ? Database
        : resource.kind === "environment"
          ? Layers
          : resource.kind === "instance"
            ? Box
            : Boxes;
  return <Icon className={className} />;
}

export function TopologyStatus({ state }: { state: TopologyState }) {
  return (
    <span
      className="topology-status inline-flex items-center gap-1.5 text-[11px]"
      data-state={state}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {stateLabels[state]}
    </span>
  );
}

const Resource = memo(function Resource({ data, selected }: NodeProps<ResourceFlowNode>) {
  const { resource, onOpen } = data;
  const isService = resource.kind === "service";
  const canInspectInstance = isService && !!resource.container?.containerId;
  const applicationRelease = resource.kind === "application" && resource.version;
  return (
    <article
      className="topology-node scale-resource-node scale-resource-tone w-[250px] overflow-hidden rounded-2xl border text-start"
      data-kind={resource.tone}
      data-selected={selected}
      data-pending={resource.pending}
      aria-label={`${resource.name}, ${resource.pending ? "pending changes" : applicationRelease ? `deployed ${resource.version}` : stateLabels[resource.state]}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={isService} />
      <div className="flex items-center gap-3 px-4 pb-3 pt-4">
        <span className="scale-resource-icon flex size-10 shrink-0 items-center justify-center rounded-xl">
          <TopologyResourceIcon resource={resource} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold text-foreground" title={resource.name}>
            {resource.name}
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {resource.description}
          </p>
        </div>
        {resource.pending && (
          <span className="size-2 shrink-0 rounded-full bg-warning" title="Pending changes" />
        )}
      </div>
      <div className="space-y-2 px-4 pb-3">
        {resource.image && (
          <p
            className="truncate font-mono text-[10px] text-muted-foreground"
            title={resource.image}
          >
            {resource.image}
          </p>
        )}
        {resource.ownerName && (
          <p className="truncate text-[11px] text-muted-foreground">From {resource.ownerName}</p>
        )}
        <div className="flex items-center justify-between gap-2">
          {applicationRelease && resource.state !== "disabled" ? (
            <span className="text-[11px] text-muted-foreground">Deployed {resource.version}</span>
          ) : (
            <TopologyStatus state={resource.pending ? "pending" : resource.state} />
          )}
          {resource.instances !== undefined && (
            <span className="text-[11px] text-muted-foreground">{resource.instances} running</span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="nodrag nopan flex w-full items-center justify-between border-t border-border/40 bg-muted/20 px-4 py-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation();
          onOpen(resource.id);
        }}
        aria-label={
          canInspectInstance ? `View instances of ${resource.name}` : `Configure ${resource.name}`
        }
      >
        <span className="flex items-center gap-1.5">
          {canInspectInstance ? <Server className="size-3" /> : <Settings2 className="size-3" />}
          {canInspectInstance
            ? "View instances"
            : resource.kind === "linked"
              ? "View connection"
              : "Configuration"}
        </span>
        <ArrowUpRight className="size-3" />
      </button>
      <Handle type="source" position={Position.Right} isConnectable={isService} />
    </article>
  );
});

const nodeTypes = { resource: Resource };
const edgeTypes = { traffic: TrafficEdge };
const defaultEdgeOptions = {
  type: "traffic",
  markerEnd: { type: MarkerType.ArrowClosed, color: "var(--th-on-30)", width: 15, height: 15 },
};

function CanvasTools({ onArrange }: { onArrange: () => void }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel
      position="bottom-left"
      className="scale-canvas-controls flex items-center gap-0.5 rounded-xl border border-border/60 p-1"
    >
      <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={() => void zoomOut()}>
        <Minus />
      </Button>
      <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
        {Math.round(zoom * 100)}%
      </span>
      <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => void zoomIn()}>
        <Plus />
      </Button>
      <span className="mx-1 h-5 w-px bg-border/60" />
      <Button
        variant="ghost"
        size="icon"
        title="Fit topology to view"
        aria-label="Fit topology to view"
        onClick={() => void fitView({ padding: 0.2, maxZoom: 1, duration: 200 })}
      >
        <Maximize />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="Arrange services"
        aria-label="Arrange services"
        onClick={onArrange}
      >
        <Network />
      </Button>
    </Panel>
  );
}

function InitialFit({ revision }: { revision: number }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const fitted = useRef(-1);
  useEffect(() => {
    if (!initialized || fitted.current === revision) return;
    const frame = requestAnimationFrame(() => {
      fitted.current = revision;
      void fitView({ padding: 0.2, maxZoom: 1, duration: revision === 0 ? 0 : 200 });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, revision, fitView]);
  return null;
}

interface TopologyCanvasProps {
  layoutKey: string;
  graph: ProjectTopologyGraph;
  selection: TopologySelection;
  inert: boolean;
  onSelect: (selection: TopologySelection) => void;
  onOpen: (id: string) => void;
  onConnect: (connection: Connection) => void;
}

function Canvas({
  layoutKey,
  graph,
  selection,
  inert,
  onSelect,
  onOpen,
  onConnect,
}: TopologyCanvasProps) {
  const positions = useMemo(() => topologyPositions(graph), [graph]);
  const storedPositions = useRef<ReturnType<typeof readTopologyPositions> | null>(null);
  if (storedPositions.current === null) storedPositions.current = readTopologyPositions(layoutKey);
  const [nodes, setNodes] = useState<ResourceFlowNode[]>([]);
  const [fitRevision, setFitRevision] = useState(0);
  const previousIds = useRef<string>("");
  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      const occupied = current
        .filter((node) => graph.nodes.some((resource) => resource.id === node.id))
        .map((node) => node.position);
      return graph.nodes.map((resource) => {
        let position = byId.get(resource.id)?.position ?? storedPositions.current?.[resource.id];
        if (!position) {
          position = { ...positions[resource.id] };
          // New nodes must not cover a service whose position was preserved
          // from an earlier refresh or the user's own arrangement.
          while (
            occupied.some(
              (other) =>
                Math.abs(other.x - position!.x) < 270 && Math.abs(other.y - position!.y) < 180,
            )
          )
            position.y += 200;
          occupied.push(position);
        }
        return {
          id: resource.id,
          type: "resource" as const,
          position,
          selected: selection?.kind === "node" && selection.id === resource.id,
          data: { resource, onOpen },
        };
      });
    });
    const ids = graph.nodes
      .map((node) => node.id)
      .sort()
      .join("|");
    if (previousIds.current && previousIds.current !== ids)
      setFitRevision((revision) => revision + 1);
    previousIds.current = ids;
  }, [graph, positions, selection, onOpen]);
  const edges = useMemo<ScaleFlowEdge[]>(
    () =>
      graph.edges.map((relation) => ({
        id: relation.id,
        source: relation.source,
        target: relation.target,
        type: "traffic",
        selected: selection?.kind === "edge" && selection.id === relation.id,
        data: {
          label: relation.label,
          showLabel: relation.kind === "binding",
          enabled: !relation.pending,
        },
        ariaLabel: `${relation.kind}: ${relation.label}`,
      })),
    [graph.edges, selection],
  );

  return (
    <div className="scale-canvas h-full w-full" inert={inert}>
      <ReactFlow<ResourceFlowNode, ScaleFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
        onNodeDragStop={(_, node, dragged) => {
          const next = { ...storedPositions.current };
          for (const item of dragged.length ? dragged : [node]) next[item.id] = item.position;
          storedPositions.current = next;
          saveTopologyPositions(layoutKey, next);
        }}
        onNodeClick={(_, node) => onSelect({ kind: "node", id: node.id })}
        onEdgeClick={(_, edge) => onSelect({ kind: "edge", id: edge.id })}
        onPaneClick={() => onSelect(null)}
        onConnect={onConnect}
        onNodeDoubleClick={(_, node) => onOpen(node.id)}
        deleteKeyCode={null}
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={!inert}
        nodesConnectable={!inert}
        elementsSelectable={!inert}
        panOnDrag={!inert}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        aria-label="Project topology"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--th-on-10)" />
        <InitialFit revision={fitRevision} />
        <CanvasTools
          onArrange={() => {
            storedPositions.current = positions;
            saveTopologyPositions(layoutKey, positions);
            setNodes((current) =>
              current.map((node) => ({ ...node, position: positions[node.id] })),
            );
            setFitRevision((revision) => revision + 1);
          }}
        />
      </ReactFlow>
    </div>
  );
}

export function TopologyCanvas(props: TopologyCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
