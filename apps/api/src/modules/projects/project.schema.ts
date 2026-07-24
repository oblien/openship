/**
 * Project validation schemas - TypeBox for Hono route validation.
 * Framework & PackageManager enums are derived from the STACKS registry
 * so adding a new stack automatically adds it to validation.
 */

import { Type, type Static, type TLiteral } from "@sinclair/typebox";
import { STACK_IDS, ALL_PACKAGE_MANAGERS } from "@repo/core";

// ─── Shared enums (derived from registry) ────────────────────────────────────

export const FrameworkEnum = Type.Union(
  STACK_IDS.map((id) => Type.Literal(id)) as [TLiteral<string>, ...TLiteral<string>[]],
);

export const PackageManagerEnum = Type.Union(
  ALL_PACKAGE_MANAGERS.map((pm) => Type.Literal(pm)) as [TLiteral<string>, ...TLiteral<string>[]],
);

/**
 * Validator block for "this row is a source-built monorepo sub-app."
 *
 * Same field set lives in three places - the DB `service` row (nullable
 * columns), the create-time `MonorepoAppSchema` used inside the project
 * create body, and the per-service `UpdateServiceBody` (when a sub-app
 * row is edited after creation). Define the block ONCE here and reuse it
 * in every callsite so a field added (or maxLength tweaked) doesn't drift
 * silently across schemas.
 *
 * `rootDirectory` is OPTIONAL at this layer because the DB column is
 * nullable (compose rows live in the same table with null monorepo
 * fields). The create-time wrappers below make it required where the
 * payload is explicitly a new monorepo sub-app.
 */
export const MonorepoSubAppFieldsSchema = {
  rootDirectory: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  installCommand: Type.Optional(Type.String({ maxLength: 1000 })),
  buildCommand: Type.Optional(Type.String({ maxLength: 1000 })),
  startCommand: Type.Optional(Type.String({ maxLength: 1000 })),
  outputDirectory: Type.Optional(Type.String({ maxLength: 200, pattern: "^[A-Za-z0-9._~/-]+$" })),
  framework: Type.Optional(FrameworkEnum),
  packageManager: Type.Optional(PackageManagerEnum),
  buildImage: Type.Optional(Type.String({ maxLength: 200 })),
} as const;

const EnvironmentEnum = Type.Union([
  Type.Literal("production"),
  Type.Literal("preview"),
  Type.Literal("development"),
]);

const EnvironmentSourceModeEnum = Type.Union([
  Type.Literal("branch"),
  Type.Literal("manual"),
]);

