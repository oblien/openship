/**
 * Project validation schemas - TypeBox for Hono route validation.
 * Framework & PackageManager enums are derived from the STACKS registry
 * so adding a new stack automatically adds it to validation.
 */

import { Type, type Static, type TLiteral } from "@sinclair/typebox";
import {
  STACK_IDS,
  ALL_PACKAGE_MANAGERS,
  ALL_RESOURCE_TIERS,
  CLOUD_RESOURCE_TIER_IDS,
  PROXY_DIRECTIVES,
  proxyKindRegex,
  type ResourceTier,
} from "@repo/core";

// ─── Shared enums (derived from registry) ────────────────────────────────────

export const FrameworkEnum = Type.String({
  maxLength: 100,
  description: "Framework stack ID or display label (e.g. 'static', 'nextjs', 'Static Site').",
});

export const PackageManagerEnum = Type.Union(
  ALL_PACKAGE_MANAGERS.map((pm) => Type.Literal(pm)) as [TLiteral<string>, ...TLiteral<string>[]],
);

/**
 * Resource-tier validators derived from the ONE tier list in @repo/core, the
 * same way FrameworkEnum derives from STACKS. Spelling the literals out per
 * schema is how the accepted set drifts between endpoints.
 */
export const ResourceTierEnum = (opts?: { description?: string }) =>
  Type.Union(
    // Typed as the real union (not TLiteral<string>) so `Static<>` keeps the
    // literal type and consumers don't need a cast back from `string`.
    ALL_RESOURCE_TIERS.map((t) => Type.Literal(t)) as [
      TLiteral<ResourceTier>,
      ...TLiteral<ResourceTier>[],
    ],
    opts,
  );

/** Cloud-selectable subset — no "unlimited" (a metered workspace must be sized). */
export const CloudResourceTierEnum = (opts?: { description?: string }) =>
  Type.Union(
    CLOUD_RESOURCE_TIER_IDS.map((t) => Type.Literal(t)) as [
      TLiteral<Exclude<ResourceTier, "unlimited">>,
      ...TLiteral<Exclude<ResourceTier, "unlimited">>[],
    ],
    opts,
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
  // `*` not `+`: an empty string is the pipeline's own "serve from root / unset"
  // value (build-config default, `!outputDirectory` checks), so `""` must be a
  // VALID input — a `+` here 400'd every caller sending the blank default (#427).
  outputDirectory: Type.Optional(Type.String({ maxLength: 200, pattern: "^[A-Za-z0-9._~/-]*$" })),
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
  /**
   * Canonical redirect: this hostname answers a 30x to another hostname of the
   * SAME project instead of serving. The target and the whole set are checked by
   * lib/domain-redirect.ts (own-project only, no self-target, no loops) — this is
   * only the shape gate.
   */
  redirectTo: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  redirectStatus: Type.Optional(
    Type.Union([Type.Literal(301), Type.Literal(302), Type.Literal(307), Type.Literal(308)]),
  ),
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

/**
 * One compose service as parsed from a docker-compose.yml — the shape
 * `folder/scan` (and `deployments/prepare`) returns in its `services[]`. Mirrors
 * the wire `BuildServiceInput` of POST /deployments/build/access so a client can
 * hand the SAME array to either step; both persist it with `syncFromCompose`.
 */
const ComposeServiceSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  image: Type.Optional(Type.String({ maxLength: 500 })),
  build: Type.Optional(Type.String({ maxLength: 500 })),
  dockerfile: Type.Optional(Type.String({ maxLength: 500 })),
  ports: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 50 })),
  dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 50 })),
  environment: Type.Optional(Type.Record(Type.String(), Type.String())),
  volumes: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })),
  command: Type.Optional(Type.String({ maxLength: 2000 })),
  // #332: structured argv passed through from folder/scan (compose Cmd, no `sh -c`).
  commandArgv: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100 })),
  restart: Type.Optional(Type.String({ maxLength: 50 })),
  exposed: Type.Optional(Type.Boolean()),
  exposedPort: Type.Optional(Type.String({ maxLength: 100 })),
  domain: Type.Optional(Type.String({ maxLength: 63 })),
  customDomain: Type.Optional(Type.String({ maxLength: 255 })),
  domainType: Type.Optional(Type.Union([Type.Literal("free"), Type.Literal("custom")])),
  publicEndpoints: Type.Optional(Type.Array(PublicEndpointSchema, { maxItems: 20 })),
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

/**
 * Openship's deploy-time readiness gate — mirrors `OpenshipReadiness` in
 * @repo/core, which is what `openship.json` declares and what the pipeline
 * reads. NOT the Docker HEALTHCHECK directive (that one is per compose service,
 * under `service.advanced.healthcheck`).
 *
 * Every field optional, every default off: an absent/`{}` value means the deploy
 * does no post-start waiting at all. Bounds mirror the core parser so the wizard,
 * `openship.json`, and MCP can't disagree about what's accepted.
 */
const ReadinessSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  path: Type.Optional(Type.String({ maxLength: 2000 })),
  port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })),
  stabilization: Type.Optional(Type.Boolean()),
  stabilizationSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })),
  onFailure: Type.Optional(Type.Union([Type.Literal("warn"), Type.Literal("fail")])),
});
/**
 * Curated reverse-proxy tunables. CURATED, never arbitrary nginx passthrough:
 * these strings are interpolated straight into generated config.
 *
 * GENERATED from `PROXY_DIRECTIVES` in @repo/core, not hand-listed — the same table
 * drives `sanitizeProxySettings`, which re-checks every value right before
 * rendering. Two hand-written copies would drift and the API would start accepting
 * values the renderer silently drops (or reject ones it renders fine). Adding a
 * directive means one row in that table; nothing here changes.
 */
const ProxySettingsSchema = Type.Object(
  Object.fromEntries(
    PROXY_DIRECTIVES.map((spec) => {
      if (spec.kind === "bool") return [spec.key, Type.Optional(Type.Boolean())];
      if (spec.kind === "int") {
        return [
          spec.key,
          Type.Optional(
            Type.Integer({
              ...(spec.min !== undefined ? { minimum: spec.min } : {}),
              ...(spec.max !== undefined ? { maximum: spec.max } : {}),
            }),
          ),
        ];
      }
      // `size` | `time` | `buffers` — the kind's regex IS the schema pattern.
      const re = proxyKindRegex(spec.kind);
      return [spec.key, Type.Optional(Type.String({ pattern: re!.source, maxLength: 64 }))];
    }),
  ),
);

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
  // No explicit null: `routingConfig` is replaced wholesale on save, so omitting
  // `proxy` already clears it (and null-ing the whole blob clears everything).
  proxy: Type.Optional(ProxySettingsSchema),
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
  // `*` not `+`: an empty string is the pipeline's own "serve from root / unset"
  // value (build-config default, `!outputDirectory` checks), so `""` must be a
  // VALID input — a `+` here 400'd every caller sending the blank default (#427).
  outputDirectory: Type.Optional(Type.String({ maxLength: 200, pattern: "^[A-Za-z0-9._~/-]*$" })),
  productionPaths: Type.Optional(Type.String({ maxLength: 2000 })),
  /**
   * Persistent mounts, compose syntax or a bare app-relative path. Omit to keep
   * the current value; send `[]` to turn persistence off (which is different
   * from `null`/absent, where the stack's defaults apply).
   */
  volumes: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })),
  rootDirectory: Type.Optional(Type.String({ maxLength: 200 })),
  /**
   * Where the compose file lives when it is NOT at the auto-detected root —
   * the file itself (`deploy/stack.yml`) or the directory holding it
   * (`deploy/docker-compose`). Makes the project a compose/services deploy.
   */
  composePath: Type.Optional(Type.String({ maxLength: 300 })),
  startCommand: Type.Optional(Type.String({ maxLength: 500 })),
  buildImage: Type.Optional(Type.String({ maxLength: 200 })),
  productionMode: Type.Optional(
    Type.Union([Type.Literal("host"), Type.Literal("static"), Type.Literal("standalone")]),
  ),
  port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
  /** Public routes for the project. An explicit `[]` clears them (no public route). */
  publicEndpoints: Type.Optional(Type.Array(PublicEndpointSchema, { maxItems: 20 })),
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
   * Deploy-time readiness gate. Omitted/null = OFF, which is the default for
   * every project — the deploy reports ready as soon as the workload is up and
   * routed, and the advisory in-container port probe (`meta.portCheck`,
   * re-runnable via POST /projects/:id/port-check) reports listening state
   * without being able to fail a deploy. Pass an object to opt in; pass null to
   * clear it. See ReadinessSchema.
   */
  readiness: Type.Optional(Type.Union([Type.Null(), ReadinessSchema])),
  /**
   * Apps-catalog marker. Set by the Create-App instantiator when a project is
   * installed from the Apps catalog (Convex, WordPress, webmail, …). Moves the
   * project to the Apps tab; `appTemplateId` records which catalog entry it came
   * from. Left at defaults for a normal user project.
   */
  isApp: Type.Optional(Type.Boolean()),
  appTemplateId: Type.Optional(Type.String({ maxLength: 100 })),
  /**
   * Custom east-west DNS alias for a single-app project, resolving ALONGSIDE the
   * default `<slug>` on the project network. Free-form here (normalized +
   * collision-checked server-side); `null`/`""` clears it back to the default.
   * The compose equivalent is per-service `advanced.alias`.
   */
  internalAlias: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
});

export const UpdateProjectBody = Type.Partial(CreateProjectBody);

/**
 * POST /projects/ensure — CreateProjectBody plus an optional `projectId` to
 * update an existing project in place instead of creating a new one, and the
 * compose `services` the source declared.
 */
