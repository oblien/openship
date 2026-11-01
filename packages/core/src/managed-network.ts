import {
  ClusterConfigError,
  infrastructureCidr,
  infrastructureIpv4,
  isInfrastructurePrivateIp,
  MAX_CLUSTER_MEMBERS,
  INFRASTRUCTURE_PROVIDERS,
  validateNativeCluster,
  type ClusterMemberConfig,
  type ClusterNetworkReport,
  type NativeClusterConfig,
  type NetworkInterfaceObservation,
} from "./infrastructure";
import {
  normalizeNetworkAccess,
  retainNetworkAccess,
  type NetworkAccessPolicy,
} from "./network-access";

export const MANAGED_NETWORK_PLAN_TTL_MS = 15 * 60_000;
export const MANAGED_NETWORK_LEASE_MS = 90_000;
export const MANAGED_NETWORK_ROLLBACK_SECONDS = 20 * 60;
export const MANAGED_NETWORK_PORT = 51820;

/** The same progress records drive preparation, apply, and recovery views. */
export const MANAGED_NETWORK_PREPARATION_STEPS = [
  "connect",
  "host",
  "python3",
  "iproute2",
  "wireguard-tools",
  "firewall",
  "kernel",
  "inspect",
] as const;
export const MANAGED_NETWORK_APPLY_STEPS = [
  "recheck",
  "tools",
  "prepare",
  "transport",
  "handshake",
  "configure",
  "verify",
  "commit",
] as const;
export type ManagedNetworkStepId =
  | (typeof MANAGED_NETWORK_PREPARATION_STEPS)[number]
  | (typeof MANAGED_NETWORK_APPLY_STEPS)[number]
  | "rollback";
