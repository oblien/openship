/**
 * Deployment validation schemas - TypeBox for Hono route validation.
 */

import { Type, type Static } from "@sinclair/typebox";

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
  cloudResourceTier: Type.Optional(
    Type.Union([
      Type.Literal("micro"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("custom"),
    ]),
  ),
  cloudResourceCustom: Type.Optional(
    Type.Object(
      { cpuCores: Type.Number(), memoryMb: Type.Number(), diskMb: Type.Number() },
      { description: "CPU/RAM/disk when cloudResourceTier='custom'." },
    ),
  ),
  cloneStrategy: Type.Optional(Type.Union([Type.Literal("api-host"), Type.Literal("server")])),
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TDeploymentIdParam = Static<typeof DeploymentIdParam>;
export type TListDeploymentsQuery = Static<typeof ListDeploymentsQuery>;
export type TTriggerDeployBody = Static<typeof TriggerDeployBody>;
export type TBuildAccessBody = Static<typeof BuildAccessBody>;
