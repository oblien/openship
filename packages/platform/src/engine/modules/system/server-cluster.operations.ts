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
  nativeNetworkSource,
  networkMemberProvider,
  networkReportSucceeded,
  networkAccessAllowed,
  networkConnectionMode,
  networkTransportPeers,
  type NetworkAccessPolicy,
  type NativeClusterConfig,
  type ClusterNetworkReport,
  type NetworkHostObservation,
  type ManagedNetworkOperation,
} from "@repo/core";
import {
  repos,
  type ServerClusterRecord,
  type ClusterVerificationRecord,
  type ManagedNetworkOperationRecord,
} from "@repo/db";
import {
  privateNetworkTools,
  managedNetworkTools,
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
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { assertSelfHosted, assertServerExecution, requireSelfHostedServer } from "./server-access";
import { notifyNetworkSetup } from "./network-setup-bus";
import { assertNetworkSetupAcceptingWork, deferNetworkSetupWork } from "./network-setup-lifecycle";

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

export async function authorizeMember(ctx: ExecutionContext, serverId: string) {
  assertClusterManagementAvailable();
  await authorization.authorize(ctx, {
    resourceType: "server",
    resourceId: serverId,
    action: "admin",
  });
  return requireSelfHostedServer(ctx, serverId);
}

export async function onServer<T>(
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

export async function inspect(executor: CommandExecutor): Promise<NetworkHostObservation> {
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
    network: {
      ...input.network,
      cidrs: input.network.cidrs.map((c) => c.trim()).sort(),
      // Do not add fields to legacy inputs: their idempotency hashes must stay stable.
      ...(input.network.source ? { source: nativeNetworkSource(input) } : {}),
    },
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

export function presentVerification(run: ClusterVerificationRecord): ClusterVerification {
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
export function presentManagedOperation(
  operation: ManagedNetworkOperationRecord,
): ManagedNetworkOperation {
  return {
    id: operation.id,
    sequence: operation.sequence,
    clusterId: operation.clusterId,
    status: operation.status,
    planHash: operation.planHash,
    plan: operation.plan,
    replacementPreparationId: operation.replacementPreparationId ?? null,
    hosts: operation.hosts,
    report: operation.report,
    error: operation.error,
    generation: operation.generation,
    leaseExpiresAt: operation.leaseExpiresAt?.toISOString() ?? null,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}

export function presentCluster(row: ServerClusterRecord): ServerCluster {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    revision: row.revision,
    network: {
      id: row.network.id,
      cidrs: row.network.cidrs,
      mtu: row.network.mtu,
      probePort: row.network.probePort,
      ...(row.network.mode === "wireguard"
        ? {
            mode: "wireguard" as const,
            ownership: "openship" as const,
            encryption: "wireguard" as const,
            managedId: row.network.managedId!,
            interfaceName: row.network.interfaceName!,
            ...(row.network.access ? { access: row.network.access } : {}),
          }
        : {
            mode: "native" as const,
            ownership: "external" as const,
            encryption: "external" as const,
            source: nativeNetworkSource(row),
          }),
    },
    members: row.members.map((m) => ({
      serverId: m.serverId,
      name: m.name,
      providerId: m.providerId,
      privateIp: m.privateIp,
      ...(m.interfaceName ? { interfaceName: m.interfaceName } : {}),
      ...(m.networkRef ? { networkRef: m.networkRef } : {}),
      ...(m.endpoint ? { endpoint: m.endpoint } : {}),
      ...(m.listenPort ? { listenPort: m.listenPort } : {}),
      ...(m.publicKey ? { publicKey: m.publicKey } : {}),
    })),
    verification: row.verification ? presentVerification(row.verification) : null,
    operation: row.operation ? presentManagedOperation(row.operation) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function record(ctx: ExecutionContext, resourceId: string, action: string) {
  notifyNetworkSetup(ctx.organizationId, "overview");
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "server:write",
    resourceType: "server",
    resourceId: "*",
    after: {
      ...(action.startsWith("network.") ? { networkId: resourceId } : { clusterId: resourceId }),
      action,
    },
  });
}

/** Bound fan-out so a fleet check cannot exhaust the shared SSH pool. */
export async function eachMember<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  concurrency = 4,
) {
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

export function checkError(error: unknown): { code: string; message: string } {
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

export async function verifyClusterNetwork(
  ctx: ExecutionContext,
  cluster: {
    id: string;
    network: {
      mode: "native" | "wireguard";
      mtu: number;
      probePort: number;
      managedId?: string | null;
      access?: NetworkAccessPolicy | null;
    };
    members: Array<NativeClusterConfig["members"][number]>;
  },
  run: ClusterVerificationRecord | null,
  managed?: {
    checkedServer<T>(serverId: string, fn: (executor: CommandExecutor) => Promise<T>): Promise<T>;
    recordIdentity(serverId: string, identity: string): Promise<void>;
    progress(report: ClusterNetworkReport): Promise<void>;
  },
  controllerSignal?: AbortSignal,
) {
  const speedTest = run?.report.speedTest;
  const report: ClusterNetworkReport = {
    stage: "inspecting",
    hosts: [],
    peers: [],
    ...(speedTest ? { speedTest, throughput: [] } : {}),
  };
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
    controllerSignal?.throwIfAborted();
    if (managed) return managed.checkedServer(serverId, fn);
    if (!run) throw new AppError("Missing verification run", 500);
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
    return onServer(ctx, serverId, (executor) => {
      controllerSignal?.throwIfAborted();
      return fn(executor);
    });
  };
  let progressWrites = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(report);
    progressWrites = progressWrites.then(async () => {
      if (managed) return managed.progress(snapshot);
      if (!run) throw new AppError("Missing verification run", 500);
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
      notifyNetworkSetup(ctx.organizationId, "overview");
    });
    return progressWrites;
  };
  try {
    if (
      speedTest &&
      (speedTest.sourceServerId === speedTest.targetServerId ||
        ![speedTest.sourceServerId, speedTest.targetServerId].every((id) =>
          cluster.members.some((member) => member.serverId === id),
        ) ||
        networkConnectionMode(
          cluster.network.access,
          speedTest.sourceServerId,
          speedTest.targetServerId,
        ) === "blocked")
    )
      throw new AppError(
        "Choose two different members of this network for the speed test.",
        400,
        "INVALID_NETWORK_TEST",
      );
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
            providerId: networkMemberProvider(cluster.network, member),
            interfaceName: member.interfaceName ?? undefined,
            networkRef: member.networkRef ?? undefined,
          },
          cluster.network.mtu,
        );
        if (cluster.network.mode === "wireguard" && nic.kind !== "wireguard")
          throw new PrivateNetworkError(
            "The managed interface is no longer a WireGuard interface. Restore its owned configuration before verifying it.",
            "MANAGED_NETWORK_INTERFACE_CHANGED",
          );
        if (identities.has(observation.hostIdentity))
          throw new PrivateNetworkError(
            "Two selected server entries point to the same physical host.",
            "NETWORK_DUPLICATE_HOST",
          );
        identities.add(observation.hostIdentity);
        if (managed) await managed.recordIdentity(member.serverId, observation.hostIdentity);
        else
          await repos.serverCluster.recordIdentity(
            cluster.id,
            member.serverId,
            observation.hostIdentity,
            run!.id,
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
            speedTest &&
              [speedTest.sourceServerId, speedTest.targetServerId].includes(probe.serverId)
              ? probes.find(
                  (peer) =>
                    peer.serverId ===
                    (probe.serverId === speedTest.sourceServerId
                      ? speedTest.targetServerId
                      : speedTest.sourceServerId),
                )!.privateIp
              : undefined,
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
        report.peers.push(
          ...result.map((peer) => {
            if (!cluster.network.access) return peer;
            const allowed = networkAccessAllowed(
              cluster.network.access,
              peer.sourceServerId,
              peer.targetServerId,
            );
            return {
              ...peer,
              expectedAccess: allowed ? ("allow" as const) : ("deny" as const),
              policyPassed: allowed ? peer.tcp && peer.udp && peer.mtu : peer.reachable === false,
              ...(!allowed
                ? {
                    message:
                      peer.reachable === false
                        ? null
                        : peer.reachable === true
                          ? "This direction is reachable despite being blocked by the connection policy."
                          : "The host did not verify that this direction rejects new connections.",
                  }
                : {}),
            };
          }),
        );
      } catch (error) {
        report.peers.push(
          ...peers.map((peer) => ({
            sourceServerId: probe.serverId,
            targetServerId: peer.serverId,
            tcp: false,
            udp: false,
            mtu: false,
            latencyMs: null,
            ...(cluster.network.access
              ? {
                  expectedAccess: networkAccessAllowed(
                    cluster.network.access,
                    probe.serverId,
                    peer.serverId,
                  )
                    ? ("allow" as const)
                    : ("deny" as const),
                  policyPassed: false,
                }
              : {}),
            message: checkError(error).message,
          })),
        );
      }
      await persist();
    });
    if (cluster.network.mode === "wireguard" && !managed) {
      if (!cluster.network.managedId)
        throw new PrivateNetworkError("This cluster is missing its managed network identity.");
      report.stage = "handshakes";
      report.handshakes = [];
      await persist();
      await eachMember(cluster.members, async (member) => {
        try {
          const result = await checkedServer(member.serverId, (executor) =>
            managedNetworkTools.inspectPeers(
              executor,
              cluster.network.managedId!,
              networkTransportPeers(cluster.members, member.serverId, cluster.network.access).map(
                (peer) => peer.serverId,
              ),
            ),
          );
          report.handshakes!.push(
            ...result.peers.map(({ serverId, ...peer }) => ({
              ...peer,
              sourceServerId: member.serverId,
              targetServerId: serverId,
            })),
          );
          if (!result.interfaceReady)
            throw new PrivateNetworkError(
              "The WireGuard interface no longer matches its saved configuration.",
              "MANAGED_NETWORK_INTERFACE_CHANGED",
            );
        } catch (error) {
          Object.assign(report.hosts.find((host) => host.serverId === member.serverId)!, {
            ok: false,
            ...checkError(error),
          });
        }
        await persist();
      });
    }
    if (speedTest) {
      report.stage = "throughput";
      await persist();
      const selected = [speedTest.sourceServerId, speedTest.targetServerId];
      // Sequential samples avoid competing with each other for the link being measured.
      for (const sourceId of selected) {
        const source = probes.find((probe) => probe.serverId === sourceId)!;
        const peer = probes.find(
          (probe) => probe.serverId === selected.find((id) => id !== sourceId),
        )!;
        if (!networkAccessAllowed(cluster.network.access, sourceId, peer.serverId)) continue;
        const connected = report.peers.find(
          (check) => check.sourceServerId === sourceId && check.targetServerId === peer.serverId,
        );
        try {
          if (!connected?.tcp || !connected.udp || !connected.mtu)
            throw new PrivateNetworkError(
              "Resolve this connection's reachability checks before running a speed sample.",
            );
          report.throughput!.push(
            await checkedServer(sourceId, (executor) =>
              privateNetworkTools.throughput(executor, source, peer),
            ),
          );
        } catch (error) {
          report.throughput!.push({
            sourceServerId: sourceId,
            targetServerId: peer.serverId,
            megabitsPerSecond: null,
            bytes: 0,
            durationMs: 0,
            message: checkError(error).message,
          });
        }
        await persist();
      }
    }
    report.stage = "complete";
    const connectivityPassed = networkReportSucceeded(
      report,
      cluster.members.map((m) => m.serverId),
      cluster.network.access,
    );
    success =
      connectivityPassed &&
      (!speedTest ||
        (report.throughput?.length ===
          [
            networkAccessAllowed(
              cluster.network.access,
              speedTest.sourceServerId,
              speedTest.targetServerId,
            ),
            networkAccessAllowed(
              cluster.network.access,
              speedTest.targetServerId,
              speedTest.sourceServerId,
            ),
          ].filter(Boolean).length &&
          report.throughput.every((sample) => sample.megabitsPerSecond !== null)));
    failureMessage = success
      ? null
      : connectivityPassed
        ? "Connectivity checks passed, but a speed sample did not complete. Review the per-connection measurements and retry the speed test."
        : "Some private connections did not match the configured access. Check the connection results and run verification again.";
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
    if (run) {
      await repos.serverCluster.finish(run.id, report, success, failureMessage);
      notifyNetworkSetup(ctx.organizationId, "overview");
    }
  }
  return { report, success, error: failureMessage };
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
      modes: reason ? [] : ["native", "wireguard"],
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
      record(ctx, row.id, "network.created");
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
      record(ctx, row.id, "network.updated");
      return presentCluster(row);
    });
  },
  async verifyCluster(ctx, input) {
    assertClusterManagementAvailable();
    assertNetworkSetupAcceptingWork();
    const cluster = await repos.serverCluster.get(ctx.organizationId, input.clusterId);
    if (cluster.revision !== input.revision)
      throw new AppError(
        "The network changed. Reload it before continuing.",
        409,
        "CLUSTER_CONFLICT",
      );
    if (
      input.speedTest &&
      (input.speedTest.sourceServerId === input.speedTest.targetServerId ||
        ![input.speedTest.sourceServerId, input.speedTest.targetServerId].every((id) =>
          cluster.members.some((member) => member.serverId === id),
        ) ||
        networkConnectionMode(
          cluster.network.access,
          input.speedTest.sourceServerId,
          input.speedTest.targetServerId,
        ) === "blocked")
    )
      throw new AppError(
        "Choose two different members of this network for the speed test.",
        400,
        "INVALID_NETWORK_TEST",
      );
    for (const member of cluster.members) await authorizeMember(ctx, member.serverId);
    const { run, created } = await repos.serverCluster.startVerification(
      ctx.organizationId,
      cluster.id,
      input.revision,
      ctx.userId,
      input.speedTest,
    );
    if (created) {
      record(ctx, cluster.id, "network.verification.started");
      await deferNetworkSetupWork(
        { kind: "verification", organizationId: ctx.organizationId, id: run.id },
        (signal) =>
          verifyClusterNetwork(
            ctx,
            {
              ...cluster,
              members: cluster.members.map((member) => ({
                ...member,
                interfaceName: member.interfaceName ?? undefined,
                networkRef: member.networkRef ?? undefined,
              })),
            },
            run,
            undefined,
            signal,
          ),
      );
    }
    return presentVerification(run);
  },
  async removeCluster(ctx, input) {
    assertClusterManagementAvailable();
    const cluster = await repos.serverCluster.get(ctx.organizationId, input.clusterId);
    for (const member of cluster.members) await authorizeMember(ctx, member.serverId);
    await repos.serverCluster.remove(ctx.organizationId, input.clusterId, input.revision);
    record(ctx, input.clusterId, "network.removed");
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
