import { describe, expect, it } from "vitest";

import {
  buildServiceTopology,
  type ServiceTopologyContainerInput,
  type ServiceTopologyServiceInput,
} from "./service-topology";

function service(
  id: string,
  name: string,
  overrides: Partial<ServiceTopologyServiceInput> = {},
): ServiceTopologyServiceInput {
  return { id, name, ...overrides };
}

describe("buildServiceTopology", () => {
  it("returns an empty topology for an empty service list", () => {
    expect(buildServiceTopology([])).toEqual({
      nodes: [],
      edges: [],
      unresolvedDependencies: [],
    });
  });

  it("creates an isolated node using the service id as identity", () => {
    expect(buildServiceTopology([service("svc_api", "api")])).toEqual({
      nodes: [
        {
          id: "svc_api",
          serviceId: "svc_api",
          name: "api",
          kind: null,
          status: null,
        },
      ],
      edges: [],
      unresolvedDependencies: [],
    });
  });

  it("preserves dependent and dependency roles in a linear topology", () => {
    const topology = buildServiceTopology([
      service("svc_api", "api", { dependsOn: ["db"] }),
      service("svc_db", "db"),
    ]);

    expect(topology.edges).toEqual([
      {
        id: "depends-on:svc_api:svc_db",
        dependentId: "svc_api",
        dependencyId: "svc_db",
        relation: "depends-on",
      },
    ]);
  });

  it("represents branching dependencies", () => {
    const topology = buildServiceTopology([
      service("svc_api", "api", { dependsOn: ["db", "cache"] }),
      service("svc_cache", "cache"),
      service("svc_db", "db"),
    ]);

    expect(topology.edges).toEqual([
      {
        id: "depends-on:svc_api:svc_cache",
        dependentId: "svc_api",
        dependencyId: "svc_cache",
        relation: "depends-on",
      },
      {
        id: "depends-on:svc_api:svc_db",
        dependentId: "svc_api",
        dependencyId: "svc_db",
        relation: "depends-on",
      },
    ]);
  });

  it("represents a diamond with a shared dependency", () => {
    const topology = buildServiceTopology([
      service("svc_gateway", "gateway", { dependsOn: ["api", "worker"] }),
      service("svc_api", "api", { dependsOn: ["db"] }),
      service("svc_worker", "worker", { dependsOn: ["db"] }),
      service("svc_db", "db"),
    ]);

    expect(topology.edges).toHaveLength(4);
    expect(topology.edges).toContainEqual({
      id: "depends-on:svc_api:svc_db",
      dependentId: "svc_api",
      dependencyId: "svc_db",
      relation: "depends-on",
    });
    expect(topology.edges).toContainEqual({
      id: "depends-on:svc_worker:svc_db",
      dependentId: "svc_worker",
      dependencyId: "svc_db",
      relation: "depends-on",
    });
  });

  it("deduplicates repeated dependency declarations", () => {
    const topology = buildServiceTopology([
      service("svc_api", "api", { dependsOn: ["db", "db", "db"] }),
      service("svc_db", "db"),
    ]);

    expect(topology.edges).toHaveLength(1);
    expect(topology.unresolvedDependencies).toEqual([]);
  });

  it("deduplicates repeated unresolved dependency declarations", () => {
    const topology = buildServiceTopology([
      service("svc_api", "api", { dependsOn: ["missing", "missing"] }),
    ]);

    expect(topology.unresolvedDependencies).toEqual([
      {
        serviceId: "svc_api",
        serviceName: "api",
        dependencyName: "missing",
        reason: "missing",
        candidateServiceIds: [],
      },
    ]);
  });

  it("reports a missing dependency without creating an edge or synthetic node", () => {
    const topology = buildServiceTopology([service("svc_api", "api", { dependsOn: ["db"] })]);

    expect(topology.nodes).toHaveLength(1);
    expect(topology.edges).toEqual([]);
    expect(topology.unresolvedDependencies).toEqual([
      {
        serviceId: "svc_api",
        serviceName: "api",
        dependencyName: "db",
        reason: "missing",
        candidateServiceIds: [],
      },
    ]);
  });

  it("reports duplicate service names as ambiguous with sorted candidates", () => {
    const topology = buildServiceTopology([
      service("svc_z", "db"),
      service("svc_api", "api", { dependsOn: ["db"] }),
      service("svc_a", "db"),
    ]);

    expect(topology.edges).toEqual([]);
    expect(topology.unresolvedDependencies).toEqual([
      {
        serviceId: "svc_api",
        serviceName: "api",
        dependencyName: "db",
        reason: "ambiguous",
        candidateServiceIds: ["svc_a", "svc_z"],
      },
    ]);
  });

  it("preserves both relationships in a dependency cycle", () => {
    const topology = buildServiceTopology([
      service("svc_a", "A", { dependsOn: ["B"] }),
      service("svc_b", "B", { dependsOn: ["A"] }),
    ]);

    expect(topology.edges).toEqual([
      {
        id: "depends-on:svc_a:svc_b",
        dependentId: "svc_a",
        dependencyId: "svc_b",
        relation: "depends-on",
      },
      {
        id: "depends-on:svc_b:svc_a",
        dependentId: "svc_b",
        dependencyId: "svc_a",
        relation: "depends-on",
      },
    ]);
  });

  it("preserves a self-dependency", () => {
    const topology = buildServiceTopology([service("svc_a", "A", { dependsOn: ["A"] })]);

    expect(topology.edges).toEqual([
      {
        id: "depends-on:svc_a:svc_a",
        dependentId: "svc_a",
        dependencyId: "svc_a",
        relation: "depends-on",
      },
    ]);
  });

  it("copies runtime statuses verbatim and leaves an absent row null", () => {
    const topology = buildServiceTopology(
      [
        service("svc_running", "running"),
        service("svc_failed", "failed"),
        service("svc_none", "none"),
      ],
      [
        { serviceId: "svc_running", status: "running" },
        { serviceId: "svc_failed", status: "failed" },
      ],
    );

    expect(topology.nodes).toEqual([
      expect.objectContaining({ serviceId: "svc_failed", status: "failed" }),
      expect.objectContaining({ serviceId: "svc_none", status: null }),
      expect.objectContaining({ serviceId: "svc_running", status: "running" }),
    ]);
  });

  it('preserves an explicit "unknown" runtime status', () => {
    const topology = buildServiceTopology(
      [service("svc_api", "api")],
      [{ serviceId: "svc_api", status: "unknown" }],
    );

    expect(topology.nodes[0].status).toBe("unknown");
  });

  it("handles duplicate container rows without status priority semantics", () => {
    const services = [service("svc_same", "same"), service("svc_conflict", "conflict")];
    const topology = buildServiceTopology(services, [
      { serviceId: "svc_same", status: "running" },
      { serviceId: "svc_same", status: "running" },
      { serviceId: "svc_conflict", status: "running" },
      { serviceId: "svc_conflict", status: "failed" },
      { serviceId: "svc_orphan", status: "starting" },
    ]);

    expect(topology.nodes.find((node) => node.id === "svc_same")?.status).toBe("running");
    expect(topology.nodes.find((node) => node.id === "svc_conflict")?.status).toBeNull();
    expect(topology.nodes.some((node) => node.id === "svc_orphan")).toBe(false);
  });

  it("treats null and omitted dependsOn as empty", () => {
    const topology = buildServiceTopology([
      service("svc_null", "null", { dependsOn: null }),
      service("svc_omitted", "omitted"),
    ]);

    expect(topology.edges).toEqual([]);
    expect(topology.unresolvedDependencies).toEqual([]);
  });

  it("preserves compose and monorepo kinds without normalization", () => {
    const topology = buildServiceTopology([
      service("svc_compose", "compose", { kind: "compose" }),
      service("svc_monorepo", "monorepo", { kind: "monorepo" }),
    ]);

    expect(topology.nodes).toEqual([
      expect.objectContaining({ id: "svc_compose", kind: "compose" }),
      expect.objectContaining({ id: "svc_monorepo", kind: "monorepo" }),
    ]);
  });

  it("reports empty, whitespace-only, and padded dependency names as missing", () => {
    const topology = buildServiceTopology([
      service("svc_api", "api", { dependsOn: ["", "   ", " db "] }),
      service("svc_db", "db"),
    ]);

    expect(topology.edges).toEqual([]);
    expect(topology.unresolvedDependencies).toEqual([
      expect.objectContaining({ dependencyName: "", reason: "missing" }),
      expect.objectContaining({ dependencyName: "   ", reason: "missing" }),
      expect.objectContaining({ dependencyName: " db ", reason: "missing" }),
    ]);
  });

  it("keeps unusual service names out of node and edge identity", () => {
    const topology = buildServiceTopology([
      service("svc_consumer", "consumer", { dependsOn: ["db:prod/α"] }),
      service("svc_database", "db:prod/α"),
    ]);

    expect(topology.nodes.find((node) => node.name === "db:prod/α")?.id).toBe("svc_database");
    expect(topology.edges[0].id).toBe("depends-on:svc_consumer:svc_database");
  });

  it("orders nodes by sortOrder, name, and id with nullish sortOrder defaulting to zero", () => {
    const topology = buildServiceTopology([
      service("svc_z", "same", { sortOrder: 0 }),
      service("svc_later", "later", { sortOrder: 2 }),
      service("svc_a", "same", { sortOrder: null }),
      service("svc_first", "first", { sortOrder: -1 }),
    ]);

    expect(topology.nodes.map((node) => node.id)).toEqual([
      "svc_first",
      "svc_a",
      "svc_z",
      "svc_later",
    ]);
  });

  it("returns deeply identical output when service order is shuffled", () => {
    const services = [
      service("svc_api", "api", { dependsOn: ["db", "cache"], sortOrder: 2 }),
      service("svc_db", "db", { sortOrder: 1 }),
      service("svc_cache", "cache", { sortOrder: 1 }),
    ];

    expect(buildServiceTopology(services)).toEqual(
      buildServiceTopology([services[2], services[0], services[1]]),
    );
  });

  it("returns deeply identical output when dependsOn order is shuffled", () => {
    const dependencies = [service("svc_db", "db"), service("svc_cache", "cache")];

    expect(
      buildServiceTopology([
        service("svc_api", "api", { dependsOn: ["db", "missing", "cache"] }),
        ...dependencies,
      ]),
    ).toEqual(
      buildServiceTopology([
        service("svc_api", "api", { dependsOn: ["cache", "db", "missing"] }),
        ...dependencies,
      ]),
    );
  });

  it("returns deeply identical output when container order is shuffled", () => {
    const services = [service("svc_a", "a"), service("svc_b", "b")];
    const containers: ServiceTopologyContainerInput[] = [
      { serviceId: "svc_a", status: "running" },
      { serviceId: "svc_b", status: "failed" },
    ];

    expect(buildServiceTopology(services, containers)).toEqual(
      buildServiceTopology(services, [containers[1], containers[0]]),
    );
  });

  it("does not mutate services, service objects, or dependsOn arrays", () => {
    const dependsOn = ["db", "cache", "db"];
    const services: ServiceTopologyServiceInput[] = [
      service("svc_api", "api", { dependsOn, sortOrder: 2 }),
      service("svc_db", "db", { sortOrder: 1 }),
      service("svc_cache", "cache", { sortOrder: 1 }),
    ];
    const before = structuredClone(services);

    buildServiceTopology(services);

    expect(services).toEqual(before);
    expect(dependsOn).toEqual(["db", "cache", "db"]);
  });

  it("does not mutate the containers array or its objects", () => {
    const containers: ServiceTopologyContainerInput[] = [
      { serviceId: "svc_api", status: "running" },
      { serviceId: "svc_api", status: "failed" },
    ];
    const before = structuredClone(containers);

    buildServiceTopology([service("svc_api", "api")], containers);

    expect(containers).toEqual(before);
  });
});