const PublicEndpointSchema = Type.Object({
  port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
  targetPath: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  domain: Type.Optional(
    Type.String({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" }),
  ),
  customDomain: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  domainType: Type.Optional(Type.Union([Type.Literal("free"), Type.Literal("custom")])),
});

/**
 * One sub-app inside a monorepo project - used inside CreateProjectBody.
 * Reuses MonorepoSubAppFieldsSchema for the build settings so any change
 * to that block ripples to both this create payload and the per-service
 * update validator.
 *
 * `rootDirectory` is re-declared as required here (the shared block has
 * it optional to match the DB), because the dashboard's discovery flow
 * always produces a rootDirectory and we want preflight to reject an
 * empty one rather than fall back to repo root by accident.
 */
const MonorepoAppSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  // Spread first, then override rootDirectory to required. The shared
  // block has it Optional to match the DB column; this create payload
  // requires it so preflight rejects empty paths instead of silently
  // falling back to repo root.
  ...MonorepoSubAppFieldsSchema,
  rootDirectory: Type.String({ minLength: 1, maxLength: 200 }),
  port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
  enabled: Type.Optional(Type.Boolean({ default: true })),
  exposed: Type.Optional(Type.Boolean({ default: true })),
  domain: Type.Optional(
    Type.String({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" }),
  ),
  customDomain: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  domainType: Type.Optional(Type.Union([Type.Literal("free"), Type.Literal("custom")])),
  environment: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const MonorepoWorkspaceSchema = Type.Object({
  packageManager: Type.String({ minLength: 1, maxLength: 32 }),
  /** Shell command run ONCE at the repo root before per-app builds.
   *  Any prep — install, codegen, schema sync — chained with `&&`. */
  prepareCommand: Type.Optional(Type.String({ maxLength: 500 })),
});

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

/**
 * Routing config parsed from the repo's `vercel.json` (rewrites/redirects/
 * headers/cleanUrls/trailingSlash). Stored on the project and compiled to
 * OpenResty at deploy. Values are re-validated + sanitized at compile time
 * (`compileVercelRouting`) since they originate from arbitrary repos.
 */
const RoutingRuleSchema = Type.Object({
  source: Type.String({ maxLength: 2000 }),
  destination: Type.String({ maxLength: 2000 }),
});
const RoutingConfigSchema = Type.Object({
  rewrites: Type.Optional(Type.Array(RoutingRuleSchema, { maxItems: 200 })),
  redirects: Type.Optional(
    Type.Array(
      Type.Composite([
        RoutingRuleSchema,
        Type.Object({
          permanent: Type.Optional(Type.Boolean()),
          statusCode: Type.Optional(Type.Number({ minimum: 300, maximum: 399 })),
        }),
      ]),
      { maxItems: 200 },
    ),
  ),
  headers: Type.Optional(
    Type.Array(
      Type.Object({
        source: Type.String({ maxLength: 2000 }),
        headers: Type.Array(
          Type.Object({ key: Type.String({ maxLength: 200 }), value: Type.String({ maxLength: 4000 }) }),
          { maxItems: 50 },
        ),
      }),
      { maxItems: 200 },
    ),
  ),
  cleanUrls: Type.Optional(Type.Boolean()),
  trailingSlash: Type.Optional(Type.Boolean()),
});

/**
 * Release/dist source config (gitProvider === "release"). A prebuilt dist is
 * deployed with no build, version-tracked. `mode: "github"` pulls a release
 * asset from a repo; `mode: "url"` pulls an external HTTPS tarball (sha256
 * REQUIRED). Mirrors the `ReleaseSource` type in @repo/core.
 */
const ReleaseSourceSchema = Type.Object({
  mode: Type.Union([Type.Literal("github"), Type.Literal("url")]),
  repo: Type.Optional(Type.String({ maxLength: 200 })),
  assetTemplate: Type.Optional(Type.String({ maxLength: 200 })),
  os: Type.Optional(Type.String({ maxLength: 32 })),
  arch: Type.Optional(Type.String({ maxLength: 32 })),
  distUrl: Type.Optional(Type.String({ maxLength: 2000 })),
  sha256Url: Type.Optional(Type.String({ maxLength: 2000 })),
  sha256: Type.Optional(Type.String({ maxLength: 128 })),
  versionUrl: Type.Optional(Type.String({ maxLength: 2000 })),
  channel: Type.Optional(Type.String({ maxLength: 64 })),
  pinnedVersion: Type.Optional(Type.String({ maxLength: 64 })),
  trackReleases: Type.Optional(Type.Boolean()),
});

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
  // Release/dist source (gitProvider === "release")
  releaseSource: Type.Optional(ReleaseSourceSchema),
  // Build configuration
  framework: Type.Optional(FrameworkEnum),
  packageManager: Type.Optional(PackageManagerEnum),
  installCommand: Type.Optional(Type.String({ maxLength: 500 })),
  buildCommand: Type.Optional(Type.String({ maxLength: 500 })),
  outputDirectory: Type.Optional(Type.String({ maxLength: 200, pattern: "^[A-Za-z0-9._~/-]+$" })),
  productionPaths: Type.Optional(Type.String({ maxLength: 2000 })),
  rootDirectory: Type.Optional(Type.String({ maxLength: 200 })),
  startCommand: Type.Optional(Type.String({ maxLength: 500 })),
  buildImage: Type.Optional(Type.String({ maxLength: 200 })),
  productionMode: Type.Optional(
    Type.Union([Type.Literal("host"), Type.Literal("static"), Type.Literal("standalone")]),
  ),
  port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
  publicEndpoints: Type.Optional(Type.Array(PublicEndpointSchema, { minItems: 1, maxItems: 20 })),
  hasServer: Type.Optional(Type.Boolean({ default: true })),
  hasBuild: Type.Optional(Type.Boolean({ default: true })),
  rollbackWindow: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
  /**
   * Cloud archive strategy. Today only "inplace" is implemented
   * (Oblien-native `snapshots.createArchive` + `workspace.stop`).
   * The "offload" branch is reserved for future self-hosted external
   * storage. Bare/Docker runtimes ignore the setting.
   */
  cloudArchiveStrategy: Type.Optional(
    Type.Union([Type.Literal("inplace"), Type.Literal("offload")]),
  ),

  /** Project flavor - "monorepo" wires the request through the multi-app path below. */
  projectType: Type.Optional(
    Type.Union([
      Type.Literal("app"),
      Type.Literal("docker"),
      Type.Literal("services"),
      Type.Literal("monorepo"),
    ]),
  ),
  /** Sub-apps discovered inside a monorepo. Only used when projectType === "monorepo". */
  monorepoApps: Type.Optional(Type.Array(MonorepoAppSchema, { minItems: 1, maxItems: 50 })),
  /** Shared workspace install (run once at repo root). Only used when projectType === "monorepo". */
  monorepoWorkspace: Type.Optional(MonorepoWorkspaceSchema),
  /**
   * Repo-root path prefixes that, when touched, force every sub-app to
   * rebuild. Null/omitted = the shared-paths force is disabled. Pass
   * an explicit `[]` to clear an existing list. Rejected if any prefix
   * overlaps an existing service's `rootDirectory`.
   */
  monorepoSharedPaths: Type.Optional(
    Type.Union([Type.Null(), Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 })]),
  ),
  /** Routing config from the repo's vercel.json (see RoutingConfigSchema). */
  routingConfig: Type.Optional(Type.Union([Type.Null(), RoutingConfigSchema])),
  /**
   * Rollback strategy applied to NEW deployments of this project.
   *   - "git"      → no artifact archive; rollback rebuilds at prior commit_sha
   *   - "snapshot" → archive prior artifact, rollback restores it instantly
   */
  defaultRollbackStrategy: Type.Optional(
    Type.Union([Type.Literal("git"), Type.Literal("snapshot")]),
  ),
  /**
   * Edge → app upstream addressing for this project (self-hosted).
   *   - "auto"          → resolved to loopback-port (the safe default)
   *   - "loopback-port" → route via a pinned `127.0.0.1:<hostPort>`
   *   - "container-ip"  → advanced: route via the container bridge IP
   *     (zero-downtime swaps; needs the edge on the docker bridge; not
   *     supported on Docker Desktop). Ignored by bare + cloud runtimes.
   */
  routeStrategy: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("loopback-port"),
      Type.Literal("container-ip"),
    ]),
  ),
  /**
   * Apps-catalog marker. Set by the Create-App instantiator when a project is
   * installed from the Apps catalog (Convex, WordPress, webmail, …). Moves the
   * project to the Apps tab; `appTemplateId` records which catalog entry it came
   * from. Left at defaults for a normal user project.
   */
  isApp: Type.Optional(Type.Boolean()),
  appTemplateId: Type.Optional(Type.String({ maxLength: 100 })),
});

