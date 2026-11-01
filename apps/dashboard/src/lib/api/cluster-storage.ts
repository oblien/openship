import type {
  ClusterStorage,
  ClusterStorageCollectionSchemas,
  ProjectVolumeSchemas,
} from "@repo/contracts";
import type { ClusterVolume, ClusterVolumeBackup } from "@repo/core";
import type { Static } from "@sinclair/typebox";
import { api } from "./client";

const path = (id: string) => `system/compute-clusters/${encodeURIComponent(id)}/storage`;
export const clusterStorageApi = {
  get: (id: string, observe = false) =>
    api.get<ClusterStorage | null>(path(id) + (observe ? "?observe=true" : ""), {
      timeout: 45_000,
    }),
  setup: (
    id: string,
    input: Omit<
      Static<typeof ClusterStorageCollectionSchemas.setupClusterStorage.input>,
      "clusterId"
    >,
  ) => api.post<ClusterStorage>(path(id), input),
  retry: (id: string, sequence: number) =>
    api.post<ClusterStorage>(path(id) + "/retry", { sequence }),
  backup: (id: string, sequence: number, destinationId: string) =>
    api.patch<ClusterStorage>(path(id) + "/backup", { sequence, destinationId }),
  remove: (id: string, sequence: number) =>
    api.delete<ClusterStorage>(path(id), { body: { sequence } }),
};
const volumes = (id: string) => `projects/${encodeURIComponent(id)}/cluster/volumes`;
export const clusterVolumesApi = {
  list: (id: string) =>
    api.get<{ data: ClusterVolume[] }>(volumes(id)).then((result) => result.data),
  backups: (id: string) =>
    api
      .get<{ data: ClusterVolumeBackup[] }>(volumes(id) + "/backups")
      .then((result) => result.data),
  schedule: (
    id: string,
    input: Static<typeof ProjectVolumeSchemas.scheduleClusterVolumeBackups.input>,
  ) =>
    api
      .patch<{ data: ClusterVolume }>(volumes(id) + "/backups", input, { timeout: 100_000 })
      .then((result) => result.data),
  removeBackup: (
    id: string,
    input: Static<typeof ProjectVolumeSchemas.removeClusterVolumeBackup.input>,
  ) =>
    api
      .delete<{
        data: { removed: boolean };
      }>(volumes(id) + "/backups", { body: input, timeout: 100_000 })
      .then((result) => result.data),
  create: (id: string, input: Static<typeof ProjectVolumeSchemas.createClusterVolume.input>) =>
    api
      .post<{ data: ClusterVolume }>(volumes(id), input, { timeout: 100_000 })
      .then((result) => result.data),
  resize: (id: string, input: Static<typeof ProjectVolumeSchemas.resizeClusterVolume.input>) =>
    api
      .patch<{ data: ClusterVolume }>(volumes(id), input, { timeout: 100_000 })
      .then((result) => result.data),
  backup: (id: string, input: Static<typeof ProjectVolumeSchemas.backupClusterVolume.input>) =>
    api
      .post<{ data: ClusterVolume }>(volumes(id) + "/backup", input, { timeout: 100_000 })
      .then((result) => result.data),
  remove: (id: string, input: Static<typeof ProjectVolumeSchemas.removeClusterVolume.input>) =>
    api
      .delete<{ data: { removed: boolean } }>(volumes(id), { body: input, timeout: 100_000 })
      .then((result) => result.data),
};
