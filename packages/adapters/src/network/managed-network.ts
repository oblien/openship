import {
  classifyConnectivityError,
  managedInterfaceName,
  managedNetworkFirewall,
  IPTABLES_PROBES,
  MANAGED_NETWORK_ROLLBACK_SECONDS,
  validateWireGuardCluster,
  validWireGuardEndpoint,
  networkAccessAllowed,
  networkTransportPeers,
  type ManagedNetworkObservation,
  type ManagedNetworkPlanHost,
  type WireGuardClusterConfig,
  type ManagedNetworkStepId,
  type ManagedNetworkStepProgress,
  type ClusterPeerHandshake,
} from "@repo/core";
import type { CommandExecutor, LogEntry } from "../types";
import { sq } from "../runtime/git-clone";
import { envOps } from "../system/environment-ops";
import { invalidateEnvironment } from "../system/environment";
import { privilegedExecutor } from "../system/privilege";
import { PrivateNetworkError } from "./private-network";
import { MANAGED_NETWORK_HOST } from "./managed-network-host";
import { checkTool, installTool } from "../toolchain";
import { isSshDisconnectedError } from "../system/errors";

export interface ManagedNetworkPreparationObserver {
  step(
    id: ManagedNetworkStepId,
    status: ManagedNetworkStepProgress["status"],
    message?: string,
  ): Promise<void>;
  log(id: ManagedNetworkStepId, entry: LogEntry): void;
}

const NETWORK_TOOLS = [
  { name: "python3", minimum: "3.8" },
  { name: "iproute2", minimum: "4.15" },
  { name: "wireguard-tools", minimum: "1.0" },
] as const;

export interface ManagedHostIdentity {
  managedId: string;
  hostIdentity: string;
  endpoint: string;
  listenPort: number;
  transportEndpoints?: string[];
  accessControlled?: boolean;
}
export interface ManagedHostTransaction {
  managedId: string;
  operationId: string;
  generation: number;
  host: ManagedNetworkPlanHost;
  accessControlled?: boolean;
}
export interface ManagedHostReceipt {
  operationId: string;
  generation: number;
  stage: "prepared" | "applied" | "committed" | "rolled_back";
  deadline: number;
  publicKey: string | null;
  configHash: string | null;
  healthy: boolean;
}
export interface ManagedPeerStatus {
  ready: boolean;
  interfaceReady: boolean;
  peers: Array<
    Omit<ClusterPeerHandshake, "sourceServerId" | "targetServerId"> & { serverId: string }
  >;
}

async function hostAccess(executor: CommandExecutor, managedId: string, fresh = false) {
  managedInterfaceName(managedId);
  if (fresh) invalidateEnvironment(executor);
  const grant = await privilegedExecutor(executor, "Managing the private network");
  if (!grant.supported) throw new PrivateNetworkError(grant.reason, "MANAGED_NETWORK_UNSUPPORTED");
  const { profile, executor: root } = grant.value;
  const ops = envOps(profile);
  const services = ops.managedNetworkServices(managedId);
  if (!services.supported)
    throw new PrivateNetworkError(services.reason, "MANAGED_NETWORK_UNSUPPORTED");
  const firewall = managedNetworkFirewall(
    profile.firewall,
    managedId,
    managedInterfaceName(managedId),
    51820,
    [],
  );
  if (!firewall.supported)
    throw new PrivateNetworkError(firewall.reason, "MANAGED_NETWORK_UNSUPPORTED");
  return { root, profile, ops, services: services.value, firewall: firewall.value };
}

async function run<T>(
  executor: CommandExecutor,
  action: string,
  input: Record<string, unknown>,
  timeout = 90_000,
): Promise<T> {
  let output: string;
  try {
    output = await executor.exec(
      `python3 -c ${sq(MANAGED_NETWORK_HOST)} ${sq(action)} ${sq(JSON.stringify(input))}`,
      { timeout },
    );
  } catch (error) {
    throw hostCommandFailure(action, error, timeout);
  }
  let data: T & { error?: unknown; code?: string };
  try {
    data = JSON.parse(output.trim());
  } catch {
    throw new PrivateNetworkError(
      "The host returned an invalid managed network receipt.",
      "MANAGED_NETWORK_REPORT_INVALID",
    );
  }
  if (!data || typeof data !== "object")
    throw new PrivateNetworkError("The host returned an invalid managed network receipt.");
  if (data.error) throw new PrivateNetworkError(String(data.error).slice(0, 2000), data.code);
  return data;
}

