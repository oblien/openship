import { Type, type Static } from "@sinclair/typebox";
import { INFRASTRUCTURE_PROVIDERS, MAX_CLUSTER_MEMBERS } from "@repo/core";
import type { ResourceOperationSchema } from "./resource-operations";

const text = Type.String({ minLength: 1, maxLength: 200 });
const nullableText = Type.Union([Type.String(), Type.Null()]);
const providerId = Type.Union(INFRASTRUCTURE_PROVIDERS.map((p) => Type.Literal(p.id)));
export const ClusterIdInputSchema = Type.Object(
  { clusterId: text },
  { additionalProperties: false },
);
export const ClusterMemberConfigSchema = Type.Object(
  {
    serverId: text,
    providerId,
    privateIp: Type.String({ maxLength: 15 }),
    interfaceName: Type.Optional(Type.String({ maxLength: 15 })),
    networkRef: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);
export const ClusterConfigSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    location: Type.Optional(Type.String({ maxLength: 100 })),
    network: Type.Object(
      {
        mode: Type.Literal("native"),
        cidrs: Type.Array(Type.String({ minLength: 3, maxLength: 18 }), {
          minItems: 1,
          maxItems: 8,
        }),
        mtu: Type.Integer({ minimum: 1280, maximum: 9000 }),
        probePort: Type.Integer({ minimum: 1024, maximum: 65535 }),
      },
      { additionalProperties: false },
    ),
    members: Type.Array(ClusterMemberConfigSchema, { minItems: 2, maxItems: MAX_CLUSTER_MEMBERS }),
  },
  { additionalProperties: false },
);
export const CreateClusterInputSchema = Type.Object(
  {
    ...ClusterConfigSchema.properties,
    requestId: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" }),
  },
  { additionalProperties: false },
);
export const UpdateClusterInputSchema = Type.Object(
  {
    ...ClusterConfigSchema.properties,
    clusterId: text,
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type CreateClusterInput = Static<typeof CreateClusterInputSchema>;
export type UpdateClusterInput = Static<typeof UpdateClusterInputSchema>;

export const NetworkHostObservationSchema = Type.Object({
  hostIdentity: Type.String(),
  interfaces: Type.Array(
    Type.Object({
      name: Type.String(),
      mtu: Type.Integer(),
      up: Type.Boolean(),
      kind: nullableText,
      addresses: Type.Array(Type.Object({ address: Type.String(), prefixLength: Type.Integer() })),
    }),
  ),
});
const report = Type.Object({
  stage: Type.Union([
    Type.Literal("inspecting"),
    Type.Literal("probing"),
    Type.Literal("complete"),
  ]),
  hosts: Type.Array(
    Type.Object({
      serverId: text,
      ok: Type.Boolean(),
      interfaceName: nullableText,
      mtu: Type.Union([Type.Number(), Type.Null()]),
      code: nullableText,
      message: nullableText,
    }),
  ),
  peers: Type.Array(
    Type.Object({
      sourceServerId: text,
      targetServerId: text,
      tcp: Type.Boolean(),
      udp: Type.Boolean(),
      mtu: Type.Boolean(),
      latencyMs: Type.Union([Type.Number(), Type.Null()]),
      message: nullableText,
    }),
  ),
});
export const ClusterVerificationSchema = Type.Object({
  id: text,
  clusterId: text,
  revision: Type.Integer(),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("interrupted"),
  ]),
  report,
  error: nullableText,
  startedAt: Type.String(),
  finishedAt: nullableText,
  expiresAt: Type.String(),
});
export type ClusterVerification = Static<typeof ClusterVerificationSchema>;
export const ServerClusterSchema = Type.Object({
  id: text,
  name: text,
  location: nullableText,
  revision: Type.Integer(),
  network: Type.Object({
    ...ClusterConfigSchema.properties.network.properties,
    id: text,
    ownership: Type.Literal("external"),
    encryption: Type.Literal("external"),
  }),
  members: Type.Array(Type.Object({ ...ClusterMemberConfigSchema.properties, name: text })),
  verification: Type.Union([ClusterVerificationSchema, Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type ServerCluster = Static<typeof ServerClusterSchema>;
export const ClusterCapabilitiesSchema = Type.Object({
  available: Type.Boolean(),
  reason: nullableText,
  canManage: Type.Boolean(),
  maxMembers: Type.Integer(),
  modes: Type.Array(Type.Literal("native")),
  providers: Type.Array(
    Type.Object({
      id: providerId,
      name: text,
      network: text,
      mtu: Type.Integer(),
      docs: nullableText,
      maxMtu: Type.Optional(Type.Integer()),
      capabilities: Type.Object({
        adopt: Type.Boolean(),
        provision: Type.Boolean(),
        configureHost: Type.Boolean(),
      }),
    }),
  ),
});
export type ClusterCapabilities = Static<typeof ClusterCapabilitiesSchema>;
/** Cluster operations require fleet-wide server grants; member checks also run in the engine. */
export const ServerClusterCollectionSchemas = {
  clusterCapabilities: { action: "read", output: ClusterCapabilitiesSchema },
  listClusters: { action: "read", scope: "all", output: Type.Array(ServerClusterSchema) },
  getCluster: {
    action: "read",
    scope: "all",
    input: ClusterIdInputSchema,
    output: ServerClusterSchema,
  },
  createCluster: {
    action: "admin",
    scope: "all",
    input: CreateClusterInputSchema,
    output: ServerClusterSchema,
  },
  updateCluster: {
    action: "admin",
    scope: "all",
    input: UpdateClusterInputSchema,
    output: ServerClusterSchema,
  },
  verifyCluster: {
    action: "admin",
    scope: "all",
    input: Type.Object(
      { ...ClusterIdInputSchema.properties, revision: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    output: ClusterVerificationSchema,
  },
  removeCluster: {
    action: "admin",
    scope: "all",
    input: Type.Object(
      { ...ClusterIdInputSchema.properties, revision: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    output: Type.Object({ removed: Type.Literal(true) }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
