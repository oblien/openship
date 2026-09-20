"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  useViewport,
  type Connection,
  type OnDelete,
  type NodeChange,
  type EdgeChange,
  type Viewport,
  type FitViewOptions,
} from "@xyflow/react";
import {
  LockKeyhole,
  Map as MapIcon,
  Maximize,
  Minus,
  Network,
  Plus,
  UnlockKeyhole,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResourceNode, type ScaleFlowNode } from "./ResourceNode";
import { ClusterNode, type ClusterFlowNode } from "./ClusterNode";
import { TrafficEdge, type ScaleFlowEdge } from "./TrafficEdge";
import {
  connectionError,
  connectionLabel,
  isClusterResource,
  type ClusterResource,
  type ScaleDraft,
  type ScaleSelection,
} from "./topology";
import {
  canRemoveClusterMember,
  clusterConnectionError,
  clusterSlotRange,
  getClusterTopology,
} from "./clusterTopology";
import "@xyflow/react/dist/style.css";

type CanvasNode = ScaleFlowNode | ClusterFlowNode;
const nodeTypes = { resource: ResourceNode, clusterMember: ClusterNode };
const edgeTypes = { traffic: TrafficEdge };
const defaultEdgeOptions = {
  type: "traffic",
  markerEnd: { type: MarkerType.ArrowClosed, color: "var(--th-on-30)", width: 15, height: 15 },
};
const connectionLineStyle = { stroke: "var(--foreground)", strokeWidth: 1.5 };

interface ScaleCanvasProps {
  inert?: boolean;
  draft: ScaleDraft;
  selection: ScaleSelection;
  onSelect: (selection: ScaleSelection) => void;
  onConnect: (source: string, target: string) => void;
  onMove: (positions: { id: string; position: { x: number; y: number } }[]) => void;
  onRemoveNodes: (ids: string[]) => void;
  onRemoveEdges: (ids: string[]) => void;
  fitRequest: { revision: number; nodeId?: string };
  cluster?: ClusterResource;
  onOpenCluster?: (id: string) => void;
  defaultViewport?: Viewport;
  onViewportChange?: (viewport: Viewport) => void;
}

function CanvasTools({
  locked,
  onToggleLock,
  showMap,
  onToggleMap,
  fitOptions,
}: {
  locked: boolean;
  onToggleLock: () => void;
  showMap: boolean;
  onToggleMap: () => void;
  fitOptions: FitViewOptions;
}) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel
      position="bottom-left"
      className="scale-canvas-controls scale-floating-surface flex items-center gap-0.5 rounded-2xl border border-border/60 p-1.5"
    >
      <Button
        variant="ghost"
        size="icon"
        title="Zoom out"
        aria-label="Zoom out"
        onClick={() => zoomOut()}
      >
        <Minus />
      </Button>
      <span className="w-10 text-center text-xs tabular-nums text-foreground/70">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        variant="ghost"
        size="icon"
        title="Zoom in"
        aria-label="Zoom in"
        onClick={() => zoomIn()}
      >
        <Plus />
      </Button>
      <span className="mx-1 h-5 w-px bg-border/70" aria-hidden="true" />
      <Button
        variant="ghost"
        size="icon"
        title="Fit topology to view"
        aria-label="Fit topology to view"
        onClick={() => fitView(fitOptions)}
      >
        <Maximize />
      </Button>
      <span className="mx-1 h-5 w-px bg-border/70" aria-hidden="true" />
      <Button
        variant="ghost"
        size="icon"
        title={locked ? "Unlock canvas" : "Lock canvas"}
        aria-label={locked ? "Unlock canvas" : "Lock canvas"}
        aria-pressed={locked}
        onClick={onToggleLock}
      >
        {locked ? <LockKeyhole /> : <UnlockKeyhole />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="Toggle minimap"
        aria-label="Toggle minimap"
        aria-pressed={showMap}
        onClick={onToggleMap}
      >
        <MapIcon />
      </Button>
    </Panel>
  );
}

