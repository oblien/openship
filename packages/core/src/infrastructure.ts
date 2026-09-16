/** Provider-neutral infrastructure definitions. No SSH, database, or UI dependencies. */
export const INFRASTRUCTURE_PROVIDERS = [
  {
    id: "hetzner-dedicated",
    name: "Hetzner Dedicated",
    network: "Robot vSwitch",
    mtu: 1400,
    maxMtu: 1400,
    docs: "https://docs.hetzner.com/robot/dedicated-server/network/vswitch/",
  },
  {
    id: "hetzner-cloud",
    name: "Hetzner Cloud",
    network: "Cloud Network",
    mtu: 1450,
    docs: "https://docs.hetzner.com/cloud/networks/overview/",
  },
  {
    id: "aws",
    name: "Amazon Web Services",
    network: "VPC / subnet",
    mtu: 1500,
    docs: "https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html",
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    network: "Virtual Network",
    mtu: 1500,
    docs: "https://learn.microsoft.com/en-us/azure/virtual-network/virtual-networks-overview",
  },
  {
    id: "gcp",
    name: "Google Cloud",
    network: "VPC / subnet",
    mtu: 1460,
    docs: "https://cloud.google.com/vpc/docs/vpc",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    network: "VPC",
    mtu: 1500,
    docs: "https://docs.digitalocean.com/products/networking/vpc/",
  },
  {
    id: "ovh",
    name: "OVHcloud",
    network: "vRack",
    mtu: 1500,
    docs: "https://www.ovhcloud.com/en/network/vrack/",
  },
  {
    id: "scaleway",
    name: "Scaleway",
    network: "Private Network",
    mtu: 1500,
    docs: "https://www.scaleway.com/en/docs/vpc/",
  },
  { id: "custom", name: "Custom", network: "LAN / VLAN / routed network", mtu: 1500, docs: null },
] as const;

export type InfrastructureProviderId = (typeof INFRASTRUCTURE_PROVIDERS)[number]["id"];
export type InfrastructureNetworkMode = "native" | "wireguard";
export const MAX_CLUSTER_MEMBERS = 16;
export const NETWORK_CHECK_TTL_MS = 15 * 60_000;
export const NETWORK_CHECK_DEADLINE_MS = 4 * 60_000;
// A listener must outlive the whole bounded fleet check, including queued peers.
export const NETWORK_PROBE_TTL_SECONDS = NETWORK_CHECK_DEADLINE_MS / 1000 + 30;

export interface ClusterMemberConfig {
  serverId: string;
  providerId: InfrastructureProviderId;
  privateIp: string;
  interfaceName?: string;
  networkRef?: string;
}
export interface NativeClusterConfig {
  name: string;
  location?: string;
  network: { mode: "native"; cidrs: string[]; mtu: number; probePort: number };
  members: ClusterMemberConfig[];
}
export interface NetworkInterfaceObservation {
  name: string;
  mtu: number;
  up: boolean;
  kind: string | null;
  addresses: Array<{ address: string; prefixLength: number }>;
}
export interface NetworkHostObservation {
  hostIdentity: string;
  interfaces: NetworkInterfaceObservation[];
}
export interface ClusterHostCheck {
  serverId: string;
  ok: boolean;
  interfaceName: string | null;
  mtu: number | null;
  code: string | null;
  message: string | null;
}
export interface ClusterPeerCheck {
  sourceServerId: string;
  targetServerId: string;
  tcp: boolean;
  udp: boolean;
  mtu: boolean;
  latencyMs: number | null;
  message: string | null;
}
export interface ClusterNetworkReport {
  hosts: ClusterHostCheck[];
  peers: ClusterPeerCheck[];
  stage: "inspecting" | "probing" | "complete";
}

/** Strict IPv4 only for the first driver. IPv6 needs its own MTU/route verification. */
export function infrastructureIpv4(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts.reduce((n, octet) => n * 256 + octet, 0);
}

function ipv4Mask(prefix: number) {
  return (0xffffffff << (32 - prefix)) >>> 0;
}

export function infrastructureCidr(
  value: string,
): { start: number; end: number; prefix: number } | null {
  const [address, rawPrefix, extra] = value.split("/");
  if (extra !== undefined || !rawPrefix || !/^(?:[1-9]|[12]\d|3[0-2])$/.test(rawPrefix))
    return null;
  const ip = infrastructureIpv4(address!);
  if (ip === null) return null;
  const prefix = Number(rawPrefix);
  const start = (ip & ipv4Mask(prefix)) >>> 0;
  if (start !== ip) return null;
  return { start, end: start + 2 ** (32 - prefix) - 1, prefix };
}

export function isInfrastructurePrivateIp(value: string): boolean {
  const n = infrastructureIpv4(value);
  return (
    n !== null &&
    ((n >= 0x0a000000 && n <= 0x0affffff) ||
      (n >= 0xac100000 && n <= 0xac1fffff) ||
      (n >= 0xc0a80000 && n <= 0xc0a8ffff))
  );
}

export class ClusterConfigError extends Error {
  readonly code = "INVALID_CLUSTER_CONFIG";
}

