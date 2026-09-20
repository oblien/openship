import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import { AppError } from "@repo/core";
import {
  clusterInputFixture,
  serverClusterFixture,
} from "../../../../../packages/contracts/test/server-cluster-fixtures";

const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: false, DEPLOY_MODE: "docker" },
  authorize: vi.fn(),
  permission: vi.fn(),
  server: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  start: vi.fn(),
  progress: vi.fn(),
  finish: vi.fn(),
  active: vi.fn(),
  identity: vi.fn(),
  inspect: vi.fn(),
  listen: vi.fn(),
  check: vi.fn(),
  throughput: vi.fn(),
  stop: vi.fn(),
  withExecutor: vi.fn(),
  recordIdentity: vi.fn(),
  work: [] as Array<() => Promise<unknown>>,
}));
vi.mock("@repo/platform/engine/config", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env }));
vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  repos: {
    server: { getInOrganization: h.server },
    serverCluster: {
      get: h.get,
      create: h.create,
      startVerification: h.start,
      progress: h.progress,
      finish: h.finish,
      active: h.active,
      recordIdentity: h.recordIdentity,
    },
  },
}));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: h.authorize, checkPermissionOnResource: h.permission },
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withExecutor: h.withExecutor },
}));
vi.mock("@repo/platform/engine/lib/host-port-target", () => ({
  inspectHostIssuedIdentity: h.identity,
}));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: vi.fn() },
  operationAuditContext: () => ({}),
}));
vi.mock("@repo/platform/engine/lib/background-work", () => ({
  deferBackgroundWork: (fn: () => Promise<unknown>) => {
    h.work.push(fn);
    return Promise.resolve();
  },
}));
vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters")>()),
  privateNetworkTools: {
    inspect: h.inspect,
    listen: h.listen,
    check: h.check,
    throughput: h.throughput,
    stop: h.stop,
  },
}));

