import { describe, expect, it } from "vitest";
import type { ProjectConnection } from "@/lib/api/connections";
import type { Service, ServiceContainer } from "@/lib/api/services";
import { serviceFromInput } from "./changes";
import {
  buildProjectTopology,
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