/** Shared semantic validation for the API, SDK, and review wizard. */
export function validateNativeCluster(config: NativeClusterConfig): void {
  const fail = (message: string): never => {
    throw new ClusterConfigError(message);
  };
  if (!config.name.trim() || config.name.length > 100)
    fail("Enter a cluster name between 1 and 100 characters.");
  if (config.network.mode !== "native") fail("This operation adopts an existing private network.");
  if (config.members.length < 2 || config.members.length > MAX_CLUSTER_MEMBERS)
    fail(`Select between 2 and ${MAX_CLUSTER_MEMBERS} servers.`);
  if (
    !Number.isInteger(config.network.mtu) ||
    config.network.mtu < 1280 ||
    config.network.mtu > 9000
  )
    fail("MTU must be between 1280 and 9000.");
  if (
    !Number.isInteger(config.network.probePort) ||
    config.network.probePort < 1024 ||
    config.network.probePort > 65535
  )
    fail("Choose a verification port between 1024 and 65535.");
  if (!config.network.cidrs.length || config.network.cidrs.length > 8)
    fail("Enter between 1 and 8 private network ranges.");
  const ranges = config.network.cidrs.map((cidr) => {
    const range = infrastructureCidr(cidr);
    if (!range || range.prefix > 30 || !isInfrastructurePrivateIp(cidr.split("/")[0]!))
      fail(`Invalid private network range: ${cidr}`);
    const end = [24, 16, 8, 0].map((shift) => (range!.end >>> shift) & 255).join(".");
    if (!isInfrastructurePrivateIp(end))
      fail(`Network range extends outside private addresses: ${cidr}`);
    return range!;
  });
  ranges.forEach((a, i) =>
    ranges.slice(i + 1).forEach((b) => {
      if (a.start <= b.end && b.start <= a.end) fail("Network ranges overlap.");
    }),
  );
  const servers = new Set<string>();
  const addresses = new Set<string>();
  for (const member of config.members) {
    if (servers.has(member.serverId)) fail("A server can appear only once in a cluster.");
    servers.add(member.serverId);
    const provider = INFRASTRUCTURE_PROVIDERS.find((p) => p.id === member.providerId);
    if (!provider) fail("Choose a supported provider or Custom.");
    if (provider && "maxMtu" in provider && config.network.mtu > provider.maxMtu)
      fail(`${provider.network} supports an MTU of at most ${provider.maxMtu}.`);
    if (!isInfrastructurePrivateIp(member.privateIp))
      fail("Cluster members need private IPv4 addresses.");
    const ip = infrastructureIpv4(member.privateIp)!;
    if (!ranges.some((r) => ip > r.start && ip < r.end))
      fail(`Address ${member.privateIp} is outside the usable network ranges.`);
    if (addresses.has(member.privateIp)) fail("Each member needs a unique private address.");
    addresses.add(member.privateIp);
    if (member.interfaceName && !/^[a-zA-Z0-9_.:-]{1,15}$/.test(member.interfaceName))
      fail("Invalid network interface name.");
  }
}

export function privateHostInterfaces(
  interfaces: readonly NetworkInterfaceObservation[],
): NetworkInterfaceObservation[] {
  return interfaces.filter(
    (nic) =>
      nic.up &&
      nic.name !== "lo" &&
      !/^(?:docker\d*|br-[0-9a-f]+|veth)/.test(nic.name) &&
      nic.addresses.some((address) => isInfrastructurePrivateIp(address.address)),
  );
}

export function selectClusterInterface(
  host: NetworkHostObservation,
  member: ClusterMemberConfig,
  mtu: number,
): NetworkInterfaceObservation {
  const candidates = privateHostInterfaces(host.interfaces).filter(
    (nic) =>
      (!member.interfaceName || nic.name === member.interfaceName) &&
      nic.addresses.some((a) => a.address === member.privateIp),
  );
  if (candidates.length !== 1)
    throw new ClusterConfigError(
      "The private address must belong to one active host interface. Check the address and interface selection.",
    );
  const provider = INFRASTRUCTURE_PROVIDERS.find((p) => p.id === member.providerId);
  if (provider && "maxMtu" in provider && candidates[0]!.mtu > provider.maxMtu)
    throw new ClusterConfigError(
      `Configure the ${provider.network} interface with an MTU of ${provider.maxMtu} or lower before verifying it.`,
    );
  if (candidates[0]!.mtu < mtu)
    throw new ClusterConfigError(
      `The interface MTU is ${candidates[0]!.mtu}; lower the verification MTU or configure the network first.`,
    );
  return candidates[0]!;
}

export function networkReportSucceeded(
  report: ClusterNetworkReport,
  serverIds: readonly string[],
): boolean {
  if (report.stage !== "complete" || serverIds.length < 2) return false;
  if (
    report.hosts.length !== serverIds.length ||
    !serverIds.every((id) => report.hosts.some((h) => h.serverId === id && h.ok))
  )
    return false;
  if (report.peers.length !== serverIds.length * (serverIds.length - 1)) return false;
  return serverIds.every((source) =>
    serverIds.every(
      (target) =>
        source === target ||
        report.peers.some(
          (p) =>
            p.sourceServerId === source && p.targetServerId === target && p.tcp && p.udp && p.mtu,
        ),
    ),
  );
}
