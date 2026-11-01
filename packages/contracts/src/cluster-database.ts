import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";

const nullable = Type.Union([Type.String(), Type.Null()]);
const stepId = Type.Union(
  (
    [
      "connect",
      "operators",
      "storage",
      "database",
      "verify",
      "remove",
      "backup",
      "restore",
    ] as const
  ).map((id) => Type.Literal(id)),
);
export const ClusterDatabaseProgressSchema = Type.Object({
  steps: Type.Array(
    Type.Object({
      id: stepId,
      status: Type.Union(
        (["pending", "running", "completed", "failed", "skipped"] as const).map((value) =>
          Type.Literal(value),
        ),
      ),
      message: nullable,
      startedAt: nullable,
      finishedAt: nullable,
    }),
  ),
  logs: Type.Array(
    Type.Object({
      step: stepId,
      level: Type.Union((["info", "warn", "error"] as const).map((value) => Type.Literal(value))),
      timestamp: Type.String(),
      message: Type.String(),
    }),
  ),
});
export const ClusterDatabaseObservationSchema = Type.Object({
  ready: Type.Boolean(),
  message: Type.String(),
  observedAt: Type.String(),
  primary: nullable,
  pods: Type.Array(
    Type.Object({
      name: Type.String(),
      serverId: nullable,
      serverName: nullable,
      nodeName: nullable,
      role: Type.String(),
      ready: Type.Boolean(),
      phase: Type.String(),
      restarts: Type.Integer(),
    }),
  ),
  volumes: Type.Array(
    Type.Object({ name: Type.String(), phase: Type.String(), capacity: nullable }),
  ),
  backups: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        phase: Type.String(),
        startedAt: nullable,
        completedAt: nullable,
        error: nullable,
        backupId: nullable,
      }),
    ),
  ),
  archive: Type.Optional(
    Type.Object({
      healthy: Type.Union([Type.Boolean(), Type.Null()]),
      message: Type.String(),
      lastSuccessfulBackup: nullable,
    }),
  ),
});
export const ClusterDatabaseConfigSchema = Type.Object(
  {
    engine: Type.Union([Type.Literal("postgres"), Type.Literal("redis")]),
    version: Type.Optional(Type.Union([Type.Literal("17"), Type.Literal("18")])),
    mode: Type.Union([
      Type.Literal("standalone"),
      Type.Literal("cluster"),
      Type.Literal("replication"),
    ]),
    instances: Type.Integer({ minimum: 1, maximum: 9 }),
    storageGiB: Type.Integer({ minimum: 1, maximum: 16384 }),
    storageClass: Type.String({ minLength: 1, maxLength: 63 }),
    cpuMillis: Type.Integer({ minimum: 100, maximum: 64000 }),
    memoryMiB: Type.Integer({ minimum: 256, maximum: 262144 }),
    databaseName: Type.String({ pattern: "^[a-z][a-z0-9_]{0,47}$" }),
    backup: Type.Optional(
      Type.Object(
        {
          destinationId: Type.String({ minLength: 1, maxLength: 128 }),
          schedule: Type.Union([
            Type.Literal("daily"),
            Type.Literal("hourly"),
            Type.Literal("manual"),
          ]),
          retentionDays: Type.Integer({ minimum: 7, maximum: 365 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const ClusterDatabaseSchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  clusterId: Type.String(),
  name: Type.String(),
  config: ClusterDatabaseConfigSchema,
  status: Type.Union(
    (
      ["provisioning", "ready", "failed", "interrupted", "deleting", "retained", "deleted"] as const
    ).map((status) => Type.Literal(status)),
  ),
  intent: Type.Union([Type.Literal("apply"), Type.Literal("remove"), Type.Literal("backup")]),
  sequence: Type.Integer(),
  generation: Type.Integer(),
  progress: ClusterDatabaseProgressSchema,
  observation: Type.Union([ClusterDatabaseObservationSchema, Type.Null()]),
  error: nullable,
  internalHost: Type.String(),
  readOnlyHost: nullable,
  envKey: nullable,
  readEnvKey: Type.Optional(nullable),
  sourceDatabaseId: Type.Optional(nullable),
  updatedAt: Type.String(),
  createdAt: Type.String(),
});
export type ClusterDatabase = Static<typeof ClusterDatabaseSchema>;
const identity = {
  databaseId: Type.String({ minLength: 1 }),
  expectedSequence: Type.Integer({ minimum: 1 }),
};
const mutation = <T extends import("@sinclair/typebox").TProperties>(fields: T) =>
  Type.Object({ ...identity, ...fields }, { additionalProperties: false });
export const ProjectDatabaseSchemas = {
  listClusterDatabases: { action: "read", output: Type.Array(ClusterDatabaseSchema) },
  listClusterDatabaseImports: {
    action: "read",
    output: Type.Array(
      Type.Object({
        runId: Type.String(),
        artifactName: Type.String(),
        engine: Type.Union([Type.Literal("postgres"), Type.Literal("redis")]),
        sourceName: Type.String(),
        completedAt: nullable,
        sizeBytes: Type.Number(),
      }),
    ),
  },
  getClusterDatabase: {
    action: "read",
    input: Type.Object(
      { databaseId: Type.String(), observe: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    output: ClusterDatabaseSchema,
  },
  createClusterDatabase: {
    action: "write",
    input: Type.Object(
      {
        requestId: Type.String({
          pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        }),
        name: Type.String({
          minLength: 1,
          maxLength: 63,
          pattern: "^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$",
        }),
        config: ClusterDatabaseConfigSchema,
        clusterId: Type.Optional(Type.String({ minLength: 1 })),
        importFrom: Type.Optional(
          Type.Object(
            {
              runId: Type.String({ minLength: 1 }),
              artifactName: Type.String({ minLength: 1, maxLength: 255 }),
            },
            { additionalProperties: false },
          ),
        ),
        copyFrom: Type.Optional(
          Type.Object(
            {
              databaseId: Type.String({ minLength: 1 }),
              expectedSequence: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
        ),
        clusterAwareClient: Type.Optional(Type.Literal(true)),
        restoreFrom: Type.Optional(
          Type.Object(
            {
              databaseId: Type.String({ minLength: 1 }),
              backupName: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    output: ClusterDatabaseSchema,
  },
  updateClusterDatabase: {
    action: "write",
    input: mutation({
      config: ClusterDatabaseConfigSchema,
      confirmRedisRebalance: Type.Optional(Type.Literal(true)),
    }),
    output: ClusterDatabaseSchema,
  },
  retryClusterDatabase: { action: "write", input: mutation({}), output: ClusterDatabaseSchema },
  backupClusterDatabase: { action: "write", input: mutation({}), output: ClusterDatabaseSchema },
  removeClusterDatabase: {
    action: "write",
    input: mutation({ name: Type.String(), deleteData: Type.Boolean() }),
    output: ClusterDatabaseSchema,
  },
  connectClusterDatabase: {
    action: "write",
    input: mutation({
      envKey: Type.Union([Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" }), Type.Null()]),
      readEnvKey: Type.Optional(
        Type.Union([Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" }), Type.Null()]),
      ),
      replace: Type.Optional(
        Type.Object(
          {
            databaseId: Type.String({ minLength: 1 }),
            expectedSequence: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    }),
    output: ClusterDatabaseSchema,
  },
} as const satisfies Record<string, ResourceOperationSchema>;
