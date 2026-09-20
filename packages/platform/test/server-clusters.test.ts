import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorization, type ExecutionContext } from "../src";
import { createServerOperations, type ServerDependencies } from "../src/servers";
import { alice, authorizationFixture } from "./fixtures";
import {
  clusterInputFixture,
  serverClusterFixture,
} from "../../contracts/test/server-cluster-fixtures";
import {
  managedOperationFixture,
  managedPlanInputFixture,
  managedPreparationFixture,
  managedPreparationSummaryFixture,
} from "../../contracts/test/managed-network-fixtures";

let state: ReturnType<typeof authorizationFixture>;
let ctx: ExecutionContext;
let operations: ReturnType<typeof createServerOperations>;
const create = vi.fn(),
  list = vi.fn(),
  inspect = vi.fn();
const planManaged = vi.fn(),
  applyManaged = vi.fn(),
  getManaged = vi.fn();
const prepareManaged = vi.fn(),
  getPreparation = vi.fn(),
  listPreparations = vi.fn();
const networkEvents = vi.fn();
const createPool = vi.fn(), listPools = vi.fn(), removePool = vi.fn(), infrastructure = vi.fn();
const discardPreparation = vi.fn(),
  discardPlan = vi.fn();
const removePreparationMember = vi.fn(),
  removeOperationMember = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "owner" });
  state.servers.set("server-a", { organizationId: "org-a" });
  const auth = createAuthorization(state);
  ctx = await auth.resolveScope(alice, "org-a");
  operations = createServerOperations(auth, {
    networks: { events: networkEvents },
    collection: {
      createCluster: create,
      listClusters: list,
      createNetwork: create,
      listNetworks: list,
      createComputeCluster: createPool,
      listComputeClusters: listPools,
      removeComputeCluster: removePool,
      planManagedNetwork: planManaged,
      applyManagedNetwork: applyManaged,
      getManagedNetworkOperation: getManaged,
      prepareManagedNetwork: prepareManaged,
      getManagedNetworkPreparation: getPreparation,
      listManagedNetworkPreparations: listPreparations,
      discardManagedNetworkPreparation: discardPreparation,
      discardManagedNetworkPlan: discardPlan,
      removeManagedNetworkPreparationMember: removePreparationMember,
      removeManagedNetworkOperationMember: removeOperationMember,
    },
    resources: { inspectNetwork: inspect, infrastructure },
  } as unknown as ServerDependencies);
  create.mockResolvedValue(serverClusterFixture());
  list.mockResolvedValue([serverClusterFixture()]);
  const network = serverClusterFixture();
  const pool = { id: "pool", name: "Apps", location: null, revision: 1, networkId: network.id, serverIds: ["server-a"], network, createdAt: network.createdAt, updatedAt: network.updatedAt };
  createPool.mockResolvedValue(pool);
  listPools.mockResolvedValue([pool]);
  removePool.mockResolvedValue({ removed: true });
  infrastructure.mockResolvedValue({ networks: [], cluster: null, canBrowse: false });
  inspect.mockResolvedValue({ hostIdentity: "host:a", interfaces: [] });
  planManaged.mockResolvedValue(managedOperationFixture());
  applyManaged.mockResolvedValue(managedOperationFixture());
  getManaged.mockResolvedValue(managedOperationFixture());
  prepareManaged.mockResolvedValue(managedPreparationFixture());
  getPreparation.mockResolvedValue(managedPreparationFixture());
  listPreparations.mockResolvedValue([managedPreparationSummaryFixture()]);
  discardPreparation.mockResolvedValue({ ...managedPreparationFixture(), status: "cancelled" });
  discardPlan.mockResolvedValue({ ...managedOperationFixture(), status: "cancelled" });
  for (const remove of [removePreparationMember, removeOperationMember])
    remove.mockResolvedValue({
      preparation: { ...managedPreparationFixture(), status: "pending" },
      operation: managedOperationFixture(),
    });
  networkEvents.mockImplementation(async () =>
    (async function* () {
      yield {
        event: "snapshot",
        data: JSON.stringify({ type: "snapshot", run: managedPreparationFixture() }),
      };
      yield { event: "complete", data: JSON.stringify({ type: "complete" }) };
    })(),
  );
});

