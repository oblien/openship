import type {
  ComputeCluster,
  CreateComputeClusterInput,
  UpdateComputeClusterInput,
} from "@repo/contracts";
import { api } from "./client";
import type { ClusterRuntime } from "@repo/core";
const path = (id: string) => `system/compute-clusters/${encodeURIComponent(id)}`;
export const computeClustersApi = {
  runtime: (id: string) => api.get<ClusterRuntime | null>(path(id) + "/runtime"),
  setupRuntime: (id: string, revision: number, requestId: string) =>
    api.post<ClusterRuntime>(path(id) + "/runtime", { revision, requestId }),
  retryRuntime: (id: string, sequence: number) =>
    api.post<ClusterRuntime>(path(id) + "/runtime/retry", { sequence }),
  removeRuntime: (id: string, sequence: number) =>
    api.delete<ClusterRuntime>(path(id) + "/runtime", { body: { sequence } }),
  list: () => api.get<ComputeCluster[]>("system/compute-clusters"),
  get: (id: string) => api.get<ComputeCluster>(path(id)),
  create: (input: CreateComputeClusterInput) =>
    api.post<ComputeCluster>("system/compute-clusters", input),
  update: ({ clusterId, ...input }: UpdateComputeClusterInput) =>
    api.patch<ComputeCluster>(path(clusterId), input),
  remove: (cluster: Pick<ComputeCluster, "id" | "revision">) =>
    api.delete<{ removed: true }>(path(cluster.id), { body: { revision: cluster.revision } }),
};
