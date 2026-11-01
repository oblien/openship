import { describe, expect, it } from "vitest";
import type { ClusterDatabase } from "@repo/contracts";
import type { ProjectConnection } from "@/lib/api/connections";
import type { Service, ServiceContainer } from "@/lib/api/services";
import { serviceFromInput } from "./changes";
import {
  buildProjectTopology,
  addClusterDatabases,
  buildDatabaseReplicaTopology,
  databaseInstanceStatus,
  buildClusterReplicaTopology,
  dependencyProblem,
  servicePresentation,
  topologyPositions,
  type TopologyProject,
} from "./model";

const project: TopologyProject = {
  id: "p1",
  name: "Store",
  framework: "docker-compose",
  activeDeploymentId: "d1",
  environmentName: "Production",
  activeVersion: 8,
};
const api = serviceFromInput("api", {
  name: "api",
  image: "acme/api:v3",
  exposed: true,
  exposedPort: "3000",
  dependsOn: ["db"],
});
const worker = serviceFromInput("worker", { name: "worker", image: "acme/worker:v2" });
const db = serviceFromInput("db", { name: "db", image: "postgres:16" });
const services = [api, worker, db];
const containers: ServiceContainer[] = [
  {
    serviceId: "api",
    serviceName: "api",
    containerId: "c-api",
    status: "running",
    ip: "172.1.0.2",
    hostPort: 13000,
    imageRef: "acme/api@sha256:abc",
    duplicates: ["orphan1", "orphan2"],
  },
];
const connection: ProjectConnection = {
  id: "link1",
  sourceProjectId: "shared",
  sourceName: "Shared data",
  sourceAppTemplateId: "postgres",
  targetProjectId: "p1",
  outputId: "database-url",
  envKey: "DATABASE_URL",
  mode: "internal",
};
const graph = (extra: Partial<Parameters<typeof buildProjectTopology>[0]> = {}) =>
  buildProjectTopology({ project, services, containers, connections: [], ...extra });

