/**
 * Deployment validation schemas - TypeBox for Hono route validation.
 */

import { Type, type Static } from "@sinclair/typebox";
import { CloudResourceTierEnum } from "../projects/project.schema";

// ─── Route params ────────────────────────────────────────────────────────────

export const DeploymentIdParam = Type.Object({
  id: Type.String({ minLength: 1 }),
});

// ─── Query params ────────────────────────────────────────────────────────────

export const ListDeploymentsQuery = Type.Object({
  projectId: Type.Optional(Type.String()),
  environment: Type.Optional(Type.Union([
    Type.Literal("production"), Type.Literal("preview"),
  ])),
  page: Type.Optional(Type.Number({ minimum: 1, default: 1 })),
  perPage: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
});

// ─── Request bodies ──────────────────────────────────────────────────────────

export const TriggerDeployBody = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  branch: Type.Optional(Type.String({ default: "main" })),
  commitSha: Type.Optional(Type.String()),
  environment: Type.Optional(Type.Union([
    Type.Literal("production"), Type.Literal("preview"),
  ])),
});

/** Public endpoint (domain/route) as sent by the deploy wizard. */
const PublicEndpointInput = Type.Object({
  port: Type.Optional(Type.String()),
  targetPath: Type.Optional(Type.String()),
  domain: Type.Optional(Type.String()),
  customDomain: Type.Optional(Type.String()),
  domainType: Type.Optional(Type.Union([Type.Literal("free"), Type.Literal("custom")])),
  /** Canonical redirect to another hostname of the same project instead of serving
   *  (validated by lib/domain-redirect.ts). Declared here because the deploy sends
   *  the endpoint list back and an omitted redirect CLEARS the stored one — a
   *  field the schema doesn't name is a field a deploy can silently drop. */
  redirectTo: Type.Optional(Type.String()),
  redirectStatus: Type.Optional(
    Type.Union([Type.Literal(301), Type.Literal(302), Type.Literal(307), Type.Literal(308)]),
  ),
});

/**
 * A service in a compose / multi-service deploy, as sent on the wire. This is a
 * subset of the pipeline's `DeployableService` (its extra compose-parser and
 * monorepo fields are all optional), so `Static<typeof BuildServiceInput>` is
 * structurally assignable to `DeployableService` where requestBuildAccess
 * consumes `services` — without depending on the compose parser type.
 */
const BuildServiceInput = Type.Object({
  name: Type.String(),
  image: Type.Optional(Type.String()),
  build: Type.Optional(Type.String()),
  dockerfile: Type.Optional(Type.String()),
  ports: Type.Array(Type.String()),
  dependsOn: Type.Array(Type.String()),
  environment: Type.Record(Type.String(), Type.String()),
  volumes: Type.Array(Type.String()),
  command: Type.Optional(Type.String()),
  restart: Type.Optional(Type.String()),
  exposed: Type.Optional(Type.Boolean()),
  exposedPort: Type.Optional(Type.String()),
  domain: Type.Optional(Type.String()),
  customDomain: Type.Optional(Type.String()),
  domainType: Type.Optional(Type.Union([Type.Literal("free"), Type.Literal("custom")])),
  // Additional public routes beyond the primary (multi-port service, e.g.
  // Convex's API 3210 + HTTP actions 3211). Entry[0] mirrors the primary above.
  publicEndpoints: Type.Optional(Type.Array(PublicEndpointInput)),
  // Source-built (monorepo) sub-app fields — optional, mirror MonorepoSubAppFields.
  kind: Type.Optional(Type.Union([Type.Literal("compose"), Type.Literal("monorepo")])),
  enabled: Type.Optional(Type.Boolean()),
  rootDirectory: Type.Optional(Type.String()),
  installCommand: Type.Optional(Type.String()),
  buildCommand: Type.Optional(Type.String()),
  startCommand: Type.Optional(Type.String()),
  outputDirectory: Type.Optional(Type.String()),
  framework: Type.Optional(Type.String()),
  packageManager: Type.Optional(Type.String()),
  buildImage: Type.Optional(Type.String()),
});

/**
 * Single source of truth for POST /deployments/build/access. `BuildAccessInput`
 * (build.service.ts) is derived from this via `Static<>`, and the MCP tool emits
 * it as the body param schema — one definition, no drift. The controller reads
 * it with `c.req.json<BuildAccessInput>()`; field types mirror the old interface
 * exactly so it's a drop-in. Kept strict (no additionalProperties) so the type
 * doesn't gain an index signature.
 */
