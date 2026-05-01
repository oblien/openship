/**
 * Project validation schemas — TypeBox for Hono route validation.
 * Framework & PackageManager enums are derived from the STACKS registry
 * so adding a new stack automatically adds it to validation.
 */

import { Type, type Static, type TLiteral } from "@sinclair/typebox";
import { STACK_IDS, ALL_PACKAGE_MANAGERS } from "@repo/core";

// ─── Shared enums (derived from registry) ────────────────────────────────────

const FrameworkEnum = Type.Union(
  STACK_IDS.map((id) => Type.Literal(id)) as [TLiteral<string>, ...TLiteral<string>[]],
);

const PackageManagerEnum = Type.Union(
  ALL_PACKAGE_MANAGERS.map((pm) => Type.Literal(pm)) as [TLiteral<string>, ...TLiteral<string>[]],
);

const EnvironmentEnum = Type.Union([
  Type.Literal("production"),
  Type.Literal("preview"),
  Type.Literal("development"),
]);

const EnvironmentSourceModeEnum = Type.Union([
  Type.Literal("branch"),
  Type.Literal("manual"),
]);

// ─── Route params ────────────────────────────────────────────────────────────

export const ProjectIdParam = Type.Object({
  id: Type.String({ minLength: 1 }),
});

// ─── Query params ────────────────────────────────────────────────────────────

export const ListProjectsQuery = Type.Object({
  page: Type.Optional(Type.Number({ minimum: 1, default: 1 })),
  perPage: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
});

// ─── Request bodies ──────────────────────────────────────────────────────────

export const CreateProjectBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  /** Override the auto-generated slug (used as free subdomain: slug.opsh.io) */
  slug: Type.Optional(
    Type.String({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" }),
  ),
  // Local source
  localPath: Type.Optional(Type.String({ maxLength: 1000 })),
  // Git source
  gitProvider: Type.Optional(Type.String({ default: "github" })),
  gitOwner: Type.Optional(Type.String({ maxLength: 100 })),
  gitRepo: Type.Optional(Type.String({ maxLength: 100 })),
  gitBranch: Type.Optional(Type.String({ default: "main" })),
  installationId: Type.Optional(Type.Number()),
  // Build configuration
  framework: Type.Optional(FrameworkEnum),
  packageManager: Type.Optional(PackageManagerEnum),
  installCommand: Type.Optional(Type.String({ maxLength: 500 })),
  buildCommand: Type.Optional(Type.String({ maxLength: 500 })),
  outputDirectory: Type.Optional(Type.String({ maxLength: 200 })),
  productionPaths: Type.Optional(Type.String({ maxLength: 2000 })),
  rootDirectory: Type.Optional(Type.String({ maxLength: 200 })),
  startCommand: Type.Optional(Type.String({ maxLength: 500 })),
  buildImage: Type.Optional(Type.String({ maxLength: 200 })),
  productionMode: Type.Optional(
    Type.Union([Type.Literal("host"), Type.Literal("static"), Type.Literal("standalone")]),
  ),
  port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
  hasServer: Type.Optional(Type.Boolean({ default: true })),
  hasBuild: Type.Optional(Type.Boolean({ default: true })),
  rollbackWindow: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
});

export const UpdateProjectBody = Type.Partial(CreateProjectBody);

export const CreateProjectEnvironmentBody = Type.Object({
  environmentName: Type.String({ minLength: 1, maxLength: 80 }),
  environmentSlug: Type.Optional(
    Type.String({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" }),
  ),
  environmentType: Type.Optional(EnvironmentEnum),
  gitBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  sourceMode: Type.Optional(EnvironmentSourceModeEnum),
});

export const SetEnvVarsBody = Type.Object({
  environment: EnvironmentEnum,
  vars: Type.Array(
    Type.Object({
      key: Type.String({ minLength: 1, maxLength: 256 }),
      value: Type.String({ maxLength: 10000 }),
      isSecret: Type.Optional(Type.Boolean({ default: false })),
    }),
    { minItems: 0, maxItems: 100 },
  ),
});

export const UpdateResourcesBody = Type.Object({
  production: Type.Optional(
    Type.Object({
      cpuCores: Type.Optional(Type.Number({ minimum: 0.25, maximum: 4 })),
      memoryMb: Type.Optional(Type.Number({ minimum: 128, maximum: 8192 })),
      diskMb: Type.Optional(Type.Number({ minimum: 64, maximum: 204800 })),
    }),
  ),
  build: Type.Optional(
    Type.Object({
      cpuCores: Type.Optional(Type.Number({ minimum: 0.25, maximum: 4 })),
      memoryMb: Type.Optional(Type.Number({ minimum: 128, maximum: 8192 })),
      diskMb: Type.Optional(Type.Number({ minimum: 64, maximum: 204800 })),
    }),
  ),
  sleepMode: Type.Optional(Type.Union([Type.Literal("auto_sleep"), Type.Literal("always_on")])),
  port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TProjectIdParam = Static<typeof ProjectIdParam>;
export type TListProjectsQuery = Static<typeof ListProjectsQuery>;
export type TCreateProjectBody = Static<typeof CreateProjectBody>;
export type TUpdateProjectBody = Static<typeof UpdateProjectBody> & {
  rollbackWindow?: number | null;
};
export type TCreateProjectEnvironmentBody = Static<typeof CreateProjectEnvironmentBody>;
export type TSetEnvVarsBody = Static<typeof SetEnvVarsBody>;
export type TUpdateResourcesBody = Static<typeof UpdateResourcesBody>;
