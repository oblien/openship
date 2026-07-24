/**
 * Project cleanup orchestrator - resource manifest + bounded-concurrency teardown.
 *
 * Reuses the same patterns as deployment-lifecycle.ts:
 *   1. Collect a manifest of all resources (containers, images, artifacts, routes)
 *   2. Execute cleanup with bounded concurrency + per-item error isolation
 *   3. Retry transient failures once with backoff
 *
 * Used by:
 *   - teardownProject()         → full project teardown (see project-teardown.ts)
 *   - deleteDeployment()        → single deployment teardown
 */

import { repos, type Project, type Deployment } from "@repo/db";
import { DockerRuntime, type RuntimeAdapter } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { platform } from "../../lib/controller-helpers";
import {
  resolveDeploymentRuntime,
  resolveDeploymentPlatform,
  type DeploymentMeta,
} from "../../lib/deployment-runtime";
import { resolveOrgCloudUserId } from "../../lib/cloud/transport";
import { buildServiceRouteDomain } from "../../lib/routing-domains";
import { createReachabilityProbe } from "../../lib/server-reachability";

/** Hard ceiling on a docker-over-SSH volume inspect during manifest/preview.
 *  These calls `.catch(() => [])` on ERROR, but a half-open SSH socket never
 *  rejects — it hangs. Without a timeout the deletion-preview handler (and the
 *  "Scanning attached services and volumes…" UI) loads forever. */
const INSPECT_TIMEOUT_MS = 10_000;

// ─── Resource Manifest ───────────────────────────────────────────────────────

export interface CleanupResource {
  type:
    | "container"
    | "image"
    | "artifact"
    | "route"
    | "volume"
    | "network"
    | "cloud_workspace"
    /**
     * A resource we KNOW exists but can't reach right now (cloud down, or a
     * server that still exists but is transiently unreachable). Its destroy
     * always throws, so runtime_cleanup is marked failed and the teardown's
     * atomicity gate keeps the project row — never orphan a live resource.
     * Distinct from "permanently gone" (server removed), which is skipped so
     * deletion can proceed.
     */
    | "unreachable";
  /** Runtime-specific identifier (container ID, image ref, hostname, volume name, network slug, cloud workspace id). */
  ref: string;
  /** Label for logging */
  label: string;
  /** The runtime to use for destroy/removeImage/removeVolume - null for routes. */
  runtime: RuntimeAdapter | null;
  /** Server the resource lives on (set on `unreachable` items) — carried into
   *  the orphaned_resource row so GC can probe + reclaim it later. */
  serverId?: string;
  /** Runtime mode (docker | bare | cloud) for the orphaned_resource row so GC
   *  resolves the right adapter. Set on `unreachable` items. */
  runtimeMode?: string;
}

export interface CleanupManifest {
  projectId: string;
  resources: CleanupResource[];
}

/** Per-service summary of what will be removed when this service's container is destroyed. */
export interface DeletionPreviewService {
  id: string;
  name: string;
  image: string | null;
  /** Named volumes attached to this service's container (will leak unless wipeVolumes=true). */
  volumes: string[];
  /** True if the container is currently known to the runtime. */
  hasContainer: boolean;
}

export interface DeletionPreview {
  projectId: string;
  projectName: string;
  /** Self-hosted (docker / bare / ssh) or cloud? Cloud teardown is always complete. */
  selfHosted: boolean;
  services: DeletionPreviewService[];
  /** Named volumes attached to the main deployment container, if any. */
  deploymentVolumes: string[];
  /** Project networks that exist on the host. */
  networks: string[];
  /** Total named volumes across services + deployment containers. */
  totalVolumes: number;
}

export interface CollectManifestOptions {
  /** Include named-volume cleanup resources in the manifest. Default false. */
  wipeVolumes?: boolean;
}

export interface CleanupResult {
  total: number;
  succeeded: number;
  failed: { ref: string; label: string; error: string; type: CleanupResource["type"] }[];
}

// ─── Manifest Collectors ─────────────────────────────────────────────────────

