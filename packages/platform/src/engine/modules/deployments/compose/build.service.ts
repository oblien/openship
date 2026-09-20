/**
 * Compose build service - builds individual service images for a compose project.
 *
 * Each enabled service with a `build` context gets its own Docker image built
 * via the runtime adapter. Services using pre-built images (image-only) are
 * resolved directly without a build step.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type {
  AmbientGitVia,
  MultiServiceRuntimeAdapter,
  ResourceConfig,
  BuildResult,
} from "@repo/adapters";
import { BuildLogger, STATIC_RELEASE_BASE } from "@repo/adapters";
import { composeBuildIssues, validateImageReference, type ComposeAdvanced } from "@repo/core";
import { repos, type Deployment, type Project, type Service } from "@repo/db";

import {
  createDockerfileBuildConfig,
  createMonorepoSourceBuildConfig,
  type BuildConfigSnapshotLike,
} from "../build-config";
import * as sessionManager from "../session-manager";
import { pinnedImageForService } from "../pinned-artifacts";
import { newerThanRestoredRelease } from "./project-services";
import {
  serviceKind,
  isStaticService,
  hasSourceBuildRecipe,
  resolveSubAppRecipe,
} from "../../../lib/deployable-service";
import { normalizeProjectRootDirectory } from "../../../lib/project-root-detector";
import {
  resolveComposeEnvironmentTemplates,
  resolveComposeInterpolation,
} from "../../../lib/compose-parser";
import { resolveServicePort } from "./domain-helpers";
import { ServiceBuildDnsDiagnostics } from "./build-service-dns";

function sanitizeComposeImageName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "service"
  );
}

/** Resolve Compose build args against this deployment's final build environment.
 * Bare/null keys are omitted when unavailable (preserving Dockerfile defaults),
 * while persisted `${...}` expressions are evaluated here rather than leaking or
 * freezing a scan-time `.env` value. */
export function resolveComposeBuildArgs(
  raw: Record<string, string | null> | null | undefined,
  buildEnv: Record<string, string>,
  templateKeys: readonly string[] = [],
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const resolved: Record<string, string> = {};
  const missing = new Set<string>();
  const templates = new Set(templateKeys);
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) {
      if (Object.hasOwn(buildEnv, key)) resolved[key] = buildEnv[key]!;
    } else if (templates.has(key)) {
      // Compose interpolates every args value against the invocation environment
      // independently. Sibling args are not variables (`A=one`, `B=${A:-two}`
      // yields B=two unless the invocation env itself defines A).
      const dynamic = resolveComposeEnvironmentTemplates(buildEnv, { [key]: value });
      for (const item of dynamic.missingRequired) missing.add(item.variable);
      resolved[key] = dynamic.env[key] ?? "";
    } else {
      resolved[key] = value;
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `Compose build arguments require missing variable(s): ${[...missing].join(", ")}`,
    );
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * Resolve a Compose-authored image against the deployment's final project env.
 *
 * The parser also keeps its scan-time concrete value. That value is the safe
 * fallback when the compose-adjacent `.env` file supplied variables which are
 * intentionally not injected into every container/build environment. We only
 * trust that fallback when the scan recorded zero unresolved variables; an
 * unresolved preview can look syntactically valid (`repo:${TAG}suffix` →
 * `repo:suffix`) and must never be pulled.
 */
export function resolveComposeImage(
  image: string | null | undefined,
  template: ComposeAdvanced["imageTemplate"],
  deployEnv: Record<string, string>,
): string {
  let resolved = image?.trim() ?? "";

  if (template) {
    const dynamic = resolveComposeInterpolation(template.expression, deployEnv);
    if (dynamic.unresolvedVariables.length === 0) {
      resolved = dynamic.value.trim();
    } else if (template.unresolvedVariables.length > 0) {
      const variables = [...new Set(dynamic.unresolvedVariables)].sort();
      throw new Error(
        `Compose image requires missing variable${variables.length === 1 ? "" : "s"}: ${variables.join(", ")}`,
      );
    }
    // Otherwise the source scan resolved every variable (normally from the
    // compose-adjacent .env file). Keep that concrete, release-frozen preview.
  }

  const invalid = validateImageReference(resolved);
  if (invalid) throw new Error(invalid);

  return resolved;
}

/** A catalog template ships this service's Docker build context INLINE
 *  (`advanced.build`) — no repo, no pullable image. */
function hasInlineBuild(service: { advanced: unknown }): boolean {
  return !!(service.advanced as ComposeAdvanced | null)?.build;
}

interface InlineBuildContexts {
  /** serviceId → the shared context root + this service's Dockerfile inside it. */
  byServiceId: Map<string, { root: string; dockerfile: string }>;
  cleanup(): Promise<void>;
}

