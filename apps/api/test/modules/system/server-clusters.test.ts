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
  privateNetworkTools: { inspect: h.inspect, listen: h.listen, check: h.check, stop: h.stop },
}));

import {
  serverClusterCollection as operations,
  serverClusterResources,
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
  h.start.mockResolvedValue({ created: true, run: run() });
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
