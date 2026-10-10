import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";
import type { ExecutionContext } from "@repo/platform";
import type { ClusterRuntimeRecord } from "@repo/db";
import { clusterRuntimeFixture } from "../../../../../packages/contracts/test/cluster-runtime-fixtures";

const h = vi.hoisted(() => ({
  fleet: vi.fn(),
  authorize: vi.fn(),
  available: vi.fn(),
  cluster: vi.fn(),
  network: vi.fn(),
  runtime: vi.fn(),
  start: vi.fn(),
  change: vi.fn(),
  active: vi.fn(),
  heartbeat: vi.fn(),
  progress: vi.fn(),
  finish: vi.fn(),
  prepare: vi.fn(),
  inspect: vi.fn(),
  install: vi.fn(),
  token: vi.fn(),
  ready: vi.fn(),
  nodes: vi.fn(),
  verify: vi.fn(),
  empty: vi.fn(),
  state: vi.fn(),
  remove: vi.fn(),
  version: vi.fn(),
  identity: vi.fn(),
  defer: vi.fn(),
  record: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    computeCluster: { get: h.cluster },
    serverCluster: { get: h.network },
    clusterRuntime: {
      get: h.runtime,
      start: h.start,
      change: h.change,
      active: h.active,
      heartbeat: h.heartbeat,
      progress: h.progress,
      finish: h.finish,
    },
  },
}));
vi.mock("@repo/adapters", () => ({
  k3sTools: {
    prepare: h.prepare,
    inspect: h.inspect,
    install: h.install,
    token: h.token,
    ready: h.ready,
    nodes: h.nodes,
    verifyNetworking: h.verify,
    assertEmpty: h.empty,
    hasState: h.state,
    remove: h.remove,
    resolveVersion: h.version,
  },
}));
vi.mock("@repo/platform/engine/modules/system/managed-network.operations", () => ({
  fleetAdmin: h.fleet,
}));
vi.mock("@repo/platform/engine/modules/system/server-cluster.operations", () => ({
  assertClusterManagementAvailable: h.available,
  authorizeMember: h.authorize,
  onServer: async (
    _ctx: unknown,
    serverId: string,
    work: (executor: { serverId: string }) => Promise<unknown>,
  ) => work({ serverId }),
  eachMember: async (members: unknown[], work: (host: unknown) => Promise<void>) => {
    await Promise.all(members.map(work));
  },
  record: h.record,
}));
vi.mock("@repo/platform/engine/lib/host-port-target", () => ({
  inspectHostIssuedIdentity: h.identity,
}));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (work: () => unknown) => work() }),
}));
vi.mock("@repo/platform/engine/lib/server-inventory-lock", () => ({
  withServerInventoryLock: (_org: string, work: () => unknown) => work(),
}));
vi.mock("@repo/platform/engine/modules/system/network-setup-bus", () => ({
  notifyNetworkSetup: h.notify,
}));
vi.mock("@repo/platform/engine/modules/system/network-setup-lifecycle", () => ({
  assertNetworkSetupAcceptingWork: vi.fn(),
  deferNetworkSetupWork: h.defer,
}));

