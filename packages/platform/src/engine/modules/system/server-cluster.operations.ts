import { createHash, randomBytes } from "node:crypto";
import {
  AppError,
  type ServerCluster,
  type ClusterVerification,
  type CreateClusterInput,
  type UpdateClusterInput,
} from "@repo/contracts";
import {
  INFRASTRUCTURE_PROVIDERS,
  MAX_CLUSTER_MEMBERS,
  ClusterConfigError,
  validateNativeCluster,
  selectClusterInterface,
  networkReportSucceeded,
  type NativeClusterConfig,
  type ClusterNetworkReport,
  type NetworkHostObservation,
} from "@repo/core";
import { repos, type ServerClusterRecord, type ClusterVerificationRecord } from "@repo/db";
import {
  privateNetworkTools,
  PrivateNetworkError,
  type CommandExecutor,
  type PrivateNetworkProbe,
} from "@repo/adapters";
import type { ExecutionContext } from "../../../context";
import type { ServerDependencies } from "../../../servers";
import { isOblienConfigured } from "../../lib/platform-mode";
import { authorization } from "../../lib/authorization";
import { sshManager } from "../../lib/ssh-manager";
import { inspectHostIssuedIdentity } from "../../lib/host-port-target";
import { deferBackgroundWork } from "../../lib/background-work";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { assertSelfHosted, assertServerExecution, requireSelfHostedServer } from "./server-access";

function infrastructureUnavailable(): string | null {
  if (isOblienConfigured())
    return "Server clusters are managed by self-hosted OpenShip. Oblien manages Cloud infrastructure.";
  // Manual adoption and bounded verification work from a local/desktop controller
  // too. Always-on reconciliation is a separate, future capability.
  return null;
}
export function assertClusterManagementAvailable() {
  assertSelfHosted();
  const reason = infrastructureUnavailable();
  if (reason) throw new AppError(reason, 404, "CAPABILITY_UNAVAILABLE");
}

async function authorizeMember(ctx: ExecutionContext, serverId: string) {
  assertClusterManagementAvailable();
  await authorization.authorize(ctx, {
    resourceType: "server",
    resourceId: serverId,
    action: "admin",
  });
  return requireSelfHostedServer(ctx, serverId);
}

async function onServer<T>(
  ctx: ExecutionContext,
  serverId: string,
  fn: (executor: CommandExecutor) => Promise<T>,
): Promise<T> {
  const server = await authorizeMember(ctx, serverId);
  await assertServerExecution(server);
  return sshManager.withExecutor(serverId, async (executor) => {
    // withExecutor can retry; recheck authority before each attempt too.
    await authorizeMember(ctx, serverId);
    await assertServerExecution(server);
    return fn(executor);
  });
}

async function inspect(executor: CommandExecutor): Promise<NetworkHostObservation> {
  const hostIdentity = await inspectHostIssuedIdentity(executor);
  if (!hostIdentity)
    throw new PrivateNetworkError(
      "The server needs a persistent machine identity before it can join a cluster.",
      "NETWORK_HOST_IDENTITY_MISSING",
    );
  return { hostIdentity, interfaces: await privateNetworkTools.inspect(executor) };
}

function normalizeConfig(input: NativeClusterConfig): NativeClusterConfig {
  const config: NativeClusterConfig = {
    name: input.name.trim(),
    location: input.location?.trim() || undefined,
    network: { ...input.network, cidrs: input.network.cidrs.map((c) => c.trim()).sort() },
    members: input.members
      .map((m) => ({
        ...m,
        privateIp: m.privateIp.trim(),
        interfaceName: m.interfaceName?.trim() || undefined,
        networkRef: m.networkRef?.trim() || undefined,
      }))
      .sort((a, b) => a.serverId.localeCompare(b.serverId)),
  };
  try {
    validateNativeCluster(config);
  } catch (error) {
    if (error instanceof ClusterConfigError) throw new AppError(error.message, 400, error.code);
    throw error;
  }
  return config;
}