import {
  serverClusterCollection as operations,
  serverClusterResources,
  verifyClusterNetwork,
} from "@repo/platform/engine/modules/system/server-cluster.operations";
import { withServerInventoryLock } from "@repo/platform/engine/lib/server-inventory-lock";
const ctx = { organizationId: "org-a", userId: "user-a", role: "owner" } as ExecutionContext;
function storedCluster() {
  const row = serverClusterFixture();
  return {
    ...row,
    organizationId: "org-a",
    requestId: "request-a",
    inputHash: "hash-a",
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    members: row.members.map((m) => ({
      ...m,
      interfaceName: null,
      networkRef: null,
      hostIdentity: null,
    })),
    verification: null,
  };
}
function run() {
  return {
    id: "run-a",
    clusterId: "cluster-a",
    revision: 1,
    status: "running",
    createdBy: "user-a",
    report: { stage: "inspecting", hosts: [], peers: [] },
    error: null,
    startedAt: new Date(),
    finishedAt: null,
    expiresAt: new Date(Date.now() + 240_000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.work.length = 0;
  h.env.CLOUD_MODE = false;
  h.env.DEPLOY_MODE = "docker";
  h.authorize.mockImplementation(async (context) => context);
  h.permission.mockResolvedValue(true);
  h.server.mockImplementation(async (id: string, org: string) =>
    id === "foreign" ? undefined : { id, organizationId: org, isLocal: false },
  );
  h.get.mockResolvedValue(storedCluster());
  h.create.mockResolvedValue(storedCluster());
  h.start.mockImplementation(async (_org, _id, _revision, _user, speedTest) => ({
    created: true,
    run: {
      ...run(),
      report: { ...run().report, ...(speedTest ? { speedTest, throughput: [] } : {}) },
    },
  }));
  h.active.mockResolvedValue(true);
  h.progress.mockResolvedValue(true);
  h.finish.mockResolvedValue(undefined);
  h.recordIdentity.mockResolvedValue(undefined);
  h.withExecutor.mockImplementation(
    async (id: string, fn: (executor: unknown) => Promise<unknown>) => fn({ id }),
  );
  h.identity.mockImplementation(async ({ id }: { id: string }) => `host:${id}`);
  h.inspect.mockImplementation(async ({ id }: { id: string }) => [
    {
      name: "eth1",
      up: true,
      mtu: 1400,
      kind: null,
      addresses: [{ address: id === "server-a" ? "10.20.0.2" : "10.20.0.3", prefixLength: 24 }],
    },
  ]);
  h.listen.mockResolvedValue(undefined);
  h.stop.mockResolvedValue(undefined);
  h.throughput.mockImplementation(async (_executor, source, target) => ({
    sourceServerId: source.serverId,
    targetServerId: target.serverId,
    megabitsPerSecond: 25,
    bytes: 1_000_000,
    durationMs: 320,
    message: null,
  }));
  h.check.mockImplementation(async (_executor, source, peers) =>
    peers.map((target: { serverId: string }) => ({
      sourceServerId: source.serverId,
      targetServerId: target.serverId,
      tcp: true,
      udp: true,
      mtu: true,
      latencyMs: 1,
      message: null,
    })),
  );
});

describe("infrastructure ownership and network verification", () => {
  it("stops verification before host work when shutdown happens while opening SSH", async () => {
    const controller = new AbortController();
    h.withExecutor.mockImplementation(async (id, fn) => {
      controller.abort();
      return fn({ id });
    });
    const cluster = storedCluster();
    await verifyClusterNetwork(
      ctx,
      {
        ...cluster,
        members: cluster.members.map((member) => ({
          ...member,
          interfaceName: undefined,
          networkRef: undefined,
        })),
      },
      run() as Parameters<typeof verifyClusterNetwork>[2],
      undefined,
      controller.signal,
    );
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.check).not.toHaveBeenCalled();
  });
  it("retains legacy request hashes while presenting a resolved native network source", async () => {
    const result = await operations.createCluster(ctx, clusterInputFixture());
    expect(h.create).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({
        network: { mode: "native", cidrs: ["10.20.0.0/24"], mtu: 1400, probePort: 51821 },
      }),
      "request-1234567890",
      "a9d5df2036844b56d6bfd42dd946d55fd2e5908a432162f5b0a4c47806f06ee2",
    );
    expect(result.network).toMatchObject({ source: { providerId: "custom" } });
  });
  it("normalizes an explicit network source without rewriting its member metadata", async () => {
    const input = clusterInputFixture();
    input.network.source = { providerId: "hetzner-dedicated", networkRef: " vswitch-a " };
    await operations.createCluster(ctx, input);
    expect(h.create.mock.calls[0]![1]).toMatchObject({
      network: { source: { providerId: "hetzner-dedicated", networkRef: "vswitch-a" } },
      members: input.members,
    });
    input.network.source.providerId = "aws";
    await expect(operations.createCluster(ctx, input)).rejects.toMatchObject({
      code: "INVALID_CLUSTER_CONFIG",
    });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.withExecutor).not.toHaveBeenCalled();
  });
  it("verifies the native network provider's interface constraints when member metadata is unknown", async () => {
    const cluster = storedCluster();
    if (cluster.network.mode !== "native") throw new Error("Expected native fixture");
    cluster.network = {
      ...cluster.network,
      mode: "native",
      source: { providerId: "hetzner-dedicated" },
    };
    cluster.members.forEach((member) => {
      member.providerId = "custom";
    });
    h.get.mockResolvedValue(cluster);
    const inspect = h.inspect.getMockImplementation()!;
    h.inspect.mockImplementation(async (...args) =>
      (await inspect(...args)).map((nic: object) => ({ ...nic, mtu: 1500 })),
    );
    await operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 1 });
    await h.work[0]!();
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(
      "run-a",
      expect.objectContaining({
        hosts: expect.arrayContaining([
          expect.objectContaining({
            ok: false,
            message: expect.stringContaining("Robot vSwitch interface"),
          }),
        ]),
      }),
      false,
      expect.any(String),
    );
  });
  it("measures only an explicitly selected pair after reachability, sequentially in both directions", async () => {
    let active = 0;
    const measure = h.throughput.getMockImplementation()!;
    h.throughput.mockImplementation(async (...args) => {
      expect(h.check).toHaveBeenCalledTimes(2);
      expect(active++).toBe(0);
      await Promise.resolve();
      const result = await measure(...args);
      active--;
      return result;
    });
    const speedTest = { sourceServerId: "server-a", targetServerId: "server-b" };
    const started = await operations.verifyCluster(ctx, {
      clusterId: "cluster-a",
      revision: 1,
      speedTest,
    });
    expect(started.report.speedTest).toEqual(speedTest);
    expect(h.throughput).not.toHaveBeenCalled();
    await h.work[0]!();
    expect(
      h.throughput.mock.calls.map(([, source, target]) => [source.serverId, target.serverId]),
    ).toEqual([
      ["server-a", "server-b"],
      ["server-b", "server-a"],
    ]);
    expect(
      h.listen.mock.calls.map(([, source, , allowedPeer]) => [source.serverId, allowedPeer]),
    ).toEqual([
      ["server-a", "10.20.0.3"],
      ["server-b", "10.20.0.2"],
    ]);
    expect(h.finish).toHaveBeenCalledWith(
      "run-a",
      expect.objectContaining({
        throughput: expect.arrayContaining([expect.objectContaining({ megabitsPerSecond: 25 })]),
      }),
      true,
      null,
    );
    expect(h.stop).toHaveBeenCalledTimes(2);
  });
  it("never starts a speed sample during ordinary network verification", async () => {
    await operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 1 });
    await h.work[0]!();
    expect(h.throughput).not.toHaveBeenCalled();
    expect(h.listen.mock.calls.every((call) => call[3] === undefined)).toBe(true);
  });
  it.each(["server-a", "foreign"])(
    "rejects an invalid speed target before scheduling work: %s",
    async (targetServerId) => {
      await expect(
        operations.verifyCluster(ctx, {
          clusterId: "cluster-a",
          revision: 1,
          speedTest: { sourceServerId: "server-a", targetServerId },
        }),
      ).rejects.toMatchObject({ code: "INVALID_NETWORK_TEST" });
      expect(h.start).not.toHaveBeenCalled();
      expect(h.work).toHaveLength(0);
      expect(h.withExecutor).not.toHaveBeenCalled();
    },
  );
  it("keeps a failed speed sample separate from its successful reachability measurements and stops listeners", async () => {
    h.throughput.mockResolvedValueOnce({
      sourceServerId: "server-a",
      targetServerId: "server-b",
      megabitsPerSecond: null,
      bytes: 0,
      durationMs: 0,
      message: "Sample interrupted",
    });
    await operations.verifyCluster(ctx, {
      clusterId: "cluster-a",
      revision: 1,
      speedTest: { sourceServerId: "server-a", targetServerId: "server-b" },
    });
    await h.work[0]!();
    const [, report, success] = h.finish.mock.calls.at(-1)!;
    expect(report.peers.every((peer: { tcp: boolean; udp: boolean }) => peer.tcp && peer.udp)).toBe(
      true,
    );
    expect(report.throughput[0].message).toBe("Sample interrupted");
    expect(success).toBe(false);
    expect(h.stop).toHaveBeenCalledTimes(2);
  });
  it.each(["cloud-mode", "cloud"])(
    "rejects %s before inventory, credentials, or SSH access",
    async (mode) => {
      if (mode === "cloud-mode") h.env.CLOUD_MODE = true;
      else h.env.DEPLOY_MODE = mode;
      const caps = await operations.clusterCapabilities(ctx);
      expect(caps).toMatchObject({ available: false, canManage: false, providers: [] });
      await expect(operations.createCluster(ctx, clusterInputFixture())).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
      });
      await expect(
        operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 1 }),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      await expect(serverClusterResources.inspectNetwork(ctx, "server-a")).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
      });
      expect(h.get).not.toHaveBeenCalled();
      expect(h.server).not.toHaveBeenCalled();
      expect(h.withExecutor).not.toHaveBeenCalled();
    },
  );
  it.each(["docker", "desktop"])(
    "supports customer servers from %s without executing SSH on create",
    async (mode) => {
      h.env.DEPLOY_MODE = mode;
      expect(await operations.clusterCapabilities(ctx)).toMatchObject({
        available: true,
        canManage: true,
      });
      const created = await operations.createCluster(ctx, clusterInputFixture());
      expect(created).toMatchObject({ id: "cluster-a", verification: null });
      expect(created).not.toHaveProperty("inputHash");
      expect(h.create).toHaveBeenCalledWith(
        "org-a",
        expect.objectContaining({ members: expect.any(Array) }),
        "request-1234567890",
        expect.stringMatching(/^[a-f0-9]{64}$/),
      );
      expect(h.withExecutor).not.toHaveBeenCalled();
    },
  );
  it("waits for server teardown and rechecks inventory before enrollment", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const teardown = withServerInventoryLock(ctx.organizationId, async () => {
      entered();
      await hold;
      h.server.mockResolvedValue(undefined);
    });
    await started;
    const creation = operations.createCluster(ctx, clusterInputFixture());
    const rejected = expect(creation).rejects.toMatchObject({ code: "NOT_FOUND" });
    await Promise.resolve();
    expect(h.create).not.toHaveBeenCalled();
    release();
    await teardown;
    await rejected;
    expect(h.create).not.toHaveBeenCalled();
    expect(h.withExecutor).not.toHaveBeenCalled();
  });
  it("rechecks fleet authority after a queued inventory operation", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = withServerInventoryLock(ctx.organizationId, async () => {
      entered();
      await hold;
      h.authorize.mockRejectedValue(new AppError("Permission revoked", 403, "FORBIDDEN"));
    });
    await started;
    const creation = operations.createCluster(ctx, clusterInputFixture());
    const rejected = expect(creation).rejects.toMatchObject({ code: "FORBIDDEN" });
    release();
    await prior;
    await rejected;
    expect(h.create).not.toHaveBeenCalled();
  });
  it("rejects a foreign server and invalid private addresses before saving", async () => {
    const input = clusterInputFixture();
    input.members[1]!.serverId = "foreign";
    await expect(operations.createCluster(ctx, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    input.members[1]!.serverId = "server-b";
    input.members[1]!.privateIp = "8.8.8.8";
    await expect(operations.createCluster(ctx, input)).rejects.toMatchObject({
      code: "INVALID_CLUSTER_CONFIG",
    });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.withExecutor).not.toHaveBeenCalled();
  });
  it.each(["docker", "desktop"])(
    "verifies all directed pairs from %s and cleans up before completion",
    async (mode) => {
      h.env.DEPLOY_MODE = mode;
      const result = await operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 1 });
      expect(result.status).toBe("running");
      expect(h.withExecutor).not.toHaveBeenCalled();
      expect(h.work).toHaveLength(1);
      await h.work[0]!();
      expect(h.check).toHaveBeenCalledTimes(2);
      expect(h.stop).toHaveBeenCalledTimes(2);
      expect(h.finish).toHaveBeenCalledWith(
        "run-a",
        expect.objectContaining({
          stage: "complete",
          peers: expect.arrayContaining([
            expect.objectContaining({ sourceServerId: "server-a", targetServerId: "server-b" }),
            expect.objectContaining({ sourceServerId: "server-b", targetServerId: "server-a" }),
          ]),
        }),
        true,
        null,
      );
      expect(h.finish.mock.invocationCallOrder[0]).toBeGreaterThan(
        h.stop.mock.invocationCallOrder[1]!,
      );
    },
  );
  it("does not call a network healthy when UDP or MTU fails", async () => {
    h.check.mockImplementation(async (_executor, source, peers) =>
      peers.map((target: { serverId: string }) => ({
        sourceServerId: source.serverId,
        targetServerId: target.serverId,
        tcp: true,
        udp: false,
        mtu: false,
        latencyMs: null,
        message: "UDP blocked",
      })),
    );
    await operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 1 });
    await h.work[0]!();
    expect(h.finish).toHaveBeenCalledWith("run-a", expect.anything(), false, expect.any(String));
    expect(h.stop).toHaveBeenCalledTimes(2);
  });
  it("rejects duplicate physical machines before binding listeners", async () => {
    h.identity.mockResolvedValue("host:same");
    await operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 1 });
    await h.work[0]!();
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(
      "run-a",
      expect.objectContaining({
        hosts: expect.arrayContaining([
          expect.objectContaining({ ok: false, code: "NETWORK_DUPLICATE_HOST" }),
        ]),
      }),
      false,
      expect.any(String),
    );
  });
  it("rechecks authority when queued work begins", async () => {
    await operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 1 });
    h.env.CLOUD_MODE = true;
    await h.work[0]!();
    expect(h.withExecutor).not.toHaveBeenCalled();
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith("run-a", expect.anything(), false, expect.any(String));
  });
  it("rejects stale revisions and avoids starting a second worker for the same run", async () => {
    await expect(
      operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 2 }),
    ).rejects.toMatchObject({ code: "CLUSTER_CONFLICT" });
    expect(h.start).not.toHaveBeenCalled();
    h.start.mockResolvedValue({ created: false, run: run() });
    await operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 1 });
    expect(h.work).toHaveLength(0);
  });
  it("stops host work after fleet access is revoked", async () => {
    await operations.verifyCluster(ctx, { clusterId: "cluster-a", revision: 1 });
    h.authorize.mockImplementation(async (context, input) => {
      if (input.resourceId === "*") throw new AppError("Access revoked", 403);
      return context;
    });
    await h.work[0]!();
    expect(h.withExecutor).not.toHaveBeenCalled();
    expect(h.listen).not.toHaveBeenCalled();
  });
});