function hostCommandFailure(action: string, error: unknown, timeout: number) {
  const label =
    {
      prerequisites: "Network prerequisite check",
      inspect: "Network inspection",
      prepare: "Network preparation",
      apply: "Network apply",
      ready: "Network connectivity check",
      commit: "Network commit",
      rollback: "Network rollback",
      finalize: "Network cleanup",
      status: "Network status check",
    }[action] ?? "Managed network command";
  // Executor errors can contain the command, its input, or remote stderr. Classify
  // them without copying that content into persisted reports or browser logs.
  const category = classifyConnectivityError(error).code;
  let code: string;
  let detail: string;
  if (isSshDisconnectedError(error)) {
    code = "MANAGED_NETWORK_HOST_UNREACHABLE";
    detail = "lost its SSH connection. Check SSH access, then retry.";
  } else if (error instanceof Error && /^Command timed out after \d+ms:/.test(error.message)) {
    code = "MANAGED_NETWORK_COMMAND_TIMEOUT";
    detail = `did not finish within ${Math.ceil(timeout / 1000)} seconds. Check the server's load and command access, then retry.`;
  } else if (category === "timeout") {
    code = "MANAGED_NETWORK_CONNECTION_TIMEOUT";
    detail = "could not complete because the connection timed out. Check SSH access, then retry.";
  } else if (category === "auth_failed") {
    code = "MANAGED_NETWORK_AUTH_FAILED";
    detail =
      "could not run because SSH authentication was rejected. Check this server's SSH credentials.";
  } else if (category === "permission_denied") {
    code = "MANAGED_NETWORK_PERMISSION_DENIED";
    detail =
      "could not run because host permissions were denied. Check root or passwordless sudo access.";
  } else if (category === "unreachable" || category === "protocol_error") {
    code = "MANAGED_NETWORK_HOST_UNREACHABLE";
    detail =
      category === "unreachable"
        ? "could not reach the server. Check SSH access, then retry."
        : "could not complete the SSH command exchange. Retry; if it repeats, check the server's SSH service.";
  } else {
    code = "MANAGED_NETWORK_COMMAND_FAILED";
    detail =
      "failed while running the host command. Check Python 3 and SSH command access, then retry.";
  }
  const next =
    action === "inspect" || action === "prerequisites"
      ? " This check does not change network configuration."
      : ["prepare", "apply", "commit", "rollback", "finalize"].includes(action)
        ? " The result is unconfirmed; use the saved operation to resume or restore the network."
        : "";
  return new PrivateNetworkError(`${label} ${detail}${next}`, code, { cause: error });
}

function receipt(
  value: ManagedHostReceipt | { missing: true },
  transaction: ManagedHostTransaction,
): ManagedHostReceipt | null {
  if ("missing" in value && value.missing === true) return null;
  const result = value as ManagedHostReceipt;
  if (
    result.operationId !== transaction.operationId ||
    result.generation !== transaction.generation ||
    !["prepared", "applied", "committed", "rolled_back"].includes(result.stage) ||
    !Number.isFinite(result.deadline) ||
    typeof result.healthy !== "boolean" ||
    (result.publicKey !== null && !/^[A-Za-z0-9+/]{43}=$/.test(result.publicKey))
  )
    throw new PrivateNetworkError(
      "The server returned a receipt for a different network operation.",
      "MANAGED_NETWORK_RECEIPT_MISMATCH",
    );
  return result;
}

async function transact(
  executor: CommandExecutor,
  transaction: ManagedHostTransaction,
  action: string,
  extra: Record<string, unknown> = {},
) {
  if (
    !/^[a-f0-9-]{36}$/.test(transaction.operationId) ||
    !Number.isInteger(transaction.generation) ||
    transaction.generation < 1
  )
    throw new PrivateNetworkError("Invalid managed network operation.");
  const access = await hostAccess(executor, transaction.managedId);
  const result = await run<ManagedHostReceipt | { missing: true }>(access.root, action, {
    managedId: transaction.managedId,
    interfaceName: managedInterfaceName(transaction.managedId),
    operationId: transaction.operationId,
    generation: transaction.generation,
    expectedConfigHash: transaction.host.configHash,
    stateDir: access.ops.stateDir(),
    firewallInspect: access.firewall.inspect,
    requireIptables: !!transaction.accessControlled && access.profile.firewall !== "nftables",
    ...extra,
  });
  return receipt(result, transaction);
}