export interface ManagedNetworkStepProgress {
  id: ManagedNetworkStepId;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ManagedNetworkSetupLog {
  timestamp: string;
  step: ManagedNetworkStepId;
  level: "info" | "warn" | "error";
  message: string;
}
export function managedNetworkSteps(
  ids: readonly ManagedNetworkStepId[],
): ManagedNetworkStepProgress[] {
  return ids.map((id) => ({
    id,
    status: "pending",
    message: null,
    startedAt: null,
    finishedAt: null,
  }));
}

/** Non-secret draft retained so setup can be reopened or edited after a failure. */
export interface ManagedNetworkPreparationInput {
  requestId: string;
  clusterId?: string;
  revision?: number;
  intent?: "configure" | "remove";
  name: string;
  location?: string;
  cidr?: string;
  mtu?: number;
  probePort?: number;
  rotateKeys?: boolean;
  access?: NetworkAccessPolicy;
  members: {
    serverId: string;
    providerId: ClusterMemberConfig["providerId"];
    endpoint?: string;
    listenPort?: number;
  }[];
}
/** Fixed field ordering keeps request hashes stable after a jsonb round trip. */
export function normalizeManagedNetworkInput(
  input: ManagedNetworkPreparationInput,
): ManagedNetworkPreparationInput {
  return {
    requestId: input.requestId,
    name: input.name.trim(),
    location: input.location?.trim() || undefined,
    clusterId: input.clusterId,
    revision: input.revision,
    intent: input.intent,
    cidr: input.cidr?.trim() || undefined,
    mtu: input.mtu,
    probePort: input.probePort,
    rotateKeys: input.rotateKeys,
    ...(input.access
      ? {
          access: normalizeNetworkAccess(
            input.access,
            input.members.map((member) => member.serverId),
          ),
        }
      : {}),
    members: [...input.members]
      .sort((a, b) => a.serverId.localeCompare(b.serverId))
      .map((member) => ({
        serverId: member.serverId,
        providerId: member.providerId,
        endpoint: member.endpoint?.trim() || undefined,
        listenPort: member.listenPort,
      })),
  };
}

/** A changed initial selection gets its own immutable request and reviewed plan. */
export function withoutManagedNetworkMember(
  input: ManagedNetworkPreparationInput,
  serverId: string,
  requestId: string,
): ManagedNetworkPreparationInput {
  if (input.clusterId || input.revision !== undefined || input.intent === "remove")
    throw new ClusterConfigError("Remove setup servers only while creating a new network.");
  if (!input.members.some((member) => member.serverId === serverId))
    throw new ClusterConfigError("This server is not selected in this setup.");
  const members = input.members.filter((member) => member.serverId !== serverId);
  if (new Set(members.map((member) => member.serverId)).size < 2)
    throw new ClusterConfigError("Keep at least two servers to continue creating this network.");
  if (requestId === input.requestId)
    throw new ClusterConfigError("The updated selection needs a new setup request.");
  return normalizeManagedNetworkInput({
    ...input,
    requestId,
    members,
    access: retainNetworkAccess(
      input.access,
      members.map((member) => member.serverId),
    ),
  });
}

export function initialManagedNetworkInput(
  plan: ManagedNetworkPlan,
  requestId: string,
): ManagedNetworkPreparationInput {
  if (plan.baseRevision !== null || plan.previous !== null || plan.intent !== "configure")
    throw new ClusterConfigError("Remove setup servers only while creating a new network.");
  return normalizeManagedNetworkInput({
    requestId,
    name: plan.config.name,
    location: plan.config.location,
    cidr: plan.config.network.cidrs[0],
    mtu: plan.config.network.mtu,
    probePort: plan.config.network.probePort,
    access: plan.config.network.access,
    members: plan.config.members.map(({ serverId, providerId, endpoint, listenPort }) => ({
      serverId,
      providerId,
      endpoint,
      listenPort,
    })),
  });
}
export interface ManagedNetworkTransport {
  endpoint: string;
  listenPort: number;
}
export interface ManagedNetworkPreparationHost {
  serverId: string;
  name: string;
  address: string;
  hostIdentity: string | null;
  /** Resolved by the planner, including DNS and inherited network settings. */
  transport?: ManagedNetworkTransport;
  steps: ManagedNetworkStepProgress[];
  logs: ManagedNetworkSetupLog[];
}
export interface ManagedNetworkPreparation {
  id: string;
  /** Durable progress order, independent of controller leases and HTTP delivery. */
  sequence: number;
  status: "pending" | "preparing" | "ready" | "failed" | "interrupted" | "cancelled";
  input: ManagedNetworkPreparationInput;
  hosts: ManagedNetworkPreparationHost[];
  operationId: string | null;
  replacementPreparationId: string | null;
  cleanupOperationId: string | null;
  error: string | null;
  generation: number;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ManagedNetworkPreparationSummary {
  id: string;
  sequence: number;
  name: string;
  status: ManagedNetworkPreparation["status"];
  serverCount: number;
  error: string | null;
  operationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WireGuardMemberConfig extends ClusterMemberConfig {
  endpoint: string;
  listenPort: number;
  publicKey?: string;
}
export interface WireGuardClusterConfig {
  name: string;
  location?: string;
  network: {
    mode: "wireguard";
    cidrs: string[];
    mtu: number;
    probePort: number;
    managedId: string;
    interfaceName: string;
    access?: NetworkAccessPolicy;
  };
  members: WireGuardMemberConfig[];
}
export type InfrastructureClusterConfig = NativeClusterConfig | WireGuardClusterConfig;

export interface ManagedNetworkObservation {
  hostIdentity: string;
  fingerprint: string;
  interfaces: NetworkInterfaceObservation[];
  routes: string[];
  reservedIps: string[];
  configHash: string | null;
  publicKey: string | null;
  packages: string[];
  firewall: "none" | "iptables" | "nftables";
  transportMtu: number;
}
export interface ManagedNetworkPlanHost {
  serverId: string;
  name: string;
  hostIdentity: string;
  fingerprint: string;
  configHash: string | null;
  endpoint: string;
  listenPort: number;
  privateIp: string;
  packages: string[];
  firewall: "none" | "iptables" | "nftables";
  action: "configure" | "remove";
}
export interface ManagedNetworkPlan {
  version: 1;
  clusterId: string;
  managedId: string;
  interfaceName: string;
  baseRevision: number | null;
  intent: "configure" | "remove";
  rotateKeys: boolean;
  config: WireGuardClusterConfig;
  previous: InfrastructureClusterConfig | null;
  hosts: ManagedNetworkPlanHost[];
  createdAt: string;
  expiresAt: string;
  preparationId?: string;
}
export type ManagedNetworkOperationStatus =
  | "planned"
  | "applying"
  | "verifying"
  | "committing"
  | "rolling_back"
  | "succeeded"
  | "rolled_back"
  | "interrupted"
  | "needs_attention"
  | "cancelled";
export type ManagedNetworkHostStage =
  | "pending"
  | "prepared"
  | "applied"
  | "verified"
  | "committed"
  | "rolled_back"
  | "failed";
export interface ManagedNetworkHostProgress {
  serverId: string;
  stage: ManagedNetworkHostStage;
  publicKey: string | null;
  error: string | null;
  /** Optional for operation journals created before step-level progress. */
  steps?: ManagedNetworkStepProgress[];
  logs?: ManagedNetworkSetupLog[];
}
export interface ManagedNetworkOperation {
  id: string;
  sequence: number;
  clusterId: string;
  status: ManagedNetworkOperationStatus;
  planHash: string;
  plan: ManagedNetworkPlan;
  replacementPreparationId: string | null;
  hosts: ManagedNetworkHostProgress[];
  report: ClusterNetworkReport | null;
  error: string | null;
  generation: number;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const managedNetworkInProgress = (status: ManagedNetworkOperationStatus) =>
  ["applying", "verifying", "committing", "rolling_back"].includes(status);
export const managedNetworkUnsettled = (status: ManagedNetworkOperationStatus) =>
  managedNetworkInProgress(status) || status === "interrupted" || status === "needs_attention";

export function managedInterfaceName(managedId: string): string {
  if (!/^[a-f0-9]{32}$/.test(managedId))
    throw new ClusterConfigError("Invalid managed network identity.");
  return `oswg${managedId.slice(0, 10)}`;
}

export function ipv4Text(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

/** Public transport addresses can be private, but never loopback, link-local or multicast. */
export function validWireGuardEndpoint(value: string): boolean {
  const ip = infrastructureIpv4(value);
  return (
    ip !== null &&
    ip >= 0x01000000 &&
    ip < 0xe0000000 &&
    ip >>> 24 !== 127 &&
    ip >>> 16 !== 0xa9fe &&
    ip !== 0xffffffff
  );
}

export function validateWireGuardCluster(config: WireGuardClusterConfig): void {
  if (config.network.access)
    normalizeNetworkAccess(
      config.network.access,
      config.members.map((member) => member.serverId),
    );
  if (config.network.interfaceName !== managedInterfaceName(config.network.managedId))
    throw new ClusterConfigError("The managed interface does not match its network.");
  if (config.network.cidrs.length !== 1)
    throw new ClusterConfigError("Choose one private range for the managed network.");
  // Reuse membership, address, MTU, port and provider validation. A tunnel MTU is distinct
  // from a native provider's interface MTU, so provider limits are validated on transport.
  validateNativeCluster({
    ...config,
    network: { ...config.network, mode: "native" },
    members: config.members.map((member) => ({ ...member, providerId: "custom" })),
  });
  const endpoints = new Set<string>();
  for (const member of config.members) {
    if (!INFRASTRUCTURE_PROVIDERS.some((provider) => provider.id === member.providerId))
      throw new ClusterConfigError("Choose a supported provider or Custom.");
    if (!validWireGuardEndpoint(member.endpoint))
      throw new ClusterConfigError("Enter a reachable IPv4 transport address for each server.");
    if (
      !Number.isInteger(member.listenPort) ||
      member.listenPort < 1024 ||
      member.listenPort > 65535 ||
      member.listenPort === config.network.probePort
    )
      throw new ClusterConfigError(
        "WireGuard needs a UDP port between 1024 and 65535, distinct from the verification port.",
      );
    const endpoint = `${member.endpoint}:${member.listenPort}`;
    if (endpoints.has(endpoint))
      throw new ClusterConfigError(
        "Each server needs a distinct WireGuard transport address and port.",
      );
    endpoints.add(endpoint);
    if (member.publicKey && !/^[A-Za-z0-9+/]{43}=$/.test(member.publicKey))
      throw new ClusterConfigError("Invalid WireGuard public key.");
  }
}

/** Allocate only a subnet absent from observed host, Docker, VPN, route and DNS ranges. */
export function allocateManagedSubnet(
  observations: readonly ManagedNetworkObservation[],
  requested?: string,
  reserved: readonly string[] = [],
): string {
  const conflicts = [
    ...reserved,
    ...observations.flatMap((host) => [
      ...host.routes,
      ...host.reservedIps.map((ip) => `${ip}/32`),
      ...host.interfaces.flatMap((nic) =>
        nic.addresses.map((address) => {
          const ip = infrastructureIpv4(address.address);
          const prefix = address.prefixLength;
          if (ip === null || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) return "";
          return `${ipv4Text((ip & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0)}/${prefix}`;
        }),
      ),
    ]),
  ]
    .map(infrastructureCidr)
    .filter((range) => range !== null);
  const available = (cidr: string) => {
    const range = infrastructureCidr(cidr);
    return (
      range &&
      range.prefix >= 16 &&
      range.prefix <= 27 &&
      isInfrastructurePrivateIp(ipv4Text(range.start)) &&
      isInfrastructurePrivateIp(ipv4Text(range.end)) &&
      !conflicts.some((other) => range.start <= other.end && other.start <= range.end)
    );
  };
  if (requested) {
    if (!available(requested))
      throw new ClusterConfigError(
        "This managed range overlaps a host, Docker, VPN, route, DNS or existing private network, or is not a private /16–/27 subnet.",
      );
    return requested;
  }
  for (let third = 0; third < 256; third++) {
    const cidr = `10.244.${third}.0/24`;
    if (available(cidr)) return cidr;
  }
  throw new ClusterConfigError(
    "No free managed subnet was found. Choose a private range that does not overlap the selected servers' networks.",
  );
}

/** Retain stable addresses for existing members. Reserve departing members until cleanup commits. */
export function allocateManagedAddresses(
  cidr: string,
  serverIds: readonly string[],
  previous: readonly ClusterMemberConfig[] = [],
): Map<string, string> {
  const range = infrastructureCidr(cidr);
  if (
    !range ||
    range.prefix < 16 ||
    range.prefix > 27 ||
    serverIds.length < 2 ||
    serverIds.length > MAX_CLUSTER_MEMBERS ||
    new Set(serverIds).size !== serverIds.length
  )
    throw new ClusterConfigError("Invalid managed network allocation.");
  if (
    new Set(previous.map((member) => member.privateIp)).size !== previous.length ||
    new Set(previous.map((member) => member.serverId)).size !== previous.length
  )
    throw new ClusterConfigError("Existing managed addresses must be unique.");
  const occupied = new Set(previous.map((member) => member.privateIp));
  const result = new Map<string, string>();
  for (const id of [...serverIds].sort()) {
    const old = previous.find((member) => member.serverId === id);
    const ip = old && infrastructureIpv4(old.privateIp);
    if (ip != null && ip > range.start && ip < range.end) {
      result.set(id, old!.privateIp);
      continue;
    }
    let next = range.start + 1;
    while (next < range.end && occupied.has(ipv4Text(next))) next++;
    if (next >= range.end)
      throw new ClusterConfigError("The managed subnet has no free addresses for these members.");
    const address = ipv4Text(next);
    occupied.add(address);
    result.set(id, address);
  }
  return result;
}