function presentVerification(run: ClusterVerificationRecord): ClusterVerification {
  return {
    id: run.id,
    clusterId: run.clusterId,
    revision: run.revision,
    status: run.status,
    report: run.report,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    expiresAt: run.expiresAt.toISOString(),
  };
}
function presentCluster(row: ServerClusterRecord): ServerCluster {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    revision: row.revision,
    network: {
      id: row.network.id,
      mode: row.network.mode,
      cidrs: row.network.cidrs,
      mtu: row.network.mtu,
      probePort: row.network.probePort,
      ownership: "external",
      encryption: "external",
    },
    members: row.members.map((m) => ({
      serverId: m.serverId,
      name: m.name,
      providerId: m.providerId,
      privateIp: m.privateIp,
      ...(m.interfaceName ? { interfaceName: m.interfaceName } : {}),
      ...(m.networkRef ? { networkRef: m.networkRef } : {}),
    })),
    verification: row.verification ? presentVerification(row.verification) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function record(ctx: ExecutionContext, clusterId: string, action: string) {
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "server:write",
    resourceType: "server",
    resourceId: "*",
    after: { clusterId, action },
  });
}

/** Bound fan-out so a fleet check cannot exhaust the shared SSH pool. */
async function eachMember<T>(items: readonly T[], fn: (item: T) => Promise<void>, concurrency = 4) {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await fn(item);
      }
    }),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

function checkError(error: unknown): { code: string; message: string } {
  if (
    error instanceof PrivateNetworkError ||
    error instanceof ClusterConfigError ||
    error instanceof AppError
  )
    return { code: error.code ?? "NETWORK_CHECK_FAILED", message: error.message };
  // SSH exceptions can include commands and transport details. Keep persisted reports bounded and credential-free.
  return {
    code: "NETWORK_HOST_UNREACHABLE",
    message: "Couldn't inspect this server. Check SSH access and network prerequisites.",
  };
}

