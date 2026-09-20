import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  AppError,
  type PlanManagedNetworkInput,
  type ApplyManagedNetworkInput,
} from "@repo/contracts";
import {
  allocateManagedAddresses,
  allocateManagedSubnet,
  managedInterfaceName,
  managedNetworkUnsettled,
  validWireGuardEndpoint,
  validateWireGuardCluster,
  MANAGED_NETWORK_PLAN_TTL_MS,
  MANAGED_NETWORK_PORT,
  ClusterConfigError,
  managedNetworkSteps,
  MANAGED_NETWORK_APPLY_STEPS,
  normalizeManagedNetworkInput,
  retainNetworkAccess,
  networkAccessAllowed,
  networkTransportPeers,
  type ManagedNetworkPlan,
  type ManagedNetworkObservation,
  type ManagedNetworkHostProgress,
  type WireGuardClusterConfig,
  type ClusterNetworkReport,
} from "@repo/core";
import { repos, type ManagedNetworkOperationRecord, type ServerClusterRecord } from "@repo/db";
import {
  managedNetworkTools,
  PrivateNetworkError,
  isRetryableRemoteConnectionError,
  type CommandExecutor,
  type ManagedHostTransaction,
} from "@repo/adapters";
import type { ExecutionContext } from "../../../context";
import type { ServerDependencies } from "../../../servers";
import { authorization } from "../../lib/authorization";
import { inspectHostIssuedIdentity } from "../../lib/host-port-target";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { createProvisionLock } from "../../lib/provision-lock";
import {
  assertClusterManagementAvailable,
  authorizeMember,
  onServer,
  eachMember,
  checkError,
  record,
  verifyClusterNetwork,
  presentManagedOperation,
} from "./server-cluster.operations";
import { appendNetworkSetupLog, updateNetworkSetupStep } from "./network-setup-progress";
import { notifyNetworkSetup } from "./network-setup-bus";
import { assertNetworkSetupAcceptingWork, deferNetworkSetupWork } from "./network-setup-lifecycle";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string) => new AppError(message, 409, "MANAGED_NETWORK_CONFLICT");

export async function fleetAdmin(ctx: ExecutionContext) {
  assertClusterManagementAvailable();
  await authorization.authorize(ctx, {
    resourceType: "server",
    resourceId: "*",
    action: "admin",
    scope: "all",
  });
}

function configuration(cluster: ServerClusterRecord): WireGuardClusterConfig {
  if (
    cluster.network.mode !== "wireguard" ||
    !cluster.network.managedId ||
    !cluster.network.interfaceName
  )
    throw conflict(
      "This is an externally managed network. Create a separate managed network to use WireGuard.",
    );
  const config: WireGuardClusterConfig = {
    name: cluster.name,
    location: cluster.location ?? undefined,
    network: {
      ...cluster.network,
      access: cluster.network.access ?? undefined,
      mode: "wireguard",
      managedId: cluster.network.managedId,
      interfaceName: cluster.network.interfaceName,
    },
    members: cluster.members.map((member) => ({
      serverId: member.serverId,
      providerId: member.providerId,
      privateIp: member.privateIp,
      interfaceName: cluster.network.interfaceName!,
      endpoint: member.endpoint ?? "",
      listenPort: member.listenPort ?? MANAGED_NETWORK_PORT,
      ...(member.publicKey ? { publicKey: member.publicKey } : {}),
    })),
  };
  // Never serialize database IDs/ownership into the strict public configuration.
  config.network = {
    mode: "wireguard",
    managedId: config.network.managedId,
    interfaceName: config.network.interfaceName,
    cidrs: config.network.cidrs,
    mtu: config.network.mtu,
    probePort: config.network.probePort,
    ...(cluster.network.access ? { access: cluster.network.access } : {}),
  };
  validateWireGuardCluster(config);
  return config;
}

async function managementAddresses(host: string): Promise<string[]> {
  if (validWireGuardEndpoint(host)) return [host];
  try {
    const resolved = await lookup(host, { family: 4, all: true });
    return resolved.map((entry) => entry.address).filter(validWireGuardEndpoint);
  } catch {
    return [];
  }
}

