import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, MANAGED_NETWORK_PREPARATION_STEPS } from "@repo/core";
import {
  PrivateNetworkError,
  SshDisconnectedError,
  isRetryableRemoteConnectionError,
} from "@repo/adapters";
import type { ExecutionContext } from "@repo/platform";
import {
  managedOperationFixture,
  managedPlanInputFixture,
  managedPreparationFixture,
} from "../../../../../packages/contracts/test/managed-network-fixtures";

const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: false, DEPLOY_MODE: "docker" },
  lookup: vi.fn(),
  authorize: vi.fn(),
  server: vi.fn(),
  executor: vi.fn(),
  identity: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  membership: vi.fn(),
  dependencies: vi.fn(),
  computeList: vi.fn(),
  find: vi.fn(),
  save: vi.fn(),
  getOperation: vi.fn(),
  claim: vi.fn(),
  active: vi.fn(),
  heartbeat: vi.fn(),
  progress: vi.fn(),
  finish: vi.fn(),
  inspect: vi.fn(),
  install: vi.fn(),
  prepare: vi.fn(),
  stageTransport: vi.fn(),
  apply: vi.fn(),
  ready: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  finalize: vi.fn(),
  prepareHost: vi.fn(),
  prepStart: vi.fn(),
  prepGet: vi.fn(),
  prepList: vi.fn(),
  prepActive: vi.fn(),
  prepHeartbeat: vi.fn(),
  prepProgress: vi.fn(),
  prepFinish: vi.fn(),
  prepDiscard: vi.fn(),
  removeMember: vi.fn(),
  reviseAccess: vi.fn(),
  interruptPending: vi.fn(),
  discardPlan: vi.fn(),
  interfaces: vi.fn(),
  listen: vi.fn(),
  check: vi.fn(),
  stop: vi.fn(),
  work: [] as Array<() => Promise<unknown>>,
}));
vi.mock("@repo/platform/engine/config", () => ({ env: h.env }));
vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  lookup: h.lookup,
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: h.authorize, checkPermissionOnResource: vi.fn() },
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withExecutor: h.executor },
}));
vi.mock("@repo/platform/engine/lib/host-port-target", () => ({
  inspectHostIssuedIdentity: h.identity,
}));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: vi.fn() },
  operationAuditContext: () => ({}),
}));
vi.mock("@repo/platform/engine/lib/background-work", () => ({
  deferBackgroundWork: (work: () => Promise<unknown>) => {
    h.work.push(work);
    return Promise.resolve();
  },
}));
vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  repos: {
    networkPreparation: {
      start: h.prepStart,
      get: h.prepGet,
      list: h.prepList,
      active: h.prepActive,
      heartbeat: h.prepHeartbeat,
      progress: h.prepProgress,
      finish: h.prepFinish,
      discard: h.prepDiscard,
      removeMember: h.removeMember,
      reviseAccess: h.reviseAccess,
      interruptPending: h.interruptPending,
    },
    server: { getInOrganization: h.server },
    computeCluster: { list: h.computeList },
    serverCluster: {
      list: h.list,
      get: h.get,
      membership: h.membership,
      assertDependencies: h.dependencies,
      findOperation: h.find,
      savePlan: h.save,
      getOperation: h.getOperation,
      claimOperation: h.claim,
      operationActive: h.active,
      heartbeatOperation: h.heartbeat,
      progressOperation: h.progress,
      finishOperation: h.finish,
      discardPlan: h.discardPlan,
    },
  },
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  managedNetworkTools: {
    prepareHost: h.prepareHost,
    inspect: h.inspect,
    install: h.install,
    prepare: h.prepare,
    stageTransport: h.stageTransport,
    apply: h.apply,
    waitForPeers: h.ready,
    commit: h.commit,
    rollback: h.rollback,
    finalize: h.finalize,
  },
  privateNetworkTools: { inspect: h.interfaces, listen: h.listen, check: h.check, stop: h.stop },
}));

import {
  managedNetworkCollection as operations,
  runManagedNetwork,
} from "@repo/platform/engine/modules/system/managed-network.operations";
import {
  networkPreparationCollection,
  runNetworkPreparation,
} from "@repo/platform/engine/modules/system/network-preparation.operations";
import { networkSetupMemberCollection } from "@repo/platform/engine/modules/system/network-setup-member.operations";
import { networkSetupStreams } from "@repo/platform/engine/modules/system/network-setup.events";
import { notifyNetworkSetup } from "@repo/platform/engine/modules/system/network-setup-bus";
const ctx = { organizationId: "org-a", userId: "user-a", role: "owner" } as ExecutionContext;
const publicKey = (id: string) =>
  Buffer.alloc(32, id === "server-a" ? 1 : id === "server-b" ? 2 : 3).toString("base64");
function stored(ids?: string[]) {
  const value = managedOperationFixture(ids);
  return {
    ...value,
    organizationId: "org-a",
    inputHash: "input",
    createdBy: "user-a",
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    leaseExpiresAt: new Date(Date.now() + 90_000),
  };
}
function applying() {
  return { ...stored(), status: "applying" as const, generation: 1 };
}
function preparing(ids?: string[]) {
  const value = managedPreparationFixture(ids);
  return {
    ...value,
    organizationId: "org-a",
    createdBy: "user-a",
    inputHash: "input",
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    leaseExpiresAt: new Date(value.leaseExpiresAt!),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.work.length = 0;
  h.env.CLOUD_MODE = false;
  h.env.DEPLOY_MODE = "docker";
  h.lookup.mockRejectedValue(new Error("No DNS fixture"));
  h.authorize.mockImplementation(async (context) => context);
  h.server.mockImplementation(async (id, organizationId) =>
    id === "foreign"
      ? null
      : {
          id,
          organizationId,
          name: id,
          sshHost: id === "server-a" ? "192.0.2.10" : "192.0.2.11",
          isLocal: false,
        },
  );
  h.executor.mockImplementation(async (id, fn) => fn({ id }));
  h.identity.mockImplementation(async ({ id }) => `host:${id}`);
  h.list.mockResolvedValue([]);
  h.membership.mockResolvedValue(null);
  h.dependencies.mockResolvedValue(undefined);
  h.computeList.mockResolvedValue([]);
  h.find.mockResolvedValue(null);
  h.save.mockImplementation(async (organizationId, id, createdBy, inputHash, planHash, plan) => ({
    ...stored(),
    id,
    organizationId,
    createdBy,
    inputHash,
    planHash,
    plan,
    clusterId: plan.clusterId,
  }));
  h.getOperation.mockResolvedValue(stored());
  h.claim.mockResolvedValue({ operation: applying(), started: true });
  h.active.mockResolvedValue(true);
  h.heartbeat.mockResolvedValue(true);
  h.prepActive.mockResolvedValue(true);
  h.prepHeartbeat.mockResolvedValue(true);
  h.prepProgress.mockResolvedValue(undefined);
  h.prepFinish.mockResolvedValue(undefined);
  h.prepGet.mockResolvedValue(preparing());
  h.prepDiscard.mockResolvedValue({
    preparation: { ...preparing(), status: "cancelled", sequence: 2 },
    operation: { ...stored(), status: "cancelled", sequence: 2 },
  });
  h.discardPlan.mockResolvedValue({
    preparation: { ...preparing(), status: "cancelled", sequence: 2 },
    operation: { ...stored(), status: "cancelled", sequence: 2 },
  });
  h.prepList.mockResolvedValue([preparing()]);
  h.prepStart.mockImplementation(async (organizationId, createdBy, inputHash, input, hosts) => ({
    started: true,
    preparation: { ...preparing(), organizationId, createdBy, inputHash, input, hosts },
  }));
  h.prepareHost.mockImplementation(async (_executor, _managedId, observer) => {
    for (const key of ["host", "python3", "iproute2", "wireguard-tools", "firewall", "kernel"]) {
      await observer.step(key, "running");
      observer.log(key, {
        level: "info",
        timestamp: new Date().toISOString(),
        message: `Prepared ${key}`,
      });
      await observer.step(key, "completed", `${key} ready`);
    }
  });
  h.inspect.mockImplementation(async (_executor, identity) => ({
    hostIdentity: identity.hostIdentity,
    fingerprint: "a".repeat(64),
    interfaces: [],
    routes: [],
    reservedIps: [],
    configHash: null,
    publicKey: null,
    packages: ["wireguard-tools"],
    firewall: "iptables",
    transportMtu: 1500,
  }));
  h.prepare.mockImplementation(async ({ id }, transaction) => ({
    operationId: transaction.operationId,
    generation: transaction.generation,
    stage: "prepared",
    publicKey: publicKey(id),
    healthy: true,
  }));
  h.apply.mockResolvedValue({ stage: "applied", healthy: true });
  h.stageTransport.mockResolvedValue({ stage: "applied", healthy: true });
  h.ready.mockImplementation(async (_executor, _managedId, peers: string[]) => ({
    ready: true,
    interfaceReady: true,
    peers: peers.map((serverId) => ({
      serverId,
      endpoint: "192.0.2.10",
      port: 51820,
      ok: true,
      lastHandshakeAt: new Date().toISOString(),
    })),
  }));
  h.commit.mockResolvedValue({ stage: "committed", healthy: true });
  h.rollback.mockResolvedValue({ stage: "rolled_back", healthy: true });
  h.interfaces.mockImplementation(async ({ id }) => [
    {
      name: applying().plan.interfaceName,
      mtu: 1400,
      up: true,
      kind: "wireguard",
      addresses: [{ address: id === "server-a" ? "10.244.0.1" : "10.244.0.2", prefixLength: 32 }],
    },
  ]);
  h.check.mockImplementation(async (_executor, source, peers) =>
    peers.map((peer: { serverId: string }) => ({
      sourceServerId: source.serverId,
      targetServerId: peer.serverId,
      tcp: true,
      udp: true,
      mtu: true,
      latencyMs: 1,
      message: null,
    })),
  );
});

