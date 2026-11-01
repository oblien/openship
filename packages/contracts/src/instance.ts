import { Type, type Static } from "@sinclair/typebox";
import type { ExportSelection, ImportSelection, ExportPreview } from "@repo/core";
import { UpdateServerInputSchema } from "./servers";
import { UpdateInstanceSettingsInputSchema } from "./system";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";

const ok = Type.Object({ ok: Type.Literal(true) });
const history = Type.Array(
  Type.Union(
    ["analytics", "activity", "backups", "incidents", "migrations"].map((value) =>
      Type.Literal(value),
    ),
  ),
);
const scope = Type.Union([Type.Literal("instance"), Type.Literal("projects")]);
const includes = {
  includeSecrets: Type.Optional(Type.Boolean()),
  includeDomains: Type.Optional(Type.Boolean()),
  includeBackups: Type.Optional(Type.Boolean()),
  includeIntegrations: Type.Optional(Type.Boolean()),
};
export const InstanceExportSelectionSchema = Type.Unsafe<ExportSelection>(
  Type.Object(
    {
      history,
      scope: Type.Optional(scope),
      projectIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      includeEnvironments: Type.Optional(Type.Boolean()),
      includeLinkedProjects: Type.Optional(Type.Boolean()),
      includeServers: Type.Optional(Type.Boolean()),
      ...includes,
    },
    { additionalProperties: false },
  ),
);
export const InstanceImportSelectionSchema = Type.Unsafe<ImportSelection>(
  Type.Object(
    {
      scope,
      projectIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      history: Type.Optional(history),
      conflictPolicy: Type.Optional(Type.Union([Type.Literal("skip"), Type.Literal("overwrite")])),
      overwriteDependencies: Type.Optional(Type.Boolean()),
      projectActions: Type.Optional(
        Type.Record(Type.String(), Type.Union([Type.Literal("skip"), Type.Literal("overwrite")])),
      ),
      serverMappings: Type.Optional(Type.Record(Type.String(), Type.String({ minLength: 1 }))),
      ...includes,
    },
    { additionalProperties: false },
  ),
);

/** Archive contents remain opaque to the client. Only the controller interprets or restores database rows and secrets. */
export const InstanceArchiveSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("openship-instance-export"),
      Type.Literal("openship-project-export"),
    ]),
    envelopeVersion: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    sourceDriver: Type.Union([Type.Literal("pg"), Type.Literal("pglite")]),
    dump: Type.Intersect([
      Type.Record(Type.String(), Type.Unknown()),
      Type.Object({
        tables: Type.Record(Type.String(), Type.Array(Type.Record(Type.String(), Type.Unknown()))),
      }),
    ]),
    secrets: Type.Unknown(),
  },
  { additionalProperties: true },
);
export type InstanceArchive = Static<typeof InstanceArchiveSchema>;

export const InstanceOnboardingSchema = Type.Object(
  {
    ...UpdateServerInputSchema.properties,
    ...Type.Pick(UpdateInstanceSettingsInputSchema, [
      "authMode",
      "confirm",
      "tunnelProvider",
      "tunnelToken",
      "defaultBuildMode",
      "defaultRollbackWindow",
    ]).properties,
    serverName: Type.Optional(Type.String()),
    serverId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const domain = Type.Union([
  Type.Object(
    { kind: Type.Literal("custom"), hostname: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("free"), slug: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);
const serverMigration = Type.Object(
  { serverId: Type.String({ minLength: 1 }), domain },
  { additionalProperties: false },
);
const importMode = Type.Union([Type.Literal("wipe"), Type.Literal("merge")]);
export const InstanceImportResultSchema = Type.Object({
  mode: importMode,
  rowsRestored: Type.Number(),
  secretsRehydrated: Type.Number(),
  secretsSkipped: Type.Boolean(),
  localPathProjects: Type.Optional(
    Type.Array(Type.Object({ slug: Type.String(), localPath: Type.String() })),
  ),
  warnings: Type.Optional(Type.Array(Type.String())),
  projectsCreated: Type.Optional(Type.Number()),
  projectsUpdated: Type.Optional(Type.Number()),
  projectsSkipped: Type.Optional(Type.Number()),
});

/** Remote instance administration. Server-side instance-admin and bootstrap restrictions still apply. */
export const InstanceOperationSchemas = {
  onboardingStatus: { action: "read", output: Type.Object({ configured: Type.Boolean() }) },
  configureOnboarding: { action: "admin", input: InstanceOnboardingSchema, output: ok },
  upgradeToAuth: {
    action: "admin",
    input: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 100 }),
        email: Type.String({ minLength: 3, maxLength: 254 }),
        password: Type.String({ minLength: 8, maxLength: 128 }),
        useOwnMailServer: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    output: Type.Object({
      ok: Type.Literal(true),
      authMode: Type.Literal("local"),
      user: Type.Object({ id: Type.String(), name: Type.String(), email: Type.String() }),
    }),
  },
  preflightMigration: {
    action: "read",
    input: serverMigration,
    output: Type.Object({
      ready: Type.Boolean(),
      checks: Type.Record(
        Type.String(),
        Type.Object({ ok: Type.Boolean(), detail: Type.String() }),
      ),
    }),
  },
  migrateToServer: {
    action: "admin",
    input: serverMigration,
    output: Type.Object({ ok: Type.Literal(true), migrationTargetUrl: Type.String() }),
  },
  migrateToCloud: {
    action: "admin",
    input: Type.Object(
      { allowNonEmptyTarget: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    optionalInput: true,
    output: Type.Object({
      ok: Type.Literal(true),
      publicUrl: Type.String(),
      imported: Type.Unknown(),
    }),
  },
  exposeTunnel: {
    action: "admin",
    input: Type.Object({ slug: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    output: Type.Object({ ok: Type.Literal(true), migrationTargetUrl: Type.String() }),
  },
  switchBack: {
    action: "admin",
    input: Type.Object(
      { abandonRemote: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    optionalInput: true,
    output: Type.Object({
      ok: Type.Literal(true),
      previousMode: Type.String(),
      rowsRestored: Type.Number(),
      syncedFromRemote: Type.Boolean(),
    }),
  },
  previewExport: {
    action: "read",
    input: Type.Object(
      { selection: Type.Optional(InstanceExportSelectionSchema) },
      { additionalProperties: false },
    ),
    optionalInput: true,
    output: Type.Unsafe<ExportPreview>(
      Type.Object({
        core: Type.Number(),
        history: Type.Record(Type.String(), Type.Number()),
        total: Type.Number(),
      }),
    ),
  },
  exportData: {
    action: "admin",
    input: Type.Object(
      { selection: Type.Optional(InstanceExportSelectionSchema) },
      { additionalProperties: false },
    ),
    optionalInput: true,
    output: InstanceArchiveSchema,
  },
  importData: {
    action: "admin",
    input: Type.Object(
      {
        file: InstanceArchiveSchema,
        passphrase: Type.Optional(Type.String()),
        mode: importMode,
        selection: Type.Optional(InstanceImportSelectionSchema),
      },
      { additionalProperties: false },
    ),
    output: InstanceImportResultSchema,
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface InstanceOperations extends ScopedOperations<typeof InstanceOperationSchemas> {}
