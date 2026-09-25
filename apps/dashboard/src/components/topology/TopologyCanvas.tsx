"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

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
import { Button } from "@/components/ui/button";
import { ResourceIcon } from "@/components/scale/ResourceIcon";
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
  if (resource.database || (resource.clusterPod && resource.tone !== "service")) {
    return <ResourceIcon kind={resource.tone} className={className} />;
  }
  const Icon =
    resource.kind === "edge"
      ? "globe"
      : resource.kind === "linked"
        ? "database"
        : resource.kind === "environment" || resource.kind === "traffic"
          ? "layers"
          : "window";
  return <UiIcon name={Icon} className={className} />;
}

export function TopologyStatus({ state }: { state: TopologyState }) {
  return (
    <span
      className="topology-status text-[11px] font-medium"
      data-state={state}
    >
      {stateLabels[state]}
    </span>
  );
}

const Resource = memo(function Resource({ data }: NodeProps<ResourceFlowNode>) {
  const { resource, onOpen } = data;
  const isService = resource.kind === "service";
  const canInspectInstance =
    (isService && !!resource.container?.containerId && !resource.pending) || !!resource.replicaStatus || !!resource.database?.observation?.pods.length;
  const applicationRelease =
    resource.kind === "application" && !resource.replicaStatus && resource.state !== "disabled" && resource.version;
  return (
    <article
      className="topology-node scale-resource-tone w-[250px] rounded-2xl text-start"
      data-kind={resource.tone}
      data-pending={resource.pending}
      aria-label={`${resource.name}, ${applicationRelease ? `deployed ${resource.version}` : stateLabels[resource.state]}${resource.pending ? ", pending changes" : ""}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={isService} />
      <div className="flex items-center gap-3 p-4 pb-3">
        <span className="topology-node-icon flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
          <TopologyResourceIcon resource={resource} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground" title={resource.name}>
            {resource.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={resource.description}>
            {resource.description}
          </p>
        </div>
      </div>
      {(resource.ownerName || resource.pending) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          {resource.ownerName && (
            <p className="truncate text-[11px] text-muted-foreground">From {resource.ownerName}</p>
          )}
          {resource.pending && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning">
              <UiIcon name="edit" className="size-2.5" />
              Pending changes
            </span>
          )}
        </div>
      )}
      <div className="px-3 pb-3">
        <button
          type="button"
          className="topology-node-action nodrag nopan flex h-8 w-full items-center justify-between gap-2 rounded-lg bg-muted/50 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(resource.id);
          }}
          aria-label={
            canInspectInstance
              ? `View instances of ${resource.name}`
              : resource.clusterPod
                ? `Inspect ${resource.name}`
                : `Configure ${resource.name}`
          }
        >
          <span className="min-w-0 truncate">
            {canInspectInstance
              ? "Instances"
              : resource.clusterPod
                ? "Inspect instance"
                : resource.kind === "traffic"
                  ? "View traffic"
                  : resource.kind === "linked"
                    ? "View connection"
                    : "Configuration"}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {applicationRelease ? (
              <span className="text-[11px] text-muted-foreground">Deployed {resource.version}</span>
            ) : (
              <TopologyStatus state={resource.state} />
            )}
            <UiIcon name="chevron-right" className="size-3 rtl:rotate-180" />
          </span>
        </button>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={isService} />
    </article>
  );
});

const nodeTypes = { resource: Resource };
const edgeTypes = { traffic: TrafficEdge };
const fitViewOptions = { padding: 0.2, maxZoom: 1 };
const ariaLabelConfig = {
  "node.a11yDescription.default": "Press Enter or Space to open details.",
  "edge.a11yDescription.default": "Press Enter or Space to open details.",
};
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
      className="topology-canvas-controls flex items-center gap-0.5 rounded-xl p-1"
    >
      <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={() => void zoomOut()}>
        <UiIcon name="minus" />
      </Button>
      <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
        {Math.round(zoom * 100)}%
      </span>
      <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => void zoomIn()}>
        <UiIcon name="plus" />
      </Button>
      <span className="mx-1 h-5 w-px bg-border/60" />
      <Button
        variant="ghost"
        size="icon"
        title="Fit topology to view"
        aria-label="Fit topology to view"
        onClick={() => void fitView({ ...fitViewOptions, duration: 200 })}
      >
        <UiIcon name="scan" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="Arrange services"
        aria-label="Arrange services"
        onClick={onArrange}
      >
        <UiIcon name="topology" />
      </Button>
    </Panel>
  );
}

function FitOnChange({ revision, fullscreen }: { revision: number; fullscreen: boolean }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  // React Flow fits the initial measurements before revealing the nodes.
  // A separate initial fit would first paint them in the default viewport.
  const fitted = useRef(`${revision}:${fullscreen}`);
  useEffect(() => {
    const view = `${revision}:${fullscreen}`;
    if (!initialized || fitted.current === view) return;
    const frame = requestAnimationFrame(() => {
      fitted.current = view;
      void fitView({ ...fitViewOptions, duration: revision === 0 ? 0 : 200 });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, revision, fullscreen, fitView]);
  return null;
}

interface TopologyCanvasProps {
  layoutKey: string;
  graph: ProjectTopologyGraph;
  selection: TopologySelection;
  fullscreen: boolean;
  inert: boolean;
  onSelect: (selection: TopologySelection) => void;
  onOpen: (id: string) => void;
  onConnect: (connection: Connection) => void;
}

function Canvas({
  layoutKey,
  graph,
  selection,
  fullscreen,
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
        const existing = byId.get(resource.id);
        let position = existing?.position ?? storedPositions.current?.[resource.id];
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
          // Keep measured dimensions so selection and refresh do not hide existing nodes.
          ...existing,
          id: resource.id,
          type: "resource" as const,
          position,
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
  }, [graph, positions, onOpen]);
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
          enabled: !relation.pending && relation.enabled !== false,
        },
        ariaLabel: `${relation.kind}: ${relation.label}`,
      })),
    [graph.edges, selection],
  );

  return (
    <div
      className="scale-canvas h-full w-full"
      inert={inert}
      onKeyDown={(event) => {
        if (inert || event.defaultPrevented || (event.key !== "Enter" && event.key !== " ")) return;
        const target = event.target;
        if (!(target instanceof Element) || !target.matches(".react-flow__node, .react-flow__edge")) return;
        const id = target.getAttribute("data-id");
        if (!id) return;
        event.preventDefault();
        onSelect({ kind: target.classList.contains("react-flow__node") ? "node" : "edge", id });
      }}
    >
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
        onNodeClick={(event, node) => {
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
          onSelect({ kind: "node", id: node.id });
        }}
        onEdgeClick={(event, edge) => {
          (event.currentTarget as SVGElement).focus({ preventScroll: true });
          onSelect({ kind: "edge", id: edge.id });
        }}
        onPaneClick={() => onSelect(null)}
        onConnect={onConnect}
        deleteKeyCode={null}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={!inert}
        nodesConnectable={!inert}
        elementsSelectable={false}
        selectNodesOnDrag={false}
        panOnDrag={!inert}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        aria-label="Project topology"
        ariaLabelConfig={ariaLabelConfig}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--th-on-10)" />
        <FitOnChange revision={fitRevision} fullscreen={fullscreen} />
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
