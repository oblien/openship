import { AppError } from "./errors";
import { infrastructureCidr, isInfrastructurePrivateIp } from "./infrastructure";
import { networkAccessAllowed, type NetworkAccessPolicy } from "./network-access";

export interface SetupStepProgress<Id extends string = string> {
  id: Id;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface SetupLog<Id extends string = string> {
  timestamp: string;
  step: Id;
  level: "info" | "warn" | "error";
  message: string;
}

export const CLUSTER_RUNTIME_LEASE_MS = 90_000;
export const CLUSTER_RUNTIME_STEPS = [
  "connect",
  "prerequisites",
  "inspect",
  "install",
  "join",
  "verify",
] as const;
export type ClusterRuntimeStep = (typeof CLUSTER_RUNTIME_STEPS)[number] | "remove";
export type ClusterRuntimeStatus =
  | "setting_up"
  | "ready"
  | "failed"
  | "interrupted"
  | "removing"
  | "removed";
export const clusterRuntimeRunning = (status: ClusterRuntimeStatus) =>
  status === "setting_up" || status === "removing";

export interface ClusterRuntimeHost {
  serverId: string;
  name: string;
  address: string;
  privateIp: string;
  nodeName: string;
  role: "server" | "agent";
  hostIdentity: string | null;
  interfaceName: string | null;
  installed: boolean;
  ready: boolean;
  steps: SetupStepProgress<ClusterRuntimeStep>[];
  logs: SetupLog<ClusterRuntimeStep>[];
}
export interface ClusterRuntimePlan {
  /** Existing schedulers own their networking; only managed K3s uses these. */
  networkId: string | null;
  networkRevision: number | null;
  version: string | null;
  podCidr: string | null;
  serviceCidr: string | null;
  clusterUid?: string;
  /** Saved before uninstalling any host, so cleanup can resume after losing etcd quorum. */
  cleanup?: { verifiedAt: string; clusterUid: string | null };
  hosts: ClusterRuntimeHost[];
}
export interface ClusterRuntime {
  id: string;
  clusterId: string;
  provider: "k3s" | "swarm";
  status: ClusterRuntimeStatus;
  intent: "setup" | "remove";
  sequence: number;
  generation: number;
  plan: ClusterRuntimePlan;
  error: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Every requirement uses private node addresses. Never publish these on the public internet. */
export function clusterRuntimeConnections(
  hosts: readonly Pick<ClusterRuntimeHost, "serverId" | "role" | "privateIp">[],
) {
  return hosts.flatMap((target) =>
    hosts
      .filter((source) => source.serverId !== target.serverId)
      .flatMap((source) => {
        const ports: { protocol: "tcp" | "udp"; port: number; purpose: string }[] = [
          { protocol: "udp", port: 8472, purpose: "Pod network" },
          { protocol: "tcp", port: 10250, purpose: "Node health and metrics" },
        ];
        if (target.role === "server")
          ports.push({ protocol: "tcp", port: 6443, purpose: "Cluster API" });
        if (target.role === "server" && source.role === "server")
          ports.push(
            { protocol: "tcp", port: 2379, purpose: "Cluster state" },
            { protocol: "tcp", port: 2380, purpose: "Cluster state replication" },
          );
        return ports.map((port) => ({
          sourceServerId: source.serverId,
          sourceIp: source.privateIp,
          targetServerId: target.serverId,
          targetIp: target.privateIp,
          ...port,
        }));
      }),
  );
}

export function assertClusterRuntimeNetwork(
  hosts: readonly Pick<ClusterRuntimeHost, "serverId" | "privateIp">[],
  access?: NetworkAccessPolicy,
) {
  if (
    !hosts.length ||
    new Set(hosts.map((host) => host.privateIp)).size !== hosts.length ||
    hosts.some((host) => !isInfrastructurePrivateIp(host.privateIp))
  )
    throw new AppError(
      "Every cluster server needs a distinct private IPv4 address.",
      400,
      "CLUSTER_RUNTIME_NETWORK",
    );
  for (const source of hosts)
    for (const target of hosts) {
      if (
        source.serverId !== target.serverId &&
        !networkAccessAllowed(access, source.serverId, target.serverId)
      )
        throw new AppError(
          "Cluster servers need private access to each other in both directions. Update their connections in Networking before setting up the runtime.",
          409,
          "CLUSTER_RUNTIME_NETWORK",
        );
    }
}

/** Reserve whole /16s: the default Kubernetes node mask allocates a /24 per node. */
export function allocateClusterRuntimeRanges(reserved: readonly string[]): {
  podCidr: string;
  serviceCidr: string;
} {
  const used = reserved.map(infrastructureCidr).filter((value) => value !== null);
  const selected: string[] = [];
  const candidates = [
    ...Array.from({ length: 214 }, (_, index) => `10.${index + 42}.0.0/16`),
    ...Array.from({ length: 42 }, (_, index) => `10.${index}.0.0/16`),
    ...Array.from({ length: 16 }, (_, index) => `172.${index + 16}.0.0/16`),
    "192.168.0.0/16",
  ];
  for (const cidr of candidates) {
    const range = infrastructureCidr(cidr)!;
    if (used.some((other) => range.start <= other.end && other.start <= range.end)) continue;
    used.push(range);
    selected.push(cidr);
    if (selected.length === 2) break;
  }
  if (selected.length !== 2)
    throw new AppError(
      "No free pod and service ranges were found. Review the servers' existing routes before setting up the cluster.",
      409,
      "CLUSTER_RUNTIME_NETWORK",
    );
  return { podCidr: selected[0]!, serviceCidr: selected[1]! };
}

export function assertClusterRuntimeRanges(
  podCidr: string,
  serviceCidr: string,
  reserved: readonly string[],
) {
  const pod = infrastructureCidr(podCidr);
  const service = infrastructureCidr(serviceCidr);
  if (
    !pod ||
    !service ||
    pod.prefix !== 16 ||
    service.prefix !== 16 ||
    podCidr === serviceCidr ||
    !isInfrastructurePrivateIp(podCidr.split("/")[0]!) ||
    !isInfrastructurePrivateIp(serviceCidr.split("/")[0]!)
  )
    throw new AppError(
      "The saved cluster network ranges are invalid.",
      409,
      "CLUSTER_RUNTIME_NETWORK",
    );
  for (const entry of reserved) {
    const range = infrastructureCidr(entry);
    if (
      range &&
      [pod, service].some(
        (candidate) => candidate.start <= range.end && range.start <= candidate.end,
      )
    )
      throw new AppError(
        `The saved cluster ranges conflict with ${entry}. Resolve the overlapping route or network before retrying.`,
        409,
        "CLUSTER_RUNTIME_NETWORK",
      );
  }
}

export function clusterRuntimeSteps(
  ids: readonly ClusterRuntimeStep[] = CLUSTER_RUNTIME_STEPS,
): SetupStepProgress<ClusterRuntimeStep>[] {
  return ids.map((id) => ({
    id,
    status: "pending",
    message: null,
    startedAt: null,
    finishedAt: null,
  }));
}