/**
 * Materialize every inline build context to a subdir under ONE shared temp root
 * on the orchestrator, and hand back the Dockerfile each service should build
 * (relative to that root, which `prepareSourceTree` consumes as `localPath` —
 * no git clone).
 *
 * One shared root rather than one per service for two reasons: `runtime.buildImages`
 * builds a whole batch against a single tree (specs[0]'s), and the subdir IS the
 * COPY prefix template authors write against — `COPY <service-name>/<file>`, which
 * only resolves when the Docker context is the root that subdir sits in.
 *
 * Callers own `cleanup()` once the build phase is done; a throw in here cleans up
 * after itself, so a failed materialize never leaks a temp dir per deploy.
 */
async function materializeInlineBuildContexts(buildable: Service[]): Promise<InlineBuildContexts> {
  const inline = buildable.filter(hasInlineBuild);
  const byServiceId = new Map<string, { root: string; dockerfile: string }>();
  if (inline.length === 0) return { byServiceId, cleanup: async () => {} };

  // One batch = one tree, so an inline context and a repo checkout can't coexist in
  // it: the inline service would fall through to the repo's ROOT Dockerfile and
  // build the wrong image under its own tag. Reachable only by hand — `advanced` is
  // an open object on the compose-sync route — since a catalog install produces
  // inline builds plus image-only sidecars, and those aren't buildable.
  if (inline.length !== buildable.length) {
    const repoBuilt = buildable
      .filter((service) => !hasInlineBuild(service))
      .map((service) => service.name)
      .join(", ");
    throw new Error(
      `Services with an inline build context can't be built alongside repo-built services (${repoBuilt}) — they need different build sources. Split them into separate projects.`,
    );
  }

  const root = await mkdtemp(join(tmpdir(), "openship-catalog-build-"));
  const cleanup = () => rm(root, { recursive: true, force: true }).catch(() => {});

  try {
    const subdirOwner = new Map<string, string>();
    for (const service of inline) {
      const build = (service.advanced as ComposeAdvanced).build!;
      // `advanced` is stored unvalidated, so a malformed blob has to be named here —
      // writeFile would only ever report ERR_INVALID_ARG_TYPE.
      if (typeof build.dockerfile !== "string" || !build.dockerfile.trim()) {
        throw new Error(
          `Service "${service.name}" has an inline build context with no Dockerfile contents.`,
        );
      }

      // Must be the sanitized service NAME, since that is what an author can write in
      // a COPY path (service.id is unknowable to them) — so two names that sanitize
      // alike would share a context dir AND an ambiguous prefix. Reject rather than
      // clobber one's Dockerfile and build the wrong image under the other's tag.
      const subdir = sanitizeComposeImageName(service.name);
      const clash = subdirOwner.get(subdir);
      if (clash) {
        throw new Error(
          `Inline build services "${clash}" and "${service.name}" both map to build-context subdir "${subdir}" — rename one so their Docker build contexts don't collide.`,
        );
      }
      subdirOwner.set(subdir, service.name);

      // Exactly one segment BELOW the root: sanitizing preserves dots, so a service
      // named ".." would otherwise write its context into os.tmpdir() — outside the
      // directory cleanup() removes.
      const serviceDir = join(root, subdir);
      if (dirname(serviceDir) !== root) {
        throw new Error(
          `Service "${service.name}" maps to an invalid build-context subdir "${subdir}".`,
        );
      }

      await mkdir(serviceDir, { recursive: true });
      await writeFile(join(serviceDir, "Dockerfile"), build.dockerfile, "utf-8");

      for (const file of build.files ?? []) {
        // Same unvalidated-blob reason as the Dockerfile check above.
        if (typeof file?.path !== "string" || typeof file?.content !== "string") {
          throw new Error(
            `Service "${service.name}" has an inline build file with a non-string path or content.`,
          );
        }
        // A context file must stay inside its service dir, and must not BE it (that
        // would writeFile over a directory). Matches a real parent ref only, not a
        // filename that merely starts with two dots ("..keep", "..dockerignore").
        const dest = join(serviceDir, file.path);
        const rel = relative(serviceDir, dest);
        if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error(`Invalid build file path "${file.path}" for service "${service.name}"`);
        }
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, file.content, "utf-8");
      }

      byServiceId.set(service.id, { root, dockerfile: `${subdir}/Dockerfile` });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { byServiceId, cleanup };
}