describe("revising setup connection access", () => {
  const request = {
    preparationId: preparing().id,
    sequence: 4,
    requestId: "bbbbbbbb-2222-4222-8222-222222222222",
    access: {
      version: 1 as const,
      rules: [{ sourceServerId: "server-a", targetServerId: "server-b" }],
    },
  };
  it("reuses the preparation worker after the repository publishes an immutable revision", async () => {
    const source = { ...preparing(), status: "ready", sequence: request.sequence };
    const child = {
      ...preparing(),
      id: request.requestId,
      status: "pending",
      input: { ...source.input, requestId: request.requestId, access: request.access },
    };
    h.prepGet.mockImplementation(async (_org, id) => (id === child.id ? child : source));
    h.reviseAccess.mockResolvedValue({
      preparation: child,
      sourcePreparation: { ...source, status: "cancelled", replacementPreparationId: child.id },
      operation: null,
    });
    h.prepStart.mockResolvedValue({
      started: true,
      preparation: { ...child, status: "preparing" },
    });
    const result = await networkSetupMemberCollection.reviseManagedNetworkAccess(ctx, request);
    expect(result).toMatchObject({
      id: child.id,
      status: "preparing",
      input: { access: request.access },
    });
    expect(h.reviseAccess).toHaveBeenCalledWith("org-a", "user-a", request);
    expect(h.prepStart).toHaveBeenCalledWith(
      "org-a",
      "user-a",
      expect.any(String),
      child.input,
      expect.any(Array),
    );
    expect(h.executor).not.toHaveBeenCalled();
    expect(h.work).toHaveLength(1);
    h.prepStart.mockResolvedValue({
      started: false,
      preparation: { ...child, status: "preparing" },
    });
    await networkSetupMemberCollection.reviseManagedNetworkAccess(ctx, request);
    expect(h.work).toHaveLength(1);
  });
  it("requires self-hosted fleet administration before changing access", async () => {
    h.env.CLOUD_MODE = true;
    await expect(
      networkSetupMemberCollection.reviseManagedNetworkAccess(ctx, request),
    ).rejects.toMatchObject({ statusCode: 404 });
    h.env.CLOUD_MODE = false;
    h.authorize.mockRejectedValue(new AppError("Denied", 403));
    await expect(
      networkSetupMemberCollection.reviseManagedNetworkAccess(ctx, request),
    ).rejects.toThrow("Denied");
    expect(h.reviseAccess).not.toHaveBeenCalled();
    expect(h.prepStart).not.toHaveBeenCalled();
  });
});

