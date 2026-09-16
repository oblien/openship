import type { ServerCluster } from "@repo/contracts";
import {
  NETWORK_CHECK_TTL_MS,
  type NativeClusterConfig,
  type InfrastructureProviderId,
} from "@repo/core";

export type ClusterStatus =
  | "unchecked"
  | "checking"
  | "verified"
  | "attention"
  | "stale"
  | "interrupted";
export function clusterStatus(cluster: ServerCluster, now = Date.now()): ClusterStatus {
  const run = cluster.verification;
  if (!run || run.revision !== cluster.revision) return "unchecked";
  if (run.status === "running")
    return new Date(run.expiresAt).getTime() > now ? "checking" : "interrupted";
  if (run.status === "interrupted") return "interrupted";
  if (run.status !== "succeeded") return "attention";
  const finishedAt = new Date(run.finishedAt ?? "").getTime();
  return Number.isFinite(finishedAt) && now - finishedAt < NETWORK_CHECK_TTL_MS
    ? "verified"
    : "stale";
}

export function clusterConfig(cluster?: ServerCluster): NativeClusterConfig {
  return cluster
    ? {
        name: cluster.name,
        location: cluster.location ?? "",
        network: {
          mode: "native",
          cidrs: cluster.network.cidrs,
          mtu: cluster.network.mtu,
          probePort: cluster.network.probePort,
        },
        members: cluster.members.map(
          ({ serverId, providerId, privateIp, interfaceName, networkRef }) => ({
            serverId,
            providerId,
            privateIp,
            interfaceName,
            networkRef,
          }),
        ),
      }
    : {
        name: "",
        location: "",
        network: { mode: "native", cidrs: [], mtu: 1400, probePort: 51821 },
        members: [],
      };
}

export const PROVIDER_COLORS: Record<InfrastructureProviderId, string> = {
  "hetzner-dedicated": "bg-red-500/10 text-red-600 dark:text-red-400",
  "hetzner-cloud": "bg-red-500/10 text-red-600 dark:text-red-400",
  aws: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  azure: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  gcp: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  digitalocean: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  ovh: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  scaleway: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  custom: "bg-muted text-muted-foreground",
};
