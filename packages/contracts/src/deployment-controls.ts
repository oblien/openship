import { Type, type Static } from "@sinclair/typebox";
import { ProjectPendingActionSchema } from "./project-controls";
import type { ResourceOperationSchema } from "./resource-operations";

export const RuntimeUsageSchema = Type.Object({
  cpuPercent: Type.Number(), memoryMb: Type.Number(), diskMb: Type.Number(), networkRxBytes: Type.Number(), networkTxBytes: Type.Number(),
}, { additionalProperties: false });
export type RuntimeUsage = Static<typeof RuntimeUsageSchema>;
export const DeploymentContainerInfoSchema = Type.Object({
  containerId: Type.String(), status: Type.Union((["queued", "building", "deploying", "running", "stopped", "failed", "cancelled", "missing"] as const).map(value => Type.Literal(value))),
  ip: Type.Optional(Type.String()), hostPort: Type.Optional(Type.Number()), hostPortByContainerPort: Type.Optional(Type.Record(Type.String(), Type.Number())),
  uptimeSeconds: Type.Optional(Type.Number()), usage: Type.Optional(RuntimeUsageSchema),
}, { additionalProperties: false });
export const DeploymentControlSchemas = {
  containerInfo: { action: "read", output: DeploymentContainerInfoSchema },
  containerUsage: { action: "read", output: RuntimeUsageSchema },
  pendingActions: { action: "read", output: Type.Object({ actions: Type.Array(ProjectPendingActionSchema) }) },
} as const satisfies Record<string, ResourceOperationSchema>;

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const DeploymentSslStatusInputSchema = Type.Object({ domain: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const DeploymentSslRenewInputSchema = Type.Object({
  domain: Type.String({ minLength: 1 }), includeWww: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const SslRenewOutcomeSchema = Type.Object({
  success: Type.Boolean(), domain: Type.String(), status: Type.String(),
  expiresAt: Type.Optional(Type.String()), issuer: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
});
export type SslRenewOutcome = Static<typeof SslRenewOutcomeSchema>;
export const DeploymentSslSchemas = {
  sslStatus: { action: "read", input: DeploymentSslStatusInputSchema, output: Type.Object({
    success: Type.Literal(true), domain: Type.String(), sslStatus: Type.String(), sslIssuer: nullableString, sslExpiresAt: nullableString, verified: Type.Boolean(),
  }) },
  renewSsl: { action: "write", input: DeploymentSslRenewInputSchema, output: Type.Intersect([
    SslRenewOutcomeSchema, Type.Object({ results: Type.Array(SslRenewOutcomeSchema) }),
  ]) },
} as const satisfies Record<string, ResourceOperationSchema>;