/**
 * Collect ALL resources owned by a project into a flat manifest.
 * Single pass: queries DB once per resource type, no per-item queries in loops.
 */
export async function collectProjectManifest(
  project: Project,
  options: CollectManifestOptions = {},
): Promise<CleanupManifest> {
  const wipeVolumes = options.wipeVolumes ?? false;
  const resources: CleanupResource[] = [];
  const services = await repos.service.listByProject(project.id).catch(() => []);
  const seenContainers = new Set<string>();
  const seenVolumes = new Set<string>();
  const dockerRuntimes = new Set<DockerRuntime>();
  // Op-scoped reachability memo (single source: sshManager). Lets us fast-fail
  // an unreachable server in ~2.5s instead of hanging on SSH connect timeouts.
  const reachProbe = createReachabilityProbe();

  const pushUnreachable = (
    containerId: string,
    serverId: string,
    runtimeMode: string | undefined,
    labelPrefix: string,
  ) => {
    if (seenContainers.has(containerId)) return;
    seenContainers.add(containerId);
    resources.push({
      type: "unreachable",
      ref: containerId,
      serverId,
      runtimeMode,
      label: `${labelPrefix} ${containerId.slice(0, 12)} (server unreachable)`,
      runtime: null,
    });
  };

  const pushContainer = (containerId: string, runtime: RuntimeAdapter, labelPrefix: string) => {
    if (seenContainers.has(containerId)) return;
    seenContainers.add(containerId);
    resources.push({
      type: "container",
      ref: containerId,
      label: `${labelPrefix} ${containerId.slice(0, 12)}`,
      runtime,
    });
  };

  /** When wipeVolumes=true, enumerate named volumes attached to this container
   *  and add them as separate cleanup resources. Must run BEFORE the container
   *  is destroyed - once the container is gone, the volume names are lost. */
  const pushVolumesForContainer = async (
    containerId: string,
    runtime: RuntimeAdapter,
    labelPrefix: string,
  ) => {
    if (!wipeVolumes || !(runtime instanceof DockerRuntime)) return;
    const names = await withTimeout(
      runtime.inspectNamedVolumes(containerId),
      INSPECT_TIMEOUT_MS,
      `inspect volumes ${labelPrefix}`,
    ).catch(() => [] as string[]);
    for (const name of names) {
      if (seenVolumes.has(name)) continue;
      seenVolumes.add(name);
      resources.push({
        type: "volume",
        ref: name,
        label: `${labelPrefix} volume ${name}`,
        runtime,
      });
    }
  };

  // ── Deployment containers + images + service containers ────────────
  const { rows: allDeps } = await repos.deployment.listByProject(project.id, { perPage: 1000 });
  const seenImages = new Set<string>();

  for (const dep of allDeps) {
    // Fast-fail: if this deployment targets a server that's UNREACHABLE right
    // now, do NOT resolve/exec against it — that's the source of the ~81s
    // delete hang (each container destroy waits out a 15-20s SSH timeout).
    // Record its containers as `unreachable` so teardown orphans them for GC
    // and the delete still completes. Skip entirely if the server was removed.
    {
      const meta = (dep.meta ?? {}) as DeploymentMeta;
      const serverId = meta.serverId;
      if (serverId && !(await reachProbe.isReachable(serverId))) {
        const serverStillExists = Boolean(
          await repos.server.getInOrganization(serverId, dep.organizationId).catch(() => null),
        );
        if (serverStillExists) {
          const mode = meta.runtimeMode;
          const serviceRows = await repos.service.listByDeployment(dep.id).catch(() => []);
          for (const sd of serviceRows) {
            if (sd.containerId) pushUnreachable(sd.containerId, serverId, mode, "service container");
          }
          if (dep.containerId) pushUnreachable(dep.containerId, serverId, mode, "deployment container");
        } else {
          console.warn(
            `[cleanup] skipping deployment ${dep.id} — server ${serverId} removed from org`,
          );
        }
        continue;
      }
    }

    let runtime: RuntimeAdapter;
    try {
      ({ runtime } = await resolveDeploymentRuntime(dep));
    } catch (err) {
      // Couldn't resolve the runtime. Two very different cases:
      //   • The target server was REMOVED from the org → its containers are
      //     unreachable forever; skip so the project can still be deleted
      //     (blocking forever would strand the row — the original lock pain).
      //   • The server still EXISTS but is transiently unreachable (SSH down)
      //     and this deployment has a live container → mark it unreachable so
      //     the atomicity gate keeps the row; never orphan a live container.
      const meta = (dep.meta ?? {}) as DeploymentMeta;
      const serverStillExists = meta.serverId
        ? Boolean(
            await repos.server
              .getInOrganization(meta.serverId, dep.organizationId)
              .catch(() => null),
          )
        : false;
      if (dep.containerId && serverStillExists) {
        resources.push({
          type: "unreachable",
          ref: dep.containerId,
          label: `deployment container ${dep.containerId.slice(0, 12)} (server unreachable)`,
          runtime: null,
        });
      } else {
        console.warn(
          `[cleanup] skipping unresolvable deployment ${dep.id} (server gone or never deployed): ${safeErrorMessage(err)}`,
        );
      }
      continue;
    }

    if (runtime instanceof DockerRuntime) {
      dockerRuntimes.add(runtime);
    }

    // Service containers - enumerate volumes BEFORE destroying the container
    // so we still have the mount metadata. Volume names live on the container
    // and disappear with it.
    const serviceRows = await repos.service.listByDeployment(dep.id);
    for (const sd of serviceRows) {
      if (sd.containerId) {
        await pushVolumesForContainer(sd.containerId, runtime, "service");
        pushContainer(sd.containerId, runtime, "service container");
      }
      // Per-service compose/monorepo images (openship/<slug>-<svc>:bld_…-svc_…).
      // These are the REAL images for a multi-service deployment — dep.imageRef
      // is only the "compose" sentinel — so without this they leak on project
      // deletion. Deduped via the shared seenImages set. Docker only.
      if (sd.imageRef && !seenImages.has(sd.imageRef) && runtime instanceof DockerRuntime) {
        seenImages.add(sd.imageRef);
        resources.push({
          type: "image",
          ref: sd.imageRef,
          label: `service image ${sd.imageRef.slice(0, 24)}`,
          runtime,
        });
      }
    }

    // Main deployment container - same order.
    if (dep.containerId) {
      await pushVolumesForContainer(dep.containerId, runtime, "deployment");
      pushContainer(dep.containerId, runtime, "deployment container");
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
      // Already tracked as "container" above - bare destroy() handles path removal
    }
  }

  // ── Orphan container sweep (label-based, authoritative per host) ───
  // Reclaim containers labeled `openship.project=<id>` that NO DB row
  // references — started by a deploy that then failed during routing, or
  // whose row was lost to a crash. This is how leaked containers ("3 for
  // one project") get cleaned, even retroactively. Sweep every docker
  // runtime the deployments resolved to PLUS the local platform runtime
  // (so a single-host install is swept even when no deployment row
  // resolved). De-duped via pushContainer's seenContainers; best-effort +
  // bounded (SSH can hang). A separate set keeps the networks block above
  // from gaining a spurious local-host network resource.
  const sweepRuntimes = new Set<DockerRuntime>(dockerRuntimes);
  const localRuntime = platform().runtime;
  if (localRuntime instanceof DockerRuntime) sweepRuntimes.add(localRuntime);
  for (const docker of sweepRuntimes) {
    if (!docker.supports("projectContainerSweep") || !docker.listProjectContainerIds) continue;
    const ids = await withTimeout(
      docker.listProjectContainerIds(project.id),
      INSPECT_TIMEOUT_MS,
      `sweep containers ${project.id}`,
    ).catch(() => [] as string[]);
    for (const id of ids) {
      // Enumerate volumes BEFORE the container is destroyed (same reason as
      // the DB-tracked path) so a wipeVolumes teardown still sees the mounts.
      await pushVolumesForContainer(id, docker, "orphan");
      pushContainer(id, docker, "orphan container");
    }
  }

  // ── Cloud workspace (the canonical Oblien binding) ────────────────
  // `project.cloudWorkspaceId` is the CURRENT workspace this project
  // deploys to. Deployment rows may reference OLD workspaces (re-provisioned)
  // or none at all (provision succeeded but no deploy row reached ready),
  // and the per-deployment runtime resolution above may have been skipped
  // (server gone). Enumerate it explicitly so deleting the project always
  // tears the workspace down on Oblien — fixes "deleted locally but still
  // live on Openship Cloud". De-duped against any deployment container that
  // already covers it.
  if (project.cloudWorkspaceId && !seenContainers.has(project.cloudWorkspaceId)) {
    try {
      // BOUNDED: this resolution mints a cloud token (cloudFetch, no native
      // timeout). Without withTimeout a cloud-side hang would stall manifest
      // collection while the teardown holds the deletion lock — the same hang
      // class the SSH paths above are bounded against.
      const { platform: cloudPlatform } = await withTimeout(
        resolveDeploymentPlatform(
          { deployTarget: "cloud", workspaceId: project.cloudWorkspaceId },
          { organizationId: project.organizationId },
        ),
        INSPECT_TIMEOUT_MS,
        `resolve cloud workspace ${project.cloudWorkspaceId}`,
      );
      // Guard against a non-cloud base resolving to local/server (a pure
      // self-hosted project never has a cloud workspace anyway).
      if (cloudPlatform.runtime.name === "cloud") {
        seenContainers.add(project.cloudWorkspaceId);
        resources.push({
          type: "cloud_workspace",
          ref: project.cloudWorkspaceId,
          label: `cloud workspace ${project.cloudWorkspaceId}`,
          runtime: cloudPlatform.runtime,
        });
      } else {
        // Don't silently drop it — an orphaned workspace should be visible.
        console.warn(
          `[cleanup] cloud workspace ${project.cloudWorkspaceId} resolved to non-cloud runtime "${cloudPlatform.runtime.name}" — skipped`,
        );
      }
    } catch (err) {
      // Two very different failures land here — distinguish them like the
      // gone-server branch above:
      //   • PERMANENT (org has no Openship Cloud link → owner unlinked/never
      //     linked): we can never reach this workspace from here, so blocking
      //     the delete forever helps nobody. Skip + warn so the project stays
      //     deletable (the workspace may remain on Oblien; re-link to clean it).
      //   • TRANSIENT (link exists but cloud/token-mint is down, or we timed
      //     out above): mark unreachable so the atomicity gate KEEPS the row and
      //     the user retries once Cloud is reachable. On an inconclusive link
      //     check we also keep (never orphan on uncertainty).
      const linkUserId = await resolveOrgCloudUserId(project.organizationId).catch(
        () => "unknown" as const,
      );
      if (linkUserId === null) {
        console.warn(
          `[cleanup] cloud workspace ${project.cloudWorkspaceId} skipped — org ${project.organizationId} has no Openship Cloud link (${safeErrorMessage(err)}); workspace may remain on Oblien. Re-link to clean it up.`,
        );
      } else {
        resources.push({
          type: "unreachable",
          ref: project.cloudWorkspaceId,
          label: `cloud workspace ${project.cloudWorkspaceId} (cloud unreachable)`,
          runtime: null,
        });
      }
    }
  }

  // ── Project networks (always cleaned - they're clutter, not data) ──
  // One per docker runtime (Docker installs are per-machine), keyed off
  // project slug to match the `openship-<slug>` naming in DockerRuntime.
  for (const docker of dockerRuntimes) {
    resources.push({
      type: "network",
      ref: project.slug,
      label: `network openship-${project.slug}`,
      runtime: docker,
    });
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

  // ── Service routes ─────────────────────────────────────────────────
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

  // Ordering matters: containers must be destroyed before their volumes
  // (Docker refuses to remove volumes still attached to a live container),
  // and networks should come after all containers detach from them. The
  // batched executor runs resources in order, so a stable sort here is
  // enough - no need for explicit phases.
  const TYPE_ORDER: Record<CleanupResource["type"], number> = {
    container: 0,
    artifact: 0,
    cloud_workspace: 0,
    unreachable: 0,
    image: 1,
    route: 2,
    volume: 3,
    network: 4,
  };
  resources.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);

  return { projectId: project.id, resources };
}

