import { Type } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";

export const ProjectTransferResultSchema = Type.Object({
  ok: Type.Boolean(), projectId: Type.String(), imported: Type.Record(Type.String(), Type.Number()),
  cloudWorkspaceId: Type.Optional(Type.Null()), code: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()), warning: Type.Optional(Type.String()),
});
export const ProjectTransferSchemas = {
  transferToCloud: { action: "admin", output: ProjectTransferResultSchema },
  transferToSelfHosted: { action: "admin", output: ProjectTransferResultSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
