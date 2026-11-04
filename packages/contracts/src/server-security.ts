import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";
import { JobRunSchema } from "./jobs";
const nullableString = Type.Union([Type.String(), Type.Null()]);
export const HostSecurityFindingSchema = Type.Object({
  id: Type.String(),
  revision: Type.Integer(),
  title: Type.String(),
  message: Type.String(),
  url: Type.String(),
  severity: Type.String(),
  packages: Type.Array(Type.String()),
  evidence: Type.Array(Type.String()),
  state: Type.Union([
    Type.Literal("affected"),
    Type.Literal("reboot_required"),
    Type.Literal("unknown"),
  ]),
  canPatch: Type.Boolean(),
  canReboot: Type.Boolean(),
});
export const ServerSecurityResultSchema = Type.Object({
  serverId: Type.String(),
  name: Type.String(),
  checksEnabled: Type.Boolean(),
  supported: Type.Boolean(),
  canManage: Type.Boolean(),
  checkedAt: nullableString,
  nextCheckAt: nullableString,
  error: nullableString,
  feedStale: Type.Boolean(),
  findings: Type.Array(HostSecurityFindingSchema),
  pending: Type.Boolean(),
});
export const HostPatchPlanSchema = Type.Object({
  operation: Type.Union([Type.Literal("install"), Type.Literal("reboot")]),
  token: Type.String(),
  expiresAt: Type.String(),
  advisoryId: Type.String(),
  title: Type.String(),
  changes: Type.Array(
    Type.Object({ package: Type.String(), previous: nullableString, version: Type.String() }),
  ),
  rebootRequired: Type.Boolean(),
});
export const ServerSecuritySchemas = {
  security: { action: "read", output: ServerSecurityResultSchema },
  checkSecurity: { action: "admin", output: ServerSecurityResultSchema },
  planSecurityPatch: {
    action: "admin",
    input: Type.Object(
      {
        advisoryId: Type.String({ minLength: 1, maxLength: 100 }),
        operation: Type.Optional(Type.Union([Type.Literal("install"), Type.Literal("reboot")])),
      },
      { additionalProperties: false },
    ),
    output: HostPatchPlanSchema,
  },
  applySecurityPatch: {
    action: "admin",
    input: Type.Object(
      { token: Type.String({ minLength: 1, maxLength: 65536 }) },
      { additionalProperties: false },
    ),
    output: Type.Object({ runId: Type.String() }),
  },
  securityRuns: { action: "admin", output: Type.Array(JobRunSchema) },
} as const satisfies Record<string, ResourceOperationSchema>;
export type ServerSecurityResult = Static<typeof ServerSecurityResultSchema>;
export type HostPatchPlan = Static<typeof HostPatchPlanSchema>;
