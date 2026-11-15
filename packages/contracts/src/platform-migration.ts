import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";

const id = Type.String({ minLength: 1, maxLength: 200 });
const text = Type.String();
const provider = Type.Union([Type.Literal("railway"), Type.Literal("vercel")]);
export const PlatformMigrationSourceSchema = Type.Object(
  { connectionId: id, projectId: id, environmentId: id },
  { additionalProperties: false },
);
export type PlatformMigrationSource = Static<typeof PlatformMigrationSourceSchema>;
export const PlatformProjectSchema = Type.Object({
  id,
  name: text,
  environments: Type.Array(Type.Object({ id, name: text })),
});
export type PlatformProject = Static<typeof PlatformProjectSchema>;
export const PlatformImportServiceSchema = Type.Object({
  id,
  name: text,
  kind: Type.Union([Type.Literal("app"), Type.Literal("database"), Type.Literal("worker")]),
  image: Type.Optional(text),
  repository: Type.Optional(text),
  branch: Type.Optional(text),
  commit: Type.Optional(text),
  rootDirectory: Type.Optional(text),
  external: Type.Optional(Type.Boolean()),
  variables: Type.Array(Type.Object({ key: text, required: Type.Boolean() })),
  volumes: Type.Array(
    Type.Object({ id, mountPath: text, sizeBytes: Type.Optional(Type.Number()) }),
  ),
  domains: Type.Array(Type.Object({ hostname: text, portable: Type.Boolean() })),
  warnings: Type.Array(text),
  blockers: Type.Array(text),
});
export type PlatformImportService = Static<typeof PlatformImportServiceSchema>;
export const PlatformDiscoverySchema = Type.Object({
  draftId: id,
  provider,
  projectName: text,
  environmentName: text,
  services: Type.Array(PlatformImportServiceSchema),
  warnings: Type.Array(text),
});
export type PlatformDiscovery = Static<typeof PlatformDiscoverySchema>;
const serviceChoice = Type.Object(
  {
    id,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    data: Type.Union([Type.Literal("copy"), Type.Literal("empty"), Type.Literal("external")]),
    databaseVersion: Type.Optional(Type.String({ pattern: "^[0-9]{1,2}$" })),
    env: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 256 }),
        Type.Union([Type.String({ maxLength: 32_768 }), Type.Null()]),
      ),
    ),
  },
  { additionalProperties: false },
);
export const PlatformMigrationReviewSchema = Type.Object(
  {
    draftId: id,
    targetServerId: id,
    projectName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    services: Type.Array(serviceChoice, { minItems: 1, maxItems: 50 }),
  },
  { additionalProperties: false },
);
export type PlatformMigrationReview = Static<typeof PlatformMigrationReviewSchema>;
export const PlatformMigrationPlanSchema = Type.Object({
  planId: id,
  provider,
  projectName: text,
  environmentName: text,
  targetServerId: id,
  services: Type.Array(PlatformImportServiceSchema),
  warnings: Type.Array(text),
  requiresWritePause: Type.Boolean(),
  ready: Type.Boolean(),
  requiresWorkerPause: Type.Boolean(),
  sourceControl: Type.Optional(Type.Literal("railway-project")),
});
export type PlatformMigrationPlan = Static<typeof PlatformMigrationPlanSchema>;
export const PlatformMigrationScopedSchemas = {
  platformProjects: {
    action: "read",
    input: Type.Object({ connectionId: id }),
    output: Type.Array(PlatformProjectSchema),
  },
  discoverPlatform: {
    action: "read",
    input: PlatformMigrationSourceSchema,
    output: PlatformDiscoverySchema,
  },
  reviewPlatform: {
    action: "read",
    input: PlatformMigrationReviewSchema,
    output: PlatformMigrationPlanSchema,
  },
  importPlatform: {
    action: "write",
    input: Type.Object(
      { planId: id, writesPaused: Type.Boolean(), workersPaused: Type.Boolean() },
      { additionalProperties: false },
    ),
    output: Type.Object({ success: Type.Literal(true), migrationId: id, confirmationToken: text }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