/**
 * Resolve a compose service's `build.context` to a path relative to the CLONE
 * ROOT, which is what BuildConfig.rootDirectory means.
 *
 * Compose resolves `build.context` relative to the compose FILE's directory, not
 * the repo root — so for a compose file at `deploy/docker-compose/`, `build: ./api`
 * means `deploy/docker-compose/api` and `build: ../../api` means `api`. Using the
 * raw value (as this did before) silently built the wrong directory for every
 * compose file that isn't at the repo root.
 *
 * `..` is resolved rather than rejected: pointing back at the repo root is normal
 * for a compose file kept in a `deploy/` subfolder. Escaping ABOVE the clone root
 * is refused. Falling back to another directory would silently build a different
 * artifact than the compose file requested.
 *
 * The directory half is normalized by the shared `normalizeProjectRootDirectory`
 * rather than a local regex pair, so a repo-relative directory means the same
 * thing here as everywhere else. That also makes the two halves symmetric — the
 * local version split the CONTEXT on `[\\/]` but the DIRECTORY on `/` only, so a
 * backslash or stray whitespace in the directory produced a literally broken path.
 */
export function resolveComposeBuildContext(composeDirectory: string, context: string): string {
  const invalid = composeBuildIssues(context)[0];
  if (invalid) {
    throw new Error(`Invalid Compose build context: ${invalid.reason}`);
  }

  // Already maps "." / "./" / "" → "", so no special-casing is needed below.
  const normalizedDirectory = normalizeProjectRootDirectory(composeDirectory);
  const segments = [...normalizedDirectory.split("/"), ...context.trim().split(/[\\/]/)].filter(
    (segment) => segment.length > 0 && segment !== ".",
  );

  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment !== "..") {
      resolved.push(segment);
      continue;
    }
    if (resolved.length === 0) {
      throw new Error("Invalid Compose build context: path escapes the linked repository.");
    }
    resolved.pop();
  }

  return resolved.join("/");
}

/**
 * Resolve a monorepo sub-app's build overrides on top of the project-level
 * snapshot, with a SINGLE, NAMED precedence rule:
 *
 *   per-service value (non-null on the row)  →  project-level snapshot default
 *
 * The DB invariant is that monorepo rows MAY have null columns even when the
 * project-level fields are populated - e.g. the workspace shares a package
 * manager and root build image. We accept the inheritance for legitimately
 * shared fields (framework, buildImage, packageManager, outputDirectory) and
 * for the command fields (install/build/start) where the user hasn't bothered
 * to set a per-app override.
 *
 * `logger` receives a one-line warning whenever a COMMAND falls back to the
 * project-level value. Commands are the most common per-app misconfiguration
 * (you meant to set startCommand="bun run apps/web/dist/server.js" but forgot
 * and got the workspace's "bun run start"). Surfacing the fallback in the
 * build trace lets the user see "this came from project, not service" instead
 * of silently picking up a value from a layer they weren't editing.
 */
interface SubAppOverrideInputs {
  service: {
    name: string;
    framework: string | null;
    buildImage: string | null;
    packageManager: string | null;
    installCommand: string | null;
    buildCommand: string | null;
    startCommand: string | null;
    outputDirectory: string | null;
  };
  snapshot: Pick<
    BuildConfigSnapshotLike,
    | "framework"
    | "buildImage"
    | "packageManager"
    | "installCommand"
    | "buildCommand"
    | "startCommand"
    | "outputDirectory"
  >;
  logger: Pick<BuildLogger, "log">;
}

function resolveSubAppOverrides(opts: SubAppOverrideInputs): {
  stack: string | undefined;
  buildImage: string | undefined;
  packageManager: string | undefined;
  installCommand: string | undefined;
  buildCommand: string | undefined;
  startCommand: string | undefined;
  outputDirectory: string;
} {
  const { service, snapshot, logger } = opts;

  const noteCommandFallback = (field: string, value: string | undefined) => {
    if (value !== undefined && value !== null && value !== "") {
      logger.log(
        `Sub-app "${service.name}" inherited ${field}="${value}" from project-level defaults (no per-service value set).\n`,
        "info",
        { serviceName: service.name },
      );
    }
  };

  // The row-vs-snapshot RULE comes from the shared resolver; this function keeps
  // only what is its own — the operator-facing log line per inherited command, and
  // the wider set of build fields. Re-deriving the rule here is what let the
  // buildable selector and the static-vs-server decision drift apart.
  const recipe = resolveSubAppRecipe(service, snapshot);
  const installCommand = recipe.installCommand ?? undefined;
  if (service.installCommand === null && installCommand !== undefined) {
    noteCommandFallback("installCommand", installCommand);
  }
  const buildCommand = recipe.buildCommand ?? undefined;
  if (service.buildCommand === null && buildCommand !== undefined) {
    noteCommandFallback("buildCommand", buildCommand);
  }
  const startCommand = recipe.startCommand ?? undefined;
  if (service.startCommand === null && startCommand !== undefined) {
    noteCommandFallback("startCommand", startCommand);
  }

  return {
    stack: recipe.framework ?? undefined,
    buildImage: service.buildImage ?? snapshot.buildImage ?? undefined,
    packageManager: service.packageManager ?? snapshot.packageManager ?? undefined,
    installCommand,
    buildCommand,
    startCommand,
    outputDirectory: service.outputDirectory ?? snapshot.outputDirectory ?? "",
  };
}