describe("shared cluster operation policy", () => {
  it("applies fleet permissions and read-only tokens to independent networks and compute pools", async () => {
    const pool = { name: "Apps", networkId: "network-a", serverIds: ["server-a"], requestId: "request-1234567890" };
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:server:server-a", { permissions: ["admin"] });
    for (const action of [() => operations.createNetwork(ctx, clusterInputFixture()), () => operations.createComputeCluster(ctx, pool), () => operations.listComputeClusters(ctx), () => operations.listNetworks(ctx)])
      await expect(action()).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Server details can expose their own references without reading the entire fleet.
    await expect(operations.infrastructure(ctx, "server-a")).resolves.toMatchObject({ data: { canBrowse: false } });
    expect(createPool).not.toHaveBeenCalled();
    state.grants.set("org-a:alice:server:*", { permissions: ["admin"] });
    const readonly = { ...ctx, credential: { organizationId: "org-a", readOnly: true } };
    for (const action of [() => operations.createComputeCluster(readonly, pool), () => operations.removeComputeCluster(readonly, { clusterId: "pool", revision: 1 }), () => operations.createNetwork(readonly, clusterInputFixture())])
      await expect(action()).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    await expect(operations.listComputeClusters(readonly)).resolves.toMatchObject({ data: [{ id: "pool" }] });
    await expect(operations.createComputeCluster(ctx, pool)).resolves.toMatchObject({ data: { id: "pool" } });
    expect(createPool).toHaveBeenCalledOnce();
    expect(prepareManaged).not.toHaveBeenCalled();
    expect(applyManaged).not.toHaveBeenCalled();
  });
  it("requires writable fleet administration to remove a server from either setup stage", async () => {
    const shared = {
      serverId: "server-c",
      sequence: 2,
      requestId: "bbbbbbbb-2222-4222-8222-222222222222",
    };
    const preparation = { ...shared, preparationId: "setup" };
    const operation = {
      ...shared,
      operationId: "plan",
      planHash: managedOperationFixture().planHash,
    };
    const readonly = { ...ctx, credential: { organizationId: "org-a", readOnly: true } };
    await expect(
      operations.removeManagedNetworkPreparationMember(readonly, preparation),
    ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    await expect(
      operations.removeManagedNetworkOperationMember(readonly, operation),
    ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:server:server-c", { permissions: ["admin"] });
    await expect(
      operations.removeManagedNetworkPreparationMember(ctx, preparation),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      operations.removeManagedNetworkOperationMember(ctx, operation),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(removePreparationMember).not.toHaveBeenCalled();
    expect(removeOperationMember).not.toHaveBeenCalled();
    state.grants.set("org-a:alice:server:*", { permissions: ["admin"] });
    await expect(
      operations.removeManagedNetworkPreparationMember(ctx, preparation),
    ).resolves.toMatchObject({ data: { preparation: { status: "pending" } } });
    await expect(
      operations.removeManagedNetworkOperationMember(ctx, operation),
    ).resolves.toMatchObject({ data: { preparation: { status: "pending" } } });
  });
  it("requires fleet administration and a writable credential to discard setup", async () => {
    const preparation = { preparationId: "setup", sequence: 1 };
    const operation = { operationId: "operation", planHash: managedOperationFixture().planHash };
    const readonly = { ...ctx, credential: { organizationId: "org-a", readOnly: true } };
    await expect(
      operations.discardManagedNetworkPreparation(readonly, preparation),
    ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    await expect(operations.discardManagedNetworkPlan(readonly, operation)).rejects.toMatchObject({
      code: "TOKEN_READ_ONLY",
    });
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:server:*", { permissions: ["read"] });
    await expect(
      operations.discardManagedNetworkPreparation(ctx, preparation),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(operations.discardManagedNetworkPlan(ctx, operation)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(discardPreparation).not.toHaveBeenCalled();
    expect(discardPlan).not.toHaveBeenCalled();
    state.grants.set("org-a:alice:server:*", { permissions: ["admin"] });
    await expect(
      operations.discardManagedNetworkPreparation(ctx, preparation),
    ).resolves.toMatchObject({ data: { status: "cancelled" } });
    await expect(operations.discardManagedNetworkPlan(ctx, operation)).resolves.toMatchObject({
      data: { status: "cancelled" },
    });
  });
  it("authorizes progress streams as fleet reads and rechecks permission before every frame", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:server:server-a", { permissions: ["read"] });
    await expect(
      operations.openManagedNetworkPreparationEvents(ctx, "setup"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      operations.openManagedNetworkOperationEvents(ctx, "operation"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(operations.openClusterEvents(ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(networkEvents).not.toHaveBeenCalled();
    state.grants.set("org-a:alice:server:*", { permissions: ["read"] });
    const abort = new AbortController();
    const opened = await operations.openManagedNetworkPreparationEvents(ctx, "setup", {
      signal: abort.signal,
    });
    expect(networkEvents).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a" }),
      "preparation",
      "setup",
      abort.signal,
    );
    const events = opened.data[Symbol.asyncIterator]();
    expect((await events.next()).value.event).toBe("snapshot");
    state.grants.clear();
    await expect(events.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prepareManaged).not.toHaveBeenCalled();
    expect(applyManaged).not.toHaveBeenCalled();
  });
  it("supports read-only tokens for reconnect and respects an already-aborted subscription", async () => {
    const context = { ...ctx, credential: { organizationId: "org-a", readOnly: true } };
    const result = await operations.openManagedNetworkOperationEvents(context, "operation");
    const frames = [];
    for await (const event of result.data) frames.push(event);
    expect(frames).toHaveLength(2);
    const abort = new AbortController();
    abort.abort();
    await expect(
      operations.openClusterEvents(context, { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(networkEvents).toHaveBeenCalledOnce();
  });
  it("requires fleet administration to bootstrap prerequisites, with read-only progress access", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:server:server-a", { permissions: ["admin"] });
    await expect(
      operations.prepareManagedNetwork(ctx, managedPlanInputFixture()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(operations.listManagedNetworkPreparations(ctx)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(prepareManaged).not.toHaveBeenCalled();
    state.grants.set("org-a:alice:server:*", { permissions: ["read"] });
    await expect(
      operations.getManagedNetworkPreparation(ctx, { preparationId: "setup" }),
    ).resolves.toMatchObject({ data: { status: "preparing" } });
    await expect(operations.listManagedNetworkPreparations(ctx)).resolves.toMatchObject({
      data: [{ status: "preparing" }],
    });
    await expect(
      operations.prepareManagedNetwork(ctx, managedPlanInputFixture()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.grants.set("org-a:alice:server:*", { permissions: ["admin"] });
    await expect(
      operations.prepareManagedNetwork(
        { ...ctx, credential: { organizationId: "org-a", readOnly: true } },
        managedPlanInputFixture(),
      ),
    ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    expect(prepareManaged).not.toHaveBeenCalled();
  });
  it("requires fleet administration for plans and apply, and fleet reads for recovery visibility", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:server:server-a", { permissions: ["admin"] });
    const apply = { operationId: "operation", planHash: "b".repeat(64), action: "apply" as const };
    await expect(
      operations.planManagedNetwork(ctx, managedPlanInputFixture()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(operations.applyManagedNetwork(ctx, apply)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      operations.getManagedNetworkOperation(ctx, { operationId: "operation" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.grants.set("org-a:alice:server:*", { permissions: ["read"] });
    await expect(
      operations.getManagedNetworkOperation(ctx, { operationId: "operation" }),
    ).resolves.toMatchObject({ data: { status: "planned" } });
    await expect(operations.applyManagedNetwork(ctx, apply)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    state.grants.set("org-a:alice:server:*", { permissions: ["admin"] });
    await expect(
      operations.planManagedNetwork(ctx, managedPlanInputFixture()),
    ).resolves.toMatchObject({ data: { status: "planned" } });
    await expect(
      operations.applyManagedNetwork(
        { ...ctx, credential: { organizationId: "org-a", readOnly: true } },
        apply,
      ),
    ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    expect(applyManaged).not.toHaveBeenCalled();
  });
  it("requires fleet-wide permission for cluster management", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:server:server-a", { permissions: ["admin"] });
    await expect(operations.createCluster(ctx, clusterInputFixture())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(operations.listClusters(ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(create).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    await expect(operations.inspectNetwork(ctx, "server-a")).resolves.toMatchObject({
      data: { hostIdentity: "host:a" },
    });
    state.grants.set("org-a:alice:server:*", { permissions: ["admin"] });
    await expect(operations.createCluster(ctx, clusterInputFixture())).resolves.toMatchObject({
      data: { id: "cluster-a" },
    });
  });
  it("allows fleet reads without allowing cluster writes or host inspection", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:server:*", { permissions: ["read"] });
    await expect(operations.listClusters(ctx)).resolves.toMatchObject({
      data: [{ id: "cluster-a" }],
    });
    await expect(operations.createCluster(ctx, clusterInputFixture())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(operations.inspectNetwork(ctx, "server-a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(create).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
  it("denies read-only tokens and a revoked membership before running a service", async () => {
    await expect(
      operations.createCluster(
        { ...ctx, credential: { organizationId: "org-a", readOnly: true } },
        clusterInputFixture(),
      ),
    ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    state.members.clear();
    await expect(operations.createCluster(ctx, clusterInputFixture())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(create).not.toHaveBeenCalled();
  });
  it("refuses unsupported drivers and arbitrary configuration fields at the shared boundary", async () => {
    const input = clusterInputFixture();
    await expect(
      operations.createCluster(ctx, {
        ...input,
        network: { ...input.network, mode: "wireguard" },
      } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      operations.createCluster(ctx, {
        ...input,
        deployTarget: "cloud",
        command: "anything",
      } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(create).not.toHaveBeenCalled();
  });
  it("accepts a typed native network source and rejects unsupported provider fields", async () => {
    const input = clusterInputFixture();
    input.network.source = { providerId: "hetzner-dedicated", networkRef: "vswitch-a" };
    await expect(operations.createCluster(ctx, input)).resolves.toMatchObject({
      data: { id: "cluster-a" },
    });
    expect(create).toHaveBeenCalledOnce();
    for (const source of [
      { providerId: "unknown" },
      { providerId: "aws", command: "configure" },
      { providerId: "aws", networkRef: "x".repeat(201) },
    ]) {
      await expect(
        operations.createCluster(ctx, { ...input, network: { ...input.network, source } } as never),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(create).toHaveBeenCalledOnce();
  });
  it("validates persisted output before presenting a cluster", async () => {
    list.mockResolvedValue([{ ...serverClusterFixture(), revision: "invalid" }]);
    await expect(operations.listClusters(ctx)).rejects.toMatchObject({
      code: "INVALID_OPERATION_RESPONSE",
    });
  });
});
