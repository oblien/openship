import { RoleSchema } from "./project-inputs";
import { Type, type Static } from "@sinclair/typebox";

export const ProjectRuntimeLogsInputSchema = Type.Object(
  {
    tail: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
    replica: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Refuse to attach a saved role selection to a newer release. */
    deploymentId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type ProjectRuntimeLogsInput = Static<typeof ProjectRuntimeLogsInputSchema>;

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const RuntimeRoleContainerSchema = Type.Object({
  replica: Type.Integer({ minimum: 1 }),
  containerId: nullableString,
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("starting"),
    Type.Literal("restarting"),
    Type.Literal("stopped"),
    Type.Literal("failed"),
    Type.Literal("missing"),
    Type.Literal("unknown"),
  ]),
  restartCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});
export const RuntimeRoleSchema = Type.Object({
  name: Type.String(),
  kind: Type.Union([
    Type.Literal("web"),
    Type.Literal("worker"),
    Type.Literal("scheduler"),
    Type.Null(),
  ]),
  replicas: Type.Integer({ minimum: 0 }),
  containers: Type.Array(RuntimeRoleContainerSchema),
});
export const ProjectRuntimeRolesSchema = Type.Object({
  deploymentId: nullableString,
  roles: Type.Array(RuntimeRoleSchema),
  error: nullableString,
});
export type RuntimeRoleContainer = Static<typeof RuntimeRoleContainerSchema>;
export type RuntimeRole = Static<typeof RuntimeRoleSchema>;
export type ProjectRuntimeRoles = Static<typeof ProjectRuntimeRolesSchema>;

export const RuntimeRoleConfigurationInputSchema = Type.Object({
  expectedDeploymentId: Type.String({ minLength: 1 }),
  expectedUpdatedAt: Type.String(),
  roles: Type.Array(RoleSchema, { maxItems: 20 }),
}, { additionalProperties: false });
export type RuntimeRoleConfigurationInput = Static<typeof RuntimeRoleConfigurationInputSchema>;
export const RuntimeRoleConfigurationSchema = Type.Object({
  supported: Type.Boolean(),
  reason: nullableString,
  deploymentId: nullableString,
  updatedAt: Type.String(),
  roles: Type.Array(RoleSchema),
});

export type RuntimeRoleConfiguration = Static<typeof RuntimeRoleConfigurationSchema>;