/**
 * Build a deletion-preview snapshot for the UI to render before the user
 * confirms. Returns the list of services and their named volumes, plus
 * any networks that exist on the host - so the user sees exactly what
 * will be wiped (or what'll be left behind if they skip `wipeVolumes`).
 *
 * Read-only - does NOT modify state. Cheap enough to call on modal open.
 */
export async function previewProjectDeletion(project: Project): Promise<DeletionPreview> {
  const services = await repos.service.listByProject(project.id).catch(() => []);
  const { rows: allDeps } = await repos.deployment.listByProject(project.id, { perPage: 1000 });

  const previewServices: DeletionPreviewService[] = [];
  const deploymentVolumes: string[] = [];
  const networkSlugs = new Set<string>();
  // Self-hosted is a STATIC fact of the project (anything not cloud-managed), not
  // something to infer from a live runtime probe: an imported/migrated project on
  // an unreachable server would otherwise resolve to `false` and hide the
  // record-only ("Remove from Openship") delete — exactly when it's most useful.
  // The loop below only strengthens (never un-sets) this.
  let selfHosted = !project.cloudWorkspaceId;

  // Map service id → its container id (most recent deployment wins, which
  // matches the order rows come back in). We resolve volumes per container.
  const serviceContainerByServiceId = new Map<string, { containerId: string; runtime: RuntimeAdapter }>();

  for (const dep of allDeps) {
    let runtime: RuntimeAdapter;
    try {
      ({ runtime } = await resolveDeploymentRuntime(dep));
    } catch {
      continue;
    }
    if (runtime instanceof DockerRuntime) {
      selfHosted = true;
      networkSlugs.add(project.slug);
    } else if (!(runtime instanceof DockerRuntime)) {
      // Bare runtime is also self-hosted; only the cloud adapter is "managed."
      selfHosted = selfHosted || runtime.name !== "cloud";
    }

    if (dep.containerId && runtime instanceof DockerRuntime) {
      const vols = await withTimeout(
        runtime.inspectNamedVolumes(dep.containerId),
        INSPECT_TIMEOUT_MS,
        `preview volumes ${dep.containerId}`,
      ).catch(() => [] as string[]);
      for (const v of vols) deploymentVolumes.push(v);
    }

    const serviceRows = await repos.service.listByDeployment(dep.id);
    for (const sd of serviceRows) {
      if (sd.containerId && !serviceContainerByServiceId.has(sd.serviceId)) {
        serviceContainerByServiceId.set(sd.serviceId, { containerId: sd.containerId, runtime });
      }
    }
  }

  for (const svc of services) {
    const link = serviceContainerByServiceId.get(svc.id);
    let volumes: string[] = [];
    if (link && link.runtime instanceof DockerRuntime) {
      volumes = await withTimeout(
        link.runtime.inspectNamedVolumes(link.containerId),
        INSPECT_TIMEOUT_MS,
        `preview volumes ${link.containerId}`,
      ).catch(() => []);
    }
    previewServices.push({
      id: svc.id,
      name: svc.name,
      image: svc.image ?? null,
      volumes,
      hasContainer: !!link,
    });
  }

  const totalVolumes = deploymentVolumes.length + previewServices.reduce((n, s) => n + s.volumes.length, 0);

  return {
    projectId: project.id,
    projectName: project.name,
    selfHosted,
    services: previewServices,
    deploymentVolumes: Array.from(new Set(deploymentVolumes)),
    networks: Array.from(networkSlugs).map((slug) => `openship-${slug}`),
    totalVolumes,
  };
}

