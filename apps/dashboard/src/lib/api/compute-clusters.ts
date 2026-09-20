import type {
  ComputeCluster,
  CreateComputeClusterInput,
  UpdateComputeClusterInput,
} from "@repo/contracts";
import { api } from "./client";
const path = (id: string) => `system/compute-clusters/${encodeURIComponent(id)}`;
export const computeClustersApi = {
  list: () => api.get<ComputeCluster[]>("system/compute-clusters"),
  get: (id: string) => api.get<ComputeCluster>(path(id)),
  create: (input: CreateComputeClusterInput) =>
    api.post<ComputeCluster>("system/compute-clusters", input),
  update: ({ clusterId, ...input }: UpdateComputeClusterInput) =>
    api.patch<ComputeCluster>(path(clusterId), input),
  remove: (cluster: Pick<ComputeCluster, "id" | "revision">) =>
    api.delete<{ removed: true }>(path(cluster.id), { body: { revision: cluster.revision } }),
};
