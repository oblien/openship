import type {
  ClusterCapabilities,
  ServerCluster,
  ClusterVerification,
  CreateClusterInput,
  UpdateClusterInput,
} from "@repo/contracts";
import type { NetworkHostObservation } from "@repo/core";
import { api } from "./client";

const path = (id: string) => `system/clusters/${encodeURIComponent(id)}`;
export const serverClustersApi = {
  capabilities: () => api.get<ClusterCapabilities>("system/clusters/capabilities"),
  list: () => api.get<ServerCluster[]>("system/clusters"),
  get: (id: string) => api.get<ServerCluster>(path(id)),
  create: (input: CreateClusterInput) => api.post<ServerCluster>("system/clusters", input),
  update: ({ clusterId, ...input }: UpdateClusterInput) =>
    api.patch<ServerCluster>(path(clusterId), input),
  verify: (cluster: Pick<ServerCluster, "id" | "revision">) =>
    api.post<ClusterVerification>(path(cluster.id) + "/verify", { revision: cluster.revision }),
  remove: (cluster: Pick<ServerCluster, "id" | "revision">) =>
    api.delete<{ removed: true }>(path(cluster.id), { body: { revision: cluster.revision } }),
  inspect: (id: string) =>
    api.post<NetworkHostObservation>(
      `system/servers/${encodeURIComponent(id)}/network/inspect`,
      {},
      { timeout: 90_000 },
    ),
};
