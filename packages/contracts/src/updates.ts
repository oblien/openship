import { Type, type Static } from "@sinclair/typebox";
import { CreateDeploymentResultSchema, isCreateDeploymentResult } from "./deployments";
import type { ResourceOperationSchema, ResourceOperations, ScopedOperations } from "./resource-operations";
const nullableString = Type.Union([Type.String(), Type.Null()]);
export const ProjectUpdateSchema = Type.Object({ projectId: Type.String(), name: Type.String(), slug: nullableString, isApp: Type.Boolean(), appTemplateId: nullableString, kind: Type.Union([Type.Literal("commit"), Type.Literal("release"), Type.Literal("image")]), behind: Type.Boolean(), latestInProgress: Type.Boolean(), currentLabel: nullableString, latestLabel: nullableString, detail: Type.Record(Type.String(), Type.Unknown()), checkedAt: Type.String() });
export const UpdateCollectionSchemas = {
  list: { action: "read", input: Type.Object({ behindOnly: Type.Optional(Type.Boolean()) }), optionalInput: true, output: Type.Array(ProjectUpdateSchema) },
  scan: { action: "write", output: Type.Object({ scanned: Type.Integer(), supported: Type.Integer() }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const UpdateProjectSchemas = {
  apply: { action: "write", output: CreateDeploymentResultSchema, outputCheck: isCreateDeploymentResult },
} as const satisfies Record<string, ResourceOperationSchema>;
export type ProjectUpdate = Static<typeof ProjectUpdateSchema>;
export interface UpdateOperations extends ScopedOperations<typeof UpdateCollectionSchemas>, ResourceOperations<typeof UpdateProjectSchemas> {}