async function verify(
  ctx: ExecutionContext,
  cluster: ServerClusterRecord,
  run: ClusterVerificationRecord,
) {
  const report: ClusterNetworkReport = { stage: "inspecting", hosts: [], peers: [] };
  const probes: PrivateNetworkProbe[] = cluster.members.map((m) => ({
    serverId: m.serverId,
    privateIp: m.privateIp,
    port: cluster.network.probePort,
    token: randomBytes(24).toString("hex"),
  }));
  const listening = new Set<string>();
  let success = false;
  let failureMessage: string | null = null;
  const checkedServer = async <T>(
    serverId: string,
    fn: (executor: CommandExecutor) => Promise<T>,
  ) => {
    await authorization.authorize(ctx, {
      resourceType: "server",
      resourceId: "*",
      action: "admin",
      scope: "all",
    });
    if (Date.now() > run.expiresAt.getTime() || !(await repos.serverCluster.active(run.id)))
      throw new AppError(
        "Network verification is no longer active.",
        409,
        "NETWORK_CHECK_INTERRUPTED",
      );
    return onServer(ctx, serverId, fn);
  };
  let progressWrites = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(report);
    progressWrites = progressWrites.then(async () => {
      if (Date.now() > run.expiresAt.getTime())
        throw new AppError(
          "Network verification expired. Run it again.",
          409,
          "NETWORK_CHECK_EXPIRED",
        );
      if (!(await repos.serverCluster.progress(run.id, snapshot)))
        throw new AppError(
          "Network verification is no longer active.",
          409,
          "NETWORK_CHECK_INTERRUPTED",
        );
    });
    return progressWrites;
  };
  try {
    // No host access until every member has passed the current organization/permission boundary.
    for (const member of cluster.members) await authorizeMember(ctx, member.serverId);
    const identities = new Set<string>();
    await eachMember(cluster.members, async (member) => {
      try {
        const observation = await checkedServer(member.serverId, inspect);
        const nic = selectClusterInterface(
          observation,
          {
            ...member,
            interfaceName: member.interfaceName ?? undefined,
            networkRef: member.networkRef ?? undefined,
          },
          cluster.network.mtu,
        );
        if (identities.has(observation.hostIdentity))
          throw new PrivateNetworkError(
            "Two selected server entries point to the same physical host.",
            "NETWORK_DUPLICATE_HOST",
          );
        identities.add(observation.hostIdentity);
        await repos.serverCluster.recordIdentity(
          cluster.id,
          member.serverId,
          observation.hostIdentity,
          run.id,
        );
        report.hosts.push({
          serverId: member.serverId,
          ok: true,
          interfaceName: nic.name,
          mtu: nic.mtu,
          code: null,
          message: null,
        });
      } catch (error) {
        report.hosts.push({
          serverId: member.serverId,
          ok: false,
          interfaceName: null,
          mtu: null,
          ...checkError(error),
        });
      }
      await persist();
    });
    if (report.hosts.some((h) => !h.ok))
      throw new PrivateNetworkError(
        "Resolve the server checks before verifying peer connectivity.",
      );
    report.stage = "probing";
    await persist();
    await eachMember(probes, async (probe) => {
      // Register before the command: if SSH disconnects after a successful bind,
      // cleanup still attempts the authenticated stop. The host also has a TTL.
      listening.add(probe.serverId);
      try {
        await checkedServer(probe.serverId, (executor) =>
          privateNetworkTools.listen(
            executor,
            probe,
            probes.map((p) => p.privateIp),
          ),
        );
      } catch (error) {
        const host = report.hosts.find((h) => h.serverId === probe.serverId)!;
        Object.assign(host, { ok: false, ...checkError(error) });
      }
    });
    if (report.hosts.some((h) => !h.ok))
      throw new PrivateNetworkError(
        "A private verification listener couldn't start. Check the per-server result.",
      );
    await eachMember(probes, async (probe) => {
      const peers = probes.filter((p) => p.serverId !== probe.serverId);
      try {
        const result = await checkedServer(probe.serverId, (executor) =>
          privateNetworkTools.check(executor, probe, peers, cluster.network.mtu),
        );
        report.peers.push(...result);
      } catch (error) {
        report.peers.push(
          ...peers.map((peer) => ({
            sourceServerId: probe.serverId,
            targetServerId: peer.serverId,
            tcp: false,
            udp: false,
            mtu: false,
            latencyMs: null,
            message: checkError(error).message,
          })),
        );
      }
      await persist();
    });
    report.stage = "complete";
    success = networkReportSucceeded(
      report,
      cluster.members.map((m) => m.serverId),
    );
    failureMessage = success
      ? null
      : "Some private connections failed. Check the connection results and run verification again.";
  } catch (error) {
    await progressWrites.catch(() => undefined);
    report.stage = "complete";
    failureMessage = checkError(error).message;
  } finally {
    await eachMember(
      probes.filter((p) => listening.has(p.serverId)),
      async (probe) => {
        try {
          await authorization.authorize(ctx, {
            resourceType: "server",
            resourceId: "*",
            action: "admin",
            scope: "all",
          });
          await onServer(ctx, probe.serverId, (executor) =>
            privateNetworkTools.stop(executor, probe),
          );
        } catch {
          /* A revoked session cannot continue host operations. The listener expires locally. */
        }
      },
    );
    await repos.serverCluster.finish(run.id, report, success, failureMessage);
  }
}

