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

export interface ClusterWorkloadStatus {
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
