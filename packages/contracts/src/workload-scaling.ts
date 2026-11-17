import { Type, type Static } from "@sinclair/typebox";
import { MAX_WORKLOAD_REPLICAS } from "@repo/core";
import { ClusterWorkloadStatusSchema } from "./project-cluster";
import type { ResourceOperationSchema } from "./resource-operations";

export const WorkloadReplicaCountSchema = Type.Integer({
  minimum: 1,
  maximum: MAX_WORKLOAD_REPLICAS,
});
export const WorkloadScalingInputSchema = Type.Object(
  {
    serviceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export const WorkloadScalingSchema = Type.Object({
  replicas: WorkloadReplicaCountSchema,
  activeReplicas: WorkloadReplicaCountSchema,
  activeDeploymentId: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.String(),
  serviceId: Type.Union([Type.String(), Type.Null()]),
  unavailableReason: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([ClusterWorkloadStatusSchema, Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});
export const WorkloadScalingSchemas = {
  getWorkloadScaling: {
    action: "read",
    input: WorkloadScalingInputSchema,
    output: WorkloadScalingSchema,
  },
  scaleWorkload: {
    action: "write",
    input: Type.Object(
      {
        ...WorkloadScalingInputSchema.properties,
        replicas: WorkloadReplicaCountSchema,
        expectedDeploymentId: Type.String({ minLength: 1 }),
        expectedUpdatedAt: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    output: Type.Object({ deploymentId: Type.String() }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export type WorkloadScaling = Static<typeof WorkloadScalingSchema>;
