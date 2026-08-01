/**
 * Pipeline shape for "a thing the deploy machinery ships."
 *
 * Two flavors travel through the same pipeline, discriminated by `kind`:
 *
 *   - "compose"  - a docker-compose service backed by an image or a
 *                  Dockerfile. Same fields as the YAML - see `ComposeService`.
 *   - "monorepo" - a sub-app inside a workspace. Source-built; carries its
 *                  own install / build / start commands, framework, root dir.
 *
 * The parser in `compose-parser.ts` ONLY produces compose rows - the
 * monorepo branch is populated by `projectServicesToDeployableServices` (in
 * compose/project-services.ts) when projecting `service` table rows out for
 * the pipeline.
 *
 * Why the split: docker-compose.yml has no concept of install/build/start
 * commands or framework detection. Polluting `ComposeService` with those
 * fields gave every reader the impression that a YAML row could carry
 * them. Now the parser type is strict and only this wider type carries
 * the source-built fields.
 */

import { STACKS, type StackDefinition, type StackId } from "@repo/core";
import type { ComposeService } from "./compose-parser";

/** Source-built sub-app fields. Only meaningful when `kind === "monorepo"`. */
export interface MonorepoSubAppFields {
  /** Sub-app root inside the repo (e.g. "apps/web"). */
  rootDirectory?: string;
  /** Run after the shared workspace install. */
  installCommand?: string;
  /** The build step for this sub-app. */
  buildCommand?: string;
  /** Long-running workload entrypoint. */
  startCommand?: string;
  /** Sub-app build output, relative to `rootDirectory`. */
  outputDirectory?: string;
  /** Detected stack id (e.g. "nextjs", "vite"). */
  framework?: string;
  /** npm / pnpm / yarn / bun. */
  packageManager?: string;
  /** Build / runtime base image (e.g. "node:22"). */
  buildImage?: string;
}

/**
 * Wider shape consumed by the deploy pipeline. `kind` tells consumers which
 * subset of fields to read - compose rows ignore the monorepo fields and
 * vice versa.
 *
 * Compose-only rows can drop the `kind` field entirely (treated as
 * "compose"); explicit when the row is a monorepo sub-app.
 */
export type DeployableService = ComposeService & MonorepoSubAppFields & {
  kind?: "compose" | "monorepo";
  /**
   * Whether this service is enabled. Defaults to true for new rows;
   * preflight / pipeline use this to skip disabled rows. The DB column
   * is non-nullable so it's always a real boolean once projected from
   * a service row.
   */
  enabled?: boolean;
  /**
   * Additional public routes beyond the primary (one per port) — a multi-port
   * service (e.g. Convex's API 3210 + HTTP actions 3211). Entry[0] mirrors the
   * scalar exposed/exposedPort/domain fields. Persisted by syncFromCompose.
   */
  publicEndpoints?: Array<{
    port?: number | string | null;
    domain?: string | null;
    customDomain?: string | null;
    domainType?: string | null;
  }>;
  /**
   * Whether ANY service_deployment row has ever been recorded for this
   * service. `undefined` means unknown (the caller supplied services
   * directly, e.g. an in-flight wizard session, rather than projecting them
   * from the project's saved `service` rows) — preflight treats that as "not
   * provably dead" and keeps failing loudly. Only an explicit `false` — a
   * saved row this project has never once deployed — is eligible for the
   * dead-row carve-out.
   */
  everDeployed?: boolean;
};

/**
 * Narrow a service row's text `kind` column to the discriminator type.
 * Anything that isn't explicit "monorepo" is treated as "compose" - matches
 * the schema default and handles rows without an explicit kind.
 *
 * One helper so every consumer narrows the same way.
 */
export function serviceKind(
  service: { kind?: string | null } | { kind?: "compose" | "monorepo" },
): "compose" | "monorepo" {
  return (service as { kind?: string | null }).kind === "monorepo"
    ? "monorepo"
    : "compose";
}

/**
 * A monorepo sub-app that is a STATIC build (frontend/static framework, no
 * long-running server command of its own). Served as FILES rather than by running
 * a `startCommand`:
 *
 *   self-hosted → the build output is moved to a host directory and the edge serves
 *                 it with `root`. No container, no port, no second web server.
 *   cloud       → a minimal nginx image, because Oblien runs the workload and there
 *                 is no host directory to serve.
 *
 * Derived from the persisted `framework` category + absence of a start command, so
 * no extra DB column is needed. Compose services (Dockerfile/image) are never
 * treated as static here.
 */
export function isStaticService(service: {
  kind?: string | null;
  framework?: string | null;
  startCommand?: string | null;
}): boolean {
  if (serviceKind(service) !== "monorepo") return false;
  if (service.startCommand?.trim()) return false;
  const framework = service.framework;
  if (!framework || !(framework in STACKS)) return false;
  const category = (STACKS[framework as StackId] as StackDefinition).category;
  return category === "frontend" || category === "static";
}

/**
 * Parse the rightmost port from a compose-style port string.
 *   "3000"          → 3000
 *   "8080:3000"     → 3000 (container side)
 *   "8080:3000/tcp" → 3000
 *   undefined/empty → null
 */
export function parseServicePort(value?: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const last = trimmed.split(":").pop()?.split("/")[0]?.trim();
  const port = Number(last);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/**
 * Resolve a service's runtime listen port using the canonical priority:
 *
 *   1. `exposedPort` - explicit external mapping (highest precedence)
 *   2. First entry of `ports[]` - compose-style "HOST:CONTAINER" or "PORT"
 *   3. `fallback` - typically the project-level port. When undefined the
 *      helper returns null.
 *
 * Centralized so build.service.ts, deploy.service.ts, and routing-domains.ts
 * all compute the same number with consistent nullability and parser behavior.
 */
export function resolveServicePort(
  service: { exposedPort?: string | null; ports?: string[] | null },
  fallback?: number | null,
): number | null {
  return (
    parseServicePort(service.exposedPort) ??
    parseServicePort(service.ports?.[0]) ??
    (typeof fallback === "number" && fallback > 0 ? fallback : null)
  );
}
