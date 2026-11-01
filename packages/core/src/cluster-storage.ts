import { AppError } from "./errors";
import type { SetupLog, SetupStepProgress } from "./cluster-runtime";

export const MANAGED_STORAGE_CLASS = "openship-replicated";
export const CLUSTER_STORAGE_LEASE_MS = 90_000;
export const CLUSTER_STORAGE_STEPS = ["prerequisites", "install", "disks", "verify"] as const;
export type ClusterStorageStep = (typeof CLUSTER_STORAGE_STEPS)[number] | "remove";
export type ClusterStorageStatus =
  | "setting_up"
  | "ready"
  | "failed"
  | "interrupted"
  | "removing"
  | "removed";
export const clusterStorageRunning = (status: string) =>
  status === "setting_up" || status === "removing";
export interface ClusterStorageConfig {
  replicas: number;
  disks: Array<{ serverId: string; path: string; reservedGiB: number }>;
  backupDestinationId?: string;
}
export interface ClusterStorageProgress {
  steps: SetupStepProgress<ClusterStorageStep>[];
  logs: SetupLog<ClusterStorageStep>[];
}
export interface ClusterStorageObservation {
  observedAt: string;
  ready: boolean;
  nodes: Array<{
    serverId: string;
    name: string;
    ready: boolean;
    availableGiB: number;
    scheduledGiB: number;
    message: string;
  }>;
  volumes: Array<{
    name: string;
    state: string;
    robustness: string;
    sizeGiB: number;
    replicas: number;
  }>;
}
export function validateClusterStorage(config: ClusterStorageConfig) {
  const invalid = (message: string): never => {
    throw new AppError(message, 422, "CLUSTER_STORAGE_CONFIG");
  };
  if (!Number.isInteger(config.replicas) || config.replicas < 2 || config.replicas > 3)
    invalid("Choose two or three independent disk copies. Three is recommended.");
  if (
    config.disks.length < config.replicas ||
    config.disks.length > 100 ||
    new Set(config.disks.map((d) => d.serverId)).size !== config.disks.length
  )
    invalid("Select distinct storage servers, with at least one server for each disk copy.");
  for (const disk of config.disks) {
    if (
      !disk.serverId ||
      !/^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(disk.path) ||
      disk.path.length > 240 ||
      disk.path.split("/").some((p) => p === "." || p === "..") ||
      /^\/(?:proc|sys|dev|etc|boot|run|root|home)(?:\/|$)/.test(disk.path)
    )
      invalid(
        "Choose a dedicated absolute data directory, such as /var/lib/openship/storage. System directories and symlinks cannot be used.",
      );
    if (!Number.isInteger(disk.reservedGiB) || disk.reservedGiB < 1 || disk.reservedGiB > 65536)
      invalid("Reserve at least 1 GiB on each storage disk for the host.");
  }
  if (
    config.backupDestinationId !== undefined &&
    (!config.backupDestinationId || config.backupDestinationId.length > 128)
  )
    invalid("Choose an existing backup destination.");
}

export interface ClusterVolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}
export interface ClusterVolumeBackup {
  name: string;
  volumeName: string;
  sizeGiB: number;
  state: string;
  progress: number;
  createdAt: string | null;
  error: string | null;
}
export interface ClusterVolumeBackupSchedule {
  frequency: "daily" | "hourly" | "manual";
  retain: number;
}
export interface ClusterVolumeSnapshot {
  volumes: ClusterVolume[];
  backups: ClusterVolumeBackup[];
}
export interface ClusterVolume {
  name: string;
  resourceVersion: string;
  sizeGiB: number;
  phase: string;
  state: string;
  robustness: string;
  volumeName: string | null;
  message: string | null;
  desiredCopies: number;
  copies: Array<{
    name: string;
    serverName: string;
    state: "ready" | "rebuilding" | "failed" | "pending";
    progress: number | null;
  }>;
  backupSchedule: ClusterVolumeBackupSchedule;
  backups: ClusterVolumeBackup[];
}
export function validateClusterVolumeMounts(mounts: ClusterVolumeMount[]) {
  if (
    mounts.length > 16 ||
    new Set(mounts.map((m) => m.name)).size !== mounts.length ||
    new Set(mounts.map((m) => m.mountPath)).size !== mounts.length
  )
    throw new AppError(
      "Choose up to 16 distinct volumes and mount paths.",
      422,
      "CLUSTER_VOLUME_CONFIG",
    );
  for (const mount of mounts) {
    if (
      !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/.test(mount.name) ||
      mount.mountPath.length > 255 ||
      !/^\/[A-Za-z0-9_./-]+$/.test(mount.mountPath) ||
      mount.mountPath
        .slice(1)
        .split("/")
        .some((p) => !p || p === "." || p === "..") ||
      /^\/(?:proc|sys|dev|etc|run|bin|sbin|usr|lib|lib64)(?:\/|$)/.test(mount.mountPath)
    )
      throw new AppError(
        "Use a valid volume name and a dedicated application directory such as /app/uploads.",
        422,
        "CLUSTER_VOLUME_CONFIG",
      );
  }
  if (
    mounts.some((mount, index) =>
      mounts.some(
        (other, otherIndex) =>
          index !== otherIndex && other.mountPath.startsWith(`${mount.mountPath}/`),
      ),
    )
  )
    throw new AppError(
      "Choose separate folders for each volume. A volume cannot hide another volume's files.",
      422,
      "CLUSTER_VOLUME_CONFIG",
    );
}
