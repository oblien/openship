import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";
const nullableString = Type.Union([Type.String(), Type.Null()]);
export const ClusterWorkloadConfigSchema = Type.Object(
  {
    replicas: Type.Integer({ minimum: 1, maximum: 100 }),
    imageRepository: Type.Optional(Type.String({ minLength: 3, maxLength: 255 })),
    mounts: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 63 }),
            mountPath: Type.String({ minLength: 2, maxLength: 255 }),
            readOnly: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        { maxItems: 16 },
      ),
    ),
  },
  { additionalProperties: false },
);
export const ClusterWorkloadStatusSchema = Type.Object({
  desired: Type.Integer(),
  ready: Type.Integer(),
  available: Type.Integer(),
  updated: Type.Integer(),
  generation: Type.Integer(),
  observedGeneration: Type.Integer(),
  message: nullableString,
  pods: Type.Array(
    Type.Object({
      name: Type.String(),
      nodeName: nullableString,
      serverId: Type.Optional(nullableString),
      serverName: Type.Optional(nullableString),
      ready: Type.Boolean(),
      phase: Type.String(),
      restarts: Type.Integer(),
    }),
  ),
});
export const ClusterPodMetricSchema = Type.Object({
  name: Type.String(),
  cpuMillicores: Type.Union([Type.Number(), Type.Null()]),
  memoryMiB: Type.Union([Type.Number(), Type.Null()]),
});
export const ClusterWorkloadMetricsSchema = Type.Object({
  cpuMillicores: Type.Number(),
  memoryMiB: Type.Number(),
  pods: Type.Array(ClusterPodMetricSchema),
});
export const ProjectClusterSchema = Type.Object({
  clusterId: nullableString,
  serverId: Type.Optional(nullableString),
  config: Type.Union([ClusterWorkloadConfigSchema, Type.Null()]),
  requiresImageRepository: Type.Optional(Type.Boolean()),
  unavailableReason: Type.Optional(nullableString),
  updatedAt: Type.String(),
  activeDeploymentId: nullableString,
  activeClusterId: nullableString,
  activeReplicas: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  internalHost: nullableString,
  observedAt: Type.Optional(nullableString),
  metrics: Type.Optional(Type.Union([ClusterWorkloadMetricsSchema, Type.Null()])),
  status: Type.Union([ClusterWorkloadStatusSchema, Type.Null()]),
  error: nullableString,
});
export const SetProjectClusterSchema = Type.Object(
  {
    clusterId: nullableString,
    config: Type.Optional(ClusterWorkloadConfigSchema),
    expectedUpdatedAt: Type.String(),
    stateless: Type.Optional(Type.Literal(true)),
    acknowledgePlacement: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export const ProjectClusterSchemas = {
  getClusterWorkload: { action: "read", output: ProjectClusterSchema },
  setClusterTarget: {
    action: "write",
    input: SetProjectClusterSchema,
    output: ProjectClusterSchema,
  },
  scaleClusterWorkload: {
    action: "write",
    input: Type.Object(
      {
        replicas: Type.Integer({ minimum: 1, maximum: 100 }),
        expectedDeploymentId: Type.String(),
        expectedUpdatedAt: Type.String(),
      },
      { additionalProperties: false },
    ),
    output: Type.Object({ deploymentId: Type.String() }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export type ProjectCluster = Static<typeof ProjectClusterSchema>;
