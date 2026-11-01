import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import ScaleInspector from "./ScaleInspector";
import { ResourceNode } from "./ResourceNode";
import {
  createExampleDraft,
  createResource,
  configureService,
  isClusterResource,
  serviceInstances,
  type ScaleDraft,
  type ScaleSelection,
} from "./topology";

const noop = () => {};
function render(id: string, draft: ScaleDraft = createExampleDraft()) {
  return renderToStaticMarkup(
    <ScaleInspector
      draft={draft}
      selection={{ type: "node", id }}
      onUpdate={noop}
      onUpdateService={noop}
      onSelect={noop}
      onConnect={noop}
      onRemoveNodes={noop}
      onRemoveEdges={noop}
      onClose={noop}
      onOpenCluster={noop}
    />,
  );
}

describe("scaling panels", () => {
  it("puts load balancing, health checks, and TLS inside OpenShip Edge", () => {
    const html = render("edge-us");
    expect(html).toContain("OpenShip Edge");
    expect(html).toContain("TLS termination");
    expect(html).toContain("Balancing algorithm");
    expect(html).toContain("Health check path");
    expect(html).toContain("no separate load balancer");
  });
  it("configures all replicas from any individual application node", () => {
    const html = render("api-instance-2");
    expect(html).toContain("api-2");
    expect(html).toContain("Application name");
    expect(html).toContain("Application type");
    expect(html).toContain("Each instance is a separate node");
    expect(html).toContain("Increase instances");
    expect(html).toContain("Remove this instance");
    expect(html).toContain("Remove application");
    expect(html).not.toContain("Node.js");
  });
  it("uses the shared platform controls and normal card typography", () => {
    const html = render("api-instance-1");
    expect(html).toContain("h-full");
    expect(html).toContain("scale-resource-icon");
    expect(html).toContain("text-sm");
    expect(html).toContain("focus-visible:ring-ring/40");
    expect(html).toContain('role="switch"');
    expect(html).not.toContain("scale-switch");
    expect(html).not.toContain("scale-accent");
    expect(html).not.toContain("scale-stepper");
    expect(html).not.toContain("h-[640px]");
  });
  it("renders one simple endpoint per canvas node, not a replica list inside a node", () => {
    const draft = createExampleDraft();
    const resource = serviceInstances(draft, "api")[1];
    const html = renderToStaticMarkup(
      <ReactFlowProvider>
        <ResourceNode
          id={resource.id}
          data={{ resource, service: draft.services[0] }}
          type="resource"
          selected={false}
          isConnectable
          dragging={false}
          draggable
          selectable
          deletable
          zIndex={0}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </ReactFlowProvider>,
    );
    expect(html).toContain("api-2");
    expect(html).toContain("Instance 2");
    expect(html).toContain(":3000");
    expect(html).not.toContain("api-1");
    expect(html).not.toContain("api-3");
    expect(html).not.toContain("scale-instance-list");
  });
  it("shows bounded autoscaling as a draft", () => {
    const draft = createExampleDraft();
    const html = render(
      "api-instance-1",
      configureService(draft, { ...draft.services[0], autoscale: true }),
    );
    expect(html).toContain("Initial instances");
    expect(html).toContain("Minimum instances");
    expect(html).toContain("Maximum instances");
    expect(html).toContain("No autoscaler is running.");
  });
  it("retains PostgreSQL single-writer semantics and replica-gated failover", () => {
    const draft = createExampleDraft();
    draft.nodes = draft.nodes.map((node) =>
      isClusterResource(node) && node.kind === "postgres" ? { ...node, replicas: 0, failover: false } : node,
    );
    const html = render("postgres", draft);
    expect(html).toContain("not multi-primary or write sharding");
    expect(html).toContain("backend orchestration");
    expect(html).toContain("Add a read replica to plan failover.");
    expect(html).toMatch(/role="switch"[^>]*disabled=""/);
  });
  it("shows automatic Redis replicas while keeping slot detail unmounted", () => {
    const html = render("redis");
    expect(html).toContain("6 Redis nodes");
    expect(html).toContain("16,384 hash slots");
    expect(html).toContain("cluster-aware Redis client");
    expect(html).toContain("Slot allocation");
    expect(html).not.toContain("5460");
  });
  it.each<ScaleSelection>([
    null,
    { type: "edge", id: "connection" },
    { type: "node", id: "missing" },
  ])("does not mount a panel without a selected node (%j)", (selection) => {
    const draft = createExampleDraft();
    const html = renderToStaticMarkup(
      <ScaleInspector
        draft={draft}
        selection={selection}
        onUpdate={noop}
        onUpdateService={noop}
        onSelect={noop}
        onConnect={noop}
        onRemoveNodes={noop}
        onRemoveEdges={noop}
        onClose={noop}
      />,
    );
    expect(html).toBe("");
  });
  it.each(["postgres", "redis"])("configures %s as a cluster", (id) => {
    const html = render(id);
    expect(html).toContain("Cluster name");
    expect(html).toContain("Engine");
    expect(html).toContain(id === "postgres" ? "PostgreSQL cluster" : "Redis cluster");
    expect(html).not.toContain("Plan overview");
  });
  it.each(["postgres", "redis"] as const)("configures standalone %s without cluster controls", (kind) => {
    const resource = createResource(kind, "standalone");
    const draft: ScaleDraft = { version: 2, services: [], nodes: [resource], edges: [] };
    const html = render(resource.id, draft);
    expect(html).toContain("Database name");
    expect(html).toContain("Standalone");
    expect(html).toContain("Instance resources");
    expect(html).toContain("vCPU");
    expect(html).toContain("Memory");
    expect(html.includes("Storage (GB)")).toBe(kind === "postgres");
    for (const label of ["Cluster name", "Open cluster", "Read replicas", "Primary shards", "Slot allocation"])
      expect(html).not.toContain(label);
  });
});