async function peerStatus(
  executor: CommandExecutor,
  managedId: string,
  expectedPeers: readonly string[],
  waitSeconds: number,
): Promise<ManagedPeerStatus> {
  if (expectedPeers.length > 15 || new Set(expectedPeers).size !== expectedPeers.length)
    throw new PrivateNetworkError("Invalid WireGuard peer selection.");
  const access = await hostAccess(executor, managedId);
  const result = await run<ManagedPeerStatus>(
    access.root,
    "ready",
    {
      managedId,
      interfaceName: managedInterfaceName(managedId),
      stateDir: access.ops.stateDir(),
      waitSeconds,
    },
    40_000,
  );
  if (
    typeof result.ready !== "boolean" ||
    typeof result.interfaceReady !== "boolean" ||
    !Array.isArray(result.peers) ||
    result.peers.length !== expectedPeers.length ||
    new Set(result.peers.map((peer) => peer.serverId)).size !== expectedPeers.length ||
    result.peers.some(
      (peer) =>
        !expectedPeers.includes(peer.serverId) ||
        typeof peer.ok !== "boolean" ||
        !validWireGuardEndpoint(peer.endpoint) ||
        !Number.isInteger(peer.port) ||
        peer.port < 1024 ||
        peer.port > 65535 ||
        (peer.lastHandshakeAt !== null &&
          (typeof peer.lastHandshakeAt !== "string" ||
            !Number.isFinite(Date.parse(peer.lastHandshakeAt)))) ||
        peer.ok !== (peer.lastHandshakeAt !== null),
    ) ||
    result.ready !== (result.interfaceReady && result.peers.every((peer) => peer.ok))
  )
    throw new PrivateNetworkError(
      "The host returned an incomplete or invalid WireGuard peer report.",
      "MANAGED_NETWORK_REPORT_INVALID",
    );
  return {
    ready: result.ready,
    interfaceReady: result.interfaceReady,
    peers: result.peers.map(({ serverId, endpoint, port, ok, lastHandshakeAt }) => ({
      serverId,
      endpoint,
      port,
      ok,
      lastHandshakeAt,
    })),
  };
}

async function applyHostConfig(
  executor: CommandExecutor,
  transaction: ManagedHostTransaction,
  config: WireGuardClusterConfig | null,
  transportOnly = false,
) {
  let hostConfig: Record<string, unknown> | null = null;
  if (config) {
    validateWireGuardCluster(config);
    const member = config.members.find((member) => member.serverId === transaction.host.serverId);
    if (!member) throw new PrivateNetworkError("This server is absent from the reviewed network.");
    const peers = networkTransportPeers(config.members, member.serverId, config.network.access);
    if (peers.some((peer) => !peer.publicKey))
      throw new PrivateNetworkError("Every peer needs a host-generated public key before apply.");
    const rules = managedNetworkFirewall(
      transaction.host.firewall,
      config.network.managedId,
      config.network.interfaceName,
      member.listenPort,
      peers,
      config.network.access
        ? {
            privateIp: member.privateIp,
            incoming: peers
              .filter((peer) =>
                networkAccessAllowed(config.network.access, peer.serverId, member.serverId),
              )
              .map((peer) => peer.privateIp),
            outgoing: peers
              .filter((peer) =>
                networkAccessAllowed(config.network.access, member.serverId, peer.serverId),
              )
              .map((peer) => peer.privateIp),
          }
        : undefined,
    );
    if (!rules.supported) throw new PrivateNetworkError(rules.reason);
    hostConfig = {
      managedId: config.network.managedId,
      interfaceName: config.network.interfaceName,
      mtu: config.network.mtu,
      privateIp: member.privateIp,
      listenPort: member.listenPort,
      peers,
      firewall: rules.value,
      ...(config.network.access ? { routeCidrs: config.network.cidrs } : {}),
      ...(transportOnly ? { transportOnly: true } : {}),
    };
  }
  const result = await transact(executor, transaction, "apply", { config: hostConfig });
  if (!result || result.stage !== "applied" || !result.healthy)
    throw new PrivateNetworkError("The managed interface did not become ready.");
  return result;
}