describe("removing a setup server through the existing recovery workflow", () => {
  const requestId = "bbbbbbbb-2222-4222-8222-222222222222";
  it("saves the remaining servers without starting work until preparation is explicitly retried", async () => {
    const source = {
      ...preparing(["server-a", "server-b", "server-c"]),
      status: "failed" as const,
    };
    let child = {
      ...preparing(),
      id: requestId,
      input: { ...preparing().input, requestId },
      status: "pending" as ReturnType<typeof preparing>["status"],
    };
    h.prepGet.mockImplementation(async (_org, id) => (id === source.id ? source : child));
    h.removeMember.mockResolvedValue({
      preparation: child,
      sourcePreparation: { ...source, status: "cancelled", replacementPreparationId: requestId },
      operation: null,
    });
    h.prepStart.mockImplementation(async (_org, _user, inputHash, input, hosts) => {
      child = { ...child, inputHash, input, hosts, status: "preparing" };
      return { preparation: child, started: true };
    });
    const target = {
      preparationId: source.id,
      serverId: "server-c",
      requestId,
      sequence: source.sequence,
    };
    const result = await networkSetupMemberCollection.removeManagedNetworkPreparationMember(
      ctx,
      target,
    );
    expect(h.removeMember).toHaveBeenCalledExactlyOnceWith("org-a", "user-a", target);
    expect(result.preparation).toMatchObject({ id: requestId, status: "pending" });
    expect(h.executor).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.prepStart).not.toHaveBeenCalled();
    expect(h.work).toHaveLength(0);
    await networkPreparationCollection.prepareManagedNetwork(ctx, child.input);
    expect(h.prepStart).toHaveBeenCalledTimes(1);
    expect(h.work).toHaveLength(1);
    await h.work.shift()!();
    expect(h.prepareHost).toHaveBeenCalledTimes(2);
    expect(h.executor.mock.calls.every(([id]) => id !== "server-c")).toBe(true);
    expect(
      h.save.mock.calls[0]![5].config.members.map(
        (member: { serverId: string }) => member.serverId,
      ),
    ).toEqual(["server-a", "server-b"]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.rollback).not.toHaveBeenCalled();
  });

  it("waits for all original hosts to reset and still requires a separate preparation retry", async () => {
    let operation = {
      ...stored(["server-a", "server-b", "server-c"]),
      status: "needs_attention" as ReturnType<typeof stored>["status"],
      replacementPreparationId: requestId,
    };
    let child = {
      ...preparing(),
      id: requestId,
      input: { ...preparing().input, requestId },
      status: "pending" as ReturnType<typeof preparing>["status"],
      cleanupOperationId: operation.id,
    };
    h.getOperation.mockImplementation(async () => operation);
    h.prepGet.mockImplementation(async () => child);
    h.removeMember.mockResolvedValue({ preparation: child, sourcePreparation: null, operation });
    h.claim.mockImplementation(async (_org, _id, _hash, action) => {
      expect(action).toBe("rollback");
      operation = { ...operation, status: "rolling_back", generation: operation.generation + 1 };
      return { operation, started: true };
    });
    h.progress.mockImplementation(async (_id, _gen, status, hosts, report, error) => {
      operation = { ...operation, status, hosts, report, error };
    });
    h.finish.mockImplementation(async (_org, _id, _gen, status, hosts, report, error) => {
      operation = { ...operation, status, hosts, report, error };
    });
    h.prepStart.mockImplementation(async (_org, _user, inputHash, input, hosts) => {
      child = { ...child, inputHash, input, hosts, status: "preparing" };
      return { preparation: child, started: true };
    });
    h.rollback.mockImplementation(async ({ id }) => {
      if (id === "server-c") throw new Error("SSH unavailable");
      return { stage: "rolled_back", healthy: true };
    });
    const result = await networkSetupMemberCollection.removeManagedNetworkOperationMember(ctx, {
      operationId: operation.id,
      serverId: "server-c",
      sequence: operation.sequence,
      planHash: operation.planHash,
      requestId,
    });
    expect(result.preparation.status).toBe("pending");
    expect(h.prepStart).not.toHaveBeenCalled();
    expect(h.executor).not.toHaveBeenCalled();
    await h.work.shift()!();
    expect(h.rollback).toHaveBeenCalledTimes(3);
    expect(operation.status).toBe("needs_attention");
    expect(operation.hosts.find((host) => host.serverId === "server-c")?.error).toBeTruthy();
    expect(h.finish).not.toHaveBeenCalled();
    expect(child.status).toBe("pending");
    expect(h.prepStart).not.toHaveBeenCalled();
    h.rollback.mockResolvedValue({ stage: "rolled_back", healthy: true });
    await networkSetupMemberCollection.applyManagedNetwork(ctx, {
      operationId: operation.id,
      planHash: operation.planHash,
      action: "rollback",
    });
    await h.work.shift()!();
    expect(h.finish.mock.calls[0]?.[3]).toBe("rolled_back");
    expect(h.finish.mock.calls[0]?.[4]).toHaveLength(3);
    expect(child.status).toBe("pending");
    expect(h.prepStart).not.toHaveBeenCalled();
    expect(h.work).toHaveLength(0);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    await networkPreparationCollection.prepareManagedNetwork(ctx, child.input);
    expect(h.prepStart).toHaveBeenCalledTimes(1);
    expect(h.work).toHaveLength(1);
  });

  it("does not start preparation when completed cleanup is replayed after a controller restart", async () => {
    const operation = {
      ...stored(),
      status: "rolled_back" as const,
      replacementPreparationId: requestId,
    };
    const child = {
      ...preparing(),
      id: requestId,
      input: { ...preparing().input, requestId },
      status: "pending",
      cleanupOperationId: operation.id,
    };
    h.getOperation.mockResolvedValue(operation);
    h.prepGet.mockResolvedValue(child);
    h.claim.mockResolvedValue({ operation, started: false });
    h.prepStart.mockRejectedValue(new AppError("Selected server changed", 409));
    await networkSetupMemberCollection.applyManagedNetwork(ctx, {
      operationId: operation.id,
      planHash: operation.planHash,
      action: "rollback",
    });
    expect(h.interruptPending).not.toHaveBeenCalled();
    expect(h.prepStart).not.toHaveBeenCalled();
    expect(h.executor).not.toHaveBeenCalled();
    expect(h.work).toHaveLength(0);
  });

  it("requires self-hosted fleet administration and ownership before changing a selection", async () => {
    const preparation = {
      preparationId: preparing().id,
      serverId: "server-a",
      sequence: 1,
      requestId,
    };
    const operation = {
      operationId: stored().id,
      serverId: "server-a",
      sequence: 1,
      planHash: stored().planHash,
      requestId,
    };
    h.env.CLOUD_MODE = true;
    await expect(
      networkSetupMemberCollection.removeManagedNetworkPreparationMember(ctx, preparation),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      networkSetupMemberCollection.removeManagedNetworkOperationMember(ctx, operation),
    ).rejects.toMatchObject({ statusCode: 404 });
    h.env.CLOUD_MODE = false;
    h.authorize.mockRejectedValue(new AppError("Denied", 403));
    await expect(
      networkSetupMemberCollection.removeManagedNetworkPreparationMember(ctx, preparation),
    ).rejects.toThrow("Denied");
    expect(h.removeMember).not.toHaveBeenCalled();
    expect(h.executor).not.toHaveBeenCalled();
  });

  it("keeps a pending preparation stream open across cleanup and preparation", async () => {
    h.prepGet.mockResolvedValue({
      ...preparing(),
      status: "pending",
      cleanupOperationId: "original",
    });
    const abort = new AbortController();
    const source = await networkSetupStreams.events(
      ctx,
      "preparation",
      preparing().id,
      abort.signal,
    );
    const events = source[Symbol.asyncIterator]();
    try {
      expect(JSON.parse((await events.next()).value!.data).run.status).toBe("pending");
      const next = events.next();
      h.prepGet.mockResolvedValue({ ...preparing(), status: "preparing", sequence: 2 });
      notifyNetworkSetup("org-a", "preparation", preparing().id);
      expect(JSON.parse((await next).value!.data).run.status).toBe("preparing");
      const finished = events.next();
      h.prepGet.mockResolvedValue({
        ...preparing(),
        status: "ready",
        sequence: 3,
        operationId: "new-plan",
      });
      notifyNetworkSetup("org-a", "preparation", preparing().id);
      expect(JSON.parse((await finished).value!.data).run.operationId).toBe("new-plan");
      expect((await events.next()).value!.event).toBe("complete");
      expect(h.executor).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await events.return?.();
    }
  });
});

describe("managed network setup discard", () => {
  it("discards saved setup through the guarded repository without accessing hosts or starting work", async () => {
    const preparation = await networkPreparationCollection.discardManagedNetworkPreparation(ctx, {
      preparationId: preparing().id,
      sequence: 1,
    });
    expect(preparation).toMatchObject({ status: "cancelled", sequence: 2 });
    expect(h.prepDiscard).toHaveBeenCalledExactlyOnceWith("org-a", preparing().id, 1);
    const operation = await operations.discardManagedNetworkPlan(ctx, {
      operationId: stored().id,
      planHash: stored().planHash,
    });
    expect(operation).toMatchObject({ status: "cancelled", sequence: 2 });
    expect(h.discardPlan).toHaveBeenCalledExactlyOnceWith("org-a", stored().id, stored().planHash);
    expect(h.work).toEqual([]);
    expect(h.executor).not.toHaveBeenCalled();
    expect(h.server).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });
  it("requires self-hosted fleet administration for both discard paths", async () => {
    const discard = () =>
      Promise.allSettled([
        networkPreparationCollection.discardManagedNetworkPreparation(ctx, {
          preparationId: preparing().id,
          sequence: 1,
        }),
        operations.discardManagedNetworkPlan(ctx, {
          operationId: stored().id,
          planHash: stored().planHash,
        }),
      ]);
    h.env.CLOUD_MODE = true;
    expect((await discard()).every((result) => result.status === "rejected")).toBe(true);
    h.env.CLOUD_MODE = false;
    h.authorize.mockRejectedValue(new AppError("Denied", 403, "FORBIDDEN"));
    expect((await discard()).every((result) => result.status === "rejected")).toBe(true);
    expect(h.prepDiscard).not.toHaveBeenCalled();
    expect(h.discardPlan).not.toHaveBeenCalled();
    expect(h.executor).not.toHaveBeenCalled();
  });
});

