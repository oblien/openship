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

import {
  categoryServesFiles,
  normalizeServiceLabel,
  STACKS,
  type StackDefinition,
  type StackId,
} from "@repo/core";
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
  return categoryServesFiles((STACKS[framework as StackId] as StackDefinition).category);
}

/**
 * Resolve a sub-app's build recipe against its project snapshot — the ONE place
 * the row-vs-snapshot fallback lives.
 *
 * A monorepo row legitimately leaves its command columns null and INHERITS them
 * from the project (an inheriting sub-app, or the materialized single-app row), so
 * every question about "what will this row actually build/run" has to be asked of
 * the resolved values, never the raw row. Three call sites open-coded this same
 * `row ?? snapshot` triple — preflight, the buildable selector, and the
 * static-vs-server build decision — and they had already drifted: the selector
 * resolved the fallback while the static decision read the RAW row, so a sub-app
 * whose start command lived on the snapshot was selected as a server and then
 * built as static files.
 */
export function resolveSubAppRecipe(
  // `kind` is loosely typed for the same reason `serviceKind` is: callers pass a
  // persisted `service` row whose column is a plain string.
  service: {
    kind?: string | null;
    framework?: string | null;
    installCommand?: string | null;
    buildCommand?: string | null;
    startCommand?: string | null;
  },
  snapshot: {
    framework?: string | null;
    installCommand?: string | null;
    buildCommand?: string | null;
    startCommand?: string | null;
  },
): {
  kind: "compose" | "monorepo";
  framework: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
} {
  return {
    kind: serviceKind(service),
    framework: service.framework ?? snapshot.framework ?? null,
    installCommand: service.installCommand ?? snapshot.installCommand ?? null,
    buildCommand: service.buildCommand ?? snapshot.buildCommand ?? null,
    startCommand: service.startCommand ?? snapshot.startCommand ?? null,
  };
}

/**
 * Does a source-built unit carry enough of a recipe to PRODUCE an artifact?
 *
 * Three ways to satisfy it, and they are the only three the build side knows:
 *   - `framework === "docker"` — a Dockerfile owns install/build/start, so having
 *     no commands is correct there, not empty.
 *   - a build command — there is a build step to run.
 *   - a start command — run-only (prebuilt artifact in the repo, static serve);
 *     still needs containerizing, and the generated Dockerfile is happy with an
 *     empty build step as long as it has something to CMD.
 *
 * Pass the ALREADY-RESOLVED values (see {@link resolveSubAppRecipe}) — the verdict
 * lives here, the fallback there. `getProjectType` is NOT a substitute: it answers
 * "what shape is this stack" and returns "app" for the `generic` category, so a
 * project with no recipe at all (framework "unknown") reads as a deployable app
 * (issue #589).
 *
 * One helper because two sides must agree: compose/build.service.ts uses it to
 * decide a monorepo row is buildable, and services/service.service.ts uses it to
 * decide whether materializing an app row could ever succeed. When they
 * disagreed, materialization produced a row the builder refused to build and the
 * deploy died on "No image available".
 *
 * DELIBERATELY NOT an arm here: "it's a static framework, so the extract-only
 * recipe needs no commands". That is true, but it is a ROW-level fact
 * ({@link isStaticService} — it needs the row's `kind` and its resolved start
 * command), and this helper is shared with #589's phantom-app-row gate, which
 * asks about a PROJECT. Adding it here made a command-less `vite`/`react` project
 * whose `hasServer` is not `false` materialize a phantom app service row again —
 * the exact regression that gate exists to prevent. The static case belongs at the
 * build selector, next to `isStaticService`.
 */
export function hasSourceBuildRecipe(resolved: {
  framework?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
}): boolean {
  return (
    resolved.framework === "docker" ||
    !!resolved.buildCommand ||
    !!resolved.startCommand
  );
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
 * Parse the PUBLISHED (host-side) port from a compose-style port string, or null
 * when the mapping declares no host side.
 *   "8080:3000"           → 8080
 *   "127.0.0.1:8080:3000" → 8080 (an interface-scoped publish)
 *   "3000"                → null (container-only, docker picks the host port)
 *   "3000-3005:3000"      → null (a RANGE names no single port)
 *
 * The sibling of {@link parseServicePort}, which reads the container side. Both
 * live here so the two halves of one compose port string are parsed by one rule —
 * a route the operator points at the PUBLISHED port has to resolve to the same
 * service as one pointed at the container port.
 *
 * The `host` field of `parseComposePort` (migration/docker-reconcile.ts) answers the
 * same question for edge detection and publish stripping. This is deliberately the
 * routing layer's own accessor — the same split `parseServicePort` already lives on,
 * and `lib/` must not import from `modules/` — so the two are held to the same
 * answer by a drift guard in project-service-upstream.test.ts rather than by a shared
 * call.
 */
export function parseServiceHostPort(value?: string | null): number | null {
  if (!value) return null;
  const parts = value.trim().split("/")[0]?.split(":") ?? [];
  // Container-only ("3000") has a single segment and therefore no host side.
  if (parts.length < 2) return null;
  const host = parts[parts.length - 2]?.trim();
  const port = Number(host);
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

/**
 * The operator's custom east-west DNS alias for a service, if any — the ONE rule
 * for it.
 *
 * `advanced.alias` resolves ALONGSIDE the default (the row name), so this returns
 * only the EXTRA names; the primary is added by `buildNetworkAliases`. Shared by
 * the compose deploy (which passes it as `extraAliases` on the runtime config) and
 * by the migration attach-live network join — a reused container has to answer to
 * exactly the same names a natively-deployed one does, or east-west resolves for
 * deployed services and silently fails for migrated ones.
 */
export function serviceAliasExtras(service: {
  name: string;
  advanced?: unknown;
}): string[] | undefined {
  const raw = (service.advanced as { alias?: string } | null | undefined)?.alias;
  if (!raw) return undefined;
  const alias = normalizeServiceLabel(raw);
  if (!alias || alias === normalizeServiceLabel(service.name)) return undefined;
  return [alias];
}
