/**
 * Project cleanup orchestrator — resource manifest + bounded-concurrency teardown.
 *
 * Reuses the same patterns as deployment-lifecycle.ts:
 *   1. Collect a manifest of all resources (containers, images, artifacts, routes)
 *   2. Execute cleanup with bounded concurrency + per-item error isolation
 *   3. Retry transient failures once with backoff
 *
 * Used by:
 *   - deleteProject()           → full project teardown
 *   - deleteDeployment()        → single deployment teardown
 */

import { repos, type Project, type Deployment } from "@repo/db";
import { DockerRuntime, type RuntimeAdapter } from "@repo/adapters";
import { NotFoundError } from "@repo/core";
import { platform } from "../../lib/controller-helpers";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { buildServiceRouteDomain } from "../../lib/routing-domains";
import { isComposeProject } from "../deployments/compose";

// ─── Resource Manifest ───────────────────────────────────────────────────────

export interface CleanupResource {
  type: "container" | "image" | "artifact" | "route";
  /** Runtime-specific identifier (container ID, image ref, hostname, etc.) */
  ref: string;
  /** Label for logging */
  label: string;
  /** The runtime to use for destroy/removeImage — null for routes */
  runtime: RuntimeAdapter | null;
}

export interface CleanupManifest {
  projectId: string;
  resources: CleanupResource[];
}

export interface CleanupResult {
  total: number;
  succeeded: number;
  failed: { ref: string; label: string; error: string }[];
}

// ─── Manifest Collectors ─────────────────────────────────────────────────────

/**
 * Collect ALL resources owned by a project into a flat manifest.
 * Single pass: queries DB once per resource type, no per-item queries in loops.
 */
export async function collectProjectManifest(project: Project): Promise<CleanupManifest> {
  const resources: CleanupResource[] = [];
  const { routing } = platform();
  const isCompose = isComposeProject(project);

  // ── Deployment containers + images + service containers ────────────
  const { rows: allDeps } = await repos.deployment.listByProject(project.id, { perPage: 1000 });
  const seenImages = new Set<string>();

  for (const dep of allDeps) {
    let runtime: RuntimeAdapter;
    try {
      ({ runtime } = await resolveDeploymentRuntime(dep));
    } catch {
      // Can't resolve runtime (e.g. server deleted) — skip runtime resources
      continue;
    }

    // Service containers (compose projects)
    if (isCompose) {
      const serviceRows = await repos.service.listByDeployment(dep.id);
      for (const sd of serviceRows) {
        if (sd.containerId) {
          resources.push({
            type: "container",
            ref: sd.containerId,
            label: `service container ${sd.containerId.slice(0, 12)}`,
            runtime,
          });
        }
      }
    }

    // Main deployment container
    if (dep.containerId) {
      resources.push({
        type: "container",
        ref: dep.containerId,
        label: `deployment container ${dep.containerId.slice(0, 12)}`,
        runtime,
      });
    }

    // Docker images (deduplicated)
    if (dep.imageRef && !seenImages.has(dep.imageRef) && runtime instanceof DockerRuntime) {
      seenImages.add(dep.imageRef);
      resources.push({
        type: "image",
        ref: dep.imageRef,
        label: `image ${dep.imageRef.slice(0, 24)}`,
        runtime,
      });
    }

    // Bare runtime artifacts (release dirs stored as containerId paths)
    if (dep.containerId?.includes("/") && !(runtime instanceof DockerRuntime)) {
      // Already tracked as "container" above — bare destroy() handles path removal
    }
  }

  // ── Domain routes (project-level) ──────────────────────────────────
  const domains = await repos.domain.listByProject(project.id).catch(() => []);
  for (const d of domains) {
    resources.push({
      type: "route",
      ref: d.hostname,
      label: `route ${d.hostname}`,
      runtime: null, // routes use routing adapter, not runtime
    });
  }

  // ── Service routes (compose) ───────────────────────────────────────
  if (isCompose) {
    const services = await repos.service.listByProject(project.id).catch(() => []);
    for (const svc of services) {
      const route = buildServiceRouteDomain({
        project,
        service: svc,
        runtimeName: "bare",
        usesManagedRouting: true,
      });
      if (route) {
        resources.push({
          type: "route",
          ref: route.hostname,
          label: `service route ${route.hostname}`,
          runtime: null,
        });
      }
    }
  }

  return { projectId: project.id, resources };
}

/**
 * Collect resources for a single deployment.
 * Used by deployment.service.ts deleteDeployment().
 */
export async function collectDeploymentManifest(
  dep: Deployment,
  project: Project | null,
): Promise<CleanupManifest> {
  const resources: CleanupResource[] = [];
  const isCompose = project ? isComposeProject(project) : false;

  const containerIds = isCompose
    ? (await repos.service.listByDeployment(dep.id))
        .map((r) => r.containerId)
        .filter((id): id is string => !!id)
    : dep.containerId
      ? [dep.containerId]
      : [];

  if (containerIds.length > 0) {
    let runtime: RuntimeAdapter;
    try {
      ({ runtime } = await resolveDeploymentRuntime(dep));
    } catch {
      return { projectId: dep.projectId, resources };
    }

    for (const containerId of containerIds) {
      resources.push({
        type: "container",
        ref: containerId,
        label: `container ${containerId.slice(0, 12)}`,
        runtime,
      });
    }
  }

  return { projectId: dep.projectId, resources };
}

