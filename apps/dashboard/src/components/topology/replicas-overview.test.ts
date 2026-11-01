import { describe, expect, it } from "vitest";
import type { ClusterDatabase } from "@repo/contracts";
import {
  addClusterDatabases,
  buildDatabaseReplicaTopology,
  buildProjectTopology,
  DEFAULT_TOPOLOGY_NODE_LAYOUT,
  expandDatabaseReplicas,
  topologyPositions,
  type TopologyProject,
} from "./model";

const project: TopologyProject = {
  id: "commerce",
  name: "Commerce",
  framework: "express",
  activeDeploymentId: "live",
};
const database = (patch: Partial<ClusterDatabase> = {}) =>
  ({
    id: "orders",
    name: "Orders",
    projectId: project.id,
    status: "ready",
    config: { engine: "postgres", mode: "cluster", instances: 3 },
    envKey: "DATABASE_URL",
    readEnvKey: "DATABASE_READ_URL",
    observation: {
      primary: "orders-2",
      ready: true,
      pods: [
        {
          name: "orders-1",
          role: "replica",
          ready: true,
          phase: "Running",
          serverName: "Server 1",
        },
        {
          name: "orders-2",
          role: "primary",
          ready: true,
          phase: "Running",
          serverName: "Server 2",
        },
        {
          name: "orders-3",
          role: "replica",
          ready: false,
          phase: "Pending",
          serverName: "Server 3",
        },
      ],
    },
    ...patch,
  }) as ClusterDatabase;
const overview = (...databases: ClusterDatabase[]) =>
  addClusterDatabases(
    buildProjectTopology({ project, services: [], containers: [], connections: [] }),
    project,
    databases,
  );