/** Managed WireGuard driver; authorization, inventory locks and journaling belong to the engine. */
export const managedNetworkTools = {
  /** Package bootstrap runs before the Python inspector, through the shared toolchain. */
  async prepareHost(
    executor: CommandExecutor,
    managedId: string,
    observer: ManagedNetworkPreparationObserver,
    signal?: AbortSignal,
    accessControlled = false,
  ): Promise<void> {
    let current: ManagedNetworkStepId = "host";
    try {
      await observer.step(current, "running");
      const access = await hostAccess(executor, managedId, true);
      await observer.step(
        current,
        "completed",
        `${access.ops.describe()}; root access and systemd available; ${access.profile.firewall} firewall.`,
      );
      for (const tool of NETWORK_TOOLS) {
        current = tool.name;
        await observer.step(current, "running");
        // The inspector and WireGuard run through this same privileged PATH.
        let status = await checkTool(access.root, tool.name, { minVersion: tool.minimum });
        if (!status.healthy) {
          observer.log(current, {
            timestamp: new Date().toISOString(),
            level: "info",
            message: status.message,
          });
          const installed = await installTool(
            executor,
            tool.name,
            (entry) => observer.log(tool.name, entry),
            tool.minimum,
            { signal },
          );
          if (!installed.success)
            throw new PrivateNetworkError(
              installed.error || `${status.label} installation failed.`,
              "MANAGED_NETWORK_INSTALL_FAILED",
            );
          status = await checkTool(access.root, tool.name, { minVersion: tool.minimum });
          if (!status.healthy)
            throw new PrivateNetworkError(status.message, "MANAGED_NETWORK_INSTALL_FAILED");
        }
        await observer.step(current, "completed", status.message);
      }
      current = "firewall";
      if (accessControlled) {
        await observer.step(current, "running");
        if (access.profile.firewall !== "nftables") {
          let status = await checkTool(access.root, "iptables", { minVersion: "1.8" });
          if (!status.healthy) {
            const installed = await installTool(
              executor,
              "iptables",
              (entry) => observer.log("firewall", entry),
              "1.8",
              { signal },
            );
            if (!installed.success)
              throw new PrivateNetworkError(
                installed.error || "Could not install the connection-policy firewall.",
                "MANAGED_NETWORK_INSTALL_FAILED",
              );
            status = await checkTool(access.root, "iptables", { minVersion: "1.8" });
            if (!status.healthy)
              throw new PrivateNetworkError(status.message, "MANAGED_NETWORK_INSTALL_FAILED");
          }
          await access.root.exec(IPTABLES_PROBES.conntrack, { timeout: 20_000 });
        }
        await observer.step(
          current,
          "completed",
          "Stateful firewall tools are available for the selected private connection policy.",
        );
      } else {
        await observer.step(
          current,
          "skipped",
          "The existing full-mesh policy does not need additional firewall tools.",
        );
      }
      current = "kernel";
      await observer.step(current, "running");
      const result = await run<{ ready: boolean }>(access.root, "prerequisites", {
        managedId,
        interfaceName: managedInterfaceName(managedId),
        stateDir: access.ops.stateDir(),
      });
      if (!result.ready)
        throw new PrivateNetworkError("The server's network prerequisites could not be verified.");
      await observer.step(
        current,
        "completed",
        "WireGuard kernel support and iproute2 JSON inspection are available.",
      );
    } catch (error) {
      await observer.step(
        current,
        "failed",
        error instanceof Error ? error.message : "Server preparation failed.",
      );
      throw error;
    }
  },

  async inspect(
    executor: CommandExecutor,
    identity: ManagedHostIdentity,
  ): Promise<ManagedNetworkObservation> {
    const access = await hostAccess(executor, identity.managedId, true);
    const result = await run<Omit<ManagedNetworkObservation, "hostIdentity" | "firewall">>(
      access.root,
      "inspect",
      {
        ...identity,
        interfaceName: managedInterfaceName(identity.managedId),
        stateDir: access.ops.stateDir(),
        firewallInspect: access.firewall.inspect,
        requireIptables: !!identity.accessControlled && access.profile.firewall !== "nftables",
      },
      60_000,
    );
    if (
      !/^[a-f0-9]{64}$/.test(result.fingerprint) ||
      !Array.isArray(result.interfaces) ||
      !Array.isArray(result.routes) ||
      !Array.isArray(result.reservedIps) ||
      !Array.isArray(result.packages) ||
      result.packages.some((name) => !["wireguard-tools", "iptables"].includes(name)) ||
      !Number.isInteger(result.transportMtu)
    )
      throw new PrivateNetworkError("The host returned an invalid managed network inspection.");
    return {
      ...result,
      hostIdentity: identity.hostIdentity,
      firewall: access.profile.firewall as "none" | "iptables" | "nftables",
    };
  },

  /** Call under the existing server provisioning lock. Installs are reviewed separately. */
  async install(
    executor: CommandExecutor,
    managedId: string,
    packages: readonly string[],
    onLog?: (entry: LogEntry) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (packages.length === 0) return;
    if (packages.some((name) => !["wireguard-tools", "iptables"].includes(name)))
      throw new PrivateNetworkError("Unrecognized managed network prerequisite.");
    const access = await hostAccess(executor, managedId);
    for (const name of packages) {
      const minimum = name === "iptables" ? "1.8" : "1.0";
      const current = await checkTool(access.root, name, { minVersion: minimum });
      if (current.healthy) continue;
      const result = await installTool(executor, name, onLog, minimum, { signal });
      if (!result.success)
        throw new PrivateNetworkError(
          result.error ||
            `${name} could not be installed. Check the server's package repositories, then resume.`,
          "MANAGED_NETWORK_INSTALL_FAILED",
        );
      const installed = await checkTool(access.root, name, { minVersion: minimum });
      if (!installed.healthy)
        throw new PrivateNetworkError(installed.message, "MANAGED_NETWORK_INSTALL_FAILED");
    }
  },

  async prepare(
    executor: CommandExecutor,
    transaction: ManagedHostTransaction,
    rotateKeys: boolean,
  ): Promise<ManagedHostReceipt> {
    const access = await hostAccess(executor, transaction.managedId);
    const result = await transact(executor, transaction, "prepare", {
      listenPort: transaction.host.listenPort,
      expectedFingerprint: transaction.host.fingerprint,
      rotateKeys,
      rollbackSeconds: MANAGED_NETWORK_ROLLBACK_SECONDS,
      services: access.services,
      runner: MANAGED_NETWORK_HOST,
    });
    if (!result?.publicKey)
      throw new PrivateNetworkError("The host did not return its WireGuard public key.");
    return result;
  },

  /** Stage the real WireGuard endpoints under the existing rollback timer, without private routes. */
  stageTransport(
    executor: CommandExecutor,
    transaction: ManagedHostTransaction,
    config: WireGuardClusterConfig,
  ) {
    return applyHostConfig(executor, transaction, config, true);
  },

  apply: (
    executor: CommandExecutor,
    transaction: ManagedHostTransaction,
    config: WireGuardClusterConfig | null,
  ) => applyHostConfig(executor, transaction, config),

  /** Let initial/rekey handshakes settle before short-lived application probes. */
  waitForPeers: (executor: CommandExecutor, managedId: string, expectedPeers: readonly string[]) =>
    peerStatus(executor, managedId, expectedPeers, 30),
  inspectPeers: (executor: CommandExecutor, managedId: string, expectedPeers: readonly string[]) =>
    peerStatus(executor, managedId, expectedPeers, 0),

  commit: (executor: CommandExecutor, transaction: ManagedHostTransaction) =>
    transact(executor, transaction, "commit"),
  rollback: (executor: CommandExecutor, transaction: ManagedHostTransaction) =>
    transact(executor, transaction, "rollback"),
  finalize: (executor: CommandExecutor, transaction: ManagedHostTransaction) =>
    transact(executor, transaction, "finalize"),
};