export const EnsureProjectBody = Type.Composite([
  CreateProjectBody,
  Type.Object({
    projectId: Type.Optional(
      Type.String({ description: "Update this existing project instead of creating a new one." }),
    ),
    services: Type.Optional(
      Type.Array(ComposeServiceSchema, {
        maxItems: 100,
        description:
          "Compose services for a multi-service project — pass the folder/scan (or deployments/prepare) `services` array through verbatim. Persisted as the project's service set: services not listed are removed, so send the WHOLE set.",
      }),
    ),
    uploadSessionId: Type.Optional(
      Type.String({
        description:
          "Folder-upload session the `services` came from. Only used to restore environment values the scan masked (`••••••••`) — it never changes the project's source or config. Pass it whenever you echo scanned services back, or those secrets are dropped.",
      }),
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

/**
 * A cpu/memory/disk selection.
 *
 * `tier` picks a preset; explicit numbers are the "custom" path. `0` means NO
 * LIMIT (self-hosted default — the machine is the cap). The upper bound here is
 * only a sanity rail: the REAL ceiling is the target machine's probed capacity,
 * enforced in project-resources.service so a large box isn't artificially
 * capped (the old flat `maximum: 8192` made >8 GB impossible to request).
 */
const ResourceSelection = Type.Object({
  tier: Type.Optional(
    ResourceTierEnum({ description: "Resource preset. 'unlimited' = no caps (self-hosted only)." }),
  ),
  cpuCores: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1024, description: "vCPU limit. 0 = no limit." }),
  ),
  memoryMb: Type.Optional(
    Type.Number({ minimum: 0, maximum: 4194304, description: "Memory limit in MB. 0 = no limit." }),
  ),
  diskMb: Type.Optional(
    Type.Number({ minimum: 0, maximum: 204800, description: "Disk limit in MB. 0 = no limit." }),
  ),
});

export const UpdateResourcesBody = Type.Object({
  production: Type.Optional(ResourceSelection),
  build: Type.Optional(ResourceSelection),
  sleepMode: Type.Optional(Type.Union([Type.Literal("auto_sleep"), Type.Literal("always_on")])),
  port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
});

/** POST /:id/git/link — link a git repository to the project. */
export const LinkRepoBody = Type.Object({
  owner: Type.String({ minLength: 1, description: "GitHub repo owner." }),
  repo: Type.String({ minLength: 1, description: "GitHub repo name." }),
  branch: Type.Optional(Type.String({ description: "Deploy branch (defaults to the repo default)." })),
  installationId: Type.Optional(Type.Number({ description: "GitHub App installation id, when known." })),
});

/** POST /:id/auto-deploy — enable/disable auto-deploy on push. */
export const SetAutoDeployBody = Type.Object({
  enabled: Type.Boolean({ description: "Whether a push to the deploy branch triggers a redeploy." }),
});

/** POST /:id/branch — set the deploy branch. */
export const SetBranchBody = Type.Object({
  branch: Type.String({ minLength: 1, description: "Branch to deploy from." }),
});

/** POST /:id/sleep-mode — set sleep behaviour. Note the snake_case key. */
export const SetSleepModeBody = Type.Object({
  sleep_mode: Type.Union([Type.Literal("auto_sleep"), Type.Literal("always_on")], {
    description: "auto_sleep = idle-sleep; always_on = never sleep.",
  }),
});

/**
 * POST /:id/options — build/deploy options. Free-form: the service applies each
 * field only when present (`additionalProperties: true` keeps it forward-
 * compatible). Enum-ish fields are typed loosely (string) to match the service,
 * which ignores unrecognised values rather than rejecting them.
 */
export const SetOptionsBody = Type.Object(
  {
    buildCommand: Type.Optional(Type.String()),
    installCommand: Type.Optional(Type.String()),
    outputDirectory: Type.Optional(Type.String()),
    productionPaths: Type.Optional(Type.String()),
    /** Persistent mounts; `null` restores the stack's defaults. */
    volumes: Type.Optional(
      Type.Union([Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 }), Type.Null()]),
    ),
    rootDirectory: Type.Optional(Type.String()),
    /** Compose file location; `null` clears it and restores root detection. */
    composePath: Type.Optional(Type.Union([Type.String({ maxLength: 300 }), Type.Null()])),
    startCommand: Type.Optional(Type.String()),
    productionPort: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    packageManager: Type.Optional(Type.String()),
    buildImage: Type.Optional(Type.String()),
    framework: Type.Optional(Type.String()),
    productionMode: Type.Optional(Type.String({ description: "host | static | standalone." })),
    hasServer: Type.Optional(Type.Boolean()),
    hasBuild: Type.Optional(Type.Boolean()),
    runtimeMode: Type.Optional(Type.String({ description: "bare | docker." })),
  },
  { additionalProperties: true },
);

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TProjectIdParam = Static<typeof ProjectIdParam>;
export type TListProjectsQuery = Static<typeof ListProjectsQuery>;
export type TCreateProjectBody = Static<typeof CreateProjectBody>;
export type TEnsureProjectBody = Static<typeof EnsureProjectBody>;
export type TUpdateProjectBody = Static<typeof UpdateProjectBody> & {
  rollbackWindow?: number | null;
};
export type TCreateProjectEnvironmentBody = Static<typeof CreateProjectEnvironmentBody>;
export type TMergeEnvVarsBody = Static<typeof MergeEnvVarsBody>;
export type TUpdateResourcesBody = Static<typeof UpdateResourcesBody>;