export const BuildAccessBody = Type.Object({
  projectId: Type.String({ description: "Target project id (from projects/ensure). Required." }),
  uploadSessionId: Type.Optional(
    Type.String({ description: "Folder-upload session id — deploys the uploaded source instead of git." }),
  ),
  branch: Type.Optional(Type.String({ description: "Git branch (git-source projects)." })),
  environment: Type.Optional(Type.String({ description: "production | preview (default production)." })),
  envVars: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: "Runtime env vars { KEY: value }." }),
  ),
  publicEndpoints: Type.Optional(
    Type.Array(PublicEndpointInput, {
      description: "Domains/routes; omit to auto-derive a free subdomain from the project slug.",
    }),
  ),
  buildStrategy: Type.Optional(
    Type.Union([Type.Literal("server"), Type.Literal("local")], { description: "Where the build runs." }),
  ),
  deployTarget: Type.Optional(
    Type.Union([Type.Literal("local"), Type.Literal("server"), Type.Literal("cloud")], {
      description: "Usually omit for folder uploads — the upload session mode decides.",
    }),
  ),
  serverId: Type.Optional(Type.String({ description: "Target server id when deployTarget='server'." })),
  runtimeMode: Type.Optional(Type.Union([Type.Literal("bare"), Type.Literal("docker")])),
  serviceDeploymentMode: Type.Optional(Type.Union([Type.Literal("services"), Type.Literal("single")])),
  services: Type.Optional(
    Type.Array(BuildServiceInput, { description: "Compose / multi-service definitions (services mode)." }),
  ),
  serviceIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Subset of service ids to (re)build; every other service carries forward on its existing container, untouched. Omit to build the whole stack (first deploy). Use this on a scoped redeploy so stateful services (MySQL/Redis/Qdrant) are NOT recreated for an unrelated code change.",
    }),
  ),
  refreshServiceIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Subset of serviceIds to recreate WITHOUT rebuilding (env-only refresh).",
    }),
  ),
  handoverImages: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "ONE-TIME migration image handover: serviceName → an already-present image ref. Those services deploy from that image with no build/pull; used only on a migration's first deploy.",
    }),
  ),
  cloudResourceTier: Type.Optional(CloudResourceTierEnum()),
  cloudResourceCustom: Type.Optional(
    Type.Object(
      { cpuCores: Type.Number(), memoryMb: Type.Number(), diskMb: Type.Number() },
      { description: "CPU/RAM/disk when cloudResourceTier='custom'." },
    ),
  ),
  cloneStrategy: Type.Optional(Type.Union([Type.Literal("api-host"), Type.Literal("server")])),
});

// POST /prepare — detect stack/build config before deploying. All optional:
// the controller resolves source from (owner,repo) vs path and enforces the
// conditional requireds (owner+repo for github, path for local).
export const PrepareDeployBody = Type.Object({
  source: Type.Optional(
    Type.Union([Type.Literal("github"), Type.Literal("local")], {
      description: "Source kind; inferred from owner/repo vs path when omitted.",
    }),
  ),
  owner: Type.Optional(Type.String({ description: "GitHub repo owner (github source)." })),
  repo: Type.Optional(Type.String({ description: "GitHub repo name (github source)." })),
  branch: Type.Optional(Type.String({ description: "Git branch (github source)." })),
  path: Type.Optional(Type.String({ description: "Local filesystem path (local source; self-hosted only)." })),
  composePath: Type.Optional(
    Type.String({
      maxLength: 300,
      description:
        "Where the compose file lives when it is not at the auto-detected root — the file itself (\"deploy/stack.yml\", which also covers non-standard filenames) or the directory holding it (\"deploy/docker-compose\"). Detects the project as a compose/services deploy; errors when no compose file is there.",
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Env already configured for this deploy. Compose interpolation resolves against these on top of the repo .env, so a file declaring ${VAR:?...} scans once the user has supplied VAR.",
    }),
  ),
});

// POST /:id/build/respond — answer a build gate/prompt.
export const BuildRespondBody = Type.Object({
  action: Type.String({ description: "The gate response (e.g. approve / continue / cancel)." }),
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TDeploymentIdParam = Static<typeof DeploymentIdParam>;
export type TListDeploymentsQuery = Static<typeof ListDeploymentsQuery>;
export type TTriggerDeployBody = Static<typeof TriggerDeployBody>;
export type TBuildAccessBody = Static<typeof BuildAccessBody>;
