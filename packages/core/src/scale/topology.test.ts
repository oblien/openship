import { describe, expect, it } from "vitest";
import { getClusterTopology } from "./clusterTopology";
import {
  ALGORITHMS,
  DATABASE_KINDS,
  MAX_CONNECTIONS,
  MAX_RESOURCES,
  RESOURCE_KINDS,
  addService,
  configureConnection,
  configureService,
  connectResources,
  connectionError,
  connectionLabel,
  createExampleDraft,
  createResource,
  createService,
  draftReducer,
  draftStorageKey,
  getConnectionSettings,
  instanceCount,
  isClusterResource,
  isDatabaseKind,
  layoutDraft,
  parseDraft,
  redisSlotRanges,
  removeConnections,
  removeResources,
  reviewDraft,
  serviceInstances,
  summarizeDraft,
  type ConnectionOptions,
  type DraftHistory,
  type ScaleDraft,
} from "./topology";

const empty = (): ScaleDraft => ({ version: 2, services: [], nodes: [], edges: [] });
const history = (): DraftHistory => ({ present: createExampleDraft(), past: [], future: [] });

describe("OpenShip Edge topology", () => {
  it("classifies PostgreSQL and Redis as database engines", () => {
    expect(RESOURCE_KINDS.filter(isDatabaseKind)).toEqual(DATABASE_KINDS);
    expect(isDatabaseKind("edge")).toBe(false);
    expect(isDatabaseKind("service")).toBe(false);
  });
  it("has one gateway type, not separate edge and load-balancer modules", () => {
    expect(RESOURCE_KINDS).toEqual(["edge", "service", "postgres", "redis"]);
    const gateway = createResource("edge", "gateway");
    expect(gateway).toMatchObject({
      kind: "edge",
      tls: true,
      algorithm: "round-robin",
      healthPath: "/health",
      healthInterval: 10,
    });
    expect(Object.keys(ALGORITHMS)).toHaveLength(3);
  });

  it("renders the example as two gateways and three individually connected application instances", () => {
    const draft = createExampleDraft();
    expect(draft.nodes).toHaveLength(7);
    expect(draft.services).toHaveLength(1);
    expect(serviceInstances(draft, "api").map((node) => node.name)).toEqual([
      "api-1",
      "api-2",
      "api-3",
    ]);
    expect(draft.edges).toHaveLength(12);
    for (const node of serviceInstances(draft, "api")) {
      expect(
        draft.edges
          .filter((edge) => edge.target === node.id)
          .map((edge) => edge.source)
          .sort(),
      ).toEqual(["edge-eu", "edge-us"]);
      expect(
        draft.edges
          .filter((edge) => edge.source === node.id)
          .map((edge) => edge.target)
          .sort(),
      ).toEqual(["postgres", "redis"]);
      expect(instanceCount(node)).toBe(1);
      expect(node).not.toHaveProperty("replicas");
      expect(node).not.toHaveProperty("port");
    }
    expect(summarizeDraft(draft)).toEqual({
      gateways: 2,
      applications: 1,
      instances: 3,
      databases: 2,
      total: 14,
    });
    expect(reviewDraft(draft)).toEqual([]);
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it.each(["api", "website", "service"] as const)(
    "supports generic %s applications without a hardcoded runtime",
    (applicationType) => {
      const draft = addService(empty(), { ...createService("app", "app"), applicationType });
      expect(draft.nodes).toHaveLength(3);
      expect(draft.services[0].applicationType).toBe(applicationType);
      expect(JSON.stringify(draft)).not.toContain("Node.js");
      expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
    },
  );

  it("keeps each example independent and places nodes in three distinct columns", () => {
    const draft = createExampleDraft();
    const positions = new Set(draft.nodes.map((node) => `${node.position.x},${node.position.y}`));
    expect(positions.size).toBe(7);
    expect(new Set(draft.nodes.map((node) => node.position.x)).size).toBe(3);
    draft.nodes[0].position.x = 900;
    expect(createExampleDraft().nodes[0].position.x).toBe(0);
    expect(layoutDraft(empty())).toEqual(empty());
  });

  it("changes the edge protocol label with TLS and uses shared application ports", () => {
    const draft = createExampleDraft();
    const resource = draft.nodes[0];
    if (resource.kind !== "edge") throw new Error("Expected a gateway");
    expect(connectionLabel(draft, { ...resource, tls: false })).toBe("HTTP · 80");
    expect(connectionLabel(draft, resource)).toBe("HTTPS · 443");
    const changed = configureService(draft, { ...draft.services[0], port: 8080 });
    expect(connectionLabel(changed, serviceInstances(changed, "api")[0])).toBe("HTTP · 8080");
  });
});

describe("horizontal service scaling", () => {
  it("adds unconnected instances while preserving the existing nodes and connections", () => {
    const original = createExampleDraft();
    const next = configureService(original, original.services[0], 5);
    expect(serviceInstances(next, "api")).toHaveLength(5);
    expect(next.edges).toEqual(original.edges);
    expect(next.nodes).toHaveLength(9);
    expect(original.nodes).toHaveLength(7);
    expect(original.edges).toHaveLength(12);
    expect(parseDraft(JSON.stringify(next))).toEqual(next);
    const restored = configureService(next, next.services[0], 2);
    expect(restored.nodes).toHaveLength(6);
    expect(restored.edges).toHaveLength(8);
    expect(serviceInstances(restored, "api").map((node) => node.id)).toEqual([
      "api-instance-1",
      "api-instance-2",
    ]);
    expect(parseDraft(JSON.stringify(restored))).toEqual(restored);
  });

  it("updates every instance from shared application configuration", () => {
    const draft = createExampleDraft();
    const positions = serviceInstances(draft, "api").map((node) => node.position);
    const next = configureService(draft, {
      ...draft.services[0],
      name: "website",
      applicationType: "website",
      cpu: 2,
      port: 8080,
    });
    expect(serviceInstances(next, "api").map((node) => node.name)).toEqual([
      "website-1",
      "website-2",
      "website-3",
    ]);
    expect(serviceInstances(next, "api").map((node) => node.position)).toEqual(positions);
    expect(next.services[0]).toMatchObject({ applicationType: "website", cpu: 2, port: 8080 });
    expect(parseDraft(JSON.stringify(next))).toEqual(next);
  });

  it("keeps ordinals unique after deleting a middle instance and scaling up", () => {
    const draft = removeResources(createExampleDraft(), ["api-instance-2"]);
    const next = configureService(draft, draft.services[0], 4);
    expect(serviceInstances(next, "api").map((node) => node.ordinal)).toEqual([1, 3, 4, 5]);
    expect(parseDraft(JSON.stringify(next))).toEqual(next);
  });

  it("removes incident routes, adjusts autoscaling bounds, and removes empty applications", () => {
    const initial = createExampleDraft();
    const draft = configureService(initial, {
      ...initial.services[0],
      autoscale: true,
      minReplicas: 3,
    });
    const next = removeResources(draft, ["api-instance-1"]);
    expect(next.services[0].minReplicas).toBe(2);
    expect(next.edges).toHaveLength(8);
    expect(parseDraft(JSON.stringify(next))).toEqual(next);
    const removed = removeResources(
      next,
      serviceInstances(next, "api").map((node) => node.id),
    );
    expect(removed.services).toEqual([]);
    expect(removed.edges).toEqual([]);
  });

  it.each([0, -1, 25, 1.5, NaN])("rejects invalid replica count %s", (count) => {
    const draft = createExampleDraft();
    expect(() => configureService(draft, draft.services[0], count)).toThrow();
    expect(() => addService(empty(), createService("new"), count)).toThrow();
  });

  it("rejects autoscaling outside configured bounds", () => {
    const draft = createExampleDraft();
    expect(() =>
      configureService(
        draft,
        { ...draft.services[0], autoscale: true, minReplicas: 2, maxReplicas: 4 },
        5,
      ),
    ).toThrow("bounds");
  });

  it("checks node capacity when scaling and connection capacity when wiring nodes", () => {
    const draft = createExampleDraft();
    const full = {
      ...draft,
      nodes: [
        ...draft.nodes,
        ...Array.from({ length: MAX_RESOURCES - draft.nodes.length }, (_entry, index) =>
          createResource("edge", `extra-${index}`),
        ),
      ],
    };
    expect(() => configureService(full, draft.services[0], 4)).toThrow("limit");
    expect(() => addService(full, createService("extra-service"))).toThrow("limit");
    const gateways = Array.from({ length: 12 }, (_, index) =>
      createResource("edge", `gateway-${index}`),
    );
    let connected = addService({ ...empty(), nodes: gateways }, createService("api", "api"), 15);
    for (const gateway of gateways)
      for (const instance of serviceInstances(connected, "api"))
        connected = connectResources(connected, gateway.id, instance.id);
    expect(connected.edges).toHaveLength(MAX_CONNECTIONS);
    expect(parseDraft(JSON.stringify(connected))).toEqual(connected);
    expect(configureService(connected, connected.services[0], 16).edges).toEqual(connected.edges);
    expect(() => connectResources(connected, "gateway-0", "gateway-1")).toThrow("connection limit");
  });
});

describe("individual node connections", () => {
  it("connects and disconnects exactly the selected pair without changing sibling instances", () => {
    const draft = createExampleDraft();
    const first = draft.edges.find((edge) => edge.source === "edge-us")!;
    const disconnected = removeConnections(draft, [first.id]);
    expect(disconnected.edges).toEqual(draft.edges.filter((edge) => edge.id !== first.id));
    expect(disconnected.edges.filter((edge) => edge.source === "edge-us")).toHaveLength(2);
    const connected = connectResources(disconnected, first.source, first.target);
    expect(connected.edges).toHaveLength(draft.edges.length);
    expect(connected.edges.at(-1)).toEqual(first);
    const databaseRoute = connected.edges.find((edge) => edge.target === "postgres")!;
    const withoutDatabaseRoute = removeConnections(connected, [databaseRoute.id]);
    expect(withoutDatabaseRoute.edges.filter((edge) => edge.target === "postgres")).toHaveLength(2);
    expect(withoutDatabaseRoute.edges).toEqual(
      connected.edges.filter((edge) => edge.id !== databaseRoute.id),
    );
    expect(parseDraft(JSON.stringify(disconnected))).toEqual(disconnected);
    expect(parseDraft(JSON.stringify(withoutDatabaseRoute))).toEqual(withoutDatabaseRoute);
  });

  it("isolates the routes and scaling of different applications", () => {
    let draft = addService(
      createExampleDraft(),
      { ...createService("web", "web"), applicationType: "website" },
      2,
    );
    draft = connectResources(draft, "edge-us", "web-instance-1");
    const route = draft.edges.find(
      (edge) => edge.source === "edge-us" && edge.target === "api-instance-1",
    )!;
    const next = removeConnections(draft, [route.id]);
    expect(
      next.edges.filter((edge) => edge.source === "edge-us").map((edge) => edge.target),
    ).toEqual(["api-instance-2", "api-instance-3", "web-instance-1"]);
    expect(
      configureService(next, next.services[0], 5).nodes.filter(
        (node) => node.kind === "service" && node.serviceId === "web",
      ),
    ).toHaveLength(2);
  });

  it("keeps each connection's settings independent through scaling, persistence, and undo", () => {
    const original = createExampleDraft();
    const connection = original.edges.find((edge) => edge.target === "postgres")!;
    const options = { label: "Reporting", protocol: "tls" as const, port: 6432, enabled: false };
    const changed = configureConnection(original, connection.id, options);
    expect(changed.edges.find((edge) => edge.id === connection.id)).toEqual({
      ...connection,
      ...options,
    });
    expect(changed.edges.filter((edge) => edge.id !== connection.id)).toEqual(
      original.edges.filter((edge) => edge.id !== connection.id),
    );
    const scaled = configureService(changed, { ...changed.services[0], name: "backend" }, 5);
    expect(scaled.edges).toEqual(changed.edges);
    expect(parseDraft(JSON.stringify(scaled))).toEqual(scaled);
    const after = draftReducer(
      { present: original, past: [], future: [] },
      { type: "change", draft: changed },
    );
    const undone = draftReducer(after, { type: "undo" });
    expect(undone.present).toEqual(original);
    expect(draftReducer(undone, { type: "redo" }).present).toEqual(changed);
  });

  it("resolves defaults for older wires and respects per-connection overrides", () => {
    const draft = createExampleDraft();
    const application = serviceInstances(draft, "api")[0];
    const database = draft.nodes.find((node) => node.id === "postgres")!;
    expect(getConnectionSettings(draft, application)).toEqual({
      label: "",
      protocol: "http",
      port: 3000,
      enabled: true,
    });
    expect(getConnectionSettings(draft, database)).toEqual({
      label: "",
      protocol: "tcp",
      port: 5432,
      enabled: true,
    });
    const connection = draft.edges.find((edge) => edge.target === application.id)!;
    const configured = configureConnection(draft, connection.id, { port: 8080, protocol: "https" });
    const changed = configureService(configured, { ...configured.services[0], port: 9000 });
    expect(connectionLabel(changed, application, changed.edges[0])).toBe("HTTPS · 8080");
    expect(connectionLabel(changed, application)).toBe("HTTP · 9000");
    expect(connectionLabel(draft, database, { protocol: "tls", port: 6432, enabled: false })).toBe(
      "Disabled · PostgreSQL (TLS) · 6432",
    );
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it("ignores disabled connections when checking reachability and restores them when enabled", () => {
    const draft = createExampleDraft();
    const incoming = draft.edges.filter((edge) => edge.target === "api-instance-2");
    const disabled = incoming.reduce(
      (current, edge) => configureConnection(current, edge.id, { enabled: false }),
      draft,
    );
    expect(disabled.edges).toHaveLength(draft.edges.length);
    expect(reviewDraft(disabled).map((issue) => issue.nodeId)).toEqual(["api-instance-2"]);
    expect(reviewDraft(configureConnection(disabled, incoming[0].id, { enabled: true }))).toEqual(
      [],
    );
  });

  it.each([
    { label: "x".repeat(61) },
    { protocol: "http" },
    { protocol: "toString" },
    { port: 0 },
    { port: 65536 },
    { port: 5432.5 },
    { port: "5432" },
    { enabled: "false" },
  ])("rejects invalid database connection settings %j on edits and restore", (patch) => {
    const draft = createExampleDraft();
    const connection = draft.edges.find((edge) => edge.target === "postgres")!;
    expect(() => configureConnection(draft, connection.id, patch as ConnectionOptions)).toThrow(
      "connection settings",
    );
    const invalid = {
      ...draft,
      edges: draft.edges.map((edge) => (edge.id === connection.id ? { ...edge, ...patch } : edge)),
    };
    expect(parseDraft(JSON.stringify(invalid))).toBeNull();
  });

  it("rejects database protocols for HTTP routes and edits of deleted connections", () => {
    const draft = createExampleDraft();
    expect(() => configureConnection(draft, draft.edges[0].id, { protocol: "tcp" })).toThrow(
      "connection settings",
    );
    expect(() => configureConnection(draft, "missing", { port: 80 })).toThrow("no longer exists");
  });

  it("allows edge-to-edge routing but rejects duplicates, loops, and unsupported directions", () => {
    const draft = createExampleDraft();
    expect(connectionError(draft, "edge-us", "edge-eu")).toBeNull();
    const routed = connectResources(draft, "edge-us", "edge-eu");
    expect(connectionError(routed, "edge-eu", "edge-us")).toContain("loop");
    expect(connectionError(draft, "edge-us", "api-instance-1")).toContain("already connected");
    expect(connectionError(draft, "api-instance-1", "edge-us")).not.toBeNull();
    expect(connectionError(draft, "postgres", "redis")).not.toBeNull();
    expect(connectionError(draft, "edge-us", "postgres")).not.toBeNull();
    expect(connectionError(draft, "missing", "edge-us")).toContain("must exist");
    expect(connectionError(draft, "edge-us", "edge-us")).toContain("itself");
  });

  it("detects missing gateway routes for every affected instance and data store", () => {
    const draft = removeResources(createExampleDraft(), ["edge-us", "edge-eu"]);
    expect(reviewDraft(draft).filter((issue) => issue.message.includes("no route"))).toHaveLength(
      5,
    );
    expect(reviewDraft(empty())[0].severity).toBe("warning");
    expect(
      reviewDraft(removeResources(createExampleDraft(), ["edge-eu"])).some((issue) =>
        issue.message.includes("single point of failure"),
      ),
    ).toBe(true);
  });
});

describe("database planning", () => {
  it.each([3, 4, 5, 7, 12])(
    "allocates every Redis slot exactly once across %i shards",
    (shards) => {
      const ranges = redisSlotRanges(shards);
      expect(ranges[0].start).toBe(0);
      expect(ranges.at(-1)?.end).toBe(16383);
      expect(ranges.reduce((total, range) => total + range.end - range.start + 1, 0)).toBe(16384);
      for (let index = 1; index < ranges.length; index += 1)
        expect(ranges[index].start).toBe(ranges[index - 1].end + 1);
    },
  );
  it("counts PostgreSQL primaries and Redis replicas separately from applications", () => {
    expect(instanceCount(createResource("postgres", "postgres", 1, "cluster"))).toBe(3);
    expect(instanceCount(createResource("redis", "redis", 1, "cluster"))).toBe(6);
  });

  it.each(DATABASE_KINDS)(
    "creates a standalone %s by default, with its own application routes",
    (kind) => {
      const database = createResource(kind, "standalone");
      expect(database).toMatchObject({ kind, mode: "standalone", cpu: 1, memory: 1024 });
      expect(isClusterResource(database)).toBe(false);
      expect(instanceCount(database)).toBe(1);
      for (const field of ["replicas", "shards", "replicasPerShard", "topology", "failover"])
        expect(database).not.toHaveProperty(field);
      let draft = addService({ ...empty(), nodes: [database] }, createService("app", "app"));
      draft = connectResources(draft, "app-instance-1", database.id);
      expect(draft.edges).toHaveLength(1);
      expect(draft.edges[0]).toMatchObject({ source: "app-instance-1", target: database.id });
      expect(connectionLabel(draft, database)).toContain(kind === "postgres" ? "5432" : "6379");
      expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
      expect(layoutDraft(draft).nodes.find((node) => node.id === database.id)).toMatchObject({
        mode: "standalone",
        position: { x: 680 },
      });
      const scaled = configureService(draft, draft.services[0], 5);
      expect(scaled.edges).toEqual(draft.edges);
      expect(summarizeDraft(scaled).total).toBe(6);
      expect(removeConnections(scaled, [scaled.edges[0].id]).edges).toEqual([]);
      expect(connectionError(draft, database.id, "app-instance-1")).not.toBeNull();
      expect(removeResources(scaled, [database.id]).edges).toEqual([]);
    },
  );
});

describe("draft persistence and history", () => {
  it("restores older databases as clusters, preserving member settings and connections", () => {
    const draft = createExampleDraft();
    draft.nodes = draft.nodes.map((node) => {
      if (!isClusterResource(node)) return node;
      const topology = getClusterTopology(node);
      topology.nodes[1] = {
        ...topology.nodes[1],
        name: "Custom replica",
        region: "eu-west-1",
        position: { x: 610, y: 350 },
      };
      topology.edges = topology.edges.slice(1);
      return { ...node, topology };
    });
    const legacy = {
      ...draft,
      nodes: draft.nodes.map((node) => ({ ...node, mode: undefined })),
    };
    expect(parseDraft(JSON.stringify(legacy))).toEqual(draft);
  });

  it.each(DATABASE_KINDS)("round-trips %s modes together through persistence and undo", (kind) => {
    const standalone = createResource(kind, "standalone");
    const cluster = createResource(kind, "cluster", 1, "cluster");
    const before = { present: { ...empty(), nodes: [cluster] }, past: [], future: [] };
    const after = draftReducer(before, {
      type: "change",
      draft: { ...before.present, nodes: [cluster, standalone] },
    });
    expect(parseDraft(JSON.stringify(after.present))).toEqual(after.present);
    expect(draftReducer(after, { type: "undo" }).present).toEqual(before.present);
    expect(draftReducer(draftReducer(after, { type: "undo" }), { type: "redo" }).present).toEqual(
      after.present,
    );
  });

  it.each([
    { mode: "replicated" },
    { mode: null },
    { mode: "cluster" },
    { mode: undefined },
    { cpu: "1" },
    { cpu: -1 },
    { memory: 0 },
    { memory: "1024" },
    { storage: 0 },
    { storage: 5000 },
    { storage: 20.5 },
    { replicas: 0 },
    { topology: { nodes: [], edges: [] } },
  ])("rejects invalid or mixed standalone settings %j", (patch) => {
    const resource = { ...createResource("postgres", "database"), ...patch };
    expect(parseDraft(JSON.stringify({ ...empty(), nodes: [resource] }))).toBeNull();
  });

  it.each(["{", "null", "[]", "{}", '{"version":1,"nodes":[],"edges":[]}'])(
    "rejects malformed or previous-model drafts: %s",
    (serialized) => expect(parseDraft(serialized)).toBeNull(),
  );
  it.each([
    { port: 65536 },
    { cpu: "1" },
    { memory: "1024" },
    { minReplicas: 9, maxReplicas: 2 },
    { applicationType: "nodejs" },
    { applicationType: "toString" },
    { name: " " },
    { autoscale: true, minReplicas: 4 },
  ])("rejects invalid shared application settings %j", (patch) => {
    const draft = createExampleDraft();
    expect(
      parseDraft(JSON.stringify({ ...draft, services: [{ ...draft.services[0], ...patch }] })),
    ).toBeNull();
  });
  it.each([
    ["edge", { algorithm: ["round-robin"] }],
    ["edge", { algorithm: "constructor" }],
    ["edge", { healthPath: "health" }],
    ["postgres", { replicas: 0, failover: true }],
    ["redis", { shards: 2 }],
    ["redis", { replicasPerShard: 0 }],
  ] as const)("rejects invalid %s settings", (kind, patch) =>
    expect(
      parseDraft(
        JSON.stringify({
          ...empty(),
          nodes: [{ ...createResource(kind, "resource", 1, "cluster"), ...patch }],
        }),
      ),
    ).toBeNull(),
  );
  it("rejects dangling service references and duplicates while allowing individual routes", () => {
    const draft = createExampleDraft();
    expect(parseDraft(JSON.stringify({ ...draft, services: [] }))).toBeNull();
    expect(
      parseDraft(
        JSON.stringify({ ...draft, services: [...draft.services, createService("unused")] }),
      ),
    ).toBeNull();
    expect(
      parseDraft(
        JSON.stringify({
          ...draft,
          nodes: [...draft.nodes, { ...serviceInstances(draft, "api")[0], id: "duplicate" }],
        }),
      ),
    ).toBeNull();
    const partial = { ...draft, edges: draft.edges.slice(1) };
    expect(parseDraft(JSON.stringify(partial))).toEqual(partial);
    expect(
      parseDraft(JSON.stringify({ ...draft, edges: [...draft.edges, draft.edges[0]] })),
    ).toBeNull();
    expect(parseDraft(" ".repeat(250001))).toBeNull();
  });
  it("scopes saved drafts by user and organization without separator collisions", () => {
    expect(draftStorageKey("first", "org")).not.toBe(draftStorageKey("second", "org"));
    expect(draftStorageKey("first", "one")).not.toBe(draftStorageKey("first", "two"));
    expect(draftStorageKey("first:second", "third")).not.toBe(
      draftStorageKey("first", "second:third"),
    );
  });
  it("undoes and redoes an entire scale operation including all nodes and routes", () => {
    const initial = history();
    const changed = draftReducer(initial, {
      type: "change",
      draft: (draft) => configureService(draft, draft.services[0], 5),
    });
    expect(changed.present.nodes).toHaveLength(9);
    expect(changed.present.edges).toEqual(initial.present.edges);
    const undone = draftReducer(changed, { type: "undo" });
    expect(undone.present).toBe(initial.present);
    expect(draftReducer(undone, { type: "redo" }).present).toBe(changed.present);
    expect(draftReducer(initial, { type: "change", draft: createExampleDraft() })).toBe(initial);
  });
  it("bounds history and clears it on restore", () => {
    let state = history();
    for (let index = 1; index < 50; index += 1)
      state = draftReducer(state, {
        type: "change",
        draft: (draft) => ({
          ...draft,
          nodes: draft.nodes.map((node, ordinal) =>
            ordinal ? node : { ...node, name: `edge-${index}` },
          ),
        }),
      });
    expect(state.past).toHaveLength(40);
    expect(draftReducer(state, { type: "restore", draft: createExampleDraft() }).past).toEqual([]);
  });
});