describe("production project topology", () => {
  it("shows database replication roles and separate private writer/reader bindings", () => {
    const application = { ...project, framework: "express" };
    const database = {
      id: "orders",
      projectId: project.id,
      name: "Orders",
      status: "ready",
      config: { engine: "postgres", mode: "cluster", instances: 3 },
      observation: {
        ready: true,
        pods: [
          { name: "primary", role: "primary", ready: true, phase: "Running" },
          { name: "reader", role: "replica", ready: false, phase: "Pending" },
        ],
        primary: "primary",
      },
      envKey: "DATABASE_URL",
      readEnvKey: "DATABASE_READ_URL",
    } as ClusterDatabase;
    const view = addClusterDatabases(graph({ project: application }), application, [database]);
    expect(view.nodes.find((node) => node.database?.id === "orders")?.description).toBe(
      "PostgreSQL · 1 primary + 2 read replicas",
    );
    expect(
      view.edges.filter((edge) => edge.databaseId === "orders").map((edge) => edge.label),
    ).toEqual(["DATABASE_URL", "DATABASE_READ_URL"]);
    expect(
      view.edges.find((edge) => edge.id === "database-read-connection:orders")?.description,
    ).toContain("replicas may lag");
    const replicas = buildDatabaseReplicaTopology(application, database);
    expect(replicas.nodes.map((node) => node.name)).toEqual(["Primary", "Replica"]);
    expect(replicas.nodes[1].state).toBe("starting");
    expect(replicas.edges[0].description).toContain("PostgreSQL streaming replication");
    database.config = { ...database.config, engine: "redis", mode: "replication" };
    database.observation!.pods.push({
      name: "voter",
      role: "sentinel",
      ready: true,
      phase: "Running",
      serverId: null,
      serverName: null,
      nodeName: null,
      restarts: 0,
    });
    const redis = addClusterDatabases({ nodes: [], edges: [] }, application, [database]);
    expect(redis.nodes[0].description).toBe("Redis · 1 primary + 2 replicas");
    expect(buildDatabaseReplicaTopology(application, database).edges[0].description).toContain(
      "Redis asynchronous replication",
    );
    expect(databaseInstanceStatus(database)).toEqual({ desired: 3, ready: 1, settled: false });
    expect(
      buildDatabaseReplicaTopology(application, database).nodes.find(
        (node) => node.clusterPod?.name === "voter",
      )?.name,
    ).toBe("Failover voter");
    expect(
      buildDatabaseReplicaTopology(application, database).edges.find((edge) =>
        edge.target.endsWith(":voter"),
      )?.label,
    ).toBe("Failover monitoring");
  });

  it("shows active runtime roles alongside the application and their live replica state", () => {
    const result = graph({
      project: { ...project, framework: "laravel" },
      services: [db],
      roles: {
        deploymentId: "d1",
        error: null,
        roles: [
          {
            name: "queue",
            kind: "worker",
            replicas: 2,
            containers: [
              { replica: 1, containerId: "queue-1", status: "running", restartCount: 0 },
              { replica: 2, containerId: "queue-2", status: "restarting", restartCount: 4 },
            ],
          },
        ],
      },
    });
    const role = result.nodes.find((node) => node.kind === "role")!;
    expect(role.name).toBe("queue");
    expect(role.state).toBe("restarting");
    expect(role.instances).toBe(1);
    expect(role.role?.containers[1].restartCount).toBe(4);
    expect(result.edges.find((edge) => edge.target === role.id)).toMatchObject({
      scope: "roles",
      readOnly: true,
    });
    expect(result.nodes.filter((node) => node.kind === "service")).toHaveLength(1);
  });

  it.each([
    ["running", "stopped", "failed", 1],
    ["running", "starting", "starting", 1],
    ["running", "unknown", "unknown", undefined],
    ["stopped", "stopped", "stopped", 0],
  ] as const)(
    "summarizes observed role replicas %s/%s as %s",
    (first, second, state, instances) => {
      const result = graph({
        roles: {
          deploymentId: "d1",
          error: null,
          roles: [
            {
              name: "queue",
              kind: "worker",
              replicas: 2,
              containers: [
                { replica: 1, containerId: "queue-1", status: first, restartCount: 0 },
                { replica: 2, containerId: "queue-2", status: second, restartCount: 0 },
              ],
            },
          ],
        },
      });
      const role = result.nodes.find((node) => node.kind === "role")!;
      expect(role.state).toBe(state);
      expect(role.instances).toBe(instances);
    },
  );

  it("never projects a retired deployment's roles onto the current graph", () => {
    expect(
      graph({
        roles: {
          deploymentId: "retired",
          error: null,
          roles: [{ name: "old-worker", kind: "worker", replicas: 1, containers: [] }],
        },
      }).nodes.some((node) => node.kind === "role"),
    ).toBe(false);
  });
  it("shows only observed cluster replicas and excludes unready pods from active service edges", () => {
    const application = {
      ...project,
      framework: "express",
      deployTarget: "cluster" as const,
      clusterId: "cluster",
    };
    const status = {
      desired: 3,
      ready: 1,
      available: 1,
      updated: 2,
      generation: 2,
      observedGeneration: 2,
      message: null,
      pods: [
        {
          name: "api-1",
          nodeName: "a",
          serverId: "server-a",
          serverName: "Production A",
          ready: true,
          phase: "Running",
          restarts: 0,
        },
        { name: "api-2", nodeName: "b", ready: false, phase: "ImagePullBackOff", restarts: 0 },
      ],
    };
    const main = graph({ project: application, services: [], cluster: status });
    expect(main.nodes.find((node) => node.kind === "application")).toMatchObject({
      instances: 1,
      state: "starting",
    });
    const replicas = buildClusterReplicaTopology(application, status);
    expect(replicas.nodes.filter((node) => node.kind === "instance")).toHaveLength(2);
    expect(replicas.edges.map((edge) => edge.enabled)).toEqual([true, false]);
    expect(replicas.nodes.find((node) => node.clusterPod?.name === "api-2")?.state).toBe("failed");
    expect(replicas.nodes.find((node) => node.id === "pod:api-1")).toMatchObject({
      name: "Instance 1",
      description: "Production A",
      clusterPod: { serverId: "server-a" },
    });
    expect(replicas.nodes[0]).toMatchObject({ kind: "traffic", name: "Traffic distribution" });
    expect(replicas.edges.every((edge) => edge.scope === "instances")).toBe(true);
    const positions = topologyPositions(replicas);
    expect(positions["cluster-service:p1"].x).toBeLessThan(positions["pod:api-1"].x);
    const workers = buildClusterReplicaTopology(
      { ...application, options: { workloadType: "worker" } },
      status,
    );
    expect(workers.edges).toEqual([]);
    expect(workers.nodes.every((node) => node.kind === "instance")).toBe(true);
    expect(
      graph({ project: application, services: [] }).nodes.find(
        (node) => node.kind === "application",
      )?.instances,
    ).toBeUndefined();
  });
  it("starts empty for a real services project with no service rows", () => {
    expect(graph({ services: [], containers: [], connections: [] })).toEqual({
      nodes: [],
      edges: [],
    });
  });
  it("keeps one selected startup dependency scoped to that service", () => {
    const dependencies = graph().edges.filter((edge) => edge.kind === "dependency");
    expect(dependencies).toHaveLength(1);
    expect(dependencies[0]).toMatchObject({
      source: "service:api",
      target: "service:db",
      serviceId: "api",
      label: "Starts after",
    });
    expect(dependencies.some((edge) => edge.source === "service:worker")).toBe(false);
  });
  it("routes only publicly exposed services", () => {
    expect(
      graph()
        .edges.filter((edge) => edge.kind === "route")
        .map((edge) => edge.target),
    ).toEqual(["service:api"]);
  });
  it("uses the actual runtime image and never counts duplicate containers as replicas", () => {
    const node = graph().nodes.find((node) => node.serviceId === "api");
    expect(node).toMatchObject({ instances: 1, image: "acme/api@sha256:abc", state: "running" });
    expect(node?.version).toBeUndefined();
  });
  it("does not turn a missing host observation into stopped or zero instances", () => {
    const node = graph({ containers: null }).nodes.find((node) => node.serviceId === "api");
    expect(node).toMatchObject({ state: "unknown" });
    expect(node?.instances).toBeUndefined();
  });
  it("does not count a restarting container as a running instance", () => {
    const node = graph({ containers: [{ ...containers[0], status: "restarting" }] }).nodes.find(
      (node) => node.serviceId === "api",
    );
    expect(node).toMatchObject({ state: "restarting", instances: 0 });
  });
  it("does not turn a PostgreSQL image into a cluster", () => {
    const node = graph().nodes.find((node) => node.serviceId === "db");
    expect(node).toMatchObject({ kind: "service", description: "PostgreSQL" });
    expect(node).not.toHaveProperty("replicas");
    expect(
      servicePresentation({ image: "registry.internal:5000/library/postgres:16", build: null })
        .tone,
    ).toBe("postgres");
  });
  it("draws environment bindings once without inventing API-level connections", () => {
    const result = graph({ connections: [connection] });
    const bindings = result.edges.filter((edge) => edge.kind === "binding");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      source: "environment:p1",
      target: "linked:shared:app",
      label: "DATABASE_URL",
    });
    expect(result.nodes.find((node) => node.kind === "linked")).toMatchObject({
      projectId: "shared",
      ownerName: "Shared data",
      state: "unknown",
    });
  });
  it("ignores connections for a different environment and preserves source-service identity", () => {
    const result = graph({
      connections: [
        { ...connection, targetProjectId: "other" },
        { ...connection, id: "s1", sourceServiceId: "db1", sourceServiceName: "DB one" },
        { ...connection, id: "s2", sourceServiceId: "db2", sourceServiceName: "DB two" },
      ],
    });
    expect(result.nodes.filter((node) => node.kind === "linked").map((node) => node.id)).toEqual([
      "linked:shared:db1",
      "linked:shared:db2",
    ]);
    expect(result.edges.filter((edge) => edge.kind === "binding")).toHaveLength(2);
  });
  it("keeps the main application beside its companion services", () => {
    const result = graph({ project: { ...project, framework: "nextjs" } });
    expect(result.nodes.find((node) => node.kind === "application")).toMatchObject({
      id: "application:p1",
      version: "v8",
      state: "unknown",
    });
    expect(result.nodes.filter((node) => node.kind === "service")).toHaveLength(3);
  });
  it("does not duplicate an application materialized as a service row", () => {
    const main = serviceFromInput("main", {
      name: "store",
      kind: "monorepo",
      rootDirectory: ".",
      framework: "nextjs",
    });
    const result = graph({
      project: { ...project, framework: "nextjs", projectType: "monorepo" },
      services: [main, db],
    });
    expect(result.nodes.filter((node) => node.kind === "application")).toHaveLength(0);
    expect(
      result.nodes.filter((node) => node.kind === "service").map((node) => node.serviceId),
    ).toEqual(["main", "db"]);
  });
  it("uses service rows for migrated and cloned projects without inventing a main app", () => {
    const result = graph({
      project: { ...project, framework: "unknown", projectType: "services" },
    });
    expect(result.nodes.filter((node) => node.kind === "application")).toHaveLength(0);
    expect(result.nodes.filter((node) => node.kind === "service")).toHaveLength(3);
  });
  it("honors a worker workload even when it has no web server", () => {
    const result = graph({
      project: {
        ...project,
        framework: "node",
        options: { workloadType: "worker", hasServer: false },
      },
      services: [],
    });
    expect(result.nodes.find((node) => node.kind === "application")?.description).toBe("Worker");
  });
  it("has a deterministic layout independent of the runtime refresh", () => {
    expect(topologyPositions(graph())).toEqual(topologyPositions(graph({ containers: null })));
  });
  it("checks service dependency cycles and identity", () => {
    expect(dependencyProblem(services, "worker", "db")).toBeNull();
    expect(dependencyProblem(services, "api", "db")).toContain("already exists");
    expect(dependencyProblem(services, "db", "api")).toContain("circular");
    expect(dependencyProblem(services, "db", "db")).toContain("itself");
    expect(dependencyProblem(services, "foreign", "db")).toContain("this environment");
  });
});