export async function planNetwork(
  ctx: ExecutionContext,
  input: PlanManagedNetworkInput,
  preparation?: {
    id: string;
    generation: number;
    assertActive(): Promise<void>;
    hostIdentity(serverId: string): string | null;
    transports(
      members: { serverId: string; endpoint: string; listenPort: number }[],
    ): Promise<void>;
    inspection(
      serverId: string,
      status: "running" | "completed" | "failed",
      message?: string,
    ): Promise<void>;
  },
) {
  await fleetAdmin(ctx);
  const legacyNormalized = {
    ...input,
    name: input.name.trim(),
    location: input.location?.trim() || undefined,
    members: [...input.members].sort((a, b) => a.serverId.localeCompare(b.serverId)),
  };
  const normalized = normalizeManagedNetworkInput(input);
  const inputHash = hash(normalized);
  const existing = await repos.serverCluster.findOperation(ctx.organizationId, input.requestId);
  if (existing) {
    if (existing.inputHash !== inputHash && existing.inputHash !== hash(legacyNormalized))
      throw conflict("This request already has a different network plan.");
    return presentManagedOperation(existing);
  }
  if (new Set(input.members.map((member) => member.serverId)).size !== input.members.length)
    throw new AppError("Select each server once.", 400, "INVALID_CLUSTER_CONFIG");
  const current = input.clusterId
    ? await repos.serverCluster.get(ctx.organizationId, input.clusterId)
    : null;
  if (current && current.revision !== input.revision)
    throw conflict("The network changed. Reload before planning.");
  if (current?.operation && managedNetworkUnsettled(current.operation.status))
    throw conflict("Resume or restore the current operation before planning another change.");
  const previous = current ? configuration(current) : null;
  const intent = input.intent ?? "configure";
  if (intent === "remove" && !previous)
    throw conflict("Only an existing managed network can be removed.");
  if (previous && input.cidr && input.cidr !== previous.network.cidrs[0])
    throw conflict(
      "The network keeps its allocated subnet. Create a separate network to change its address range.",
    );
  const managedId = previous?.network.managedId ?? randomBytes(16).toString("hex");
  const interfaceName = managedInterfaceName(managedId);
  const selected = intent === "remove" ? previous!.members : normalized.members;
  const access =
    intent === "remove"
      ? previous?.network.access
      : (normalized.access ??
        retainNetworkAccess(
          previous?.network.access,
          selected.map((member) => member.serverId),
        ));
  if (current)
    await repos.serverCluster.assertDependencies(
      ctx.organizationId,
      current.id,
      intent === "remove" ? undefined : selected.map((member) => member.serverId),
    );
  const ids = [
    ...new Set([...selected, ...(previous?.members ?? [])].map((member) => member.serverId)),
  ].sort();
  // Authorize the whole fleet before the first inspection, including departing hosts.
  const servers = new Map<string, Awaited<ReturnType<typeof authorizeMember>>>();
  for (const id of ids) {
    servers.set(id, await authorizeMember(ctx, id));
    const membership = await repos.serverCluster.membership(id, true);
    if (membership && membership.clusterId !== current?.id)
      throw conflict("A selected server is reserved by another network operation.");
  }
  const endpoints = new Map<string, { endpoint: string; listenPort: number }>();
  const managementIps: string[] = [];
  for (const id of ids) {
    const member =
      selected.find((member) => member.serverId === id) ??
      previous!.members.find((member) => member.serverId === id)!;
    const old = previous?.members.find((member) => member.serverId === id);
    const management = await managementAddresses(servers.get(id)!.sshHost);
    managementIps.push(...management);
    const endpoint = member.endpoint ?? old?.endpoint ?? management[0] ?? "";
    if (!validWireGuardEndpoint(endpoint))
      throw new AppError(
        "Set a reachable IPv4 transport address for this server. SSH can use IPv6, but the managed mesh currently requires direct IPv4 UDP between servers.",
        400,
        "MANAGED_NETWORK_ENDPOINT_REQUIRED",
      );
    endpoints.set(id, {
      endpoint,
      listenPort: member.listenPort ?? old?.listenPort ?? MANAGED_NETWORK_PORT,
    });
  }
  await preparation?.assertActive();
  await preparation?.transports(
    [...endpoints].map(([serverId, transport]) => ({ serverId, ...transport })),
  );
  const observations = new Map<string, ManagedNetworkObservation>();
  const identities = new Set<string>();
  await eachMember(
    ids,
    async (id) => {
      let inspectionError: PrivateNetworkError | undefined;
      try {
        await preparation?.assertActive();
        await preparation?.inspection(id, "running");
        const observation = await onServer(ctx, id, async (executor) => {
          const hostIdentity = await inspectHostIssuedIdentity(executor);
          if (!hostIdentity)
            throw new AppError(
              "This server needs a persistent machine identity before it can join.",
              400,
              "NETWORK_HOST_IDENTITY_MISSING",
            );
          try {
            return await managedNetworkTools.inspect(executor, {
              managedId,
              hostIdentity,
              ...endpoints.get(id)!,
              accessControlled: !!access,
              transportEndpoints: [...endpoints]
                .filter(([other]) =>
                  networkTransportPeers(selected, id, access).some(
                    (peer) => peer.serverId === other,
                  ),
                )
                .map(([, endpoint]) => endpoint.endpoint),
            });
          } catch (error) {
            // This callback only reads identity/network state. Let the shared SSH
            // manager reconnect once, without replaying installs or network changes.
            if (
              error instanceof PrivateNetworkError &&
              isRetryableRemoteConnectionError(error.cause)
            ) {
              inspectionError = error;
              throw error.cause;
            }
            throw error;
          }
        });
        if (identities.has(observation.hostIdentity))
          throw conflict("Two server entries point to the same physical host.");
        if (preparation && preparation.hostIdentity(id) !== observation.hostIdentity)
          throw conflict(
            "This server's identity changed after preparation. Review its SSH settings and start a new preparation.",
          );
        const enrolled = current?.members.find((member) => member.serverId === id);
        if (enrolled?.hostIdentity && enrolled.hostIdentity !== observation.hostIdentity)
          throw conflict(
            "This server's physical identity changed. Review its SSH target before continuing.",
          );
        identities.add(observation.hostIdentity);
        observations.set(id, observation);
        await preparation?.inspection(
          id,
          "completed",
          "Host interfaces, Docker networks, VPN routes, DNS addresses, transport MTU, and firewall rules inspected.",
        );
      } catch (error) {
        const detail = checkError(
          inspectionError && inspectionError.cause === error ? inspectionError : error,
        );
        await preparation?.inspection(id, "failed", detail.message);
        throw new AppError(`${servers.get(id)!.name || id}: ${detail.message}`, 400, detail.code);
      }
    },
    3,
  );
  const others = (await repos.serverCluster.list(ctx.organizationId)).filter(
    (cluster) => cluster.id !== current?.id,
  );
  const reserved = [
    ...managementIps,
    ...[...endpoints.values()].map((endpoint) => endpoint.endpoint),
  ].map((ip) => `${ip}/32`);
  const cidr =
    intent === "remove"
      ? previous!.network.cidrs[0]!
      : allocateManagedSubnet(
          [...observations.values()],
          previous?.network.cidrs[0] ?? input.cidr?.trim(),
          [...reserved, ...others.flatMap((cluster) => cluster.network.cidrs)],
        );
  const addresses = allocateManagedAddresses(
    cidr,
    selected.map((member) => member.serverId),
    previous?.members,
  );
  const maxMtu = Math.min(
    1420,
    ...[...observations.values()].map((observation) => observation.transportMtu - 80),
  );
  const mtu = input.mtu ?? Math.min(previous?.network.mtu ?? 1420, maxMtu);
  if (intent !== "remove" && (mtu < 1280 || mtu > maxMtu))
    throw new AppError(
      `The tunnel MTU must be between 1280 and ${maxMtu} for these transport routes.`,
      400,
      "INVALID_CLUSTER_CONFIG",
    );
  const config: WireGuardClusterConfig =
    intent === "remove"
      ? previous!
      : {
          name: normalized.name,
          location: normalized.location,
          network: {
            mode: "wireguard",
            cidrs: [cidr],
            mtu,
            probePort: input.probePort ?? previous?.network.probePort ?? 45876,
            managedId,
            interfaceName,
            ...(access ? { access } : {}),
          },
          members: selected.map((member) => ({
            serverId: member.serverId,
            providerId: member.providerId,
            privateIp: addresses.get(member.serverId)!,
            interfaceName,
            ...endpoints.get(member.serverId)!,
          })),
        };
  validateWireGuardCluster(config);
  const plan: ManagedNetworkPlan = {
    version: 1,
    clusterId: current?.id ?? randomUUID(),
    managedId,
    interfaceName,
    baseRevision: current?.revision ?? null,
    intent,
    rotateKeys: !!input.rotateKeys,
    config,
    previous,
    hosts: ids.map((id) => ({
      serverId: id,
      name: servers.get(id)!.name || servers.get(id)!.sshHost,
      hostIdentity: observations.get(id)!.hostIdentity,
      fingerprint: observations.get(id)!.fingerprint,
      configHash: observations.get(id)!.configHash,
      ...endpoints.get(id)!,
      privateIp:
        addresses.get(id) ?? previous!.members.find((member) => member.serverId === id)!.privateIp,
      packages: observations.get(id)!.packages,
      firewall: observations.get(id)!.firewall,
      action:
        intent === "configure" && selected.some((member) => member.serverId === id)
          ? "configure"
          : "remove",
    })),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + MANAGED_NETWORK_PLAN_TTL_MS).toISOString(),
    ...(preparation ? { preparationId: preparation.id } : {}),
  };
  await preparation?.assertActive();
  const operation = await repos.serverCluster.savePlan(
    ctx.organizationId,
    input.requestId,
    ctx.userId,
    inputHash,
    hash(plan),
    plan,
    preparation?.generation,
  );
  notifyNetworkSetup(ctx.organizationId, "operation", operation.id);
  record(ctx, plan.clusterId, "network.planned");
  return presentManagedOperation(operation);
}