describe("managed network prerequisite preparation", () => {
  it("persists inherited access for older callers so preparation cannot display a wider topology", async () => {
    const current = { ...stored().plan.config, id: "existing", revision: 3 };
    current.network.access = {
      version: 1,
      rules: [{ sourceServerId: "server-a", targetServerId: "server-b" }],
    };
    h.get.mockResolvedValue(current);
    const result = await networkPreparationCollection.prepareManagedNetwork(ctx, {
      ...managedPlanInputFixture(),
      clusterId: current.id,
      revision: 3,
    });
    expect(result.input.access).toEqual(current.network.access);
    expect(h.prepStart.mock.calls[0]![3].access).toEqual(current.network.access);
    expect(h.prepareHost).not.toHaveBeenCalled();
  });
  function reconnectingExecutor() {
    const reconnects: string[] = [];
    // Model the existing SSH manager's single retry with a fresh connection.
    h.executor.mockImplementation(async (id, fn) => {
      try {
        return await fn({ id });
      } catch (error) {
        if (!isRetryableRemoteConnectionError(error)) throw error;
        reconnects.push(id);
        return fn({ id });
      }
    });
    return reconnects;
  }
  it("reconnects a dropped inspection without repeating prerequisite installation or applying a network", async () => {
    const reconnects = reconnectingExecutor();
    h.inspect.mockRejectedValueOnce(
      new PrivateNetworkError(
        "Network inspection lost its SSH connection.",
        "MANAGED_NETWORK_HOST_UNREACHABLE",
        { cause: new SshDisconnectedError("private-transport-detail") },
      ),
    );
    await runNetworkPreparation(ctx, preparing());
    expect(reconnects).toEqual(["server-a"]);
    expect(h.inspect).toHaveBeenCalledTimes(3);
    expect(h.prepareHost).toHaveBeenCalledTimes(2);
    expect(h.prepFinish.mock.calls.at(-1)?.slice(3)).toEqual([preparing().id, null]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  });
  it("stops after a failed reconnect and persists the inspection diagnostic without raw transport details", async () => {
    const reconnects = reconnectingExecutor();
    const inspect = h.inspect.getMockImplementation()!;
    h.inspect.mockImplementation(async (executor, identity) => {
      if (executor.id !== "server-a") return inspect(executor, identity);
      throw new PrivateNetworkError(
        "Network inspection lost its SSH connection. Check SSH access, then retry.",
        "MANAGED_NETWORK_HOST_UNREACHABLE",
        { cause: new SshDisconnectedError("private-transport-detail") },
      );
    });
    await runNetworkPreparation(ctx, preparing());
    expect(reconnects).toEqual(["server-a"]);
    expect(h.inspect).toHaveBeenCalledTimes(3);
    const [, , hosts, operationId, error] = h.prepFinish.mock.calls.at(-1)!;
    expect(operationId).toBeNull();
    expect(error).toContain("Network inspection lost its SSH connection");
    expect(hosts[0].steps).toContainEqual(
      expect.objectContaining({
        id: "inspect",
        status: "failed",
        message: expect.stringContaining("lost its SSH connection"),
      }),
    );
    expect(hosts[1].steps).toContainEqual(
      expect.objectContaining({ id: "inspect", status: "completed" }),
    );
    expect(JSON.stringify(hosts)).not.toContain("private-transport-detail");
    expect(h.save).not.toHaveBeenCalled();
  });
  it("does not reconnect for an ordinary host command failure", async () => {
    const reconnects = reconnectingExecutor();
    const detail =
      "ip -j -4 route get 192.0.2.3 failed (exit 2): RTNETLINK answers: Network is unreachable";
    h.inspect.mockRejectedValueOnce(
      new PrivateNetworkError(detail, "MANAGED_NETWORK_COMMAND_FAILED", {
        cause: new Error("Exit code 1"),
      }),
    );
    await runNetworkPreparation(ctx, preparing());
    expect(reconnects).toEqual([]);
    expect(h.inspect).toHaveBeenCalledTimes(2);
    expect(h.prepFinish.mock.calls.at(-1)?.[4]).toBe(`server-a: ${detail}`);
    const hosts = h.prepFinish.mock.calls.at(-1)![2];
    expect(hosts[0].steps).toContainEqual(
      expect.objectContaining({ id: "inspect", status: "failed", message: detail }),
    );
    expect(hosts[0].transport).toEqual({ endpoint: "192.0.2.10", listenPort: 51820 });
    expect(hosts[0].logs).toContainEqual(
      expect.objectContaining({ step: "inspect", level: "error", message: detail }),
    );
    expect(h.save).not.toHaveBeenCalled();
  });
  it("marks a new attempt while retaining earlier diagnostics", async () => {
    const source = preparing();
    source.generation = 2;
    source.hosts[0]!.logs.push({
      step: "inspect",
      level: "error",
      message: "Previous inspection failure",
      timestamp: new Date(0).toISOString(),
    });
    await runNetworkPreparation(ctx, source);
    const hosts = h.prepFinish.mock.calls.at(-1)![2];
    expect(hosts[0].logs).toContainEqual(
      expect.objectContaining({ message: "Previous inspection failure" }),
    );
    for (const host of hosts)
      expect(host.logs).toContainEqual(
        expect.objectContaining({
          step: "connect",
          message: expect.stringContaining("Preparation attempt 2"),
        }),
      );
  });
  it("stops host preparation if another network operation reserves the server after the request was accepted", async () => {
    h.membership.mockResolvedValue({ clusterId: "another-cluster" });
    await runNetworkPreparation(ctx, preparing());
    expect(h.executor).not.toHaveBeenCalled();
    expect(h.prepareHost).not.toHaveBeenCalled();
    expect(h.prepFinish.mock.calls.at(-1)?.[3]).toBeNull();
    expect(h.prepFinish.mock.calls.at(-1)?.[2][0].steps[0]).toMatchObject({
      id: "connect",
      status: "failed",
      message: expect.stringContaining("Another network operation reserved"),
    });
  });
  it("uses stable retry hashes when jsonb changes object key order", async () => {
    const original = managedPlanInputFixture();
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as typeof original;
    reordered.members = original.members
      .map((member) => Object.fromEntries(Object.entries(member).reverse()) as typeof member)
      .reverse();
    await networkPreparationCollection.prepareManagedNetwork(ctx, original);
    await networkPreparationCollection.prepareManagedNetwork(ctx, reordered);
    expect(h.prepStart.mock.calls[0]![2]).toBe(h.prepStart.mock.calls[1]![2]);
  });
  it("returns a durable preparation before background SSH and does not apply the network", async () => {
    const result = await networkPreparationCollection.prepareManagedNetwork(
      ctx,
      managedPlanInputFixture(),
    );
    expect(result.status).toBe("preparing");
    expect(result.hosts).toHaveLength(2);
    expect(result).not.toHaveProperty("inputHash");
    expect(h.work).toHaveLength(1);
    expect(h.executor).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });
  it("finishes bootstrap across the fleet before allocating a reviewable plan", async () => {
    const inspection = h.inspect.getMockImplementation()!;
    h.inspect.mockImplementation(async (...args) => {
      expect(h.prepareHost).toHaveBeenCalledTimes(2);
      return inspection(...args);
    });
    await runNetworkPreparation(ctx, preparing());
    expect(h.prepFinish).toHaveBeenCalledWith(
      preparing().id,
      1,
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "server-a",
          hostIdentity: "host:server-a",
          steps: expect.arrayContaining([
            expect.objectContaining({ id: "python3", status: "completed" }),
            expect.objectContaining({ id: "inspect", status: "completed" }),
          ]),
        }),
      ]),
      preparing().id,
      null,
    );
    expect(h.save.mock.calls[0]![5]).toMatchObject({ preparationId: preparing().id });
    expect(h.save.mock.calls[0]![6]).toBe(preparing().generation);
    for (const host of h.prepFinish.mock.calls.at(-1)![2])
      expect(host.steps).toEqual(
        MANAGED_NETWORK_PREPARATION_STEPS.map((id) =>
          expect.objectContaining({ id, status: "completed" }),
        ),
      );
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  });
  it("streams resolved DNS endpoints and custom ports before inspection without changing the request", async () => {
    const source = preparing();
    delete source.input.members[0]!.endpoint;
    delete source.input.members[0]!.listenPort;
    source.input.members[1]!.listenPort = 53000;
    const original = structuredClone(source.input);
    const server = h.server.getMockImplementation()!;
    h.server.mockImplementation(async (id, organizationId) => ({
      ...(await server(id, organizationId)),
      sshHost: id === "server-a" ? "alpha.example.test" : "192.0.2.11",
    }));
    h.lookup.mockResolvedValue([{ address: "203.0.113.31", family: 4 }]);
    const inspect = h.inspect.getMockImplementation()!;
    h.inspect.mockImplementation(async (...args) => {
      expect(
        h.prepProgress.mock.calls.at(-1)![2].map((host: { transport: unknown }) => host.transport),
      ).toEqual([
        { endpoint: "203.0.113.31", listenPort: 51820 },
        { endpoint: "192.0.2.11", listenPort: 53000 },
      ]);
      return inspect(...args);
    });
    await runNetworkPreparation(ctx, source);
    expect(h.prepFinish.mock.calls.at(-1)?.[4]).toBeNull();
    expect(h.prepFinish.mock.calls.at(-1)![2][0].transport).toEqual({
      endpoint: "203.0.113.31",
      listenPort: 51820,
    });
    expect(h.lookup).toHaveBeenCalledWith("alpha.example.test", { family: 4, all: true });
    expect(source.input).toEqual(original);
  });

  it("keeps existing cluster transport settings when preparation does not override them", async () => {
    const source = preparing();
    const config = stored().plan.config;
    config.members[0]!.endpoint = "203.0.113.71";
    config.members[0]!.listenPort = 53001;
    h.get.mockResolvedValue({ ...config, id: "existing", revision: 3 });
    source.input.clusterId = "existing";
    source.input.revision = 3;
    for (const member of source.input.members) {
      delete member.endpoint;
      delete member.listenPort;
    }
    await runNetworkPreparation(ctx, source);
    expect(h.prepFinish.mock.calls.at(-1)?.[4]).toBeNull();
    expect(h.prepFinish.mock.calls.at(-1)![2][0].transport).toEqual({
      endpoint: "203.0.113.71",
      listenPort: 53001,
    });
    expect(source.input.members[0]).not.toHaveProperty("endpoint");
  });

  it("restores resolved firewall endpoints when a preparation retry reuses its saved plan", async () => {
    const source = preparing();
    source.generation = 2;
    source.hosts.forEach((host) => {
      host.hostIdentity = `host:${host.serverId}`;
      host.steps.forEach((step) => {
        step.status = step.id === "firewall" ? "skipped" : "completed";
      });
    });
    source.input.members[1]!.listenPort = 53111;
    await operations.planManagedNetwork(ctx, source.input);
    const [, id, , inputHash, planHash, plan] = h.save.mock.calls[0]!;
    h.find.mockResolvedValue({ ...stored(), id, inputHash, planHash, plan });
    h.inspect.mockClear();
    await runNetworkPreparation(ctx, source);
    expect(h.prepFinish.mock.calls.at(-1)?.[4]).toBeNull();
    expect(h.prepFinish.mock.calls.at(-1)![2][1].transport).toEqual({
      endpoint: "192.0.2.11",
      listenPort: 53111,
    });
    expect(h.prepFinish.mock.calls.at(-1)![1]).toBe(2);
    expect(h.prepFinish.mock.calls.at(-1)![3]).toBe(source.id);
    for (const host of h.prepFinish.mock.calls.at(-1)![2])
      expect(host.steps).toEqual(
        MANAGED_NETWORK_PREPARATION_STEPS.map((id) =>
          expect.objectContaining({ id, status: "completed" }),
        ),
      );
    expect(h.prepareHost).toHaveBeenCalledTimes(2);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("persists each failed prerequisite and keeps preparing other servers", async () => {
    const healthy = h.prepareHost.getMockImplementation()!;
    h.prepareHost.mockImplementation(async (executor, managedId, observer) => {
      if (executor.id === "server-a") {
        await observer.step("kernel", "failed", "This kernel does not provide WireGuard");
        throw new AppError("This kernel does not provide WireGuard", 400);
      }
      return healthy(executor, managedId, observer);
    });
    await runNetworkPreparation(ctx, preparing());
    expect(h.prepareHost).toHaveBeenCalledTimes(2);
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    const [, , hosts, operationId, error] = h.prepFinish.mock.calls.at(-1)!;
    expect(operationId).toBeNull();
    expect(error).toContain("1 server(s)");
    expect(hosts[0].steps).toContainEqual(
      expect.objectContaining({
        id: "kernel",
        status: "failed",
        message: "This kernel does not provide WireGuard",
      }),
    );
    expect(hosts[1].steps).toContainEqual(
      expect.objectContaining({ id: "kernel", status: "completed" }),
    );
  });
  it("refuses duplicate physical hosts before the first package installation", async () => {
    h.identity.mockResolvedValue("host:same");
    await runNetworkPreparation(ctx, preparing());
    expect(h.prepareHost).not.toHaveBeenCalled();
    expect(h.prepFinish.mock.calls.at(-1)![2][1].steps[0]).toMatchObject({
      status: "failed",
      message: expect.stringContaining("same physical host"),
    });
  });
  it.each(["cloud-mode", "cloud", "foreign"])(
    "refuses %s before scheduling server preparation",
    async (kind) => {
      const input = managedPlanInputFixture();
      if (kind === "cloud-mode") h.env.CLOUD_MODE = true;
      else if (kind === "cloud") h.env.DEPLOY_MODE = "cloud";
      else input.members[1]!.serverId = "foreign";
      await expect(
        networkPreparationCollection.prepareManagedNetwork(ctx, input),
      ).rejects.toThrow();
      expect(h.prepStart).not.toHaveBeenCalled();
      expect(h.work).toHaveLength(0);
      expect(h.executor).not.toHaveBeenCalled();
    },
  );
  it("does not continue installing after losing its durable lease", async () => {
    h.prepActive.mockResolvedValue(false);
    await runNetworkPreparation(ctx, preparing());
    expect(h.prepareHost).not.toHaveBeenCalled();
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.executor).not.toHaveBeenCalled();
  });
  it("redacts repository credentials and bounds log output before persistence", async () => {
    h.prepareHost.mockImplementation(async (_executor, _managedId, observer) => {
      await observer.step("python3", "running");
      for (let i = 0; i < 350; i++)
        observer.log("python3", {
          level: "info",
          message: `Downloading https://user:repository-secret@example.test/packages/${i}\u0000`,
          timestamp: new Date().toISOString(),
        });
      await observer.step("python3", "failed", "The repository is unavailable");
      throw new AppError("The repository is unavailable", 400);
    });
    await runNetworkPreparation(ctx, preparing());
    const hosts = h.prepFinish.mock.calls.at(-1)![2];
    expect(hosts.every((host: { logs: unknown[] }) => host.logs.length <= 300)).toBe(true);
    expect(JSON.stringify(hosts)).not.toContain("repository-secret");
    expect(JSON.stringify(hosts)).not.toContain("\\u0000");
  });
});