describe("database replicas in the project overview", () => {
  it("keeps a single-instance database as one card", () => {
    const row = database();
    row.config = { ...row.config, instances: 1 };
    row.observation!.pods = [row.observation!.pods[1]];
    const original = overview(row);
    expect(expandDatabaseReplicas(original, project)).toEqual(original);
  });
  it("shows the three actual members without replacing logical writer/reader bindings", () => {
    const row = database();
    const original = overview(row);
    const snapshot = JSON.stringify(original);
    const expanded = expandDatabaseReplicas(original, project);
    expect(expanded.nodes.filter((node) => node.clusterPod)).toHaveLength(3);
    expect(expanded.nodes.find((node) => node.id === "database:orders")).toMatchObject({
      replicaGroup: true,
      database: row,
    });
    expect(expanded.edges.filter((edge) => edge.scope === "database")).toEqual(
      original.edges.filter((edge) => edge.scope === "database"),
    );
    expect(
      expanded.edges.filter((edge) => edge.scope === "database").map((edge) => edge.target),
    ).toEqual(["database:orders", "database:orders"]);
    const members = expanded.nodes.filter((node) => node.clusterPod);
    expect(members.map((node) => node.description)).toEqual(["Server 1", "Server 2", "Server 3"]);
    expect(members.map((node) => node.state)).toEqual(["running", "running", "starting"]);
    expect(
      members.every(
        (node) =>
          node.parentId === "database:orders" &&
          !node.database &&
          !node.service &&
          !node.replicaStatus,
      ),
    ).toBe(true);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("uses the observed primary through failover instead of StatefulSet ordinals", () => {
    const row = database();
    const before = expandDatabaseReplicas(overview(row), project);
    expect(
      before.edges
        .filter((edge) => edge.scope === "instances")
        .every((edge) => edge.source === "database-pod:orders:orders-2"),
    ).toBe(true);
    row.observation!.primary = "orders-3";
    row.observation!.pods[1].role = "replica";
    row.observation!.pods[2].role = "primary";
    const after = expandDatabaseReplicas(overview(row), project);
    expect(after.nodes.map((node) => node.id)).toEqual(before.nodes.map((node) => node.id));
    expect(
      after.edges
        .filter((edge) => edge.scope === "instances")
        .every((edge) => edge.source === "database-pod:orders:orders-3"),
    ).toBe(true);
    expect(after.nodes.find((node) => node.id === "database-pod:orders:orders-3")?.name).toBe(
      "Primary",
    );
  });

  it("keeps member positions stable when an observation returns the same pods in another order", () => {
    const row = database();
    const before = expandDatabaseReplicas(overview(row), project);
    row.observation!.pods.reverse();
    const after = expandDatabaseReplicas(overview(row), project);
    expect(topologyPositions(after)).toEqual(topologyPositions(before));
  });

  it("does not invent missing members, roles, or a replication source while observations recover", () => {
    const row = database();
    row.observation!.pods = [row.observation!.pods[0]];
    row.observation!.primary = "gone";
    const expanded = expandDatabaseReplicas(overview(row), project);
    expect(expanded.nodes.filter((node) => node.clusterPod)).toHaveLength(1);
    expect(expanded.edges.filter((edge) => edge.scope === "instances")).toEqual([]);
    expect(buildDatabaseReplicaTopology(project, row).edges).toEqual([]);
    row.observation = null;
    const original = overview(row);
    expect(expandDatabaseReplicas(original, project)).toEqual(original);
  });

  it("distinguishes Redis failover voters from data replicas and keeps the detailed view intact", () => {
    const row = database();
    row.config = { ...row.config, engine: "redis", mode: "replication" };
    row.observation!.pods.push({
      ...row.observation!.pods[0],
      name: "sentinel-1",
      role: "sentinel",
    });
    const expanded = expandDatabaseReplicas(overview(row), project);
    expect(expanded.nodes.filter((node) => node.clusterPod)).toHaveLength(3);
    expect(expanded.nodes.some((node) => node.clusterPod?.role === "sentinel")).toBe(false);
    expect(expanded.edges.some((edge) => edge.target.endsWith(":sentinel-1"))).toBe(false);
    expect(
      expanded.nodes.find((node) => node.replicaGroup)?.database?.observation?.pods,
    ).toHaveLength(4);
    expect(
      buildDatabaseReplicaTopology(project, row).nodes.find(
        (node) => node.clusterPod?.role === "sentinel",
      )?.name,
    ).toBe("Failover voter");
  });

  it.each([1, 3, 8])(
    "keeps %i observed members inside each database with no overlapping cards or groups",
    (count) => {
      const first = database();
      first.observation!.pods = Array.from({ length: count }, (_, index) => ({
        ...first.observation!.pods[index % 3],
        name: `pod-${index}`,
        role: index === 0 ? "primary" : "replica",
      }));
      first.observation!.primary = "pod-0";
      const second = { ...first, id: "sessions", name: "Sessions" };
      const expanded = expandDatabaseReplicas(overview(first, second), project);
      const positions = topologyPositions(expanded);
      expect(new Set(expanded.nodes.map((node) => node.id)).size).toBe(expanded.nodes.length);
      for (const group of expanded.nodes.filter((node) => node.replicaGroup)) {
        const members = expanded.nodes.filter((node) => node.parentId === group.id);
        expect(members).toHaveLength(count);
        for (const member of members) {
          expect(expanded.nodes.indexOf(group)).toBeLessThan(expanded.nodes.indexOf(member));
          const pos = positions[member.id];
          expect(pos.x).toBeGreaterThanOrEqual(0);
          expect(pos.y).toBeGreaterThanOrEqual(72);
          expect(pos.x + DEFAULT_TOPOLOGY_NODE_LAYOUT.width).toBeLessThanOrEqual(
            group.layoutWidth!,
          );
          expect(pos.y + DEFAULT_TOPOLOGY_NODE_LAYOUT.height).toBeLessThanOrEqual(
            group.layoutHeight!,
          );
          for (const other of members.filter((node) => node.id !== member.id)) {
            const otherPos = positions[other.id];
            expect(
              Math.abs(pos.x - otherPos.x) >= DEFAULT_TOPOLOGY_NODE_LAYOUT.width ||
                Math.abs(pos.y - otherPos.y) >= DEFAULT_TOPOLOGY_NODE_LAYOUT.height,
            ).toBe(true);
          }
        }
      }
      const [a, b] = expanded.nodes.filter((node) => node.replicaGroup);
      expect(Math.abs(positions[a.id].y - positions[b.id].y)).toBeGreaterThanOrEqual(
        (a.layoutHeight! + b.layoutHeight!) / 2,
      );
      const ids = new Set(expanded.nodes.map((node) => node.id));
      expect(expanded.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(
        true,
      );
    },
  );
});