/**
 * Collect resources for a single deployment.
 * Used by deployment.service.ts deleteDeployment().
 */
export async function collectDeploymentManifest(
  dep: Deployment,
  _project: Project | null,
): Promise<CleanupManifest> {
  const resources: CleanupResource[] = [];
  const serviceRows = await repos.service.listByDeployment(dep.id).catch(() => []);
  const serviceContainerIds = serviceRows
    .map((r) => r.containerId)
    .filter((id): id is string => !!id);
  const containerIds = [
    ...new Set(
      serviceContainerIds.length > 0
        ? serviceContainerIds
        : dep.containerId
          ? [dep.containerId]
          : [],
    ),
  ];

  // Resolve the runtime once. Anything below this point that depends on the
  // runtime (containers, images) only fires when the runtime is reachable.
  let runtime: RuntimeAdapter | null = null;
  try {
    runtime = (await resolveDeploymentRuntime(dep)).runtime;
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

  // Images - main deployment imageRef + per-service imageRef. Only Docker
  // images need explicit removal (bare runtime artifacts are tied to the
  // container destroy path). Deduplicated across the manifest.
  if (runtime instanceof DockerRuntime) {
    const seenImages = new Set<string>();
    const pushImage = (ref: string | null | undefined, label: string) => {
      if (!ref || seenImages.has(ref)) return;
      seenImages.add(ref);
      resources.push({ type: "image", ref, label, runtime });
    };
    pushImage(dep.imageRef, `image ${(dep.imageRef ?? "").slice(0, 24)}`);
    for (const sd of serviceRows) {
      pushImage(sd.imageRef, `service image ${(sd.imageRef ?? "").slice(0, 24)}`);
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
/** Hard ceiling on a single resource destroy (SSH/docker can half-open and
 *  hang forever). A timeout becomes a counted failure so the batch + the whole
 *  runtime_cleanup step stay bounded — critical because the teardown holds the
 *  deletion lock until it returns. */
const DESTROY_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`cleanup timed out after ${ms}ms: ${label}`)),
      ms,
    );
    // Don't let the timer keep the process alive once the race settles.
    (timer as { unref?: () => void }).unref?.();
  });
  // clearTimeout on settle so a successful inspect/destroy doesn't leave a live
  // 10–30s timer (holding its closure) for every resource in a large manifest.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

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
        result.failed.push({
          ref: resource.ref,
          label: resource.label,
          error: safeErrorMessage(reason.reason),
          type: resource.type,
        });
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
    await withTimeout(destroyResourceOnce(resource, routing), DESTROY_TIMEOUT_MS, resource.label);
  } catch (firstErr) {
    // Retry once after backoff (also bounded — the retry can hang too).
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    await withTimeout(destroyResourceOnce(resource, routing), DESTROY_TIMEOUT_MS, resource.label);
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
    case "cloud_workspace": {
      if (!resource.runtime) return;
      await resource.runtime.destroy(resource.ref);
      return;
    }
    case "unreachable": {
      // We know this resource exists but can't reach its runtime right now
      // (cloud down, or a still-existing server that's transiently
      // unreachable). Throw so runtime_cleanup is marked failed and the
      // teardown's atomicity gate KEEPS the project row for a later retry —
      // deleting it would orphan a live resource.
      throw new Error(`${resource.label}: unreachable — project kept, retry once reachable`);
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
    case "volume": {
      if (!resource.runtime || !(resource.runtime instanceof DockerRuntime)) return;
      await resource.runtime.removeVolume(resource.ref);
      return;
    }
    case "network": {
      if (!resource.runtime || !(resource.runtime instanceof DockerRuntime)) return;
      await resource.runtime.removeNetwork(resource.ref);
      return;
    }
  }
}

// The legacy monolithic deleteProject() lived here. It was superseded by
// teardownProject() in project-teardown.ts, which runs the same manifest +
// executor but as a named, audited, idempotent step sequence with a
// deletion lock + force-cancel + 207 partial-success support. Anything new
// should call teardownProject().