export const UpdateProjectBody = Type.Partial(CreateProjectBody);

/**
 * POST /projects/ensure — CreateProjectBody plus an optional `projectId` to
 * update an existing project in place instead of creating a new one.
 */
export const EnsureProjectBody = Type.Composite([
  CreateProjectBody,
  Type.Object({
    projectId: Type.Optional(
      Type.String({ description: "Update this existing project instead of creating a new one." }),
    ),
  }),
]);

/** POST /projects/folder/session — open a folder-upload deploy session. */
export const FolderSessionBody = Type.Object(
  {
    stack: Type.Optional(
      Type.String({ description: "Stack hint (e.g. 'vite','nextjs'); picks the cloud build image." }),
    ),
    packageManager: Type.Optional(Type.String({ description: "npm | pnpm | yarn | bun." })),
    name: Type.Optional(Type.String({ description: "Project name." })),
  },
  { additionalProperties: true },
);

export const CreateProjectEnvironmentBody = Type.Object({
  environmentName: Type.String({ minLength: 1, maxLength: 80 }),
  environmentSlug: Type.Optional(
    Type.String({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" }),
  ),
  environmentType: Type.Optional(EnvironmentEnum),
  gitBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  sourceMode: Type.Optional(EnvironmentSourceModeEnum),
});

/**
 * MERGE of env vars — the per-variable editor's write. Only the named keys are
 * touched: `upserts` are inserted/updated, `deletes` are removed, every other
 * var (including untouched masked secrets) is left intact. (Replaced the old
 * destructive full-replace PUT /:id/env, which could wipe/corrupt masked
 * secrets — the project-level full-replace endpoint has been removed.)
 */
export const MergeEnvVarsBody = Type.Object({
  environment: EnvironmentEnum,
  upserts: Type.Array(
    Type.Object({
      key: Type.String({ minLength: 1, maxLength: 256 }),
      value: Type.String({ maxLength: 10000 }),
      isSecret: Type.Optional(Type.Boolean({ default: false })),
    }),
    { minItems: 0, maxItems: 100 },
  ),
  deletes: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
    minItems: 0,
    maxItems: 100,
  }),
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
export type TMergeEnvVarsBody = Static<typeof MergeEnvVarsBody>;
export type TUpdateResourcesBody = Static<typeof UpdateResourcesBody>;