import {
  clusterRuntimeCollection as operations,
  runClusterRuntime,
} from "@repo/platform/engine/modules/system/cluster-runtime.operations";
const ctx = { organizationId: "org", userId: "user" } as ExecutionContext;
function record(): ClusterRuntimeRecord {
  const fixture = clusterRuntimeFixture();
  return {
    ...fixture,
    organizationId: "org",
    clusterRevision: 1,
    requestId: "request-123456789",
    leaseExpiresAt: new Date(Date.now() + 90_000),
    verifiedAt: null,
    createdAt: new Date(fixture.createdAt),
    updatedAt: new Date(fixture.updatedAt),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  const row = record();
  h.cluster.mockResolvedValue({
    id: row.clusterId,
    revision: 1,
    serverIds: ["a", "b", "c"],
    networkId: row.plan.networkId,
  });
  h.network.mockResolvedValue({
    id: row.plan.networkId,
    revision: 1,
    members: row.plan.hosts,
    network: { cidrs: ["10.20.0.0/24"] },
    operation: null,
  });
  h.authorize.mockImplementation(async (_ctx, serverId) => ({
    name: `Server ${serverId}`,
    sshHost: `${serverId}.example`,
  }));
  h.identity.mockImplementation(async ({ serverId }) => `machine-${serverId}`);
  h.active.mockResolvedValue(true);
  h.heartbeat.mockResolvedValue(true);
  h.finish.mockResolvedValue(true);
  h.inspect.mockResolvedValue({ interfaceName: "wg0", ranges: ["10.20.0.0/24"], installed: false });
  h.install.mockResolvedValue({ installed: true });
  h.token.mockResolvedValue(`K10${"a".repeat(64)}::server:secret-join-token`);
  h.ready.mockResolvedValue({ ready: true, clusterUid: "one-real-cluster" });
  h.version.mockResolvedValue(row.plan.version);
  h.nodes.mockResolvedValue({
    items: row.plan.hosts.map((host) => ({
      metadata: { name: host.nodeName, labels: { "openship.io/runtime": row.id } },
      status: {
        nodeInfo: { kubeletVersion: row.plan.version },
        addresses: [{ type: "InternalIP", address: host.privateIp }],
        conditions: [{ type: "Ready", status: "True" }],
      },
    })),
  });
  h.state.mockResolvedValue({ hasState: true });
  h.empty.mockResolvedValue({ empty: true, clusterUid: "one-real-cluster" });
  h.remove.mockResolvedValue({ removed: true });
  h.start.mockResolvedValue({ row, started: true });
  h.runtime.mockResolvedValue(row);
});
describe("managed cluster runtime", () => {
  it("checks fleet and every server's authority before scheduling host work", async () => {
    h.authorize.mockRejectedValueOnce(new AppError("Not allowed", 403));
    await expect(
      operations.setupClusterRuntime(ctx, {
        clusterId: "pool-a",
        revision: 1,
        requestId: "request-123456789",
      }),
    ).rejects.toThrow("Not allowed");
    expect(h.start).not.toHaveBeenCalled();
    expect(h.defer).not.toHaveBeenCalled();
  });
  it("rejects cloud and restricted private network configurations", async () => {
    h.fleet.mockRejectedValueOnce(new AppError("Self-hosted only", 404));
    await expect(
      operations.setupClusterRuntime(ctx, {
        clusterId: "pool-a",
        revision: 1,
        requestId: "request-123456789",
      }),
    ).rejects.toThrow("Self-hosted");
    const network = await h.network();
    network.network.access = { version: 1, rules: [] };
    await expect(
      operations.setupClusterRuntime(ctx, {
        clusterId: "pool-a",
        revision: 1,
        requestId: "request-123456789",
      }),
    ).rejects.toThrow("both directions");
    expect(h.install).not.toHaveBeenCalled();
  });
  it("does not dispatch duplicate work when the durable claim already exists", async () => {
    const row = record();
    h.start.mockResolvedValue({ row, started: false });
    const result = await operations.setupClusterRuntime(ctx, {
      clusterId: "pool-a",
      revision: 1,
      requestId: "request-123456789",
    });
    expect(result.id).toBe(row.id);
    expect(h.defer).not.toHaveBeenCalled();
  });
  it("makes the local server the first control so it stays the public gateway", async () => {
    const row = record();
    h.cluster.mockResolvedValue({
      id: row.clusterId,
      revision: 1,
      serverIds: ["a", "b", "c", "d"],
      networkId: row.plan.networkId,
    });
    h.network.mockResolvedValue({
      id: row.plan.networkId,
      revision: 1,
      members: [...row.plan.hosts, { serverId: "d", privateIp: "10.20.0.9" }],
      network: { cidrs: ["10.20.0.0/24"] },
      operation: null,
    });
    h.authorize.mockImplementation(async (_ctx, serverId) => ({
      name: `Server ${serverId}`,
      sshHost: `${serverId}.example`,
      isLocal: serverId === "d",
    }));
    await operations.setupClusterRuntime(ctx, {
      clusterId: "pool-a",
      revision: 1,
      requestId: "request-123456789",
    });
    const plan = h.start.mock.calls[0][4] as { hosts: { serverId: string; role: string }[] };
    expect(plan.hosts.map((host) => [host.serverId, host.role])).toEqual([
      ["d", "server"],
      ["a", "server"],
      ["b", "server"],
      ["c", "agent"],
    ]);
  });
  it("starts saved controls before waiting for quorum and verifies real services before readiness", async () => {
    const row = record();
    await runClusterRuntime(ctx, row);
    expect(h.install.mock.calls.map((call) => call[1].host.serverId)).toEqual(["a", "b", "c"]);
    expect(h.install.mock.calls[0]![2]).toBeUndefined();
    expect(h.install.mock.calls[1]![2]).toContain("K10");
    expect(h.ready.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.install.mock.invocationCallOrder.at(-1)!,
    );
    expect(h.verify).toHaveBeenCalledOnce();
    const result = h.finish.mock.calls.at(-1)!;
    expect(result[4]).toBeNull();
    expect(result[2].hosts.every((host: { ready: boolean }) => host.ready)).toBe(true);
    expect(JSON.stringify(h.progress.mock.calls)).not.toContain("secret-join-token");
    expect(h.version).not.toHaveBeenCalled(); // the retry's version was already pinned
  });
  it("does not install anything when one server fails prerequisites", async () => {
    h.prepare.mockImplementation(async ({ serverId }) => {
      if (serverId === "b") throw new Error("Package repository unavailable");
    });
    await runClusterRuntime(ctx, record());
    expect(h.install).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.at(-1)![4]).toContain("Package repository unavailable");
  });
  it("does not claim success when DNS/service checks fail despite Ready nodes", async () => {
    h.verify.mockRejectedValueOnce(new Error("DNS failed from server c"));
    await runClusterRuntime(ctx, record());
    expect(h.finish.mock.calls.at(-1)![4]).toContain("DNS failed");
    expect(
      h.finish.mock.calls.at(-1)![2].hosts.every((host: { ready: boolean }) => !host.ready),
    ).toBe(true);
  });
  it("does not publish a ready audit event when another worker owns completion", async () => {
    h.finish.mockResolvedValue(false);
    await runClusterRuntime(ctx, record());
    expect(h.record).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.at(-1)![4]).toContain("no longer owns");
  });
  it("detects accidental split clusters and changed physical hosts", async () => {
    h.ready
      .mockResolvedValueOnce({ ready: true, clusterUid: "cluster-a" })
      .mockResolvedValueOnce({ ready: true, clusterUid: "cluster-b" });
    await runClusterRuntime(ctx, record());
    expect(h.finish.mock.calls.at(-1)![4]).toContain("different cluster identities");
    h.install.mockClear();
    h.identity.mockResolvedValue("replacement-machine");
    await runClusterRuntime(ctx, record());
    expect(h.install).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.at(-1)![4]).toContain("machine identity changed");
  });
  it("refuses cleanup while databases or other workloads remain", async () => {
    const row = record();
    row.intent = "remove";
    row.status = "removing";
    row.plan.hosts.forEach((host) => {
      host.installed = true;
    });
    h.empty.mockRejectedValue(new Error("Persistent volumes remain"));
    await runClusterRuntime(ctx, row);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.at(-1)![4]).toContain("Persistent volumes");
  });
  it("keeps the bootstrap control server until other owned installations are removed", async () => {
    const row = record();
    row.intent = "remove";
    row.status = "removing";
    row.plan.hosts.forEach((host) => {
      host.installed = true;
    });
    await runClusterRuntime(ctx, row);
    expect(h.remove.mock.calls.map((call) => call[1].host.serverId)).toEqual(["c", "b", "a"]);
    expect(h.finish.mock.calls.at(-1)![4]).toBeNull();
  });
  it("resumes partial removal using the saved empty-cluster check after quorum is lost", async () => {
    const row = record();
    row.intent = "remove";
    row.status = "removing";
    row.plan.hosts.forEach((host) => {
      host.installed = true;
    });
    h.remove.mockImplementation(async (_executor, context) => {
      if (context.host.serverId === "b") throw new Error("SSH disconnected during removal");
      return { removed: true };
    });
    await runClusterRuntime(ctx, row);
    const plan = structuredClone(h.finish.mock.calls.at(-1)![2]);
    expect(plan.cleanup).toMatchObject({ clusterUid: "one-real-cluster" });
    expect(plan.hosts.find((host: { serverId: string }) => host.serverId === "c").installed).toBe(
      false,
    );
    h.state.mockRejectedValue(new Error("Quorum is gone"));
    h.empty.mockClear();
    h.remove.mockReset().mockResolvedValue({ removed: true });
    h.identity.mockImplementation(async ({ serverId }) => {
      if (serverId === "c") throw new Error("Already removed host is offline");
      return `machine-${serverId}`;
    });
    await runClusterRuntime(ctx, { ...row, plan, generation: 2 });
    expect(h.empty).not.toHaveBeenCalled();
    expect(h.remove.mock.calls.map((call) => call[1].host.serverId)).toEqual(["b", "a"]);
    expect(h.finish.mock.calls.at(-1)![4]).toBeNull();
  });
  it("can discard failed preparation without contacting hosts that never received a runtime", async () => {
    const row = record();
    row.intent = "remove";
    row.status = "removing";
    h.identity.mockRejectedValue(new Error("SSH unavailable"));
    await runClusterRuntime(ctx, row);
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.at(-1)![4]).toBeNull();
  });
  it("will not use an empty control to excuse workloads or a different cluster on another control", async () => {
    const row = record();
    row.intent = "remove";
    row.status = "removing";
    row.plan.hosts.forEach((host) => {
      host.installed = true;
    });
    h.empty
      .mockResolvedValueOnce({ empty: true, clusterUid: "one-real-cluster" })
      .mockRejectedValueOnce(
        new AppError("Postgres data remains", 409, "CLUSTER_RUNTIME_NOT_EMPTY"),
      );
    await runClusterRuntime(ctx, row);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.at(-1)![4]).toContain("Postgres");
    h.empty
      .mockResolvedValueOnce({ empty: true, clusterUid: "one-real-cluster" })
      .mockResolvedValueOnce({ empty: true, clusterUid: "different-cluster" });
    await runClusterRuntime(ctx, row);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.at(-1)![4]).toContain("different cluster identities");
  });
});
