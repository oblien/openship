/**
 * Compose build service - builds individual service images for a compose project.
 *
 * Each enabled service with a `build` context gets its own Docker image built
 * via the runtime adapter. Services using pre-built images (image-only) are
 * resolved directly without a build step.
 */

import type { MultiServiceRuntimeAdapter, ResourceConfig, BuildResult } from "@repo/adapters";
import { BuildLogger } from "@repo/adapters";
import { repos, type Deployment, type Project, type Service } from "@repo/db";

import {
  createDockerfileBuildConfig,
  createMonorepoSourceBuildConfig,
  type BuildConfigSnapshotLike,
} from "../build-config";
import * as sessionManager from "../session-manager";
import { serviceKind } from "../../../lib/deployable-service";
import { resolveServicePort } from "./domain-helpers";

function sanitizeComposeImageName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "service"
  );
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
    "framework" | "buildImage" | "packageManager" | "installCommand" | "buildCommand" | "startCommand" | "outputDirectory"
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

  const installCommand = service.installCommand ?? snapshot.installCommand ?? undefined;
  if (service.installCommand === null && installCommand !== undefined) {
    noteCommandFallback("installCommand", installCommand);
  }
  const buildCommand = service.buildCommand ?? snapshot.buildCommand ?? undefined;
  if (service.buildCommand === null && buildCommand !== undefined) {
    noteCommandFallback("buildCommand", buildCommand);
  }
  const startCommand = service.startCommand ?? snapshot.startCommand ?? undefined;
  if (service.startCommand === null && startCommand !== undefined) {
    noteCommandFallback("startCommand", startCommand);
  }

  return {
    stack: service.framework ?? snapshot.framework ?? undefined,
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
  /** Image/workspace refs created during this build phase, excluding image-only services. */
  builtImageRefs: Map<string, string>;
  buildFailures: Map<string, string>;
  /** Count of image-only (external) services included in imageRefs */
  externalCount: number;
  durationMs: number;
}

