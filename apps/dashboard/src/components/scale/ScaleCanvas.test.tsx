import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactFlowProps } from "@xyflow/react";
import type { ScaleFlowNode } from "./ResourceNode";
import type { ScaleFlowEdge } from "./TrafficEdge";
import ScaleCanvas from "./ScaleCanvas";
import {
  createExampleDraft,
  createResource,
  isClusterResource,
  removeConnections,
  removeResources,
} from "./topology";
import { setReplicationSource } from "./clusterTopology";

const flow = vi.hoisted(() => ({
  props: null as ReactFlowProps<ScaleFlowNode, ScaleFlowEdge> | null,
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlow: (props: ReactFlowProps<ScaleFlowNode, ScaleFlowEdge>) => {
      flow.props = props;
      return null;
    },
  };
});

function renderCanvas(props: Partial<ComponentProps<typeof ScaleCanvas>> = {}) {
  let draft = createExampleDraft();
  const onRemoveNodes = vi.fn((ids: string[]) => {
    draft = removeResources(draft, ids);
  });
  const onRemoveEdges = vi.fn((ids: string[]) => {
    draft = removeConnections(draft, ids);
  });
  renderToStaticMarkup(
    <ScaleCanvas
      draft={draft}
      selection={null}
      onSelect={vi.fn()}
      onConnect={vi.fn()}
      onMove={vi.fn()}
      onRemoveNodes={onRemoveNodes}
      onRemoveEdges={onRemoveEdges}
      fitRequest={{ revision: 0 }}
      {...props}
    />,
  );
  return { current: () => draft, onRemoveNodes, onRemoveEdges };
}

describe("scaling canvas deletion", () => {
  beforeEach(() => {
    flow.props = null;
  });

  it("removes a single instance without treating incident edges as shared route deletions", () => {
    const { current, onRemoveNodes, onRemoveEdges } = renderCanvas();
    const instance = current().nodes.find((node) => node.id === "api-instance-2")!;
    const incidentEdges = current().edges.filter(
      (edge) => edge.source === instance.id || edge.target === instance.id,
    );
    flow.props!.onDelete!({
      nodes: [
        {
          id: instance.id,
          type: "resource",
          position: instance.position,
          data: { resource: instance },
        },
      ],
      edges: incidentEdges,
    });
    expect(onRemoveNodes).toHaveBeenCalledExactlyOnceWith([instance.id]);
    expect(onRemoveEdges).not.toHaveBeenCalled();
    expect(current().nodes).toHaveLength(6);
    expect(current().edges).toHaveLength(8);
    expect(current().edges.some((edge) => edge.target === "api-instance-1")).toBe(true);
    expect(flow.props!.onNodesDelete).toBeUndefined();
    expect(flow.props!.onEdgesDelete).toBeUndefined();
  });

  it("removes only the deliberately selected connection", () => {
    const { current, onRemoveNodes, onRemoveEdges } = renderCanvas();
    const connection = current().edges[0];
    flow.props!.onDelete!({ nodes: [], edges: [connection] });
    expect(onRemoveNodes).not.toHaveBeenCalled();
    expect(onRemoveEdges).toHaveBeenCalledExactlyOnceWith([connection.id]);
    expect(current().nodes).toHaveLength(7);
    expect(current().edges).toHaveLength(11);
    expect(current().edges.some((edge) => edge.id === connection.id)).toBe(false);
    expect(current().edges.filter((edge) => edge.source === connection.source)).toHaveLength(2);
  });

  it("does not update the draft when no elements are deleted", () => {
    const { onRemoveNodes, onRemoveEdges } = renderCanvas();
    flow.props!.onDelete!({ nodes: [], edges: [] });
    expect(onRemoveNodes).not.toHaveBeenCalled();
    expect(onRemoveEdges).not.toHaveBeenCalled();
  });

  it("does not pan the viewport when a node receives focus", () => {
    renderCanvas();
    expect(flow.props!.autoPanOnNodeFocus).toBe(false);
    expect(flow.props!.fitView).toBe(true);
  });

  it("opens only clusters on double-click, keeping standalone databases and applications in the overview", () => {
    const onOpenCluster = vi.fn();
    const { current } = renderCanvas({ onOpenCluster });
    const resources = [
      current().nodes.find((node) => node.id === "postgres")!,
      current().nodes.find((node) => node.id === "api-instance-1")!,
      createResource("postgres", "standalone-postgres"),
      createResource("redis", "standalone-redis"),
    ];
    for (const resource of resources) {
      flow.props!.onNodeDoubleClick!({} as never, {
        id: resource.id,
        type: "resource",
        position: resource.position,
        data: { resource },
      });
    }
    expect(onOpenCluster).toHaveBeenCalledExactlyOnceWith("postgres");
  });

  it("uses replication rules inside a cluster and rejects overview resource connections", () => {
    const resource = createExampleDraft().nodes.find((node) => node.id === "postgres")!;
    if (!isClusterResource(resource)) throw new Error("Expected a cluster");
    renderCanvas({ cluster: setReplicationSource(resource, "replica-1-1", "") });
    expect(
      flow.props!.isValidConnection!({
        source: "primary-1",
        target: "replica-1-1",
        sourceHandle: "out",
        targetHandle: "in",
      }),
    ).toBe(true);
    expect(
      flow.props!.isValidConnection!({
        source: "edge-us",
        target: "api-instance-1",
        sourceHandle: "out",
        targetHandle: "in",
      }),
    ).toBe(false);
  });

  it("restores an existing view without fitting it again", () => {
    const viewport = { x: 140, y: -80, zoom: 0.65 };
    renderCanvas({ defaultViewport: viewport });
    expect(flow.props!.fitView).toBe(false);
    expect(flow.props!.defaultViewport).toEqual(viewport);
  });
});
