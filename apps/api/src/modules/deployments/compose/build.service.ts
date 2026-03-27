/**
 * Compose build service — builds individual service images for a compose project.
 *
 * Each enabled service with a `build` context gets its own Docker image built
 * via the runtime adapter. Services using pre-built images (image-only) are
 * resolved directly without a build step.
 */

import type { BuildConfig, ResourceConfig } from "@repo/adapters";
import { BuildLogger } from "@repo/adapters";
import { repos, type Deployment, type Project } from "@repo/db";

import { createBuildConfig, type BuildConfigSnapshotLike } from "../build-config";
import * as sessionManager from "../session-manager";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeComposeImageName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "service";
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComposeBuildImagesResult {
  imageRefs: Map<string, string>;
  buildFailures: Map<string, string>;
  /** Count of image-only (external) services included in imageRefs */
  externalCount: number;
  durationMs: number;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function buildComposeImages(opts: {
  project: Project;
  dep: Deployment;
  runtime: {
    build(config: BuildConfig, logger?: BuildLogger): Promise<{
      status: string;
      imageRef?: string;
      durationMs?: number;
      errorMessage?: string;
    }>;
  };
  logger: BuildLogger;
  snapshot: BuildConfigSnapshotLike;
  buildSessionId: string;
  buildEnvVars: Record<string, string>;
  buildResources: ResourceConfig;
  gitToken?: string;
}): Promise<ComposeBuildImagesResult> {
  const services = await repos.service.listByProject(opts.project.id);
  const enabled = services.filter((service) => service.enabled);
  const imageRefs = new Map<string, string>();
  const buildFailures = new Map<string, string>();
  const startedAt = Date.now();

  const buildable = enabled.filter((service) => !!service.build);
  const external = enabled.filter((service) => !service.build && !!service.image);

  // ── Broadcast initial per-service status for ALL services ──────────
  // This seeds the UI check-list immediately so users see every service.
  for (const service of enabled) {
    sessionManager.broadcastServiceStatus(opts.dep.id, {
      serviceName: service.name,
      serviceId: service.id,
      status: "pending",
    });
  }

  if (buildable.length > 0) {
    opts.logger.step("build", "running", `Building ${buildable.length} compose service image${buildable.length === 1 ? "" : "s"}...`);
  } else {
    opts.logger.step("build", "completed", "Compose services use pre-built images — skipping build phase");
  }

  for (const service of external) {
    if (service.image) {
      imageRefs.set(service.id, service.image);
    }
  }

  for (const service of buildable) {
    const context = service.build ?? opts.snapshot.rootDirectory;
    const dockerfileLabel = service.dockerfile ? ` using ${service.dockerfile}` : "";
    opts.logger.log(`Building compose service "${service.name}" from ${context || "."}${dockerfileLabel}...\n`);

    // Broadcast "building" so the UI shows a spinner for this service
    sessionManager.broadcastServiceStatus(opts.dep.id, {
      serviceName: service.name,
      serviceId: service.id,
      status: "building",
    });

    const buildResult = await opts.runtime.build(
      createBuildConfig({
        project: opts.project,
        dep: opts.dep,
        snapshot: opts.snapshot,
        sessionId: `${opts.buildSessionId}-${service.id}`,
        envVars: opts.buildEnvVars,
        resources: opts.buildResources,
        gitToken: opts.gitToken,
        overrides: {
          slug: `${sanitizeComposeImageName(opts.project.slug ?? opts.project.name)}-${sanitizeComposeImageName(service.name)}`,
          stack: "docker",
          rootDirectory: context,
          dockerfilePath: service.dockerfile ?? undefined,
          hasServer: true,
        },
      }),
      opts.logger,
    );

    if (buildResult.status === "failed" || !buildResult.imageRef) {
      const failureMessage = buildResult.errorMessage ?? `Failed to build service "${service.name}"`;
      buildFailures.set(service.id, failureMessage);
      opts.logger.log(`Compose service "${service.name}" build failed: ${failureMessage}\n`, "error");
      sessionManager.broadcastServiceStatus(opts.dep.id, {
        serviceName: service.name,
        serviceId: service.id,
        status: "failed",
        error: failureMessage,
      });
      continue;
    }

    imageRefs.set(service.id, buildResult.imageRef);
    sessionManager.broadcastServiceStatus(opts.dep.id, {
      serviceName: service.name,
      serviceId: service.id,
      status: "built",
    });
  }

  if (buildable.length > 0) {
    const succeeded = imageRefs.size - external.length;
    if (buildFailures.size === 0) {
      opts.logger.step("build", "completed", `All ${succeeded} service image${succeeded === 1 ? "" : "s"} built successfully`);
    } else {
      opts.logger.step("build", "completed", `Built ${succeeded}/${buildable.length} images (${buildFailures.size} failed)`);
    }
  }

  return {
    imageRefs,
    buildFailures,
    externalCount: external.length,
    durationMs: Date.now() - startedAt,
  };
}
