import type {
  ClusterCapabilities,
  ServerCluster,
  ClusterVerification,
  CreateClusterInput,
  UpdateClusterInput,
  PlanManagedNetworkInput,
  ApplyManagedNetworkInput,
  DiscardManagedNetworkPreparationInput,
  DiscardManagedNetworkPlanInput,
  RemoveManagedNetworkPreparationMemberInput,
  RemoveManagedNetworkOperationMemberInput,
  ReviseManagedNetworkAccessInput,
} from "@repo/contracts";
import type {
  NetworkHostObservation,
  ManagedNetworkOperation,
  ManagedNetworkPreparation,
  ManagedNetworkPreparationSummary,
  ClusterSpeedTest,
} from "@repo/core";
import { api } from "./client";

const path = (id: string) => `system/networks/${encodeURIComponent(id)}`;
type RemoveSetupMemberResult = {
  preparation: ManagedNetworkPreparation;
  operation: ManagedNetworkOperation | null;
};
export const privateNetworksApi = {
  prepareManaged: (input: PlanManagedNetworkInput) =>
    api.post<ManagedNetworkPreparation>("system/networks/preparations", input),
  reviseConnections: ({ preparationId, ...input }: ReviseManagedNetworkAccessInput) =>
    api.patch<ManagedNetworkPreparation>(`system/networks/preparations/${encodeURIComponent(preparationId)}/connections`, input),
  managedPreparation: (id: string) =>
    api.get<ManagedNetworkPreparation>(`system/networks/preparations/${encodeURIComponent(id)}`),
  managedPreparations: () =>
    api.get<ManagedNetworkPreparationSummary[]>("system/networks/preparations"),
  discardPreparation: ({ preparationId, ...input }: DiscardManagedNetworkPreparationInput) =>
    api.delete<ManagedNetworkPreparation>(
      `system/networks/preparations/${encodeURIComponent(preparationId)}`,
      { body: input },
    ),
  discardPlan: ({ operationId, ...input }: DiscardManagedNetworkPlanInput) =>
    api.delete<ManagedNetworkOperation>(
      `system/networks/operations/${encodeURIComponent(operationId)}`,
      { body: input },
    ),
  removePreparationMember: ({
    preparationId,
    serverId,
    ...input
  }: RemoveManagedNetworkPreparationMemberInput) =>
    api.delete<RemoveSetupMemberResult>(
      `system/networks/preparations/${encodeURIComponent(preparationId)}/members/${encodeURIComponent(serverId)}`,
      { body: input },
    ),
  removeOperationMember: ({
    operationId,
    serverId,
    ...input
  }: RemoveManagedNetworkOperationMemberInput) =>
    api.delete<RemoveSetupMemberResult>(
      `system/networks/operations/${encodeURIComponent(operationId)}/members/${encodeURIComponent(serverId)}`,
      { body: input },
    ),
  planManaged: (input: PlanManagedNetworkInput) =>
    api.post<ManagedNetworkOperation>("system/networks/plans", input, { timeout: 240_000 }),
  managedOperation: (id: string) =>
    api.get<ManagedNetworkOperation>(`system/networks/operations/${encodeURIComponent(id)}`),
  applyManaged: ({ operationId, ...input }: ApplyManagedNetworkInput) =>
    api.post<ManagedNetworkOperation>(
      `system/networks/operations/${encodeURIComponent(operationId)}/apply`,
      input,
    ),
  capabilities: () => api.get<ClusterCapabilities>("system/networks/capabilities"),
  list: () => api.get<ServerCluster[]>("system/networks"),
  get: (id: string) => api.get<ServerCluster>(path(id)),
  create: (input: CreateClusterInput) => api.post<ServerCluster>("system/networks", input),
  update: ({ clusterId, ...input }: UpdateClusterInput) =>
    api.patch<ServerCluster>(path(clusterId), input),
  verify: (cluster: Pick<ServerCluster, "id" | "revision">, speedTest?: ClusterSpeedTest) =>
    api.post<ClusterVerification>(path(cluster.id) + "/verify", {
      revision: cluster.revision,
      ...(speedTest ? { speedTest } : {}),
    }),
  remove: (cluster: Pick<ServerCluster, "id" | "revision">) =>
    api.delete<{ removed: true }>(path(cluster.id), { body: { revision: cluster.revision } }),
  inspect: (id: string) =>
    api.post<NetworkHostObservation>(
      `system/servers/${encodeURIComponent(id)}/network/inspect`,
      {},
      { timeout: 90_000 },
    ),
};