export const serverClusterCollection = {
  async clusterCapabilities(ctx) {
    const reason = infrastructureUnavailable();
    return {
      available: !reason,
      reason,
      maxMembers: MAX_CLUSTER_MEMBERS,
      canManage:
        !reason &&
        (await authorization.checkPermissionOnResource(ctx, {
          resourceType: "server",
          resourceId: "*",
          action: "admin",
          scope: "all",
        })),
      modes: reason ? [] : ["native"],
      providers: reason
        ? []
        : INFRASTRUCTURE_PROVIDERS.map((p) => ({
            ...p,
            capabilities: { adopt: true, provision: false, configureHost: false },
          })),
    };
  },
  async listClusters(ctx) {
    assertClusterManagementAvailable();
    return (await repos.serverCluster.list(ctx.organizationId)).map(presentCluster);
  },
  async getCluster(ctx, input) {
    assertClusterManagementAvailable();
    return presentCluster(await repos.serverCluster.get(ctx.organizationId, input.clusterId));
  },
  async createCluster(ctx, input: CreateClusterInput) {
    assertClusterManagementAvailable();
    const config = normalizeConfig(input);
    return withServerInventoryLock(ctx.organizationId, async () => {
      assertClusterManagementAvailable();
      await authorization.authorize(ctx, {
        resourceType: "server",
        resourceId: "*",
        action: "admin",
        scope: "all",
      });
      for (const member of config.members) await authorizeMember(ctx, member.serverId);
      const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
      const row = await repos.serverCluster.create(
        ctx.organizationId,
        config,
        input.requestId,
        hash,
      );
      record(ctx, row.id, "cluster.created");
      return presentCluster(row);
    });
  },
  async updateCluster(ctx, input: UpdateClusterInput) {
    assertClusterManagementAvailable();
    const config = normalizeConfig(input);
    return withServerInventoryLock(ctx.organizationId, async () => {
      assertClusterManagementAvailable();
      await authorization.authorize(ctx, {
        resourceType: "server",
        resourceId: "*",
        action: "admin",
        scope: "all",
      });
      const current = await repos.serverCluster.get(ctx.organizationId, input.clusterId);
      for (const id of new Set([...current.members, ...config.members].map((m) => m.serverId)))
        await authorizeMember(ctx, id);
      const row = await repos.serverCluster.update(
        ctx.organizationId,
        input.clusterId,
        input.revision,
        config,
      );
      record(ctx, row.id, "cluster.updated");
      return presentCluster(row);
    });
  },
  async verifyCluster(ctx, input) {
    assertClusterManagementAvailable();
    const cluster = await repos.serverCluster.get(ctx.organizationId, input.clusterId);
    if (cluster.revision !== input.revision)
      throw new AppError(
        "The cluster changed. Reload it before continuing.",
        409,
        "CLUSTER_CONFLICT",
      );
    for (const member of cluster.members) await authorizeMember(ctx, member.serverId);
    const { run, created } = await repos.serverCluster.startVerification(
      ctx.organizationId,
      cluster.id,
      input.revision,
      ctx.userId,
    );
    if (created) {
      record(ctx, cluster.id, "cluster.verification.started");
      void deferBackgroundWork(() => verify(ctx, cluster, run)).catch(() => undefined);
    }
    return presentVerification(run);
  },
  async removeCluster(ctx, input) {
    assertClusterManagementAvailable();
    const cluster = await repos.serverCluster.get(ctx.organizationId, input.clusterId);
    for (const member of cluster.members) await authorizeMember(ctx, member.serverId);
    await repos.serverCluster.remove(ctx.organizationId, input.clusterId, input.revision);
    record(ctx, input.clusterId, "cluster.removed");
    return { removed: true };
  },
} satisfies Pick<
  ServerDependencies["collection"],
  | "clusterCapabilities"
  | "listClusters"
  | "getCluster"
  | "createCluster"
  | "updateCluster"
  | "verifyCluster"
  | "removeCluster"
>;

export const serverClusterResources = {
  async inspectNetwork(ctx, id) {
    return onServer(ctx, id, inspect);
  },
} satisfies Pick<ServerDependencies["resources"], "inspectNetwork">;
