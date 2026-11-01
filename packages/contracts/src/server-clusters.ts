import { Type, type Static } from "@sinclair/typebox";
import {
  INFRASTRUCTURE_PROVIDERS,
  MAX_CLUSTER_MEMBERS,
  MANAGED_NETWORK_PREPARATION_STEPS,
  MANAGED_NETWORK_APPLY_STEPS,
} from "@repo/core";
import type { ResourceOperationSchema } from "./resource-operations";

const text = Type.String({ minLength: 1, maxLength: 200 });
const nullableText = Type.Union([Type.String(), Type.Null()]);
const providerId = Type.Union(INFRASTRUCTURE_PROVIDERS.map((p) => Type.Literal(p.id)));
export const NetworkAccessPolicySchema = Type.Object(
  {
    version: Type.Literal(1),
    rules: Type.Array(
      Type.Object({ sourceServerId: text, targetServerId: text }, { additionalProperties: false }),
      {
        maxItems: MAX_CLUSTER_MEMBERS * (MAX_CLUSTER_MEMBERS - 1),
        uniqueItems: true,
      },
    ),
  },
  { additionalProperties: false },
);
export const NativeNetworkSourceSchema = Type.Object(
  { providerId, networkRef: Type.Optional(Type.String({ maxLength: 200 })) },
  { additionalProperties: false },
);
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
        source: Type.Optional(NativeNetworkSourceSchema),
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
    Type.Literal("handshakes"),
    Type.Literal("probing"),
    Type.Literal("throughput"),
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
      reachable: Type.Optional(Type.Boolean()),
      expectedAccess: Type.Optional(Type.Union([Type.Literal("allow"), Type.Literal("deny")])),
      policyPassed: Type.Optional(Type.Boolean()),
      latencyMs: Type.Union([Type.Number(), Type.Null()]),
      latencyKind: Type.Optional(Type.Literal("rtt")),
      packetLossPercent: Type.Optional(
        Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
      ),
      jitterMs: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
      message: nullableText,
    }),
  ),
  handshakes: Type.Optional(
    Type.Array(
      Type.Object({
        sourceServerId: text,
        targetServerId: text,
        endpoint: Type.String(),
        port: Type.Integer({ minimum: 1024, maximum: 65535 }),
        ok: Type.Boolean(),
        lastHandshakeAt: nullableText,
      }),
    ),
  ),
  speedTest: Type.Optional(
    Type.Object({ sourceServerId: text, targetServerId: text }, { additionalProperties: false }),
  ),
  throughput: Type.Optional(
    Type.Array(
      Type.Object({
        sourceServerId: text,
        targetServerId: text,
        megabitsPerSecond: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
        bytes: Type.Integer({ minimum: 0 }),
        durationMs: Type.Number({ minimum: 0 }),
        message: nullableText,
      }),
    ),
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

const managedMember = Type.Object(
  {
    ...ClusterMemberConfigSchema.properties,
    endpoint: Type.String({ minLength: 7, maxLength: 15 }),
    listenPort: Type.Integer({ minimum: 1024, maximum: 65535 }),
    publicKey: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9+/]{43}=$" })),
  },
  { additionalProperties: false },
);
export const WireGuardClusterConfigSchema = Type.Object(
  {
    name: ClusterConfigSchema.properties.name,
    location: ClusterConfigSchema.properties.location,
    network: Type.Object(
      {
        mode: Type.Literal("wireguard"),
        cidrs: Type.Array(Type.String(), { minItems: 1, maxItems: 1 }),
        mtu: Type.Integer({ minimum: 1280, maximum: 9000 }),
        probePort: Type.Integer({ minimum: 1024, maximum: 65535 }),
        managedId: Type.String({ pattern: "^[a-f0-9]{32}$" }),
        interfaceName: Type.String({ pattern: "^oswg[a-f0-9]{10}$" }),
        access: Type.Optional(NetworkAccessPolicySchema),
      },
      { additionalProperties: false },
    ),
    members: Type.Array(managedMember, { minItems: 2, maxItems: MAX_CLUSTER_MEMBERS }),
  },
  { additionalProperties: false },
);