function Canvas({
  inert = false,
  draft,
  selection,
  onSelect,
  onConnect,
  onMove,
  onRemoveNodes,
  onRemoveEdges,
  fitRequest,
  cluster,
  onOpenCluster,
  defaultViewport,
  onViewportChange,
}: ScaleCanvasProps) {
  const [initialViewport] = useState(defaultViewport);
  const canvasWidth = useStore((state) => state.width);
  const inCluster = !!cluster;
  const fitViewOptions = useMemo<FitViewOptions>(
    () => ({
      maxZoom: 1,
      padding: {
        top: canvasWidth > 0 && canvasWidth <= (inCluster ? 700 : 560) ? "152px" : "88px",
        bottom: "80px",
        x: "28px",
      },
    }),
    [canvasWidth, inCluster],
  );
  const topology = useMemo(() => (cluster ? getClusterTopology(cluster) : null), [cluster]);
  const expectedNodes = topology?.nodes ?? draft.nodes;
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ScaleFlowEdge>([]);
  const [locked, setLocked] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const fittedRevision = useRef(fitRequest.revision);
  useEffect(() => {
    const services = new Map(draft.services.map((service) => [service.id, service]));
    setNodes((current) => {
      const previous = new Map(current.map((node) => [node.id, node]));
      if (cluster && topology) {
        return topology.nodes.map((member): ClusterFlowNode => {
          const candidate = previous.get(member.id);
          const existing = candidate?.type === "clusterMember" ? candidate : undefined;
          const selected = selection?.type === "node" && selection.id === member.id;
          const connected = topology.edges.some((edge) => edge.target === member.id);
          const slots = clusterSlotRange(cluster, member);
          const deletable = canRemoveClusterMember(cluster, member);
          const unchanged =
            existing?.data.member === member &&
            existing.data.connected === connected &&
            existing.deletable === deletable &&
            existing.data.slots?.start === slots?.start &&
            existing.data.slots?.end === slots?.end;
          if (unchanged && existing.selected === selected) return existing;
          return {
            ...existing,
            id: member.id,
            type: "clusterMember",
            position: member.position,
            data: unchanged ? existing.data : { member, kind: cluster.kind, connected, slots },
            selected,
            deletable,
            ariaLabel: `${member.name}, ${member.role}. Select, then choose Expand settings.`,
          };
        });
      }
      return draft.nodes.map((resource) => {
        const candidate = previous.get(resource.id);
        const existing = candidate?.type === "resource" ? candidate : undefined;
        const selected = selection?.type === "node" && selection.id === resource.id;
        const service = resource.kind === "service" ? services.get(resource.serviceId) : undefined;
        const unchanged =
          existing?.data.resource === resource &&
          existing?.data.service === service &&
          existing.data.onOpenCluster === onOpenCluster;
        if (unchanged && existing.selected === selected) return existing;
        return {
          ...existing,
          id: resource.id,
          type: "resource" as const,
          position: resource.position,
          data: unchanged ? existing.data : { resource, service, onOpenCluster },
          selected,
          ariaLabel: `${resource.name}, ${resource.kind}. ${isClusterResource(resource) ? "Double-click to open cluster." : "Select, then choose Expand settings."}`,
        };
      });
    });
  }, [draft.nodes, draft.services, cluster, topology, selection, setNodes, onOpenCluster]);
  useEffect(() => {
    const resources = new Map(draft.nodes.map((resource) => [resource.id, resource]));
    setEdges((current) => {
      const previous = new Map(current.map((edge) => [edge.id, edge]));
      if (cluster && topology) {
        return topology.edges.map((edge): ScaleFlowEdge => {
          const selected = selection?.type === "edge" && selection.id === edge.id;
          const label = edge.mode === "sync" ? "Sync replication" : "Async replication";
          const existing = previous.get(edge.id);
          if (
            existing?.source === edge.source &&
            existing.target === edge.target &&
            existing.data?.label === label &&
            existing.selected === selected
          )
            return existing;
          return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            ...defaultEdgeOptions,
            type: "traffic",
            sourceHandle: "out",
            targetHandle: "in",
            data: { label, showLabel: true },
            selected,
            ariaLabel: `${label} from ${topology.nodes.find((node) => node.id === edge.source)?.name} to ${topology.nodes.find((node) => node.id === edge.target)?.name}`,
          };
        });
      }
      return draft.edges.flatMap((edge) => {
        const target = resources.get(edge.target);
        if (!target) return [];
        const existing = previous.get(edge.id);
        const selected = selection?.type === "edge" && selection.id === edge.id;
        const label = `${edge.label ? `${edge.label} · ` : ""}${connectionLabel(draft, target, edge)}`;
        const enabled = edge.enabled !== false;
        const ariaLabel = `${enabled ? "Connection" : "Disabled connection"} from ${resources.get(edge.source)?.name} to ${target.name}`;
        if (
          existing?.source === edge.source &&
          existing.target === edge.target &&
          existing.data?.label === label &&
          existing.data.enabled === enabled &&
          existing.selected === selected &&
          existing.ariaLabel === ariaLabel
        )
          return [existing];
        return [
          {
            ...edge,
            ...defaultEdgeOptions,
            type: "traffic" as const,
            sourceHandle: "out",
            targetHandle: "in",
            data: { label, enabled },
            selected,
            ariaLabel,
          },
        ];
      });
    });
  }, [draft, cluster, topology, selection, setEdges]);
  useEffect(() => {
    if (!nodesInitialized || fittedRevision.current === fitRequest.revision) return;
    // The draft can request a fit before its new nodes and positions reach the canvas.
    if (
      nodes.length !== expectedNodes.length ||
      nodes.some(
        (node, index) =>
          node.id !== expectedNodes[index].id ||
          node.position.x !== expectedNodes[index].position.x ||
          node.position.y !== expectedNodes[index].position.y,
      )
    )
      return;
    const frame = requestAnimationFrame(() => {
      fittedRevision.current = fitRequest.revision;
      fitView({
        ...fitViewOptions,
        nodes: fitRequest.nodeId ? [{ id: fitRequest.nodeId }] : undefined,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitRequest, nodesInitialized, nodes, expectedNodes, fitView, fitViewOptions]);

  const handleConnection = useCallback(
    (connection: Connection) => onConnect(connection.source, connection.target),
    [onConnect],
  );
  const isValidConnection = useCallback(
    (connection: Connection | ScaleFlowEdge) =>
      !(cluster && topology
        ? clusterConnectionError(cluster, topology, connection.source, connection.target)
        : connectionError(draft, connection.source, connection.target)),
    [draft, cluster, topology],
  );
  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      onNodesChange(changes);
      const selected = changes.find((change) => change.type === "select" && change.selected);
      if (selected?.type === "select") onSelect({ type: "node", id: selected.id });
      const settled = changes.flatMap((change) =>
        change.type === "position" && change.position && !change.dragging
          ? [{ id: change.id, position: change.position }]
          : [],
      );
      if (settled.length) onMove(settled);
    },
    [onNodesChange, onSelect, onMove],
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<ScaleFlowEdge>[]) => {
      onEdgesChange(changes);
      const selected = changes.find((change) => change.type === "select" && change.selected);
      if (selected?.type === "select") onSelect({ type: "edge", id: selected.id });
    },
    [onEdgesChange, onSelect],
  );
  const handleNodeClick = useCallback(
    (_event: unknown, node: CanvasNode) => onSelect({ type: "node", id: node.id }),
    [onSelect],
  );
  const handleNodeDoubleClick = useCallback(
    (_event: unknown, node: CanvasNode) => {
      if (node.type === "resource" && isClusterResource(node.data.resource))
        onOpenCluster?.(node.id);
    },
    [onOpenCluster],
  );
  const handleEdgeClick = useCallback(
    (_event: unknown, edge: ScaleFlowEdge) => onSelect({ type: "edge", id: edge.id }),
    [onSelect],
  );
  const handlePaneClick = useCallback(() => onSelect(null), [onSelect]);
  const handleDelete = useCallback<OnDelete<CanvasNode, ScaleFlowEdge>>(
    ({ nodes: removedNodes, edges: removedEdges }) => {
      if (removedNodes.length) onRemoveNodes(removedNodes.map((node) => node.id));
      else if (removedEdges.length) onRemoveEdges(removedEdges.map((edge) => edge.id));
    },
    [onRemoveNodes, onRemoveEdges],
  );

  return (
    <div
      className="scale-canvas h-full w-full"
      dir="ltr"
      inert={inert}
      aria-label={
        cluster ? `Interactive ${cluster.name} cluster topology` : "Interactive scaling topology"
      }
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") onSelect(null);
      }}
    >
      <ReactFlow<CanvasNode, ScaleFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnection}
        isValidConnection={isValidConnection}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        onDelete={handleDelete}
        nodesDraggable={!locked}
        nodesConnectable={!locked}
        autoPanOnNodeFocus={false}
        edgesReconnectable={false}
        deleteKeyCode={locked || inert ? null : ["Backspace", "Delete"]}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        onlyRenderVisibleElements
        minZoom={cluster ? 0.1 : 0.2}
        maxZoom={1.6}
        fitView={!initialViewport}
        defaultViewport={initialViewport}
        onMove={(_event, viewport) => onViewportChange?.(viewport)}
        fitViewOptions={fitViewOptions}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionLineStyle={connectionLineStyle}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--th-on-12)" />
        {!cluster && !draft.nodes.length && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <Network className="size-8 text-muted-foreground/50" />
            <h3 className="text-lg font-medium text-foreground/80">No resources yet</h3>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              Add an edge, application, or cluster to start your topology.
            </p>
          </div>
        )}
        <CanvasTools
          locked={locked}
          onToggleLock={() => setLocked(!locked)}
          showMap={showMap}
          onToggleMap={() => setShowMap(!showMap)}
          fitOptions={fitViewOptions}
        />
        {showMap && (
          <MiniMap pannable zoomable nodeColor="var(--th-on-30)" maskColor="var(--th-sf-06)" />
        )}
      </ReactFlow>
    </div>
  );
}

export default memo(function ScaleCanvas(props: ScaleCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
});