// ─── Cleanup Executor ────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 6;
const RETRY_DELAY_MS = 2000;

/**
 * Execute cleanup for all resources in a manifest.
 *
 * - Bounded concurrency (default 6 parallel ops)
 * - Per-item error isolation: one failure doesn't block others
 * - Single retry with backoff for transient failures
 */
export async function executeCleanup(
  manifest: CleanupManifest,
  opts?: { concurrency?: number },
): Promise<CleanupResult> {
  const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;
  const { routing } = platform();
  const result: CleanupResult = { total: manifest.resources.length, succeeded: 0, failed: [] };

  // Process in bounded batches
  for (let i = 0; i < manifest.resources.length; i += concurrency) {
    const batch = manifest.resources.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map((resource) => destroyResource(resource, routing)),
    );

    for (let j = 0; j < settled.length; j++) {
      if (settled[j].status === "fulfilled") {
        result.succeeded++;
      } else {
        const resource = batch[j];
        const reason = settled[j] as PromiseRejectedResult;
        const errMsg =
          reason.reason instanceof Error ? reason.reason.message : String(reason.reason);
        result.failed.push({ ref: resource.ref, label: resource.label, error: errMsg });
      }
    }
  }

  return result;
}

/** Destroy a single resource with one retry on failure. */
async function destroyResource(
  resource: CleanupResource,
  routing: ReturnType<typeof platform>["routing"],
): Promise<void> {
  try {
    await destroyResourceOnce(resource, routing);
  } catch (firstErr) {
    // Retry once after backoff
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    await destroyResourceOnce(resource, routing);
  }
}

async function destroyResourceOnce(
  resource: CleanupResource,
  routing: ReturnType<typeof platform>["routing"],
): Promise<void> {
  switch (resource.type) {
    case "container": {
      if (!resource.runtime) return;
      await resource.runtime.destroy(resource.ref);
      return;
    }
    case "image": {
      if (!resource.runtime || !(resource.runtime instanceof DockerRuntime)) return;
      await resource.runtime.removeImage(resource.ref);
      return;
    }
    case "artifact": {
      if (!resource.runtime) return;
      await resource.runtime.destroy(resource.ref);
      return;
    }
    case "route": {
      await routing.removeRoute(resource.ref);
      return;
    }
  }
}

// ─── High-Level Orchestrators ────────────────────────────────────────────────

export interface DeleteProjectOptions {
  /** True deletes every environment under the same project app. */
  deleteApp?: boolean;
}

/**
 * Full project/environment deletion: validate → soft-delete → background cleanup.
 *
 * In the current product model, a DB project is one environment and project_app
 * is the app users think of as "the project". deleteApp=true removes all sibling
 * environments under that app; false removes only the current environment.
 */
export async function deleteProject(
  projectId: string,
  userId: string,
  options: DeleteProjectOptions = {},
): Promise<{ deletedApp: boolean; deletedProjects: number }> {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const deleteApp = options.deleteApp ?? true;
  const projects = deleteApp
    ? (await repos.project.listByApp(p.appId)).filter((row) => row.userId === userId)
    : [p];

  // 1. Soft-delete immediately — environments disappear from listings
  await Promise.all(projects.map((project) => repos.project.softDelete(project.id)));

  let deletedApp = deleteApp;
  if (deleteApp) {
    await repos.projectApp.softDelete(p.appId);
  } else {
    const remainingEnvironments = await repos.project.listByApp(p.appId);
    if (remainingEnvironments.length === 0) {
      await repos.projectApp.softDelete(p.appId);
      deletedApp = true;
    }
  }

  // 2. Background cleanup (fire-and-forget)
  for (const project of projects) {
    cleanupProjectResources(project, project.id).catch((err) =>
      console.error(`[PROJECT] Background cleanup failed for ${project.id}:`, err),
    );
  }

  return { deletedApp, deletedProjects: projects.length };
}

/** Internal: runs after soft-delete, outside the request lifecycle. */
async function cleanupProjectResources(
  p: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  projectId: string,
): Promise<void> {
  // 1. Collect all resources
  const manifest = await collectProjectManifest(p);

  // 2. Destroy resources with bounded concurrency
  const result = await executeCleanup(manifest);
  if (result.failed.length > 0) {
    console.error(
      `[PROJECT] Cleanup for ${projectId}: ${result.succeeded}/${result.total} succeeded, ` +
        `${result.failed.length} failed:`,
      result.failed.map((f) => `${f.label}: ${f.error}`),
    );
  }

  // 3. DB cleanup (hard-delete deployments + build sessions)
  await repos.deployment.deleteByProjectId(projectId);
}