describe("managed network progress subscriptions", () => {
  it("replays committed preparation and streams its terminal failure without starting host work", async () => {
    const abort = new AbortController();
    const source = await networkSetupStreams.events(
      ctx,
      "preparation",
      preparing().id,
      abort.signal,
    );
    const events = source[Symbol.asyncIterator]();
    try {
      expect(JSON.parse((await events.next()).value!.data).run).toMatchObject({
        id: preparing().id,
        sequence: 1,
        status: "preparing",
      });
      const waiting = events.next();
      h.prepGet.mockResolvedValue({
        ...preparing(),
        sequence: 2,
        status: "failed",
        error: "Repository unavailable",
      });
      notifyNetworkSetup("org-a", "preparation", preparing().id);
      expect(JSON.parse((await waiting).value!.data).run).toMatchObject({
        sequence: 2,
        status: "failed",
        error: "Repository unavailable",
      });
      expect((await events.next()).value!.event).toBe("complete");
      expect((await events.next()).done).toBe(true);
      expect(h.work).toHaveLength(0);
      expect(h.executor).not.toHaveBeenCalled();
      expect(h.prepStart).not.toHaveBeenCalled();
      expect(h.claim).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await events.return?.();
    }
  });
  it("replays a saved operation after the worker is gone", async () => {
    h.getOperation.mockResolvedValue({
      ...stored(),
      sequence: 9,
      status: "interrupted",
      error: "Controller lease expired",
    });
    const source = await networkSetupStreams.events(ctx, "operation", stored().id);
    const received = [];
    for await (const event of source) received.push(event);
    expect(received.map((event) => event.event)).toEqual(["snapshot", "complete"]);
    expect(JSON.parse(received[0]!.data).run).toMatchObject({ sequence: 9, status: "interrupted" });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.executor).not.toHaveBeenCalled();
  });
  it("checks organization and self-hosted availability before opening a stream", async () => {
    h.prepGet.mockImplementation(async (organizationId) => {
      if (organizationId !== "org-a") throw new AppError("Not found", 404, "NOT_FOUND");
      return preparing();
    });
    await expect(
      networkSetupStreams.events(
        { ...ctx, organizationId: "org-b" },
        "preparation",
        preparing().id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.env.CLOUD_MODE = true;
    await expect(networkSetupStreams.events(ctx, "operation", stored().id)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(h.getOperation).not.toHaveBeenCalled();
  });
  it("rechecks read permission while subscribed and closes when it is revoked", async () => {
    const abort = new AbortController();
    const source = await networkSetupStreams.events(
      ctx,
      "preparation",
      preparing().id,
      abort.signal,
    );
    const events = source[Symbol.asyncIterator]();
    try {
      await events.next();
      const waiting = events.next();
      h.authorize.mockRejectedValue(new AppError("Access revoked", 403));
      notifyNetworkSetup("org-a", "preparation", preparing().id);
      await expect(waiting).rejects.toThrow("Access revoked");
      expect(h.executor).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await events.return?.();
    }
  });
});

describe("managed network authority and dry-run planning", () => {
  it("includes directed access in the reviewed plan and inspects only selected transport pairs", async () => {
    const access = { version: 1 as const, rules: [] };
    const result = await operations.planManagedNetwork(ctx, {
      ...managedPlanInputFixture(),
      access,
    });
    expect(result.plan.config.network.access).toEqual(access);
    expect(result.plan.config.members).toHaveLength(2);
    expect(h.inspect).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accessControlled: true, transportEndpoints: [] }),
    );
    expect(h.apply).not.toHaveBeenCalled();
  });
  it("blocks detaching a cluster dependency before preparation or planning touches a host", async () => {
    const current = { ...stored().plan.config, id: "existing", revision: 3 };
    h.get.mockResolvedValue(current);
    h.dependencies.mockRejectedValue(
      new AppError("A cluster uses this network", 409, "NETWORK_IN_USE"),
    );
    const input = { ...managedPlanInputFixture(), clusterId: current.id, revision: 3 };
    await expect(
      networkPreparationCollection.prepareManagedNetwork(ctx, input),
    ).rejects.toMatchObject({ code: "NETWORK_IN_USE" });
    await expect(
      operations.planManagedNetwork(ctx, { ...input, intent: "remove" }),
    ).rejects.toMatchObject({ code: "NETWORK_IN_USE" });
    expect(h.executor).not.toHaveBeenCalled();
    expect(h.prepStart).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each(["cloud-mode", "cloud"])(
    "blocks %s in planning, apply and workers before host access",
    async (mode) => {
      if (mode === "cloud-mode") h.env.CLOUD_MODE = true;
      else h.env.DEPLOY_MODE = "cloud";
      await expect(
        operations.planManagedNetwork(ctx, managedPlanInputFixture()),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      await expect(
        operations.applyManagedNetwork(ctx, {
          operationId: stored().id,
          planHash: stored().planHash,
          action: "apply",
        }),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      await runManagedNetwork(ctx, applying());
      expect(h.executor).not.toHaveBeenCalled();
      expect(h.install).not.toHaveBeenCalled();
      expect(h.prepare).not.toHaveBeenCalled();
    },
  );
  it("authorizes every selected server before any inspection", async () => {
    const input = managedPlanInputFixture();
    input.members[1]!.serverId = "foreign";
    await expect(operations.planManagedNetwork(ctx, input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.executor).not.toHaveBeenCalled();
  });
  it("persists a reviewable plan without package, key, interface or firewall mutations", async () => {
    const result = await operations.planManagedNetwork(ctx, managedPlanInputFixture());
    expect(result.status).toBe("planned");
    expect(result.plan.config.network).toMatchObject({
      mode: "wireguard",
      cidrs: ["10.244.0.0/24"],
      mtu: 1420,
    });
    expect(result.plan.hosts).toHaveLength(2);
    expect(result.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.inspect).toHaveBeenCalledTimes(2);
    for (const mutation of [h.install, h.prepare, h.stageTransport, h.apply, h.commit, h.rollback])
      expect(mutation).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("privateKey");
    expect(result).not.toHaveProperty("createdBy");
    expect(result).not.toHaveProperty("inputHash");
  });
  it("rejects duplicate physical hosts and conflicting ranges without mutation", async () => {
    h.identity.mockResolvedValue("host:same");
    await expect(operations.planManagedNetwork(ctx, managedPlanInputFixture())).rejects.toThrow(
      "same physical host",
    );
    expect(h.save).not.toHaveBeenCalled();
    h.identity.mockImplementation(async ({ id }) => `host:${id}`);
    h.inspect.mockImplementation(async (_executor, identity) => ({
      hostIdentity: identity.hostIdentity,
      fingerprint: "a".repeat(64),
      interfaces: [],
      routes: ["10.244.0.0/16"],
      reservedIps: [],
      configHash: null,
      publicKey: null,
      packages: [],
      firewall: "iptables",
      transportMtu: 1500,
    }));
    await expect(
      operations.planManagedNetwork(ctx, { ...managedPlanInputFixture(), cidr: "10.244.0.0/24" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(h.prepare).not.toHaveBeenCalled();
  });
  it("accepts IPv6 SSH management when each member supplies an IPv4 transport endpoint", async () => {
    h.server.mockImplementation(async (id, organizationId) => ({
      id,
      organizationId,
      name: id,
      sshHost: "2001:db8::1",
      isLocal: false,
    }));
    const input = managedPlanInputFixture();
    input.members = input.members.map((member, index) => ({
      ...member,
      endpoint: `192.0.2.${index + 10}`,
    }));
    const result = await operations.planManagedNetwork(ctx, input);
    expect(result.plan.config.members.map((member) => member.endpoint)).toEqual([
      "192.0.2.10",
      "192.0.2.11",
    ]);
    expect(h.install).not.toHaveBeenCalled();
  });
  it("reuses a claimed operation on repeated apply and schedules one worker", async () => {
    const input = {
      operationId: stored().id,
      planHash: stored().planHash,
      action: "apply" as const,
    };
    h.claim
      .mockResolvedValueOnce({ operation: applying(), started: true })
      .mockResolvedValueOnce({ operation: applying(), started: false });
    await operations.applyManagedNetwork(ctx, input);
    await operations.applyManagedNetwork(ctx, input);
    expect(h.work).toHaveLength(1);
    expect(h.claim).toHaveBeenCalledWith("org-a", input.operationId, input.planHash, "apply");
  });
});

describe("managed network application and recovery", () => {
  it("verifies allowed and denied directions while excluding isolated servers from WireGuard peer lists", async () => {
    const value = {
      ...stored(["server-a", "server-b", "server-c"]),
      status: "applying" as const,
      generation: 1,
    };
    value.plan.config.network.access = {
      version: 1,
      rules: [{ sourceServerId: "server-a", targetServerId: "server-b" }],
    };
    h.interfaces.mockImplementation(async ({ id }) => [
      {
        name: value.plan.interfaceName,
        mtu: 1400,
        up: true,
        kind: "wireguard",
        addresses: [
          {
            address: value.plan.config.members.find((member) => member.serverId === id)!.privateIp,
            prefixLength: 32,
          },
        ],
      },
    ]);
    h.check.mockImplementation(async (_executor, source, peers) =>
      peers.map((peer: { serverId: string }) => {
        const allowed = source.serverId === "server-a" && peer.serverId === "server-b";
        return {
          sourceServerId: source.serverId,
          targetServerId: peer.serverId,
          tcp: allowed,
          udp: allowed,
          mtu: allowed,
          reachable: allowed,
          latencyMs: allowed ? 1 : null,
          message: null,
        };
      }),
    );
    await runManagedNetwork(ctx, value);
    expect(h.ready).toHaveBeenCalledWith({ id: "server-a" }, value.plan.managedId, ["server-b"]);
    expect(h.ready).toHaveBeenCalledWith({ id: "server-b" }, value.plan.managedId, ["server-a"]);
    expect(h.ready).toHaveBeenCalledWith({ id: "server-c" }, value.plan.managedId, []);
    expect(h.prepare.mock.calls.every(([, transaction]) => transaction.accessControlled)).toBe(
      true,
    );
    expect(h.check).toHaveBeenCalledTimes(3);
    const [, , , status, , report] = h.finish.mock.calls.at(-1)!;
    expect(status).toBe("succeeded");
    expect(report.handshakes).toHaveLength(2);
    expect(report.peers).toHaveLength(6);
    expect(
      report.peers.filter((peer: { expectedAccess: string }) => peer.expectedAccess === "deny"),
    ).toHaveLength(5);
    expect(report.peers.every((peer: { policyPassed: boolean }) => peer.policyPassed)).toBe(true);
    expect(h.rollback).not.toHaveBeenCalled();
    expect(h.commit).toHaveBeenCalledTimes(3);
  });

  it.each(["reachable", "lost-ssh"])(
    "restores the network when a blocked direction cannot be verified: %s",
    async (failure) => {
      const value = applying();
      value.plan.config.network.access = {
        version: 1,
        rules: [{ sourceServerId: "server-a", targetServerId: "server-b" }],
      };
      h.check.mockImplementation(async (_executor, source, peers) => {
        if (failure === "lost-ssh" && source.serverId === "server-b")
          throw new SshDisconnectedError("Disconnected");
        return peers.map((peer: { serverId: string }) => ({
          sourceServerId: source.serverId,
          targetServerId: peer.serverId,
          tcp: true,
          udp: true,
          mtu: true,
          reachable: true,
          latencyMs: 1,
          message: null,
        }));
      });
      await runManagedNetwork(ctx, value);
      expect(h.commit).not.toHaveBeenCalled();
      expect(h.rollback).toHaveBeenCalledTimes(2);
      expect(h.finish.mock.calls.at(-1)![3]).toBe("rolled_back");
      const reverse = h.finish.mock.calls
        .at(-1)![5]
        .peers.find((peer: { sourceServerId: string }) => peer.sourceServerId === "server-b");
      expect(reverse).toMatchObject({ expectedAccess: "deny", policyPassed: false });
    },
  );

  it("tests every encrypted transport before assigning routes, verifies private connectivity, then commits", async () => {
    h.stageTransport.mockImplementation(async (_executor, _transaction, config) => {
      expect(h.prepare).toHaveBeenCalledTimes(2);
      expect(config.members.every((member: { publicKey: string }) => member.publicKey)).toBe(true);
      expect(h.apply).not.toHaveBeenCalled();
      return { stage: "applied", healthy: true };
    });
    const ready = h.ready.getMockImplementation()!;
    h.ready.mockImplementation(async (...args) => {
      expect(h.stageTransport).toHaveBeenCalledTimes(2);
      expect(h.apply).not.toHaveBeenCalled();
      return ready(...args);
    });
    h.listen.mockImplementation(async () => {
      expect(h.ready).toHaveBeenCalledTimes(2);
    });
    h.apply.mockImplementation(async (_executor, _transaction, config) => {
      expect(h.prepare).toHaveBeenCalledTimes(2);
      expect(h.ready).toHaveBeenCalledTimes(2);
      expect(config.members.every((member: { publicKey: string }) => member.publicKey)).toBe(true);
      return { stage: "applied", healthy: true };
    });
    h.commit.mockImplementation(async () => {
      expect(h.check).toHaveBeenCalledTimes(2);
      return { stage: "committed", healthy: true };
    });
    await runManagedNetwork(ctx, applying());
    expect(h.finish).toHaveBeenCalledWith(
      "org-a",
      stored().id,
      1,
      "succeeded",
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "server-a",
          stage: "committed",
          publicKey: publicKey("server-a"),
        }),
      ]),
      expect.objectContaining({ stage: "complete", peers: expect.any(Array) }),
      null,
    );
    expect(h.rollback).not.toHaveBeenCalled();
    expect(h.stop).toHaveBeenCalledTimes(2);
    expect(h.finalize).toHaveBeenCalledTimes(2);
    expect(
      h.finish.mock.calls
        .at(-1)![4]
        .every((host: { steps: Array<{ status: string }> }) =>
          host.steps.every((step) => step.status === "completed"),
        ),
    ).toBe(true);
  });
  it("cannot verify a replacement interface as an encrypted managed network", async () => {
    const original = h.interfaces.getMockImplementation()!;
    h.interfaces.mockImplementation(async (executor) =>
      (await original(executor)).map((nic: { kind: string }) => ({ ...nic, kind: "bridge" })),
    );
    await runManagedNetwork(ctx, applying());
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.rollback).toHaveBeenCalledTimes(2);
  });
  it("restores the mesh if handshakes fail, without assigning private addresses or routes", async () => {
    h.ready.mockRejectedValue(new AppError("WireGuard transport is blocked", 409));
    await runManagedNetwork(ctx, applying());
    expect(h.stageTransport).toHaveBeenCalledTimes(2);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.rollback).toHaveBeenCalledTimes(2);
    expect(h.finish.mock.calls.at(-1)![4][0].steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "handshake",
          status: "failed",
          message: "WireGuard transport is blocked",
        }),
        expect.objectContaining({ id: "rollback", status: "completed" }),
        expect.objectContaining({ id: "configure", status: "pending" }),
      ]),
    );
    expect(h.finish).toHaveBeenCalledWith(
      "org-a",
      stored().id,
      1,
      "rolled_back",
      expect.any(Array),
      expect.objectContaining({
        stage: "handshakes",
        handshakes: [],
        hosts: expect.arrayContaining([
          expect.objectContaining({ message: "WireGuard transport is blocked" }),
        ]),
      }),
      expect.stringContaining("Private address and route setup was not started"),
    );
  });
  it("retains the exact failed peers and transport endpoints after restoring a three-server mesh", async () => {
    const operation = {
      ...stored(["server-a", "server-b", "server-c"]),
      status: "applying" as const,
      generation: 1,
    };
    h.ready.mockImplementation(async ({ id }, _managedId, peers: string[]) => ({
      ready: false,
      interfaceReady: true,
      peers: peers.map((serverId) => ({
        serverId,
        endpoint: serverId === "server-c" ? "192.0.2.12" : "192.0.2.10",
        port: 51820,
        ok: id !== "server-c" && serverId !== "server-c",
        lastHandshakeAt:
          id !== "server-c" && serverId !== "server-c" ? new Date().toISOString() : null,
      })),
    }));
    await runManagedNetwork(ctx, operation);
    const [, , , status, hosts, report] = h.finish.mock.calls.at(-1)!;
    expect(status).toBe("rolled_back");
    expect(report.handshakes).toHaveLength(6);
    expect(report.handshakes.filter((peer: { ok: boolean }) => peer.ok)).toHaveLength(2);
    expect(report.handshakes).toContainEqual(
      expect.objectContaining({
        sourceServerId: "server-a",
        targetServerId: "server-c",
        endpoint: "192.0.2.12",
        port: 51820,
        ok: false,
      }),
    );
    expect(hosts[0].logs).toContainEqual(
      expect.objectContaining({
        step: "handshake",
        message: expect.stringContaining("server-c at 192.0.2.12:51820/UDP"),
      }),
    );
    expect(h.ready).toHaveBeenCalledTimes(3);
    expect(h.rollback).toHaveBeenCalledTimes(3);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });
  it("rolls back every possible mutation when UDP verification fails", async () => {
    h.check.mockImplementation(async (_executor, source, peers) =>
      peers.map((peer: { serverId: string }) => ({
        sourceServerId: source.serverId,
        targetServerId: peer.serverId,
        tcp: true,
        udp: false,
        mtu: false,
        latencyMs: null,
        message: "UDP blocked",
      })),
    );
    await runManagedNetwork(ctx, applying());
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.rollback).toHaveBeenCalledTimes(2);
    expect(h.finish).toHaveBeenCalledWith(
      "org-a",
      stored().id,
      1,
      "rolled_back",
      expect.any(Array),
      expect.any(Object),
      expect.any(String),
    );
    expect(h.finalize).toHaveBeenCalledTimes(2);
  });
  it("restores uncertain transport setup and keeps recovery open when a host cannot confirm", async () => {
    h.stageTransport.mockRejectedValueOnce(
      new AppError("SSH disconnected during transport setup", 503),
    );
    h.rollback.mockImplementation(async ({ id }) => {
      if (id === "server-a") throw new AppError("Server is offline", 503);
      return { stage: "rolled_back", healthy: true };
    });
    await runManagedNetwork(ctx, applying());
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.rollback).toHaveBeenCalledTimes(2);
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.progress).toHaveBeenLastCalledWith(
      stored().id,
      1,
      "needs_attention",
      expect.arrayContaining([expect.objectContaining({ serverId: "server-a", stage: "failed" })]),
      null,
      "SSH disconnected during transport setup",
    );
  });
  it("restores uncertain apply results too, and retains recovery when a host cannot confirm", async () => {
    h.apply.mockRejectedValueOnce(new AppError("SSH disconnected after apply", 503));
    h.rollback.mockImplementation(async ({ id }) => {
      if (id === "server-a") throw new AppError("Server is offline", 503);
      return { stage: "rolled_back", healthy: true };
    });
    await runManagedNetwork(ctx, applying());
    expect(h.rollback).toHaveBeenCalledTimes(2);
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.progress).toHaveBeenLastCalledWith(
      stored().id,
      1,
      "needs_attention",
      expect.arrayContaining([expect.objectContaining({ serverId: "server-a", stage: "failed" })]),
      expect.objectContaining({ stage: "handshakes", handshakes: expect.any(Array) }),
      "SSH disconnected after apply",
    );
  });
  it("keeps recovery claims when an old rollback receipt no longer describes a healthy network", async () => {
    h.apply.mockRejectedValueOnce(new AppError("SSH disconnected after apply", 503));
    h.rollback.mockResolvedValue({ stage: "rolled_back", healthy: false });
    await runManagedNetwork(ctx, applying());
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.progress).toHaveBeenLastCalledWith(
      stored().id,
      1,
      "needs_attention",
      expect.arrayContaining([expect.objectContaining({ stage: "failed" })]),
      expect.any(Object),
      expect.any(String),
    );
  });
  it("checks host fingerprints again before installation or preparation", async () => {
    h.inspect.mockResolvedValue({ fingerprint: "changed" });
    await runManagedNetwork(ctx, applying());
    expect(h.install).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.rollback).toHaveBeenCalledTimes(2);
  });
  it("cannot mutate a replacement SSH target during recovery", async () => {
    h.identity.mockImplementation(async ({ id }) =>
      id === "server-a" ? "host:replacement" : `host:${id}`,
    );
    await runManagedNetwork(ctx, { ...applying(), status: "rolling_back" });
    expect(h.rollback.mock.calls.every(([executor]) => executor.id !== "server-a")).toBe(true);
    expect(h.finish).not.toHaveBeenCalled();
  });
  it("stops host work after authorization revocation and relies on local rollback", async () => {
    h.authorize.mockImplementation(async (context) => {
      if (h.prepare.mock.calls.length === 2) throw new AppError("Access revoked", 403);
      return context;
    });
    await runManagedNetwork(ctx, applying());
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.rollback).not.toHaveBeenCalled();
    expect(h.progress).toHaveBeenLastCalledWith(
      stored().id,
      1,
      "needs_attention",
      expect.any(Array),
      null,
      "Access revoked",
    );
  });
  it("a stale worker cannot finish after losing its lease", async () => {
    h.active.mockResolvedValue(false);
    await runManagedNetwork(ctx, applying());
    expect(h.executor).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });
});
