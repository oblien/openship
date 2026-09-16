import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorization, type ExecutionContext } from "../src";
import { createServerOperations, type ServerDependencies } from "../src/servers";
import { alice, authorizationFixture } from "./fixtures";
import {
  clusterInputFixture,
  serverClusterFixture,
} from "../../contracts/test/server-cluster-fixtures";

let state: ReturnType<typeof authorizationFixture>;
let ctx: ExecutionContext;
let operations: ReturnType<typeof createServerOperations>;
const create = vi.fn(),
  list = vi.fn(),
  inspect = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "owner" });
  state.servers.set("server-a", { organizationId: "org-a" });
  const auth = createAuthorization(state);
  ctx = await auth.resolveScope(alice, "org-a");
  operations = createServerOperations(auth, {
    collection: { createCluster: create, listClusters: list },
    resources: { inspectNetwork: inspect },
  } as unknown as ServerDependencies);
  create.mockResolvedValue(serverClusterFixture());
  list.mockResolvedValue([serverClusterFixture()]);
  inspect.mockResolvedValue({ hostIdentity: "host:a", interfaces: [] });
});

describe("shared cluster operation policy", () => {
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
  it("validates persisted output before presenting a cluster", async () => {
    list.mockResolvedValue([{ ...serverClusterFixture(), revision: "invalid" }]);
    await expect(operations.listClusters(ctx)).rejects.toMatchObject({
      code: "INVALID_OPERATION_RESPONSE",
    });
  });
});
