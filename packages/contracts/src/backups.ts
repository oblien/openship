import { Type, type Static } from "@sinclair/typebox";
import type { DeploymentEvent } from "./deployment-resources";
import type { ResourceOperationSchema, ResourceOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const object = Type.Record(Type.String(), Type.Unknown());
const nullableObject = Type.Union([object, Type.Null()]);
const optionalRetention = Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]));
const policyFields = {
  cronExpression: Type.Optional(nullableString), triggerOnPreDeploy: Type.Optional(Type.Boolean()),
  enableWebhook: Type.Optional(Type.Boolean()), retainCount: optionalRetention, retainDays: optionalRetention,
  payloadKind: Type.Optional(Type.String({ minLength: 1 })), payloadConfig: Type.Optional(object),
  preHook: Type.Optional(nullableString), postHook: Type.Optional(nullableString), enabled: Type.Optional(Type.Boolean()),
};
export const CreateBackupPolicySchema = Type.Object({
  ...policyFields, serviceId: Type.Optional(nullableString), destinationId: Type.String({ minLength: 1 }),
});
// Unknown fields cannot reach the retained service's explicit write allowlist.
export const UpdateBackupPolicySchema = Type.Object({
  ...policyFields, destinationId: Type.Optional(Type.String({ minLength: 1 })),
  rotateWebhookToken: Type.Optional(Type.Boolean()), hookTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const ListBackupRunsSchema = Type.Object({
  serviceId: Type.Optional(Type.String({ minLength: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});
export const ProtectBackupRunSchema = Type.Object({ until: Type.Optional(Type.String()), protected: Type.Optional(Type.Boolean()) });
export const PrepareBackupRestoreSchema = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("in_place"), Type.Literal("to_fork")])),
  forkMailServerId: Type.Optional(nullableString),
});
export const ApplyBackupRestoreSchema = Type.Object({ confirmationToken: Type.String({ minLength: 1, maxLength: 256 }) });

export const BackupPolicySchema = Type.Object({
  id: Type.String(), sourceKind: Type.String(), projectId: nullableString, serviceId: nullableString, mailServerId: nullableString,
  destinationId: Type.String(), enabled: Type.Boolean(), cronExpression: nullableString, triggerOnPreDeploy: Type.Boolean(),
  webhookToken: nullableString, webhookLastFiredAt: nullableString, retainCount: nullableNumber, retainDays: nullableNumber,
  payloadKind: Type.String(), payloadConfig: nullableObject, preHook: nullableString, postHook: nullableString,
  hookTimeoutSeconds: Type.Number(), compressionAlgo: Type.String(), encryptionAtRest: Type.Boolean(),
  createdBy: nullableString, deletedAt: nullableString, createdAt: Type.String(), updatedAt: Type.String(),
}, { additionalProperties: false });
export const BackupRunStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("preparing"), Type.Literal("snapshotting"), Type.Literal("uploading"), Type.Literal("verifying"),
  Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("server_error"),
]);
export const BackupRestoreStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("preparing"), Type.Literal("prepared"), Type.Literal("applying"),
  Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("server_error"),
]);
export const BackupRunSchema = Type.Object({
  id: Type.String(), batchId: nullableString, policyId: nullableString, destinationId: nullableString, sourceKind: Type.String(),
  projectId: nullableString, serviceId: nullableString, mailServerId: nullableString, organizationId: Type.String(), status: BackupRunStatusSchema,
  triggeredBy: Type.String(), triggeredByUserId: nullableString, clientIp: nullableString, startedAt: Type.String(), finishedAt: nullableString,
  executionStartedAt: nullableString, executionFinishedAt: nullableString, lastEventAt: Type.String(),
  objectKeyPrefix: nullableString, manifestKey: nullableString, bytesTransferred: nullableNumber,
  artifacts: Type.Union([Type.Array(Type.Unknown()), Type.Null()]), errorMessage: nullableString, hookLog: nullableString,
  retentionLockedUntil: nullableString, deletedAt: nullableString,
}, { additionalProperties: false });
export const BackupRestoreSchema = Type.Object({
  id: Type.String(), runId: Type.String(), destinationId: Type.String(), projectId: nullableString, serviceId: nullableString,
  organizationId: Type.String(), status: BackupRestoreStatusSchema, mode: Type.String(), forkServiceId: nullableString, forkMailServerId: nullableString,
  startedAt: Type.String(), finishedAt: nullableString, lastEventAt: Type.String(), bytesRestored: nullableNumber, errorMessage: nullableString,
  clientIp: nullableString, meta: nullableObject, cancelRequested: Type.Boolean(), cancelRequestedAt: nullableString, cancelledAt: nullableString,
  confirmationToken: nullableString,
}, { additionalProperties: false });
export type BackupPolicy = Static<typeof BackupPolicySchema>;
export type BackupRun = Static<typeof BackupRunSchema>;
export type BackupRestore = Static<typeof BackupRestoreSchema>;
export type CreateBackupPolicyInput = Static<typeof CreateBackupPolicySchema>;
export type UpdateBackupPolicyInput = Static<typeof UpdateBackupPolicySchema>;
export type PrepareBackupRestoreInput = Static<typeof PrepareBackupRestoreSchema>;

const ok = Type.Object({ ok: Type.Literal(true) });
export const BackupProjectSchemas = {
  listPolicies: { action: "write", output: Type.Array(BackupPolicySchema) },
  createPolicy: { action: "write", input: CreateBackupPolicySchema, output: BackupPolicySchema },
  listRuns: { action: "write", input: ListBackupRunsSchema, optionalInput: true, output: Type.Array(BackupRunSchema) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const BackupPolicySchemas = {
  updatePolicy: { action: "write", input: UpdateBackupPolicySchema, output: BackupPolicySchema },
  removePolicy: { action: "write", output: ok },
  run: { action: "write", output: Type.Object({ runId: Type.String() }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const BackupRunSchemas = {
  getRun: { action: "read", output: BackupRunSchema },
  protectRun: { action: "write", input: ProtectBackupRunSchema, optionalInput: true, output: Type.Object({ ok: Type.Literal(true), retentionLockedUntil: nullableString }) },
  prepareRestore: { action: "admin", input: PrepareBackupRestoreSchema, optionalInput: true, output: Type.Object({ restoreId: Type.String(), confirmationToken: Type.String() }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const BackupRestoreSchemas = {
  getRestore: { action: "read", output: BackupRestoreSchema },
  applyRestore: { action: "admin", input: ApplyBackupRestoreSchema, output: ok },
  cancelRestore: { action: "admin", output: Type.Object({ ok: Type.Literal(true), accepted: Type.Boolean(), status: BackupRestoreStatusSchema, destructive: Type.Boolean(), forced: Type.Boolean() }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface BackupOperations extends ResourceOperations<typeof BackupProjectSchemas>, ResourceOperations<typeof BackupPolicySchemas>, ResourceOperations<typeof BackupRunSchemas>, ResourceOperations<typeof BackupRestoreSchemas> {
  /** Existing snapshot/transition/progress/complete event envelopes. Reconnect reads durable state. */
  streamRun(id: string, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
  streamRestore(id: string, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
}
