import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";
const nullable = Type.Union([Type.String(), Type.Null()]);
const id = Type.String({ minLength: 1, maxLength: 200 });
export const ClusterStorageConfigSchema = Type.Object(
  {
    replicas: Type.Integer({ minimum: 2, maximum: 3 }),
    disks: Type.Array(
      Type.Object(
        {
          serverId: id,
          path: Type.String({ minLength: 4, maxLength: 240 }),
          reservedGiB: Type.Integer({ minimum: 1, maximum: 65536 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: 100 },
    ),
    backupDestinationId: Type.Optional(id),
  },
  { additionalProperties: false },
);
const step = Type.Union(
  (["prerequisites", "install", "disks", "verify", "remove"] as const).map((v) => Type.Literal(v)),
);
export const ClusterStorageObservationSchema = Type.Object({
  observedAt: Type.String(),
  ready: Type.Boolean(),
  nodes: Type.Array(
    Type.Object({
      serverId: id,
      name: Type.String(),
      ready: Type.Boolean(),
      availableGiB: Type.Number(),
      scheduledGiB: Type.Number(),
      message: Type.String(),
    }),
  ),
  volumes: Type.Array(
    Type.Object({
      name: Type.String(),
      state: Type.String(),
      robustness: Type.String(),
      sizeGiB: Type.Number(),
      replicas: Type.Integer(),
    }),
  ),
});
export const ClusterStorageSchema = Type.Object({
  id,
  clusterId: id,
  runtimeId: id,
  config: ClusterStorageConfigSchema,
  status: Type.Union(
    (["setting_up", "ready", "failed", "interrupted", "removing", "removed"] as const).map((v) =>
      Type.Literal(v),
    ),
  ),
  intent: Type.Union([Type.Literal("setup"), Type.Literal("remove")]),
  sequence: Type.Integer(),
  generation: Type.Integer(),
  error: nullable,
  progress: Type.Object({
    steps: Type.Array(
      Type.Object({
        id: step,
        status: Type.Union(
          (["pending", "running", "completed", "failed", "skipped"] as const).map((v) =>
            Type.Literal(v),
          ),
        ),
        message: nullable,
        startedAt: nullable,
        finishedAt: nullable,
      }),
    ),
    logs: Type.Array(
      Type.Object({
        step,
        level: Type.Union((["info", "warn", "error"] as const).map((v) => Type.Literal(v))),
        timestamp: Type.String(),
        message: Type.String(),
      }),
    ),
  }),
  observation: Type.Union([ClusterStorageObservationSchema, Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type ClusterStorage = Static<typeof ClusterStorageSchema>;
const identity = { clusterId: id };
export const ClusterStorageCollectionSchemas = {
  getClusterStorage: {
    action: "read",
    scope: "all",
    input: Type.Object(
      { ...identity, observe: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    output: Type.Union([ClusterStorageSchema, Type.Null()]),
  },
  setupClusterStorage: {
    action: "admin",
    scope: "all",
    input: Type.Object(
      {
        ...identity,
        requestId: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" }),
        config: ClusterStorageConfigSchema,
      },
      { additionalProperties: false },
    ),
    output: ClusterStorageSchema,
  },
  retryClusterStorage: {
    action: "admin",
    scope: "all",
    input: Type.Object(
      { ...identity, sequence: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    output: ClusterStorageSchema,
  },
  configureClusterStorageBackup: {
    action: "admin",
    scope: "all",
    input: Type.Object(
      { ...identity, sequence: Type.Integer({ minimum: 1 }), destinationId: id },
      { additionalProperties: false },
    ),
    output: ClusterStorageSchema,
  },
  removeClusterStorage: {
    action: "admin",
    scope: "all",
    input: Type.Object(
      { ...identity, sequence: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    output: ClusterStorageSchema,
  },
} as const satisfies Record<string, ResourceOperationSchema>;

export const ClusterVolumeBackupSchema = Type.Object({
  name: Type.String(),
  volumeName: Type.String(),
  sizeGiB: Type.Number(),
  state: Type.String(),
  progress: Type.Number(),
  createdAt: nullable,
  error: nullable,
});
export const ClusterVolumeBackupScheduleSchema = Type.Object(
  {
    frequency: Type.Union(
      (["daily", "hourly", "manual"] as const).map((value) => Type.Literal(value)),
    ),
    retain: Type.Integer({ minimum: 1, maximum: 365 }),
  },
  { additionalProperties: false },
);
export const ClusterVolumeSchema = Type.Object({
  name: Type.String(),
  resourceVersion: Type.String(),
  sizeGiB: Type.Number(),
  phase: Type.String(),
  state: Type.String(),
  robustness: Type.String(),
  volumeName: nullable,
  message: nullable,
  desiredCopies: Type.Integer(),
  copies: Type.Array(
    Type.Object({
      name: Type.String(),
      serverName: Type.String(),
      state: Type.Union(
        (["ready", "rebuilding", "failed", "pending"] as const).map((value) => Type.Literal(value)),
      ),
      progress: Type.Union([Type.Number(), Type.Null()]),
    }),
  ),
  backupSchedule: ClusterVolumeBackupScheduleSchema,
  backups: Type.Array(ClusterVolumeBackupSchema),
});
const volumeName = Type.String({ pattern: "^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$" });
export const ProjectVolumeSchemas = {
  listClusterVolumes: { action: "read", output: Type.Array(ClusterVolumeSchema) },
  listClusterVolumeBackups: { action: "read", output: Type.Array(ClusterVolumeBackupSchema) },
  createClusterVolume: {
    action: "write",
    input: Type.Object(
      {
        name: volumeName,
        sizeGiB: Type.Integer({ minimum: 1, maximum: 16384 }),
        requestId: Type.String({ pattern: "^[a-zA-Z0-9_-]{16,64}$" }),
        restoreFrom: Type.Optional(
          Type.Object({ volumeName, backupName: id }, { additionalProperties: false }),
        ),
      },
      { additionalProperties: false },
    ),
    output: ClusterVolumeSchema,
  },
  resizeClusterVolume: {
    action: "write",
    input: Type.Object(
      {
        name: volumeName,
        resourceVersion: id,
        sizeGiB: Type.Integer({ minimum: 1, maximum: 16384 }),
      },
      { additionalProperties: false },
    ),
    output: ClusterVolumeSchema,
  },
  backupClusterVolume: {
    action: "write",
    input: Type.Object(
      { name: volumeName, requestId: Type.String({ pattern: "^[a-zA-Z0-9_-]{16,64}$" }) },
      { additionalProperties: false },
    ),
    output: ClusterVolumeSchema,
  },
  scheduleClusterVolumeBackups: {
    action: "write",
    input: Type.Object(
      { name: volumeName, resourceVersion: id, schedule: ClusterVolumeBackupScheduleSchema },
      { additionalProperties: false },
    ),
    output: ClusterVolumeSchema,
  },
  removeClusterVolumeBackup: {
    action: "write",
    input: Type.Object({ backupName: id, confirmName: id }, { additionalProperties: false }),
    output: Type.Object({ removed: Type.Boolean() }),
  },
  removeClusterVolume: {
    action: "write",
    input: Type.Object(
      {
        name: volumeName,
        resourceVersion: id,
        confirmName: volumeName,
        deleteData: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    output: Type.Object({ removed: Type.Boolean() }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
