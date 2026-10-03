import { Type, type Static } from "@sinclair/typebox";
const CloudAllocationSchema = Type.Object({
  cpuCores: Type.Number({ minimum: 0.25, maximum: 1024 }),
  memoryMb: Type.Integer({ minimum: 128, maximum: 1048576 }),
  diskMb: Type.Integer({ minimum: 0, maximum: 1073741824 }),
});

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const resourceSize = Type.Union([CloudAllocationSchema, Type.Null()]);
export const ManagedServerActivityInputSchema = Type.Object({
  // TypeBox does not register string formats; keep this wire schema standalone.
  id: Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" }),
  controllerId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9:_-]+$" }),
  scope: Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9:_-]+$" }),
  projects: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9_-]+$" }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
  }, { additionalProperties: false }), { maxItems: 10000 }),
}, { additionalProperties: false });
export type ManagedServerActivityInput = Static<typeof ManagedServerActivityInputSchema>;
export const ManagedServerDeletionSchema = Type.Object({
  serverId: Type.String(), workspaceId: Type.String(), operationId: Type.String(), deletedAt: Type.String(),
}, { additionalProperties: false });
export type ManagedServerDeletion = Static<typeof ManagedServerDeletionSchema>;
/** Server-to-server credential handoff. Never returned by dashboard server reads. */
export const ManagedServerConnectionSchema = Type.Object({
  userId: Type.String({ minLength: 1 }),
  organizationId: Type.String({ minLength: 1 }),
  serverId: Type.String({ minLength: 1 }),
  ownerWorkspaceId: Type.String({ minLength: 1 }),
  workspaceId: Type.String({ minLength: 1 }),
  namespace: Type.String({ minLength: 1 }),
  image: Type.String({ minLength: 1 }),
  resources: CloudAllocationSchema,
  providerApiUrl: Type.String({ minLength: 1 }),
  state: Type.String(),
  token: Type.String({ minLength: 1 }),
  expiresAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type ManagedServerConnection = Static<typeof ManagedServerConnectionSchema>;
export const CloudWorkspaceSchema = Type.Object({
  id: Type.String(),
  serverId: Type.String(),
  name: Type.String(),
  planTierId: Type.String(),
  subscriptionStatus: Type.String(),
  projectCount: Type.Integer({ minimum: 0 }),
  state: Type.String(),
  resources: resourceSize,
  operation: Type.Union([
    Type.Object({
      id: Type.String(),
      kind: Type.String(),
      status: Type.String(),
      requestedAt: Type.String(),
      nextAttemptAt: nullableString,
      error: nullableString,
      logs: Type.Array(Type.String()),
    }),
    Type.Null(),
  ]),
  createdAt: Type.String(),
});
export const CloudWorkspaceUsageSchema = Type.Object({
  measuredAt: Type.String(),
  available: Type.Boolean(),
  reason: nullableString,
  cpuPercent: nullableNumber,
  memoryUsedMb: nullableNumber,
  memoryAvailableMb: nullableNumber,
  diskUsedMb: nullableNumber,
  diskAvailableMb: nullableNumber,
  diskTotalMb: nullableNumber,
  sharedDiskMb: nullableNumber,
  projects: Type.Array(
    Type.Object({ id: Type.String(), name: Type.String(), diskMb: nullableNumber }),
  ),
});
export const CloudWorkspaceResizePreviewSchema = Type.Object({
  revision: Type.String(),
  before: CloudAllocationSchema,
  after: CloudAllocationSchema,
  restartProjects: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
});
const operationKey = Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const name = Type.String({ minLength: 1, maxLength: 80, pattern: "\\S" });
export const CreateManagedServerInputSchema = Type.Object(
  {
    name,
  },
  { additionalProperties: false },
);
export const ResizeManagedServerInputSchema = Type.Object(
  {
    revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    confirmRestart: Type.Literal(true),
    idempotencyKey: operationKey,
  },
  { additionalProperties: false },
);
export const RemoveManagedServerInputSchema = Type.Object(
  { confirmDelete: Type.Literal(true), idempotencyKey: operationKey },
  { additionalProperties: false },
);
export type CloudWorkspaceSummary = Static<typeof CloudWorkspaceSchema>;
export type CloudWorkspaceUsage = Static<typeof CloudWorkspaceUsageSchema>;
export type CloudWorkspaceResizePreview = Static<typeof CloudWorkspaceResizePreviewSchema>;
export type CreateManagedServerInput = Static<typeof CreateManagedServerInputSchema>;
export type ResizeManagedServerInput = Static<typeof ResizeManagedServerInputSchema>;
export type RemoveManagedServerInput = Static<typeof RemoveManagedServerInputSchema>;