export interface ComposeBuildImagesResult {
  imageRefs: Map<string, string>;
  /** Exact service/image pairs that are already available on the deploy target
   * because they were built now or explicitly pinned by an internal workflow. */
  preparedLocalImages: Map<string, string>;
  /** Image/workspace refs created during this build phase, excluding image-only services. */
  builtImageRefs: Map<string, string>;
  /** Service id -> trusted host directory produced (or internally pinned) for
   * a self-hosted static sub-app. Kept separate from imageRefs so an arbitrary
   * absolute service.image can never be interpreted as a host artifact. */
  staticArtifactRefs: Map<string, string>;
  /** Effective static classification after applying project-snapshot fallback.
   * Needed when a refresh reuses the prior deployment's host artifact. */
  staticServiceIds: Set<string>;
  buildFailures: Map<string, string>;
  /** Count of image-only (external) services included in imageRefs */
  externalCount: number;
  /**
   * At least one service build came back "cancelled" (the user cancelled the
   * deployment). Distinct from buildFailures: the caller must stop WITHOUT
   * marking the deployment failed.
   */
  cancelled: boolean;
  durationMs: number;
}

export async function buildComposeImages(opts: {
  project: Project;
  dep: Deployment;
  runtime: Pick<MultiServiceRuntimeAdapter, "name" | "build" | "buildImages">;
  logger: BuildLogger;
  snapshot: BuildConfigSnapshotLike;
  buildSessionId: string;
  /** Project-scoped deployment env only. Compose image interpolation must not
   *  accidentally consume Openship's injected CI/build helper variables. */
  composeInterpolationEnv: Record<string, string>;
  buildEnvVars: Record<string, string>;
  buildResources: ResourceConfig;
  gitToken?: string;
  /** Relay helper path on the build host — desktop clone-on-server credential. */
  gitCredentialHelperPath?: string;
  /** Per-server SSH clone credential (ssh-server-key / deploy-key mode). */
  gitSsh?: { privateKey: string; knownHosts: string };
  /** The build host clones with its OWN verified git credentials (nothing shipped). */
  gitAmbient?: { via: AmbientGitVia };
  /** Clone each service on the remote build host instead of transferring. */
  cloneOnServer?: boolean;
  /** Smart (partial) redeploy: build ONLY these services. Undefined = build
   *  all (full deploy). Non-targeted services are left running / carried
   *  forward by the deploy step, so their existing image is reused. */
  targetServiceIds?: Set<string>;
  /** Env-only refresh subset (⊆ targetServiceIds): recreated at deploy from
   *  their existing image, so they're excluded from the build here. */
  refreshServiceIds?: Set<string>;
}): Promise<ComposeBuildImagesResult> {
  const services = await repos.service.listByProject(opts.project.id);
  const enabled = services.filter((service) => service.enabled);
  const serviceNames = new Set(enabled.map((service) => service.name));
  const buildDnsDiagnostics = new Map<string, ServiceBuildDnsDiagnostics>();
  const imageRefs = new Map<string, string>();
  const preparedLocalImages = new Map<string, string>();
  const builtImageRefs = new Map<string, string>();
  const staticArtifactRefs = new Map<string, string>();
  const staticServiceIds = new Set(
    enabled
      .filter((service) => isStaticService(resolveSubAppRecipe(service, opts.snapshot)))
      .map((service) => service.id),
  );
  const buildFailures = new Map<string, string>();
  const cancelledServices = new Set<string>();
  const startedAt = Date.now();

  // Buildable = anything that needs a per-service image build.
  //   - Compose rows with a Dockerfile context (service.build set).
  //   - Monorepo sub-apps (kind="monorepo") with EITHER a buildCommand or a
  //     startCommand. Run-only sub-apps (prebuilt artifacts in repo, static
  //     serve, etc.) have no buildCommand but still need to be containerized
  //     to start - the generated Dockerfile is happy with an empty
  //     buildCommand as long as it has something to CMD. Excluding them
  //     would drop them to neither bucket and they'd silently fail at
  //     deploy time with a misleading "No image available" error.
  //   - A `framework === "docker"` sub-app ALWAYS counts too, even with both
  //     commands empty: it builds from its own repo Dockerfile (the Dockerfile
  //     owns install/build/start), so requiring a build or start command here
  //     would drop every Dockerfile-based monorepo sub-app to neither bucket -
  //     the same silent "No image available" failure.
  // External = compose rows with a pre-built image and no Dockerfile build.
  // PINNED ARTIFACT: a service whose image is pinned deploys from that
  // already-present image with NO build and NO pull — seeded straight into
  // imageRefs, exactly like a freshly-built one, so the SAME native deploy step
  // consumes it. Two producers, one mechanism (see pinned-artifacts.ts): the
  // migration cutover's one-time handover, and a rollback restoring a past
  // release's retained images. A plain Redeploy strips the pins and rebuilds
  // natively — no separate migration or rollback deploy path exists.
  const isHandedOver = (service: { name: string }) =>
    !!pinnedImageForService(opts.snapshot, service.name);

  // Rollback: a service added after the restored release is carried forward by
  // the deploy step, so building it here is pure waste — and for a source-built
  // one it fails, because the release's commit may not contain it at all.
  const isNewerThanRelease = newerThanRestoredRelease(opts.dep);

  const buildable = enabled.filter(
    (service) =>
      !isHandedOver(service) &&
      !isNewerThanRelease(service) &&
      // Smart redeploy: skip building services that aren't in the target
      // subset — they're carried forward at deploy with their existing image.
      // Also skip env-only refresh services — they recreate from their
      // existing image (no rebuild).
      (!opts.targetServiceIds || opts.targetServiceIds.has(service.id)) &&
      !opts.refreshServiceIds?.has(service.id) &&
      (!!service.build ||
        // Catalog template shipping an inline Docker build context: no repo and no
        // `build` column, so it needs the materialization below to build at all.
        hasInlineBuild(service) ||
        (serviceKind(service) === "monorepo" &&
          !service.image &&
          // Asked of the RESOLVED recipe, not the raw row: a monorepo row whose
          // command lives on the project snapshot (an inheriting sub-app, or the
          // #231 materialized app row) must be selected as buildable HERE too.
          // Keying off the raw row dropped it to neither bucket → the misleading
          // "No image available" the comment above warns of.
          //
          // Two accepting verdicts, deliberately separate:
          //   • `hasSourceBuildRecipe` — shared verbatim with the row-materializer
          //     so the two cannot disagree (#589).
          //   • `isStaticService` — a static sub-app is served as FILES, and its
          //     extract-only recipe is a valid Dockerfile with an EMPTY build step.
          //     So a sub-app that is already just files (hand-written HTML, a
          //     committed `dist/`) has no command to declare and is still buildable.
          //     This arm lives here rather than inside `hasSourceBuildRecipe`
          //     because it is a row-level fact and that helper is shared with a
          //     PROJECT-level gate — see its docblock.
          (hasSourceBuildRecipe(resolveSubAppRecipe(service, opts.snapshot)) ||
            isStaticService(resolveSubAppRecipe(service, opts.snapshot))))),
  );
  const external = enabled.filter(
    (service) =>
      !isHandedOver(service) &&
      !service.build &&
      !hasInlineBuild(service) &&
      Boolean(service.image || (service.advanced as ComposeAdvanced | null)?.imageTemplate),
  );

  // Repo-less catalog builds need their context on disk before any spec is built,
  // and gone once the build phase ends (the images live on the deploy host).
  const inlineBuilds = await materializeInlineBuildContexts(buildable);

  try {
    // This seeds the UI check-list immediately so users see every service.
    for (const service of enabled) {
      sessionManager.broadcastServiceStatus(opts.dep.id, {
        serviceName: service.name,
        serviceId: service.id,
        status: "pending",
      });
    }

    for (const service of enabled) {
      const pinned = pinnedImageForService(opts.snapshot, service.name);
      if (!pinned) continue;
      imageRefs.set(service.id, pinned);
      preparedLocalImages.set(service.id, pinned);
      if (pinned.startsWith("/") && staticServiceIds.has(service.id)) {
        staticArtifactRefs.set(service.id, pinned);
      }
      sessionManager.broadcastServiceStatus(opts.dep.id, {
        serviceName: service.name,
        serviceId: service.id,
        status: "built",
      });
    }

    for (const service of external) {
      try {
        const image = resolveComposeImage(
          service.image,
          (service.advanced as ComposeAdvanced | null)?.imageTemplate,
          opts.composeInterpolationEnv,
        );
        imageRefs.set(service.id, image);
        sessionManager.broadcastServiceStatus(opts.dep.id, {
          serviceName: service.name,
          serviceId: service.id,
          status: "built",
        });
      } catch (err) {
        const failureMessage =
          err instanceof Error ? err.message : `Invalid image for service "${service.name}"`;
        buildFailures.set(service.id, failureMessage);
        opts.logger.log(
          `Compose service "${service.name}" image resolution failed: ${failureMessage}\n`,
          "error",
          { serviceName: service.name },
        );
        sessionManager.broadcastServiceStatus(opts.dep.id, {
          serviceName: service.name,
          serviceId: service.id,
          status: "failed",
          error: failureMessage,
        });
      }
    }

    if (buildable.length > 0) {
      opts.logger.step(
        "build",
        "running",
        `Building ${buildable.length} compose service image${buildable.length === 1 ? "" : "s"}...`,
      );
      sessionManager.broadcastInstallPhase(opts.dep.id, { id: "images", status: "active" });
    } else {
      opts.logger.step(
        "build",
        "completed",
        "Compose services use pre-built images - skipping build phase",
      );
      // Pull-only app (the common catalog case): no image to build → show the phase
      // complete instantly rather than briefly "active".
      sessionManager.broadcastInstallPhase(opts.dep.id, { id: "images", status: "skipped" });
    }

    // Prepare a build spec per service: constructs the per-service BuildConfig +
    // logger and broadcasts "building". Kept SEPARATE from the build itself so a
    // runtime that builds every service on one daemon (Docker) can clone/transfer
    // the shared source ONCE and build N images from it (see runtime.buildImages)
    // instead of re-cloning per service.
    const buildSpecFor = (service: Service) => {
      const inlineBuild = inlineBuilds.byServiceId.get(service.id);
      // An inline context is a Dockerfile build by definition, so a monorepo row
      // carrying one must not reach the source-build factory below — that one
      // ignores localPath and would build the project's repo instead.
      const isMonorepo = !inlineBuild && serviceKind(service) === "monorepo";
      // Build context resolution:
      //   - Inline catalog build             → the shared materialized ROOT. The
      //     subdir rides in the Dockerfile path instead, which is what makes the
      //     author's `COPY <service-name>/<file>` resolve on every runtime (docker
      //     builds with the context dir; cloud tars up `rootDirectory`).
      //   - Compose service with Dockerfile  → service.build, resolved against the
      //     compose file's directory (compose semantics — see
      //     resolveComposeBuildContext)
      //   - Monorepo sub-app                 → service.rootDirectory
      //   - Fallback                         → snapshot.rootDirectory
      const context = inlineBuild
        ? ""
        : service.build != null
          ? resolveComposeBuildContext(opts.snapshot.rootDirectory ?? "", service.build)
          : (service.rootDirectory ?? opts.snapshot.rootDirectory);
      // #634: `build` is a build CONTEXT, so the runtime must point docker AT it —
      // not merely resolve the Dockerfile inside it while building the whole clone.
      // Without this the service's own `COPY requirements.txt` looked for the file at
      // the repo root, and the repo's root `.dockerignore` pruned the service's tree.
      //
      // Only where the user actually declared a context. `rootDirectory` (monorepo
      // sub-apps) stays a subdir WITHIN a whole-repo context — those build from a
      // generated recipe that COPYs the workspace root. An inline catalog build keeps
      // the root too: its context is the materialized root and the per-service subdir
      // rides in the Dockerfile path, which is what makes a template author's
      // `COPY <service-name>/<file>` resolve.
      const buildContextDirectory = !inlineBuild && service.build != null ? context : undefined;
      const dockerfile = inlineBuild?.dockerfile ?? service.dockerfile;
      const from =
        buildContextDirectory !== undefined ? `build context ${context || "."}` : context || ".";
      opts.logger.log(
        `Building ${isMonorepo ? "monorepo app" : "compose service"} "${service.name}" from ${from}${dockerfile ? ` using ${dockerfile}` : ""}...\n`,
        "info",
        { serviceName: service.name },
      );

      // NOTE: "building" is broadcast when this service's build actually STARTS
      // (after the shared clone), not here — otherwise every service shows as
      // building while we're still in the shared clone/prepare phase.

      // Per-service logger keeps native terminal bytes intact and routes by
      // serviceName. Inner step events are forwarded as plain service logs;
      // the outer orchestrator owns the top-level step lifecycle.
      const dnsDiagnostics =
        opts.runtime.name === "docker" ? new ServiceBuildDnsDiagnostics(serviceNames) : undefined;
      if (dnsDiagnostics) buildDnsDiagnostics.set(service.id, dnsDiagnostics);
      const serviceLogger = new BuildLogger(
        (entry) => {
          opts.logger.callback({
            timestamp: entry.timestamp,
            message: entry.message,
            level: entry.level,
            serviceName: service.name,
            serviceId: service.id,
            rawData: entry.rawData,
          });
        },
        (data, streamId) => dnsDiagnostics?.observe(data, streamId),
      );

      if (opts.runtime.name === "cloud" && !opts.project.localPath) {
        opts.logger.log(
          `Resolving Dockerfile for compose service "${service.name}" from the build source checkout.\n`,
          "info",
          { serviceName: service.name },
        );
      }

      // BuildConfig differs by kind:
      //   - Compose service (Dockerfile in repo) → createDockerfileBuildConfig
      //     forces stack="docker", clears install/build/start so the runtime
      //     defers everything to the repo Dockerfile.
      //   - Monorepo sub-app (source build)      → createMonorepoSourceBuildConfig
      //     keeps the sub-app's stack/installCommand/buildCommand/startCommand/
      //     outputDirectory so the runtime synthesizes a Dockerfile from them.
      const buildSlug = `${sanitizeComposeImageName(opts.project.slug ?? opts.project.name)}-${sanitizeComposeImageName(service.name)}`;
      const buildConfig = isMonorepo
        ? createMonorepoSourceBuildConfig({
            project: opts.project,
            dep: opts.dep,
            snapshot: opts.snapshot,
            sessionId: `${opts.buildSessionId}-${service.id}`,
            envVars: opts.buildEnvVars,
            resources: opts.buildResources,
            gitToken: opts.gitToken,
            overrides: {
              slug: buildSlug,
              ...resolveSubAppOverrides({
                service,
                snapshot: opts.snapshot,
                logger: serviceLogger,
              }),
              rootDirectory: context,
              port: resolveServicePort(service, opts.snapshot.port) ?? opts.snapshot.port,
              // A static sub-app (no start command) serves FILES; a server sub-app
              // runs its start command. Derived from framework + start command.
              //
              // On self-hosted the files are moved to the host and served by the edge
              // — no container, no port, no second web server. That is why
              // `staticExtractOnly` is gated on the runtime: on CLOUD there is no host
              // directory to serve (Oblien runs the workload), so those keep the
              // generated nginx image and stay a proxied container.
              ...(isStaticService(resolveSubAppRecipe(service, opts.snapshot))
                ? {
                    isStatic: true,
                    hasServer: false,
                    ...(opts.runtime.name === "cloud"
                      ? {}
                      : {
                          staticExtractOnly: true,
                          staticOutDir: `${STATIC_RELEASE_BASE}/.builds/${opts.buildSessionId}-${service.id}`,
                        }),
                  }
                : { hasServer: true }),
            },
          })
        : createDockerfileBuildConfig({
            project: opts.project,
            dep: opts.dep,
            snapshot: opts.snapshot,
            sessionId: `${opts.buildSessionId}-${service.id}`,
            envVars: opts.buildEnvVars,
            resources: opts.buildResources,
            gitToken: opts.gitToken,
            overrides: {
              slug: buildSlug,
              // BOTH: `rootDirectory` stays the context because the cloud runtime
              // reads only that field as its context root, while
              // `buildContextDirectory` is what narrows the docker build on a
              // self-hosted target. Same value, two readers.
              rootDirectory: context,
              buildContextDirectory,
              dockerfilePath: dockerfile ?? undefined,
              buildArgs: resolveComposeBuildArgs(
                service.buildArgs,
                opts.buildEnvVars,
                service.advanced?.buildArgTemplateKeys,
              ),
              // Inline catalog build: the source IS the materialized root, so
              // prepareSourceTree copies it instead of cloning a repo.
              ...(inlineBuild ? { localPath: inlineBuild.root } : {}),
              hasServer: true,
            },
          });

      // Clone-on-server credential, shared across the fan-out (all services share
      // one repo): the relay helper (desktop), a per-server ssh key, the server's
      // own ambient credentials, or the token already on buildConfig.gitToken.
      // Never for an inline build — cloning on the host replaces the shared tree,
      // so the materialized context would never reach the build.
      if (opts.cloneOnServer && !inlineBuild) buildConfig.cloneOnServer = true;
      if (opts.gitCredentialHelperPath) {
        buildConfig.gitCredentialHelperPath = opts.gitCredentialHelperPath;
      }
      if (opts.gitSsh) buildConfig.gitSsh = opts.gitSsh;
      if (opts.gitAmbient) buildConfig.gitAmbient = opts.gitAmbient;

      return { service, buildConfig, serviceLogger };
    };

    // Record a per-service build result: image refs / failures + status broadcast.
    const applyBuildResult = (service: Service, buildResult: BuildResult) => {
      const dnsDiagnostics = buildDnsDiagnostics.get(service.id);
      buildDnsDiagnostics.delete(service.id);
      // Cancelled ≠ failed: tracked separately so the pipeline can stop without
      // recording a build failure on the deployment. The per-service SSE status
      // union has no "cancelled" member, so the tab reports the reason instead of
      // being left spinning on "building".
      if (buildResult.status === "cancelled") {
        cancelledServices.add(service.id);
        opts.logger.log(`Compose service "${service.name}" build cancelled\n`, "info", {
          serviceName: service.name,
        });
        sessionManager.broadcastServiceStatus(opts.dep.id, {
          serviceName: service.name,
          serviceId: service.id,
          status: "failed",
          error: "Build cancelled",
        });
        return;
      }

      if (buildResult.status === "failed" || !buildResult.imageRef) {
        const originalFailure =
          buildResult.errorMessage ?? `Failed to build service "${service.name}"`;
        const hint = dnsDiagnostics?.finish(originalFailure);
        const failureMessage = hint ? `${originalFailure}\n\n${hint}` : originalFailure;
        buildFailures.set(service.id, failureMessage);
        opts.logger.log(
          `Compose service "${service.name}" build failed: ${failureMessage}\n`,
          "error",
          { serviceName: service.name },
        );
        sessionManager.broadcastServiceStatus(opts.dep.id, {
          serviceName: service.name,
          serviceId: service.id,
          status: "failed",
          error: failureMessage,
        });
        return;
      }

      imageRefs.set(service.id, buildResult.imageRef);
      preparedLocalImages.set(service.id, buildResult.imageRef);
      builtImageRefs.set(service.id, buildResult.imageRef);
      if (buildResult.imageRef.startsWith("/") && staticServiceIds.has(service.id)) {
        staticArtifactRefs.set(service.id, buildResult.imageRef);
      }
      opts.logger.log(
        `Compose service "${service.name}" image ready: ${buildResult.imageRef}\n`,
        "info",
        { serviceName: service.name },
      );
      sessionManager.broadcastServiceStatus(opts.dep.id, {
        serviceName: service.name,
        serviceId: service.id,
        status: "built",
      });
    };

    const specs = buildable.map(buildSpecFor);

    if (typeof opts.runtime.buildImages === "function") {
      // Docker: clone + prune the shared repo ONCE (transfer once for SSH), then
      // build every image from that single tree — sequentially — no per-service
      // re-clone. Per-service status/imageRef is applied via onResult the moment
      // each build settles (not after the whole batch), so the UI follows the one
      // service that's currently building and each tab streams its own output.
      await opts.runtime.buildImages(
        specs.map((spec) => ({
          config: spec.buildConfig,
          serviceName: spec.service.name,
          logger: spec.serviceLogger,
          // Flip to "building" only when THIS image's build starts (post-clone),
          // so services stay "pending" through the shared clone/prepare phase.
          onStart: () =>
            sessionManager.broadcastServiceStatus(opts.dep.id, {
              serviceName: spec.service.name,
              serviceId: spec.service.id,
              status: "building",
            }),
          onResult: (result) => applyBuildResult(spec.service, result),
        })),
        opts.logger,
      );
    } else {
      // Runtimes without a batch build (e.g. cloud — each service is a separate
      // instance): build per service, as before.
      await Promise.all(
        specs.map(async (spec) => {
          sessionManager.broadcastServiceStatus(opts.dep.id, {
            serviceName: spec.service.name,
            serviceId: spec.service.id,
            status: "building",
          });
          applyBuildResult(
            spec.service,
            await opts.runtime.build(spec.buildConfig, spec.serviceLogger),
          );
        }),
      );
    }

    // Non-empty only for services derived from `buildable`, so it implies there was
    // something to build.
    if (cancelledServices.size > 0) {
      // "failed" is the closest step state there is — BuildLogger has no cancelled
      // one — but no install phase is marked done: the deployment's own cancelled
      // status is the outcome the user is waiting on.
      opts.logger.step("build", "failed", "Image build cancelled");
      opts.logger.log("Compose image build cancelled. Deployment will not continue.\n", "error");
    } else if (buildable.length > 0) {
      // Count of images actually BUILT (builtImageRefs is set only on a build) —
      // not imageRefs.size, which also holds external/pull + handed-over images.
      const succeeded = builtImageRefs.size;
      if (buildFailures.size === 0) {
        opts.logger.step(
          "build",
          "completed",
          `All ${succeeded} service image${succeeded === 1 ? "" : "s"} built successfully`,
        );
        opts.logger.log("Compose image build phase complete. Preparing deployment phase...\n");
        sessionManager.broadcastInstallPhase(opts.dep.id, { id: "images", status: "done" });
      } else if (succeeded > 0) {
        opts.logger.step(
          "build",
          "failed",
          `Built ${succeeded}/${buildable.length} images, but ${buildFailures.size} failed`,
        );
        opts.logger.log(
          "Compose image build phase failed. Deployment will not continue.\n",
          "error",
        );
        sessionManager.broadcastInstallPhase(opts.dep.id, { id: "images", status: "failed" });
      } else {
        opts.logger.step(
          "build",
          "failed",
          `All ${buildFailures.size} service image builds failed`,
        );
        opts.logger.log(
          "Compose image build phase failed. Deployment will not continue.\n",
          "error",
        );
        sessionManager.broadcastInstallPhase(opts.dep.id, { id: "images", status: "failed" });
      }
    }
  } finally {
    await inlineBuilds.cleanup();
  }

  return {
    imageRefs,
    preparedLocalImages,
    builtImageRefs,
    staticArtifactRefs,
    staticServiceIds,
    buildFailures,
    externalCount: external.length,
    cancelled: cancelledServices.size > 0,
    durationMs: Date.now() - startedAt,
  };
}
