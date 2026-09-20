import { Type, type Static } from "@sinclair/typebox";
import { MAX_CLUSTER_MEMBERS } from "@repo/core";
import type { ResourceOperationSchema } from "./resource-operations";
import {
  ServerClusterSchema,
  ServerClusterCollectionSchemas,
  UpdateClusterInputSchema,
} from "./server-clusters";

/** The v1 cluster aggregate is now an independent private network. */
export const PrivateNetworkSchema = ServerClusterSchema;
export type PrivateNetwork = Static<typeof PrivateNetworkSchema>;
const id = Type.String({ minLength: 1, maxLength: 200 });
const revision = Type.Integer({ minimum: 1 });
export const ServerInfrastructureSchema = Type.Object({
  canBrowse: Type.Boolean(),
  networks: Type.Array(
    Type.Object({
      id,
      name: Type.String(),
      privateIp: Type.String(),
      mode: Type.Union([Type.Literal("native"), Type.Literal("wireguard")]),
    }),
  ),
  cluster: Type.Union([Type.Object({ id, name: Type.String() }), Type.Null()]),
});
export type ServerInfrastructure = Static<typeof ServerInfrastructureSchema>;
export const NetworkIdInputSchema = Type.Object({ networkId: id }, { additionalProperties: false });
export const UpdateNetworkInputSchema = Type.Object(
  {
    ...Type.Omit(UpdateClusterInputSchema, ["clusterId"]).properties,
    networkId: id,
  },
  { additionalProperties: false },
);
export const NetworkCollectionSchemas = {
  networkCapabilities: ServerClusterCollectionSchemas.clusterCapabilities,
  listNetworks: ServerClusterCollectionSchemas.listClusters,
  getNetwork: { ...ServerClusterCollectionSchemas.getCluster, input: NetworkIdInputSchema },
  createNetwork: ServerClusterCollectionSchemas.createCluster,
  updateNetwork: {
    ...ServerClusterCollectionSchemas.updateCluster,
    input: UpdateNetworkInputSchema,
  },
  verifyNetwork: {
    ...ServerClusterCollectionSchemas.verifyCluster,
    input: Type.Object(
      {
        ...Type.Omit(ServerClusterCollectionSchemas.verifyCluster.input, ["clusterId"]).properties,
        networkId: id,
      },
      { additionalProperties: false },
    ),
  },
  removeNetwork: {
    ...ServerClusterCollectionSchemas.removeCluster,
    input: Type.Object({ networkId: id, revision }, { additionalProperties: false }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;

export const ComputeClusterConfigSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    location: Type.Optional(Type.String({ maxLength: 100 })),
    networkId: id,
    serverIds: Type.Array(id, { minItems: 1, maxItems: MAX_CLUSTER_MEMBERS, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export const CreateComputeClusterInputSchema = Type.Object(
  {
    ...ComputeClusterConfigSchema.properties,
    requestId: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" }),
  },
  { additionalProperties: false },
);
export const UpdateComputeClusterInputSchema = Type.Object(
  {
    ...ComputeClusterConfigSchema.properties,
    clusterId: id,
    revision,
  },
  { additionalProperties: false },
);
export const ComputeClusterSchema = Type.Object({
  id,
  name: Type.String(),
  location: Type.Union([Type.String(), Type.Null()]),
  revision,
  networkId: id,
  serverIds: Type.Array(id),
  network: PrivateNetworkSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type ComputeCluster = Static<typeof ComputeClusterSchema>;
export type CreateComputeClusterInput = Static<typeof CreateComputeClusterInputSchema>;
export type UpdateComputeClusterInput = Static<typeof UpdateComputeClusterInputSchema>;
export const ComputeClusterCollectionSchemas = {
  listComputeClusters: { action: "read", scope: "all", output: Type.Array(ComputeClusterSchema) },
  getComputeCluster: {
    action: "read",
    scope: "all",
    input: Type.Object({ clusterId: id }, { additionalProperties: false }),
    output: ComputeClusterSchema,
  },
  createComputeCluster: {
    action: "admin",
    scope: "all",
    input: CreateComputeClusterInputSchema,
    output: ComputeClusterSchema,
  },
  updateComputeCluster: {
    action: "admin",
    scope: "all",
    input: UpdateComputeClusterInputSchema,
    output: ComputeClusterSchema,
  },
  removeComputeCluster: {
    action: "admin",
    scope: "all",
    input: Type.Object({ clusterId: id, revision }, { additionalProperties: false }),
    output: Type.Object({ removed: Type.Literal(true) }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