/** Durable orchestration reuses fleet authority, SSH, provisioning locks and network probes. */
export async function runManagedNetwork(
  ctx: ExecutionContext,
  operation: ManagedNetworkOperationRecord,
  controllerSignal?: AbortSignal,
) {
  const { plan, id, generation } = operation;
  const hosts = structuredClone(operation.hosts);
  for (const host of hosts) {
    if (operation.status !== "rolling_back" || !host.steps)
      host.steps = managedNetworkSteps(MANAGED_NETWORK_APPLY_STEPS);
    host.logs ??= [];
  }
  let report: ClusterNetworkReport | null = operation.report;
  let status = operation.status;
  let progress = Promise.resolve();
  let heartbeat = Promise.resolve();
  let lostLease = false;
  let dirtyLogs = false;
  const deadline = Date.now() + 15 * 60_000;
  const waitSignal = AbortSignal.any([
    AbortSignal.timeout(15 * 60_000),
    ...(controllerSignal ? [controllerSignal] : []),
  ]);
  const interval = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        if (controllerSignal?.aborted) return;
        if (!(await repos.serverCluster.heartbeatOperation(id, generation))) lostLease = true;
      })
      .catch(() => {
        lostLease = true;
      });
  }, 20_000);
  interval.unref();
  const persist = () => {
    dirtyLogs = false;
    const snapshot = structuredClone(hosts);
    const snapshotReport = structuredClone(report);
    const snapshotStatus = status;
    progress = progress
      .catch(() => undefined)
      .then(async () => {
        await repos.serverCluster.progressOperation(
          id,
          generation,
          snapshotStatus,
          snapshot,
          snapshotReport,
        );
        notifyNetworkSetup(ctx.organizationId, "operation", id);
      });
    return progress;
  };
  const logTimer = setInterval(() => {
    if (dirtyLogs)
      void persist().catch(() => {
        lostLease = true;
      });
  }, 1000);
  logTimer.unref();
  const step = async (
    host: ManagedNetworkHostProgress,
    key: Parameters<typeof updateNetworkSetupStep>[1],
    state: Parameters<typeof updateNetworkSetupStep>[2],
    message?: string,
  ) => {
    updateNetworkSetupStep(host, key, state, message);
    await persist();
  };
  const transaction = (serverId: string): ManagedHostTransaction => ({
    managedId: plan.managedId,
    operationId: id,
    generation,
    host: plan.hosts.find((host) => host.serverId === serverId)!,
    accessControlled: !!plan.config.network.access,
  });
  const checkedServer = async <T>(
    serverId: string,
    fn: (executor: CommandExecutor) => Promise<T>,
  ): Promise<T> => {
    await fleetAdmin(ctx);
    if (status !== "rolling_back" && Date.now() >= deadline)
      throw conflict(
        "Network setup exceeded its deadline. Resume after reviewing the server results.",
      );
    if (
      controllerSignal?.aborted ||
      lostLease ||
      !(await repos.serverCluster.operationActive(id, generation))
    )
      throw conflict("This worker no longer owns the network operation.");
    return onServer(ctx, serverId, async (executor) => {
      await fleetAdmin(ctx);
      if (!(await repos.serverCluster.operationActive(id, generation)))
        throw conflict("This network generation expired.");
      if ((await inspectHostIssuedIdentity(executor)) !== transaction(serverId).host.hostIdentity)
        throw conflict("The SSH target's physical identity changed. Host changes were stopped.");
      controllerSignal?.throwIfAborted();
      return fn(executor);
    });
  };
  const finalize = async () => {
    // Only obsolete recovery files are removed after the database settles. Host
    // receipts still fence this cleanup if a new operation has already started.
    await eachMember(
      hosts,
      async (host) => {
        try {
          await fleetAdmin(ctx);
          await onServer(ctx, host.serverId, async (executor) => {
            if (
              (await inspectHostIssuedIdentity(executor)) !==
              transaction(host.serverId).host.hostIdentity
            )
              return;
            await managedNetworkTools.finalize(executor, transaction(host.serverId));
          });
        } catch {
          /* An offline host retains its root-only recovery files. */
        }
      },
      3,
    );
  };
  const rollback = async (message: string | null) => {
    status = "rolling_back";
    await persist();
    await eachMember(
      hosts,
      async (host) => {
        try {
          await step(host, "rollback", "running");
          const result = await checkedServer(host.serverId, (executor) =>
            managedNetworkTools.rollback(executor, transaction(host.serverId)),
          );
          if (result && (result.stage !== "rolled_back" || !result.healthy))
            throw conflict("This server did not confirm restoration.");
          host.stage = "rolled_back";
          host.error = null;
          await step(
            host,
            "rollback",
            "completed",
            "The previous network configuration was restored.",
          );
        } catch (error) {
          host.stage = "failed";
          host.error = checkError(error).message;
          for (const active of host.steps ?? [])
            if (active.status === "running")
              updateNetworkSetupStep(host, active.id, "failed", host.error);
          updateNetworkSetupStep(host, "rollback", "failed", host.error);
        }
        await persist();
      },
      3,
    );
    if (hosts.every((host) => host.stage === "rolled_back")) {
      await withServerInventoryLock(ctx.organizationId, () =>
        repos.serverCluster.finishOperation(
          ctx.organizationId,
          id,
          generation,
          "rolled_back",
          hosts,
          report,
          message,
        ),
      );
      record(ctx, plan.clusterId, "network.restored");
      notifyNetworkSetup(ctx.organizationId, "operation", id);
      await finalize();
    } else {
      await repos.serverCluster.progressOperation(
        id,
        generation,
        "needs_attention",
        hosts,
        report,
        message ??
          "Some servers could not confirm restoration. Check access, then restore this operation again.",
      );
      notifyNetworkSetup(ctx.organizationId, "operation", id);
    }
  };
  try {
    await fleetAdmin(ctx);
    for (const host of plan.hosts) await authorizeMember(ctx, host.serverId);
    await persist();
    if (status === "rolling_back") {
      await rollback(null);
      return;
    }
    await eachMember(
      hosts,
      async (host) => {
        try {
          await createProvisionLock(`provision:server:${host.serverId}`).run(async () => {
            await step(host, "recheck", "running");
            await checkedServer(host.serverId, async (executor) => {
              const observed = await managedNetworkTools.inspect(executor, {
                managedId: plan.managedId,
                hostIdentity: transaction(host.serverId).host.hostIdentity,
                endpoint: transaction(host.serverId).host.endpoint,
                listenPort: transaction(host.serverId).host.listenPort,
                accessControlled: !!plan.config.network.access,
                transportEndpoints: plan.hosts
                  .filter((peer) =>
                    networkTransportPeers(
                      plan.config.members,
                      host.serverId,
                      plan.config.network.access,
                    ).some((member) => member.serverId === peer.serverId),
                  )
                  .map((peer) => peer.endpoint),
              });
              if (observed.fingerprint !== transaction(host.serverId).host.fingerprint)
                throw conflict(
                  "The host network changed after review. Restore this operation and make a new plan.",
                );
            });
            await step(
              host,
              "recheck",
              "completed",
              "Server identity and reviewed network configuration still match.",
            );
            await step(host, "tools", "running");
            await checkedServer(host.serverId, (executor) =>
              managedNetworkTools.install(
                executor,
                plan.managedId,
                transaction(host.serverId).host.packages,
                (entry) => {
                  appendNetworkSetupLog(host, "tools", entry);
                  dirtyLogs = true;
                },
                waitSignal,
              ),
            );
            await step(host, "tools", "completed", "Required networking tools are available.");
          }, waitSignal);
          host.error = null;
        } catch (error) {
          host.stage = "failed";
          host.error = checkError(error).message;
          for (const active of host.steps ?? [])
            if (active.status === "running")
              updateNetworkSetupStep(host, active.id, "failed", host.error);
          throw error;
        } finally {
          await persist();
        }
      },
      2,
    );
    // Finish package work across the fleet before starting any host rollback
    // deadline. Cold installs on many hosts must not consume the apply window.
    await eachMember(
      hosts,
      async (host) => {
        try {
          await step(host, "prepare", "running");
          const result = await createProvisionLock(`provision:server:${host.serverId}`).run(
            () =>
              checkedServer(host.serverId, (executor) =>
                managedNetworkTools.prepare(executor, transaction(host.serverId), plan.rotateKeys),
              ),
            waitSignal,
          );
          host.publicKey = result.publicKey;
          host.stage = "prepared";
          host.error = null;
          await step(
            host,
            "prepare",
            "completed",
            "Host keys and recovery files are ready; the rollback timer is armed.",
          );
        } catch (error) {
          host.stage = "failed";
          host.error = checkError(error).message;
          for (const active of host.steps ?? [])
            if (active.status === "running")
              updateNetworkSetupStep(host, active.id, "failed", host.error);
          throw error;
        } finally {
          await persist();
        }
      },
      3,
    );
    const config: WireGuardClusterConfig = {
      ...plan.config,
      members: plan.config.members.map((member) => ({
        ...member,
        publicKey: hosts.find((host) => host.serverId === member.serverId)!.publicKey!,
      })),
    };
    await eachMember(
      hosts.filter((host) => transaction(host.serverId).host.action === "configure"),
      async (host) => {
        try {
          await step(host, "transport", "running");
          await checkedServer(host.serverId, (executor) =>
            managedNetworkTools.stageTransport(executor, transaction(host.serverId), config),
          );
          host.stage = "applied";
          host.error = null;
          await step(
            host,
            "transport",
            "completed",
            "WireGuard endpoints and owned UDP firewall rules are ready for testing; private addresses and routes are not assigned yet.",
          );
        } catch (error) {
          host.stage = "failed";
          host.error = checkError(error).message;
          for (const active of host.steps ?? [])
            if (active.status === "running")
              updateNetworkSetupStep(host, active.id, "failed", host.error);
          throw error;
        } finally {
          await persist();
        }
      },
      3,
    );
    if (plan.intent === "configure") {
      status = "verifying";
      report = { stage: "handshakes", hosts: [], peers: [], handshakes: [] };
      await persist();
      // WireGuard retries early handshakes when another host has not finished
      // staging transport yet. Test every reviewed UDP endpoint before any private
      // address or route is assigned, using the actual keys and WireGuard protocol.
      await eachMember(config.members, async (member) => {
        const host = hosts.find((item) => item.serverId === member.serverId)!;
        try {
          await step(host, "handshake", "running");
          const observation = await checkedServer(member.serverId, (executor) =>
            managedNetworkTools.waitForPeers(
              executor,
              plan.managedId,
              networkTransportPeers(config.members, member.serverId, config.network.access).map(
                (peer) => peer.serverId,
              ),
            ),
          );
          report!.handshakes!.push(
            ...observation.peers.map(({ serverId, ...peer }) => ({
              ...peer,
              sourceServerId: member.serverId,
              targetServerId: serverId,
            })),
          );
          report!.hosts.push({
            serverId: member.serverId,
            ok: observation.interfaceReady,
            interfaceName: plan.interfaceName,
            mtu: config.network.mtu,
            code: observation.interfaceReady ? null : "MANAGED_NETWORK_INTERFACE_CHANGED",
            message: observation.interfaceReady
              ? null
              : "The WireGuard interface no longer matches the reviewed configuration.",
          });
          for (const peer of observation.peers) {
            const name =
              plan.hosts.find((item) => item.serverId === peer.serverId)?.name ?? peer.serverId;
            appendNetworkSetupLog(host, "handshake", {
              level: peer.ok ? "info" : "error",
              message: peer.ok
                ? `Encrypted handshake with ${name} verified (${peer.endpoint}:${peer.port}/UDP).`
                : `No WireGuard handshake with ${name} at ${peer.endpoint}:${peer.port}/UDP. Check this endpoint and allow the reviewed UDP port in both host and provider firewalls.`,
            });
          }
          if (!observation.ready)
            throw new PrivateNetworkError(
              observation.interfaceReady
                ? "Some WireGuard peers did not connect. Check the failed links and their UDP endpoints in the topology before retrying."
                : "The WireGuard interface no longer matches the reviewed configuration. Check the managed network service before retrying.",
              observation.interfaceReady
                ? "MANAGED_NETWORK_HANDSHAKE_FAILED"
                : "MANAGED_NETWORK_INTERFACE_CHANGED",
            );
          await step(
            host,
            "handshake",
            "completed",
            "All WireGuard peers completed an encrypted handshake.",
          );
        } catch (error) {
          host.stage = "failed";
          host.error = checkError(error).message;
          if (!report!.hosts.some((item) => item.serverId === member.serverId))
            report!.hosts.push({
              serverId: member.serverId,
              ok: false,
              interfaceName: null,
              mtu: null,
              ...checkError(error),
            });
          for (const active of host.steps ?? [])
            if (active.status === "running")
              updateNetworkSetupStep(host, active.id, "failed", host.error);
          await persist();
        }
      });
      if (
        hosts.some((host) =>
          host.steps?.some((step) => step.id === "handshake" && step.status === "failed"),
        )
      )
        throw new PrivateNetworkError(
          "WireGuard UDP transport could not be verified. Check the failed links, endpoint addresses and provider firewall ports before retrying. Private address and route setup was not started; restoring the previous configuration.",
          "MANAGED_NETWORK_HANDSHAKE_FAILED",
        );
    }
    status = "applying";
    await eachMember(
      hosts,
      async (host) => {
        try {
          await step(host, "configure", "running");
          await checkedServer(host.serverId, (executor) =>
            managedNetworkTools.apply(
              executor,
              transaction(host.serverId),
              transaction(host.serverId).host.action === "configure" ? config : null,
            ),
          );
          host.stage = "applied";
          host.error = null;
          await step(
            host,
            "configure",
            "completed",
            transaction(host.serverId).host.action === "remove"
              ? "The managed tunnel and its owned rules were removed."
              : "WireGuard, private routes, firewall rules, and startup service configured.",
          );
        } catch (error) {
          host.stage = "failed";
          host.error = checkError(error).message;
          for (const active of host.steps ?? [])
            if (active.status === "running")
              updateNetworkSetupStep(host, active.id, "failed", host.error);
          throw error;
        } finally {
          await persist();
        }
      },
      3,
    );
    if (plan.intent === "configure") {
      status = "verifying";
      const handshakes = report?.handshakes;
      for (const member of config.members)
        await step(hosts.find((host) => host.serverId === member.serverId)!, "verify", "running");
      const result = await verifyClusterNetwork(
        ctx,
        { id: plan.clusterId, network: config.network, members: config.members },
        null,
        {
          checkedServer,
          recordIdentity: async (serverId, identity) => {
            if (identity !== transaction(serverId).host.hostIdentity)
              throw conflict("A server identity changed during verification.");
          },
          progress: async (value) => {
            report = { ...value, handshakes };
            await persist();
          },
        },
      );
      report = { ...result.report, handshakes };
      for (const member of config.members) {
        const host = hosts.find((item) => item.serverId === member.serverId)!;
        const own = report.hosts.find((item) => item.serverId === member.serverId);
        const peers = report.peers.filter((peer) => peer.sourceServerId === member.serverId);
        const success =
          own?.ok &&
          peers.length === config.members.length - 1 &&
          peers.every((peer) =>
            networkAccessAllowed(config.network.access, member.serverId, peer.targetServerId)
              ? peer.tcp && peer.udp && peer.mtu
              : peer.expectedAccess === "deny" && peer.policyPassed === true,
          );
        await step(
          host,
          "verify",
          success ? "completed" : "failed",
          success
            ? config.network.access
              ? "Allowed connections passed TCP, UDP, and MTU checks; blocked directions rejected new connections."
              : "TCP, UDP, and MTU checks passed to every peer."
            : own?.message ||
                peers.find((peer) =>
                  peer.expectedAccess === "deny"
                    ? !peer.policyPassed
                    : !peer.tcp || !peer.udp || !peer.mtu,
                )?.message ||
                "Private connectivity checks failed. Check peer endpoints and provider UDP firewall rules.",
        );
      }
      if (!result.success)
        throw conflict(
          result.error ??
            "Private connectivity failed. Check UDP reachability between the reviewed transport addresses.",
        );
    }
    for (const host of hosts)
      if (plan.intent === "remove" || transaction(host.serverId).host.action === "remove") {
        await step(host, "transport", "skipped", "This server is leaving the managed network.");
        await step(host, "handshake", "skipped", "This server is leaving the managed network.");
        await step(host, "verify", "skipped", "The removed network does not require peer probes.");
      }
    for (const host of hosts) host.stage = "verified";
    status = "committing";
    await persist();
    await eachMember(
      hosts,
      async (host) => {
        await step(host, "commit", "running");
        const result = await checkedServer(host.serverId, (executor) =>
          managedNetworkTools.commit(executor, transaction(host.serverId)),
        );
        if (!result || result.stage !== "committed" || !result.healthy)
          throw conflict("A host no longer matches the verified network.");
        host.stage = "committed";
        await step(
          host,
          "commit",
          "completed",
          "Verified configuration saved and automatic rollback disarmed.",
        );
        await persist();
      },
      3,
    );
    await fleetAdmin(ctx);
    await withServerInventoryLock(ctx.organizationId, () =>
      repos.serverCluster.finishOperation(
        ctx.organizationId,
        id,
        generation,
        "succeeded",
        hosts,
        report,
        null,
      ),
    );
    record(ctx, plan.clusterId, "network.applied");
    notifyNetworkSetup(ctx.organizationId, "operation", id);
    // Recovery files stay root-only. Finalization removes obsolete key backups; a
    // cleanup failure cannot turn a committed, verified network into a failed one.
    await finalize();
  } catch (error) {
    const message = checkError(error).message;
    for (const host of hosts)
      for (const active of host.steps ?? [])
        if (active.status === "running") {
          updateNetworkSetupStep(host, active.id, "failed", host.error || message);
        }
    if (await repos.serverCluster.operationActive(id, generation).catch(() => false)) {
      try {
        await rollback(message);
      } catch {
        await repos.serverCluster
          .progressOperation(id, generation, "needs_attention", hosts, report, message)
          .then(() => notifyNetworkSetup(ctx.organizationId, "operation", id))
          .catch(() => undefined);
      }
    }
  } finally {
    clearInterval(interval);
    clearInterval(logTimer);
    await heartbeat;
    await progress.catch(() => undefined);
  }
}

