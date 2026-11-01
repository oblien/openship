import { Type, type Static } from "@sinclair/typebox";
import type { ConnectivityCode } from "@repo/core";
import type { ResourceOperationSchema, ResourceOperations, ScopedOperations } from "./resource-operations";
import { ListBackupRunsSchema, BackupRunStatusSchema } from "./backups";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const mutableFields = {
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  endpoint: Type.Optional(nullableString), region: Type.Optional(nullableString), bucket: Type.Optional(nullableString), pathPrefix: Type.Optional(nullableString),
  sshHost: Type.Optional(nullableString), sshPort: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()])),
  sshUser: Type.Optional(nullableString), serverId: Type.Optional(nullableString),
  accessKeyId: Type.Optional(nullableString), secretAccessKey: Type.Optional(nullableString),
  sftpPassword: Type.Optional(nullableString), sftpPrivateKey: Type.Optional(nullableString), sftpKeyPassphrase: Type.Optional(nullableString),
  isDefault: Type.Optional(Type.Boolean()),
};
export const BackupDestinationKindSchema = Type.Union([
  Type.Literal("s3_compatible"), Type.Literal("sftp"), Type.Literal("openship_server"), Type.Literal("local"), Type.Literal("http_upload"),
]);
export const CreateBackupDestinationSchema = Type.Object({
  ...mutableFields, name: Type.String({ minLength: 1, maxLength: 80 }), kind: BackupDestinationKindSchema,
});
export const UpdateBackupDestinationSchema = Type.Object(mutableFields);
export const PreflightBackupDestinationSchema = Type.Object({
  ...mutableFields, kind: BackupDestinationKindSchema, id: Type.Optional(Type.String({ minLength: 1 })),
});
export type CreateBackupDestinationInput = Static<typeof CreateBackupDestinationSchema>;
export type UpdateBackupDestinationInput = Static<typeof UpdateBackupDestinationSchema>;
export type PreflightBackupDestinationInput = Static<typeof PreflightBackupDestinationSchema>;

export const BackupDestinationStatsSchema = Type.Object({
  storedBytes: Type.Number(),
  /** All non-deleted attempts, including failures and runs still in progress. */
  runCount: Type.Number(),
  lastRunAt: nullableString,
  // Optional for clients connected to an older server. Missing counts are
  // unknown, not zero and not interchangeable with the attempt count.
  savedCount: Type.Optional(Type.Number()),
  activeCount: Type.Optional(Type.Number()),
  failedCount: Type.Optional(Type.Number()),
  cancelledCount: Type.Optional(Type.Number()),
});
export type BackupDestinationStats = Static<typeof BackupDestinationStatsSchema>;

/** Public destination presentation contains credential-presence flags only. */
export const BackupDestinationSchema = Type.Object({
  id: Type.String(), name: Type.String(), kind: Type.String(),
  endpoint: nullableString, region: nullableString, bucket: nullableString, pathPrefix: nullableString,
  sshHost: nullableString, sshPort: nullableNumber, sshUser: nullableString, serverId: nullableString,
  hasAccessKeyId: Type.Boolean(), hasSecretAccessKey: Type.Boolean(), hasSftpPassword: Type.Boolean(), hasSftpPrivateKey: Type.Boolean(), hasSftpKeyPassphrase: Type.Boolean(),
  lastVerifiedAt: nullableString, lastVerifyError: nullableString, isDefault: Type.Boolean(), createdAt: Type.String(), updatedAt: Type.String(),
  stats: Type.Union([BackupDestinationStatsSchema, Type.Null()]),
}, { additionalProperties: false });
export type BackupDestination = Static<typeof BackupDestinationSchema>;
export const BackupDestinationUsageSchema = Type.Object({
  destination: BackupDestinationSchema,
  policies: Type.Array(Type.Object({
    policyId: Type.String(), sourceKind: Type.String(), projectId: nullableString, projectName: nullableString, projectSlug: nullableString,
    serviceId: nullableString, serviceName: nullableString, mailServerId: nullableString, payloadKind: Type.String(), cronExpression: nullableString, enabled: Type.Boolean(),
    lastRun: Type.Union([Type.Object({ id: Type.String(), status: Type.String(), startedAt: Type.String(), finishedAt: nullableString, bytesTransferred: nullableNumber }), Type.Null()]),
  })),
});
export type BackupDestinationUsage = Static<typeof BackupDestinationUsageSchema>;
export const ListBackupDestinationRunsSchema = Type.Pick(ListBackupRunsSchema, ["limit", "before"]);
export type ListBackupDestinationRunsInput = Static<typeof ListBackupDestinationRunsSchema>;
/** A history row has presentation metadata only; no credentials or restore commands. */
export const BackupDestinationRunSchema = Type.Object({
  id: Type.String(), destinationId: nullableString, destinationName: nullableString,
  projectId: nullableString, projectName: nullableString, serviceId: nullableString, serviceName: nullableString,
  mailServerId: nullableString, mailServerName: nullableString, sourceKind: Type.String(),
  status: BackupRunStatusSchema, triggeredBy: Type.String(), startedAt: Type.String(), finishedAt: nullableString,
  bytesTransferred: nullableNumber, errorMessage: nullableString,
  payloads: Type.Array(Type.Object({ kind: Type.String(), volumeTarget: nullableString, incremental: Type.Boolean() })),
});
export type BackupDestinationRun = Static<typeof BackupDestinationRunSchema>;
export const BackupDestinationHistorySchema = Type.Object({
  runs: Type.Array(BackupDestinationRunSchema), nextCursor: nullableString,
});
export type BackupDestinationHistory = Static<typeof BackupDestinationHistorySchema>;
export const BackupDestinationPreflightSchema = Type.Object({
  ok: Type.Boolean(), reason: Type.Optional(Type.String()), code: Type.Optional(Type.Unsafe<ConnectivityCode>(Type.String())),
});
export const BackupDestinationCollectionSchemas = {
  list: { action: "read", scope: "list", output: Type.Array(BackupDestinationSchema) },
  history: { action: "read", scope: "all", input: ListBackupDestinationRunsSchema, optionalInput: true, output: BackupDestinationHistorySchema },
  create: { action: "write", input: CreateBackupDestinationSchema, output: BackupDestinationSchema },
  preflightDraft: { action: "write", input: PreflightBackupDestinationSchema, output: BackupDestinationPreflightSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const BackupDestinationResourceSchemas = {
  get: { action: "read", output: BackupDestinationSchema },
  usage: { action: "read", output: BackupDestinationUsageSchema },
  runs: { action: "read", input: ListBackupDestinationRunsSchema, optionalInput: true, output: BackupDestinationHistorySchema },
  update: { action: "write", input: UpdateBackupDestinationSchema, output: BackupDestinationSchema },
  remove: { action: "admin", output: Type.Object({ ok: Type.Literal(true) }) },
  preflight: { action: "write", output: BackupDestinationPreflightSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface BackupDestinationOperations extends ScopedOperations<typeof BackupDestinationCollectionSchemas>, ResourceOperations<typeof BackupDestinationResourceSchemas> {}