export async function buildComposeImages(opts: {
  project: Project;
  dep: Deployment;
  runtime: Pick<MultiServiceRuntimeAdapter, "name" | "build" | "buildImages">;
  logger: BuildLogger;
  snapshot: BuildConfigSnapshotLike;
  buildSessionId: string;
  buildEnvVars: Record<string, string>;
  buildResources: ResourceConfig;
  gitToken?: string;
  /** Relay helper path on the build host — desktop clone-on-server credential. */
  gitCredentialHelperPath?: string;
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
  const imageRefs = new Map<string, string>();
  const builtImageRefs = new Map<string, string>();
  const buildFailures = new Map<string, string>();
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
  // External = compose rows with a pre-built image and no Dockerfile build.
  const buildable = enabled.filter(
    (service) =>
      // Smart redeploy: skip building services that aren't in the target
      // subset — they're carried forward at deploy with their existing image.
      // Also skip env-only refresh services — they recreate from their
      // existing image (no rebuild).
      (!opts.targetServiceIds || opts.targetServiceIds.has(service.id)) &&
      !opts.refreshServiceIds?.has(service.id) &&
      (!!service.build ||
        (serviceKind(service) === "monorepo" &&
          !service.image &&
          (!!service.buildCommand || !!service.startCommand))),
  );
  const external = enabled.filter((service) => !service.build && !!service.image);

  // This seeds the UI check-list immediately so users see every service.
  for (const service of enabled) {
    sessionManager.broadcastServiceStatus(opts.dep.id, {
      serviceName: service.name,
      serviceId: service.id,
      status: "pending",
    });
  }

  for (const service of external) {
    if (service.image) {
      imageRefs.set(service.id, service.image);
      sessionManager.broadcastServiceStatus(opts.dep.id, {
        serviceName: service.name,
        serviceId: service.id,
        status: "built",
      });
    }
  }

  if (buildable.length > 0) {
    opts.logger.step(
      "build",
      "running",
      `Building ${buildable.length} compose service image${buildable.length === 1 ? "" : "s"}...`,
    );
  } else {
    opts.logger.step(
      "build",
      "completed",
      "Compose services use pre-built images - skipping build phase",
    );
  }

  // Prepare a build spec per service: constructs the per-service BuildConfig +
  // logger and broadcasts "building". Kept SEPARATE from the build itself so a
  // runtime that builds every service on one daemon (Docker) can clone/transfer
  // the shared source ONCE and build N images from it (see runtime.buildImages)
  // instead of re-cloning per service.
  const buildSpecFor = (service: Service) => {
    const isMonorepo = serviceKind(service) === "monorepo";
    // Build context resolution:
    //   - Compose service with Dockerfile  → service.build (the context dir)
    //   - Monorepo sub-app                 → service.rootDirectory
    //   - Fallback                         → snapshot.rootDirectory
    const context = service.build ?? service.rootDirectory ?? opts.snapshot.rootDirectory;
    const dockerfileLabel = service.dockerfile ? ` using ${service.dockerfile}` : "";
    opts.logger.log(
      `Building ${isMonorepo ? "monorepo app" : "compose service"} "${service.name}" from ${context || "."}${dockerfileLabel}...\n`,
      "info",
      { serviceName: service.name },
    );

    // NOTE: "building" is broadcast when this service's build actually STARTS
    // (after the shared clone), not here — otherwise every service shows as
    // building while we're still in the shared clone/prepare phase.

    // Per-service logger keeps native terminal bytes intact and routes by
    // serviceName. Inner step events are forwarded as plain service logs;
    // the outer orchestrator owns the top-level step lifecycle.
    const serviceLogger = new BuildLogger((entry) => {
      opts.logger.callback({
        timestamp: entry.timestamp,
        message: entry.message,
        level: entry.level,
        serviceName: service.name,
        serviceId: service.id,
        rawData: entry.rawData,
      });
    });

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
            ...resolveSubAppOverrides({ service, snapshot: opts.snapshot, logger: serviceLogger }),
            rootDirectory: context,
            port: resolveServicePort(service, opts.snapshot.port) ?? opts.snapshot.port,
            hasServer: true,
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
            rootDirectory: context,
            dockerfilePath: service.dockerfile ?? undefined,
            hasServer: true,
          },
        });

    // Clone-on-server credential, shared across the fan-out: the relay helper
    // (desktop) or the token already on buildConfig.gitToken (non-desktop).
    if (opts.cloneOnServer) buildConfig.cloneOnServer = true;
    if (opts.gitCredentialHelperPath) {
      buildConfig.gitCredentialHelperPath = opts.gitCredentialHelperPath;
    }

    return { service, buildConfig, serviceLogger };
  };

  // Record a per-service build result: image refs / failures + status broadcast.
  const applyBuildResult = (service: Service, buildResult: BuildResult) => {
    if (buildResult.status === "failed" || !buildResult.imageRef) {
      const failureMessage =
        buildResult.errorMessage ?? `Failed to build service "${service.name}"`;
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
    builtImageRefs.set(service.id, buildResult.imageRef);
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
        applyBuildResult(spec.service, await opts.runtime.build(spec.buildConfig, spec.serviceLogger));
      }),
    );
  }

  if (buildable.length > 0) {
    const succeeded = imageRefs.size - external.length;
    if (buildFailures.size === 0) {
      opts.logger.step(
        "build",
        "completed",
        `All ${succeeded} service image${succeeded === 1 ? "" : "s"} built successfully`,
      );
      opts.logger.log("Compose image build phase complete. Preparing deployment phase...\n");
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
    } else {
      opts.logger.step(
        "build",
        "failed",
        `All ${buildFailures.size} service image builds failed`,
      );
      opts.logger.log("Compose image build phase failed. Deployment will not continue.\n", "error");
    }
  }

  return {
    imageRefs,
    builtImageRefs,
    buildFailures,
    externalCount: external.length,
    durationMs: Date.now() - startedAt,
  };
}