export const PlanManagedNetworkInputSchema = Type.Object(
  {
    requestId: Type.String({
      pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
    }),
    clusterId: Type.Optional(text),
    revision: Type.Optional(Type.Integer({ minimum: 1 })),
    intent: Type.Optional(Type.Union([Type.Literal("configure"), Type.Literal("remove")])),
    name: ClusterConfigSchema.properties.name,
    location: ClusterConfigSchema.properties.location,
    cidr: Type.Optional(Type.String({ maxLength: 18 })),
    mtu: Type.Optional(Type.Integer({ minimum: 1280, maximum: 1420 })),
    probePort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
    rotateKeys: Type.Optional(Type.Boolean()),
    access: Type.Optional(NetworkAccessPolicySchema),
    members: Type.Array(
      Type.Object(
        {
          serverId: text,
          providerId,
          endpoint: Type.Optional(Type.String({ minLength: 7, maxLength: 15 })),
          listenPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: MAX_CLUSTER_MEMBERS },
    ),
  },
  { additionalProperties: false },
);
export type PlanManagedNetworkInput = Static<typeof PlanManagedNetworkInputSchema>;

const setupStepId = Type.Union(
  [
    ...new Set([
      ...MANAGED_NETWORK_PREPARATION_STEPS,
      ...MANAGED_NETWORK_APPLY_STEPS,
      "rollback",
    ] as const),
  ].map((id) => Type.Literal(id)),
);
export const ManagedNetworkStepSchema = Type.Object(
  {
    id: setupStepId,
    status: Type.Union(
      (["pending", "running", "completed", "failed", "skipped"] as const).map((value) =>
        Type.Literal(value),
      ),
    ),
    message: nullableText,
    startedAt: nullableText,
    finishedAt: nullableText,
  },
  { additionalProperties: false },
);
const setupLogs = Type.Array(
  Type.Object(
    {
      timestamp: Type.String(),
      step: setupStepId,
      level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
      message: Type.String(),
    },
    { additionalProperties: false },
  ),
);
export const ManagedNetworkPreparationSchema = Type.Object(
  {
    id: text,
    sequence: Type.Integer({ minimum: 1 }),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("preparing"),
      Type.Literal("ready"),
      Type.Literal("failed"),
      Type.Literal("interrupted"),
      Type.Literal("cancelled"),
    ]),
    input: PlanManagedNetworkInputSchema,
    hosts: Type.Array(
      Type.Object(
        {
          serverId: text,
          name: text,
          address: Type.String(),
          hostIdentity: nullableText,
          transport: Type.Optional(
            Type.Object(
              {
                endpoint: Type.String({ minLength: 7, maxLength: 15 }),
                listenPort: Type.Integer({ minimum: 1024, maximum: 65535 }),
              },
              { additionalProperties: false },
            ),
          ),
          steps: Type.Array(ManagedNetworkStepSchema),
          logs: setupLogs,
        },
        { additionalProperties: false },
      ),
    ),
    operationId: nullableText,
    replacementPreparationId: nullableText,
    cleanupOperationId: nullableText,
    error: nullableText,
    generation: Type.Integer(),
    leaseExpiresAt: nullableText,
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export const ManagedNetworkPreparationSummarySchema = Type.Object(
  {
    id: text,
    sequence: Type.Integer({ minimum: 1 }),
    name: text,
    status: ManagedNetworkPreparationSchema.properties.status,
    serverCount: Type.Integer(),
    operationId: nullableText,
    error: nullableText,
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

const managedHost = Type.Object(
  {
    serverId: text,
    name: text,
    hostIdentity: text,
    fingerprint: Type.String(),
    configHash: nullableText,
    endpoint: Type.String(),
    listenPort: Type.Integer(),
    privateIp: Type.String(),
    packages: Type.Array(Type.String()),
    firewall: Type.Union([
      Type.Literal("none"),
      Type.Literal("iptables"),
      Type.Literal("nftables"),
    ]),
    action: Type.Union([Type.Literal("configure"), Type.Literal("remove")]),
  },
  { additionalProperties: false },
);
export const ManagedNetworkPlanSchema = Type.Object(
  {
    version: Type.Literal(1),
    clusterId: text,
    managedId: text,
    interfaceName: text,
    baseRevision: Type.Union([Type.Integer(), Type.Null()]),
    intent: Type.Union([Type.Literal("configure"), Type.Literal("remove")]),
    rotateKeys: Type.Boolean(),
    config: WireGuardClusterConfigSchema,
    previous: Type.Union([ClusterConfigSchema, WireGuardClusterConfigSchema, Type.Null()]),
    hosts: Type.Array(managedHost),
    createdAt: Type.String(),
    expiresAt: Type.String(),
    preparationId: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const ManagedNetworkOperationSchema = Type.Object(
  {
    id: text,
    sequence: Type.Integer({ minimum: 1 }),
    clusterId: text,
    status: Type.Union(
      (
        [
          "planned",
          "applying",
          "verifying",
          "committing",
          "rolling_back",
          "succeeded",
          "rolled_back",
          "interrupted",
          "needs_attention",
          "cancelled",
        ] as const
      ).map((value) => Type.Literal(value)),
    ),
    planHash: Type.String(),
    plan: ManagedNetworkPlanSchema,
    replacementPreparationId: nullableText,
    hosts: Type.Array(
      Type.Object(
        {
          serverId: text,
          stage: Type.Union(
            (
              [
                "pending",
                "prepared",
                "applied",
                "verified",
                "committed",
                "rolled_back",
                "failed",
              ] as const
            ).map((value) => Type.Literal(value)),
          ),
          publicKey: nullableText,
          error: nullableText,
          steps: Type.Optional(Type.Array(ManagedNetworkStepSchema)),
          logs: Type.Optional(setupLogs),
        },
        { additionalProperties: false },
      ),
    ),
    report: Type.Union([report, Type.Null()]),
    error: nullableText,
    generation: Type.Integer(),
    leaseExpiresAt: nullableText,
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export const ManagedNetworkOperationInputSchema = Type.Object(
  { operationId: text },
  { additionalProperties: false },
);
export const ApplyManagedNetworkInputSchema = Type.Object(
  {
    operationId: text,
    planHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    action: Type.Union([Type.Literal("apply"), Type.Literal("resume"), Type.Literal("rollback")]),
  },
  { additionalProperties: false },
);
export type ApplyManagedNetworkInput = Static<typeof ApplyManagedNetworkInputSchema>;

export const DiscardManagedNetworkPreparationInputSchema = Type.Object(
  { preparationId: text, sequence: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type DiscardManagedNetworkPreparationInput = Static<
  typeof DiscardManagedNetworkPreparationInputSchema
>;
export const DiscardManagedNetworkPlanInputSchema = Type.Object(
  { operationId: text, planHash: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);
export type DiscardManagedNetworkPlanInput = Static<typeof DiscardManagedNetworkPlanInputSchema>;

export const ReviseManagedNetworkAccessInputSchema = Type.Object(
  {
    preparationId: text,
    sequence: Type.Integer({ minimum: 1 }),
    requestId: PlanManagedNetworkInputSchema.properties.requestId,
    access: NetworkAccessPolicySchema,
  },
  { additionalProperties: false },
);
export type ReviseManagedNetworkAccessInput = Static<typeof ReviseManagedNetworkAccessInputSchema>;

const removeSetupMember = {
  serverId: text,
  sequence: Type.Integer({ minimum: 1 }),
  requestId: PlanManagedNetworkInputSchema.properties.requestId,
};
export const RemoveManagedNetworkPreparationMemberInputSchema = Type.Object(
  { preparationId: text, ...removeSetupMember },
  { additionalProperties: false },
);
export type RemoveManagedNetworkPreparationMemberInput = Static<
  typeof RemoveManagedNetworkPreparationMemberInputSchema
>;
export const RemoveManagedNetworkOperationMemberInputSchema = Type.Object(
  {
    operationId: text,
    planHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    ...removeSetupMember,
  },
  { additionalProperties: false },
);
export type RemoveManagedNetworkOperationMemberInput = Static<
  typeof RemoveManagedNetworkOperationMemberInputSchema
>;
const removeSetupMemberResult = Type.Object(
  {
    preparation: ManagedNetworkPreparationSchema,
    operation: Type.Union([ManagedNetworkOperationSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const ServerClusterSchema = Type.Object({
  id: text,
  name: text,
  location: nullableText,
  revision: Type.Integer(),
  network: Type.Union([
    Type.Object({
      ...ClusterConfigSchema.properties.network.properties,
      id: text,
      ownership: Type.Literal("external"),
      encryption: Type.Literal("external"),
    }),
    Type.Object({
      ...WireGuardClusterConfigSchema.properties.network.properties,
      id: text,
      ownership: Type.Literal("openship"),
      encryption: Type.Literal("wireguard"),
    }),
  ]),
  members: Type.Array(
    Type.Object({
      ...ClusterMemberConfigSchema.properties,
      name: text,
      endpoint: Type.Optional(Type.String()),
      listenPort: Type.Optional(Type.Integer()),
      publicKey: Type.Optional(Type.String()),
    }),
  ),
  verification: Type.Union([ClusterVerificationSchema, Type.Null()]),
  operation: Type.Optional(Type.Union([ManagedNetworkOperationSchema, Type.Null()])),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type ServerCluster = Static<typeof ServerClusterSchema>;
export const ClusterCapabilitiesSchema = Type.Object({
  available: Type.Boolean(),
  reason: nullableText,
  canManage: Type.Boolean(),
  maxMembers: Type.Integer(),
  modes: Type.Array(Type.Union([Type.Literal("native"), Type.Literal("wireguard")])),
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
  prepareManagedNetwork: {
    action: "admin",
    scope: "all",
    input: PlanManagedNetworkInputSchema,
    output: ManagedNetworkPreparationSchema,
  },
  reviseManagedNetworkAccess: {
    action: "admin",
    scope: "all",
    input: ReviseManagedNetworkAccessInputSchema,
    output: ManagedNetworkPreparationSchema,
  },
  getManagedNetworkPreparation: {
    action: "read",
    scope: "all",
    input: Type.Object({ preparationId: text }, { additionalProperties: false }),
    output: ManagedNetworkPreparationSchema,
  },
  discardManagedNetworkPreparation: {
    action: "admin",
    scope: "all",
    input: DiscardManagedNetworkPreparationInputSchema,
    output: ManagedNetworkPreparationSchema,
  },
  removeManagedNetworkPreparationMember: {
    action: "admin",
    scope: "all",
    input: RemoveManagedNetworkPreparationMemberInputSchema,
    output: removeSetupMemberResult,
  },
  removeManagedNetworkOperationMember: {
    action: "admin",
    scope: "all",
    input: RemoveManagedNetworkOperationMemberInputSchema,
    output: removeSetupMemberResult,
  },
  listManagedNetworkPreparations: {
    action: "read",
    scope: "all",
    output: Type.Array(ManagedNetworkPreparationSummarySchema),
  },
  planManagedNetwork: {
    action: "admin",
    scope: "all",
    input: PlanManagedNetworkInputSchema,
    output: ManagedNetworkOperationSchema,
  },
  getManagedNetworkOperation: {
    action: "read",
    scope: "all",
    input: ManagedNetworkOperationInputSchema,
    output: ManagedNetworkOperationSchema,
  },
  applyManagedNetwork: {
    action: "admin",
    scope: "all",
    input: ApplyManagedNetworkInputSchema,
    output: ManagedNetworkOperationSchema,
  },
  discardManagedNetworkPlan: {
    action: "admin",
    scope: "all",
    input: DiscardManagedNetworkPlanInputSchema,
    output: ManagedNetworkOperationSchema,
  },
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
      {
        ...ClusterIdInputSchema.properties,
        revision: Type.Integer({ minimum: 1 }),
        speedTest: Type.Optional(
          Type.Object(
            {
              sourceServerId: text,
              targetServerId: text,
            },
            { additionalProperties: false },
          ),
        ),
      },
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
