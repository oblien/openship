import { AppError } from "./errors";
import { detectDbImage } from "./backup-image-detect";
import { validateClusterVolumeMounts, type ClusterVolumeMount } from "./cluster-storage";

/** Database replicas require an engine-specific workflow, not application copies. */
export function clusterWorkloadNeedsOperator(
  framework?: string | null,
  image?: string | null,
): boolean {
  return (
    !!detectDbImage(image) ||
    /^(postgres|postgresql|mysql|mariadb|redis|valkey|mongodb|clickhouse|elasticsearch)$/i.test(
      framework ?? "",
    )
  );
}

/** Shared admission and presentation rule; runtime capabilities stay authoritative. */
export function clusterWorkloadUnsupportedReason(input: {
  workload: string;
  volumes?: readonly string[];
  services?: readonly unknown[];
  framework?: string | null;
  image?: string;
  provider?: "k3s" | "swarm";
}): string | null {
  if (input.workload === "static") return "Static sites have no application process to replicate.";
  if (clusterWorkloadNeedsOperator(input.framework, input.image))
    return "Database replication uses database management. Add a managed database and review its data migration before switching connections.";
  if (input.services?.length && input.provider !== "swarm")
    return "This environment contains services. Per-service replication is not supported on this target yet; its existing services and data stay on their current server.";
  if (input.volumes?.length && input.provider !== "swarm")
    return "This application has persistent storage. Review a shared-storage migration before running multiple instances.";
  return null;
}

/** Persisted product intent. Kubernetes owns placement, health and reconciliation. */
export interface ClusterWorkloadConfig {
  replicas: number;
  /** Registry repository, without a tag; source builds publish immutable releases here. */
  imageRepository?: string;
  /** References to project-owned shared volumes, frozen with each release. */
  mounts?: ClusterVolumeMount[];
}

/** One autoscale decision, kept for the "why did it scale" panel. */
export type AutoscaleEvent = {
  id: string;
  createdAt: string;
  action: "scale_up" | "scale_down" | "hold" | "fail" | "suspend";
  fromReplicas: number;
  toReplicas: number | null;
  observedCpuPercent: number | null;
  reason: string;
};

/** A scale decision may only change the exact workload generation it observed. */
export interface ClusterScalePrecondition {
  uid: string;
  generation: number;
  replicas: number;
  operationId: string;
}

export interface ClusterWorkloadStatus {
  /** Runtime receipt for recoverable, conditional in-place scaling. */
  scaling?: {
    uid: string;
    operationId: string | null;
    cpuLimitMillicores: number | null;
  };
  desired: number;
  ready: number;
  available: number;
  updated: number;
  generation: number;
  observedGeneration: number;
  message: string | null;
  pods: Array<{
    name: string;
    nodeName: string | null;
    serverId?: string | null;
    serverName?: string | null;
    ready: boolean;
    phase: string;
    restarts: number;
  }>;
}

/** Observed per-instance resource usage — exactly what metrics.k8s.io reports,
 *  so the autoscaler and dashboards share one shape without guessing units.
 *  cpuMillicores is cumulative usage per instance window; memoryMiB is the
 *  working set. Usage is missing (null) while a pod is starting, so partial
 *  windows never read as zero consumption. */
export interface ClusterWorkloadMetrics {
  cpuMillicores: number;
  memoryMiB: number;
  pods: Array<{
    name: string;
    timestamp?: string;
    cpuMillicores: number | null;
    memoryMiB: number | null;
  }>;
}

export function validateClusterWorkload(config: ClusterWorkloadConfig): void {
  if (config.mounts) validateClusterVolumeMounts(config.mounts);
  if (!Number.isSafeInteger(config.replicas) || config.replicas < 1 || config.replicas > 100)
    throw new AppError(
      "Choose between 1 and 100 application instances.",
      422,
      "CLUSTER_CONFIG_INVALID",
    );
  if (
    config.imageRepository !== undefined &&
    (config.imageRepository.length > 255 ||
      !/^(?:[a-z0-9.-]+(?::[0-9]{1,5})?\/)[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(
        config.imageRepository,
      ))
  )
    throw new AppError(
      "Enter a registry repository without a tag, such as ghcr.io/team/api.",
      422,
      "CLUSTER_CONFIG_INVALID",
    );
}
