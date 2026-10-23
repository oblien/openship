import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);

/** One autoscale decision, kept for the "why did it scale" panel. */
export const AutoscaleEventSchema = Type.Object({
  id: Type.String(),
  createdAt: Type.String(),
  action: Type.Union([
    Type.Literal("scale_up"),
    Type.Literal("scale_down"),
    Type.Literal("hold"),
    Type.Literal("fail"),
    Type.Literal("suspend"),
  ]),
  fromReplicas: Type.Integer({ minimum: 0 }),
  toReplicas: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
  observedCpuPercent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  reason: Type.String(),
});

/** The saved intent. `suspendedAt` means a human touched replicas or the
 * autoscaler gave up; the policy then does nothing until the operator re-arms
 * it from the dashboard. */
export const ProjectAutoscalePolicySchema = Type.Object({
  projectId: Type.String(),
  enabled: Type.Boolean(),
  targetCpuPercent: Type.Integer({ minimum: 1, maximum: 100 }),
  minReplicas: Type.Integer({ minimum: 1, maximum: 100 }),
  maxReplicas: Type.Integer({ minimum: 1, maximum: 100 }),
  /** Replica step per tick (±N), so a spike ramps one bounded step at a time. */
  stepSize: Type.Integer({ minimum: 1, maximum: 10 }),
  /** Cooldown between applied steps, measured from the accepted change; the rollout must also be ready. */
  cooldownSeconds: Type.Integer({ minimum: 30 }),
  /** Tick gap multiplier after failures (exponential backoff ceiling). */
  suspendAfterFailures: Type.Integer({ minimum: 1, maximum: 10 }),
  suspendedAt: nullableString,
  suspendedReason: nullableString,
  lastDecision: Type.Union([AutoscaleEventSchema, Type.Null()]),
  updatedAt: Type.String(),
});

export type ProjectAutoscalePolicy = Static<typeof ProjectAutoscalePolicySchema>;
export type { AutoscaleEvent } from "@repo/core";

export const SetProjectAutoscalePolicySchema = Type.Object(
  {
    enabled: Type.Boolean(),
    targetCpuPercent: Type.Integer({ minimum: 1, maximum: 100 }),
    minReplicas: Type.Integer({ minimum: 1, maximum: 100 }),
    maxReplicas: Type.Integer({ minimum: 1, maximum: 100 }),
    stepSize: Type.Integer({ minimum: 1, maximum: 10 }),
    cooldownSeconds: Type.Integer({ minimum: 30, maximum: 3600 }),
    suspendAfterFailures: Type.Integer({ minimum: 1, maximum: 10 }),
    /** Operator confirms a suspended policy should resume ownership. */
    rearm: Type.Optional(Type.Literal(true)),
    expectedUpdatedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ProjectAutoscaleSchemas = {
  getAutoscalePolicy: { action: "read", output: ProjectAutoscalePolicySchema },
  setAutoscalePolicy: {
    action: "write",
    input: SetProjectAutoscalePolicySchema,
    output: ProjectAutoscalePolicySchema,
  },
  listAutoscaleEvents: {
    action: "read",
    output: Type.Object({ events: Type.Array(AutoscaleEventSchema) }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