export const managedNetworkCollection = {
  async planManagedNetwork(ctx, input) {
    try {
      return await planNetwork(ctx, input);
    } catch (error) {
      if (error instanceof ClusterConfigError) throw new AppError(error.message, 400, error.code);
      throw error;
    }
  },
  async getManagedNetworkOperation(ctx, input) {
    assertClusterManagementAvailable();
    return presentManagedOperation(
      await repos.serverCluster.getOperation(ctx.organizationId, input.operationId),
    );
  },
  async discardManagedNetworkPlan(ctx, input) {
    const result = await withServerInventoryLock(ctx.organizationId, async () => {
      await fleetAdmin(ctx);
      return repos.serverCluster.discardPlan(ctx.organizationId, input.operationId, input.planHash);
    });
    notifyNetworkSetup(ctx.organizationId, "operation", result.operation!.id);
    if (result.preparation)
      notifyNetworkSetup(ctx.organizationId, "preparation", result.preparation.id);
    record(ctx, result.operation!.clusterId, "network.plan.discarded");
    return presentManagedOperation(result.operation!);
  },
  async applyManagedNetwork(ctx, input: ApplyManagedNetworkInput) {
    await fleetAdmin(ctx);
    assertNetworkSetupAcceptingWork();
    const current = await repos.serverCluster.getOperation(ctx.organizationId, input.operationId);
    for (const host of current.plan.hosts) await authorizeMember(ctx, host.serverId);
    const { operation, started } = await withServerInventoryLock(ctx.organizationId, async () => {
      await fleetAdmin(ctx);
      for (const host of current.plan.hosts) await authorizeMember(ctx, host.serverId);
      return repos.serverCluster.claimOperation(
        ctx.organizationId,
        input.operationId,
        input.planHash,
        input.action,
      );
    });
    if (started) {
      notifyNetworkSetup(ctx.organizationId, "operation", operation.id);
      record(ctx, operation.clusterId, `network.${input.action}.started`);
      await deferNetworkSetupWork(
        {
          kind: "operation",
          organizationId: ctx.organizationId,
          id: operation.id,
          generation: operation.generation,
        },
        (signal) => runManagedNetwork(ctx, operation, signal),
      );
    }
    return presentManagedOperation(operation);
  },
} satisfies Pick<
  ServerDependencies["collection"],
  | "planManagedNetwork"
  | "getManagedNetworkOperation"
  | "applyManagedNetwork"
  | "discardManagedNetworkPlan"
>;
