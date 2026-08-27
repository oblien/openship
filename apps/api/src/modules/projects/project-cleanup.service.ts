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
import {
  DockerRuntime,
  edgeProxyFor,
  ownsBuiltImage,
  type EdgeProxyApi,
  type RoutingProvider,
  type RuntimeAdapter,
} from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { platform } from "../../lib/controller-helpers";
import {
  disposeRuntime,
  resolveDeploymentRuntime,
  resolveDeploymentPlatform,
  type DeploymentMeta,
} from "../../lib/deployment-runtime";
import { resolveOrgCloudUserId } from "../../lib/cloud/transport";
import { isArtifactRef } from "../../lib/container-ref";
import { computeCleanupKeepSet } from "./cleanup-keep-set";
import { buildServiceRouteDomains } from "../../lib/routing-domains";
import { releaseManagedHostnames } from "../../lib/managed-edge-proxy";
import { createReachabilityProbe } from "../../lib/server-reachability";
import { resolveLiveServiceState, type LiveMatchKind } from "../services/live-state";
import type { HostPortTargetIdentity } from "../../lib/host-port-target";
import { connectionHostPortTargetKey } from "../../lib/host-port-target";
import { convergeTargetHostPortClaims } from "../deployments/pinned-host-ports";

/** Identity keys a DELETE may act on: each one proves the container is this
 *  project's. Deliberately excludes `compose` (see ResolveLiveStateInput.tiers). */
const TEARDOWN_MATCH_TIERS: readonly LiveMatchKind[] = ["label", "name", "trackedId"];

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
  /** Server the resource lives on. Null means the local host or cloud, as
   *  distinguished by `runtimeMode`. Carried into an orphan row verbatim so a
   *  multi-target teardown never retries an old resource on the newest server. */
  serverId?: string | null;
  /** Immutable physical bind-namespace identity used to fence orphan cleanup. */
  targetKey?: string | null;
  /** Runtime mode (docker | bare | cloud) for the orphaned_resource row so GC
   *  resolves the right adapter. */
  runtimeMode?: string;
  /** Deferred GC operation when `type` is unreachable. */
  deferredResourceType?: string;
  payload?: Record<string, unknown> | null;
}

export interface CleanupManifest {
  projectId: string;
  /**
   * Owning org — needed to release a managed (`*.opsh.io`) route on Openship
   * Cloud's edge, which is namespace-scoped upstream. Optional so an older
   * manifest (or a caller that only destroys runtime resources) still type-checks;
   * a route release is simply skipped without it.
   */
  organizationId?: string;
  resources: CleanupResource[];
  /** Every per-deployment runtime opened while collecting this manifest. */
  runtimes?: RuntimeAdapter[];
  /**
   * Every reachable physical target on which this project's deployments may
   * have written a vhost. Route teardown must use these target-bound providers,
   * never the API process's global edge, or a migrated/remote route survives
   * deletion while its database row disappears.
   */
  routeContexts?: CleanupRouteContext[];
  /**
   * Historical targets that are known to exist but could not be reached while
   * collecting the manifest. They deliberately carry no live adapter. Teardown
   * records one route orphan per hostname/target so GC can remove the remote
   * vhost and converge its detached claims when the server returns.
   */
  unreachableRouteTargets?: CleanupUnreachableRouteTarget[];
}

export interface CleanupUnreachableRouteTarget {
  /** Server-row identity GC can resolve once reachability returns. */
  serverId: string;
  runtimeMode: "docker" | "bare";
  targetKey: string;
}

export interface CleanupRouteContext {
  /** Stable physical collision-domain key; also deduplicates server-row aliases. */
  key: string;
  routing: RoutingProvider;
  hostPortTarget: HostPortTargetIdentity;
  /** Concrete target locator used if force-orphan GC must retry this vhost. */
  serverId: string | null;
  runtimeMode: "docker" | "bare";
  /** Strict post-mutation inventory used before durable claims are reclaimed. */
  edgeProxy: Pick<EdgeProxyApi, "listLoopbackUpstreamPortsStrict">;
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
  const services = await repos.service.listByProject(project.id);
  const seenContainers = new Set<string>();
  const seenVolumes = new Set<string>();
  const seenRouteHostnames = new Set<string>();
  const dockerRuntimes = new Set<DockerRuntime>();
  const resolvedRuntimes = new Set<RuntimeAdapter>();
  const authoritativeRead = async <T>(operation: Promise<T>, label: string): Promise<T> => {
    try {
      return await withTimeout(operation, INSPECT_TIMEOUT_MS, label);
    } catch (error) {
      for (const runtime of resolvedRuntimes) disposeRuntime(runtime);
      throw new Error(`${label} failed: ${safeErrorMessage(error)}`);
    }
  };
  const routeContexts = new Map<string, CleanupRouteContext>();
  const unreachableRouteTargets = new Map<string, CleanupUnreachableRouteTarget>();
  const unreachableSweeps = new Map<
    string,
    {
      serverId: string;
      targetKey: string;
      runtimeMode: "docker" | "bare";
      containerIds: Set<string>;
      imageRefs: Set<string>;
      artifactRefs: Set<string>;
    }
  >();
  type CollectedTarget = {
    key: string;
    serverId: string | null;
    runtimeMode: "docker" | "bare" | "cloud";
  };
  const runtimeTargets = new Map<RuntimeAdapter, CollectedTarget>();
  const resourceKey = (target: CollectedTarget, ref: string) => `${target.key}\0${ref}`;
  const targetFields = (target: CollectedTarget) => ({
    serverId: target.serverId,
    runtimeMode: target.runtimeMode,
    targetKey: target.key,
  });
  const pushRoute = (hostname: string, label: string) => {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized || seenRouteHostnames.has(normalized)) return;
    seenRouteHostnames.add(normalized);
    resources.push({ type: "route", ref: normalized, label, runtime: null });
  };
  const targetForResolved = (
    resolved: Awaited<ReturnType<typeof resolveDeploymentRuntime>>,
    dep: Deployment,
  ): CollectedTarget => {
    const runtimeMode =
      resolved.runtime.name === "cloud"
        ? "cloud"
        : resolved.runtime.name === "bare"
          ? "bare"
          : "docker";
    return {
      key:
        resolved.hostPortTarget?.targetKey ??
        (resolved.serverId
          ? `server:${resolved.serverId}`
          : runtimeMode === "cloud"
            ? `cloud:${dep.containerId ?? ((dep.meta ?? {}) as DeploymentMeta).workspaceId ?? dep.id}`
            : `local:${runtimeMode}`),
      serverId: resolved.serverId,
      runtimeMode,
    };
  };
  // Op-scoped reachability memo (single source: sshManager). Lets us fast-fail
  // an unreachable server in ~2.5s instead of hanging on SSH connect timeouts.
  const reachProbe = createReachabilityProbe();

  const recordUnreachableDeployment = (
    serverId: string,
    targetKey: string,
    runtimeMode: "docker" | "bare",
    dep: Deployment,
    serviceRows: Awaited<ReturnType<typeof repos.service.listByDeployment>>,
  ) => {
    const sweep = unreachableSweeps.get(targetKey) ?? {
      serverId,
      targetKey,
      runtimeMode,
      containerIds: new Set<string>(),
      imageRefs: new Set<string>(),
      artifactRefs: new Set<string>(),
    };
    const collectRef = (ref: string | null | undefined, kind: "container" | "image") => {
      if (!ref) return;
      if (isArtifactRef(ref)) sweep.artifactRefs.add(ref);
      else if (kind === "container") sweep.containerIds.add(ref);
      else if (ownsBuiltImage(ref)) sweep.imageRefs.add(ref);
    };
    collectRef(dep.containerId, "container");
    collectRef(dep.imageRef, "image");
    for (const row of serviceRows) {
      collectRef(row.containerId, "container");
      collectRef(row.imageRef, "image");
    }
    unreachableSweeps.set(targetKey, sweep);
  };

  const pushContainer = (
    containerId: string,
    runtime: RuntimeAdapter,
    labelPrefix: string,
    target: CollectedTarget,
  ) => {
    const key = resourceKey(target, containerId);
    if (seenContainers.has(key)) return;
    seenContainers.add(key);
    // A static deploy's containerId IS its release directory. Both branches of
    // destroyResourceOnce call runtime.destroy, so this reclassification is
    // behaviour-preserving — but it makes the manifest TYPE match the thing, which
    // the force-orphan `resourceType` column and the deletion-preview copy both
    // read. A directory recorded as a "container" is an orphan row the GC then
    // hands to the container resolver.
    if (isArtifactRef(containerId)) {
      resources.push({
        type: "artifact",
        ref: containerId,
        label: `${labelPrefix} files ${containerId}`,
        runtime,
        ...targetFields(target),
      });
      return;
    }
    resources.push({
      type: "container",
      ref: containerId,
      label: `${labelPrefix} ${containerId.slice(0, 12)}`,
      runtime,
      ...targetFields(target),
    });
  };

  /** When wipeVolumes=true, enumerate named volumes attached to this container
   *  and add them as separate cleanup resources. Must run BEFORE the container
   *  is destroyed - once the container is gone, the volume names are lost. */
  const pushVolumesForContainer = async (
    containerId: string,
    runtime: RuntimeAdapter,
    labelPrefix: string,
    target: CollectedTarget,
  ) => {
    if (!wipeVolumes || !(runtime instanceof DockerRuntime)) return;
    // A release directory cannot have mounts. Inspecting it is guaranteed to fail
    // and costs the full INSPECT_TIMEOUT_MS on a Docker-over-SSH bridge, which is
    // the deletion-preview request hanging for nothing.
    if (isArtifactRef(containerId)) return;
    const names = await authoritativeRead(
      runtime.inspectNamedVolumes(containerId),
      `inspect volumes ${labelPrefix}`,
    );
    for (const name of names) {
      const key = resourceKey(target, name);
      if (seenVolumes.has(key)) continue;
      seenVolumes.add(key);
      resources.push({
        type: "volume",
        ref: name,
        label: `${labelPrefix} volume ${name}`,
        runtime,
        ...targetFields(target),
      });
    }
  };

  // ── Deployment containers + images + service containers ────────────
  const { rows: allDeps } = await repos.deployment.listByProject(project.id, { perPage: 1000 });
  const seenImages = new Set<string>();

  /**
   * An `image_ref` column can hold EITHER a Docker tag or a host DIRECTORY — a
   * static service's build output is a path (see isArtifactRef). Classifying by
   * the runtime class alone sent the path to `removeImage`, which cannot delete a
   * directory and whose failure is not a 404, so it was rethrown and blocked the
   * whole project deletion forever (issue #640). Classify by the REF's shape.
   *
   * The artifact branch is also the only producer of `type: "artifact"` for a
   * compose static sub-app: those rows carry no containerId, so `pushContainer`
   * never runs for them and this is the single entry their doc-root ever gets.
   */
  const pushImageOrArtifact = (
    ref: string,
    runtime: RuntimeAdapter,
    tagLabel: string,
    target: CollectedTarget,
  ) => {
    const key = resourceKey(target, ref);
    if (seenImages.has(key)) return;
    seenImages.add(key);
    if (isArtifactRef(ref)) {
      resources.push({
        type: "artifact",
        ref,
        label: `static output ${ref}`,
        runtime,
        ...targetFields(target),
      });
      return;
    }
    // Only Docker holds images. Bare has no removeImage at all, so a tag reaching
    // here on a bare runtime is a no-op we should say out loud rather than drop.
    if (!(runtime instanceof DockerRuntime)) {
      console.warn(`[cleanup] skipping image ${ref}: ${runtime.name} runtime cannot remove images`);
      return;
    }
    // Registry/adopted images are shared daemon cache, not deployment-owned
    // artifacts. This is the same structural ownership rule Docker purge and
    // image GC use; project deletion must not turn a pulled release image (or a
    // service image such as postgres:17) into something Openship may untag.
    if (!ownsBuiltImage(ref)) return;
    resources.push({ type: "image", ref, label: tagLabel, runtime, ...targetFields(target) });
  };

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
        const server = await repos.server.getInOrganization(serverId, dep.organizationId);
        if (server) {
          const mode = meta.runtimeMode === "bare" ? "bare" : "docker";
          const targetKey = server.isLocal
            ? "local"
            : connectionHostPortTargetKey({
                sshHost: server.sshHost,
                sshPort: server.sshPort,
                sshJumpHost: server.sshJumpHost,
                sshArgs: server.sshArgs,
              });
          unreachableRouteTargets.set(targetKey, {
            serverId,
            runtimeMode: mode,
            targetKey,
          });
          const serviceRows = await repos.service.listByDeployment(dep.id);
          recordUnreachableDeployment(serverId, targetKey, mode, dep, serviceRows);
        } else {
          console.warn(
            `[cleanup] skipping deployment ${dep.id} — server ${serverId} removed from org`,
          );
        }
        continue;
      }
    }

    let runtime: RuntimeAdapter;
    let resourceTarget: CollectedTarget;
    try {
      const resolved = await resolveDeploymentRuntime(dep);
      runtime = resolved.runtime;
      resourceTarget = targetForResolved(resolved, dep);
      runtimeTargets.set(runtime, resourceTarget);
      resolvedRuntimes.add(runtime);
      if (resolved.hostPortTarget && resolved.executor) {
        const key = resolved.hostPortTarget.targetKey;
        if (!routeContexts.has(key)) {
          routeContexts.set(key, {
            key,
            routing: resolved.routing,
            hostPortTarget: resolved.hostPortTarget,
            // The local collision namespace is resolved locally during GC even
            // when it originally arrived through a "This Server" row.
            serverId: key === "local" ? null : resolved.serverId,
            runtimeMode: runtime.name === "bare" ? "bare" : "docker",
            edgeProxy: edgeProxyFor(resolved.executor, "openresty", { ours: true }),
          });
        }
      }
    } catch (err) {
      // Couldn't resolve the runtime. Two very different cases:
      //   • The target server was REMOVED from the org → its containers are
      //     unreachable forever; skip so the project can still be deleted
      //     (blocking forever would strand the row — the original lock pain).
      //   • The server still EXISTS but is transiently unreachable (SSH down)
      //     and this deployment has a live container → mark it unreachable so
      //     the atomicity gate keeps the row; never orphan a live container.
      const meta = (dep.meta ?? {}) as DeploymentMeta;
      const server = meta.serverId
        ? await repos.server.getInOrganization(meta.serverId, dep.organizationId)
        : null;
      if (server && meta.serverId) {
        const serverId = meta.serverId!;
        const mode = meta.runtimeMode === "bare" ? "bare" : "docker";
        const targetKey = server.isLocal
          ? "local"
          : connectionHostPortTargetKey({
              sshHost: server.sshHost,
              sshPort: server.sshPort,
              sshJumpHost: server.sshJumpHost,
              sshArgs: server.sshArgs,
            });
        unreachableRouteTargets.set(targetKey, {
          serverId,
          runtimeMode: mode,
          targetKey,
        });
        const serviceRows = await repos.service.listByDeployment(dep.id);
        recordUnreachableDeployment(serverId, targetKey, mode, dep, serviceRows);
      } else if (!meta.serverId) {
        // A local/cloud target has no removable server row that could explain
        // the failure. Silently skipping its known refs would let teardown drop
        // the only DB record for a workload/artifact we never even attempted to
        // destroy. Fail manifest collection closed and let the caller retry.
        const serviceRows = await repos.service.listByDeployment(dep.id);
        const hasKnownResources =
          !!dep.containerId ||
          !!dep.imageRef ||
          serviceRows.some((row) => !!row.containerId || !!row.imageRef);
        if (hasKnownResources) {
          for (const opened of resolvedRuntimes) disposeRuntime(opened);
          throw new Error(
            `Could not resolve cleanup target for deployment ${dep.id}: ${safeErrorMessage(err)}`,
          );
        }
        console.warn(
          `[cleanup] skipping unresolvable empty deployment ${dep.id}: ${safeErrorMessage(err)}`,
        );
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
        await pushVolumesForContainer(sd.containerId, runtime, "service", resourceTarget);
        pushContainer(sd.containerId, runtime, "service container", resourceTarget);
      }
      // Per-service compose/monorepo images (openship/<slug>-<svc>:bld_…-svc_…)
      // OR, for a static sub-app, its doc-root DIRECTORY. These are the REAL
      // artifacts of a multi-service deployment — dep.imageRef is only the
      // "compose" sentinel — so without this they leak on project deletion.
      // A static sub-app has no containerId, so this is the ONLY entry its
      // doc-root ever gets.
      if (sd.imageRef) {
        pushImageOrArtifact(
          sd.imageRef,
          runtime,
          `service image ${sd.imageRef.slice(0, 24)}`,
          resourceTarget,
        );
      }
    }

    // Main deployment container - same order.
    if (dep.containerId) {
      await pushVolumesForContainer(dep.containerId, runtime, "deployment", resourceTarget);
      pushContainer(dep.containerId, runtime, "deployment container", resourceTarget);
    }

    // The deployment's own image tag, or (single-app static) its extracted
    // build directory. Deduplicated across the manifest.
    if (dep.imageRef) {
      pushImageOrArtifact(
        dep.imageRef,
        runtime,
        `image ${dep.imageRef.slice(0, 24)}`,
        resourceTarget,
      );
    }
  }

  for (const sweep of unreachableSweeps.values()) {
    resources.push({
      type: "unreachable",
      deferredResourceType: "project_target_sweep",
      ref: project.id,
      serverId: sweep.serverId,
      targetKey: sweep.targetKey,
      runtimeMode: sweep.runtimeMode,
      label: `project target ${sweep.serverId} (server unreachable)`,
      runtime: null,
      payload: {
        slug: project.slug,
        wipeVolumes,
        containerIds: [...sweep.containerIds],
        imageRefs: [...sweep.imageRefs],
        artifactRefs: [...sweep.artifactRefs],
        volumeNames: [],
      },
    });
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
  if (localRuntime instanceof DockerRuntime) {
    sweepRuntimes.add(localRuntime);
    runtimeTargets.set(localRuntime, { key: "local", serverId: null, runtimeMode: "docker" });
  }
  for (const docker of sweepRuntimes) {
    const target = runtimeTargets.get(docker);
    if (!target) {
      console.warn(`[cleanup] skipping unlocated runtime sweep for project ${project.id}`);
      continue;
    }
    if (!docker.supports("projectContainerSweep") || !docker.listProjectContainerIds) continue;
    const ids = await authoritativeRead(
      docker.listProjectContainerIds(project.id),
      `sweep containers ${project.id}`,
    );
    for (const id of ids) {
      // Enumerate volumes BEFORE the container is destroyed (same reason as
      // the DB-tracked path) so a wipeVolumes teardown still sees the mounts.
      await pushVolumesForContainer(id, docker, "orphan", target);
      pushContainer(id, docker, "orphan container", target);
    }
  }

  // ── Adopted-container sweep (identity-based, not label-based) ─────
  // A migration can adopt a container IN PLACE, and docker labels are immutable
  // in place — so it still carries the PREVIOUS project's `openship.project` and
  // is invisible to the label sweep above. Its DB row can also point at an id a
  // redeploy replaced. Either way the container survived a "delete everything"
  // teardown, kept its volumes, and then fought the next deploy for its ports.
  // Resolve by the SAME identity chain the live-state read uses (canonical
  // `openship-<slug>-<svc>` name / compose labels / tracked id), so teardown
  // reclaims exactly what the Services panel can see. Deduped by pushContainer.
  const ownServices = services;
  if (ownServices.length > 0) {
    const targets = ownServices.map((s) => ({ id: s.id, name: s.name }));
    for (const docker of sweepRuntimes) {
      const target = runtimeTargets.get(docker);
      if (!target) continue;
      if (!docker.supports("hostContainerQuery") || !docker.listAllContainers) continue;
      const containers = await authoritativeRead(
        docker.listAllContainers(),
        `sweep host containers ${project.id}`,
      );
      if (containers.length === 0) continue;
      const matches = resolveLiveServiceState({
        services: targets,
        live: containers,
        projectId: project.id,
        slug: project.slug,
        // OWNERSHIP-PROVING keys only. The `compose` key matches on
        // `com.docker.compose.project === slug`, which for a migration that KEPT
        // its source would also match the ORIGINAL stack still running under that
        // name — destroying containers and volumes the operator chose to keep.
        tiers: TEARDOWN_MATCH_TIERS,
      });
      for (const match of matches.values()) {
        if (!match.containerId) continue;
        await pushVolumesForContainer(match.containerId, docker, "adopted", target);
        pushContainer(match.containerId, docker, "adopted container", target);
      }
    }
  }

  // ── Orphan image sweep (label-based, authoritative per host) ──────
  // Reclaim images labeled `openship.project=<id>` that NO DB row references —
  // e.g. a service was deleted (its imageRef row cascade-dropped) or a build
  // crashed after `docker build` but before persisting imageRef. The DB-tracked
  // pushes above miss these; this label sweep is the authoritative backstop on
  // hard delete. Deduped via `seenImages`. Base/third-party images are PULLED
  // (unlabeled) so they can never be selected. Best-effort + bounded.
  for (const docker of sweepRuntimes) {
    const target = runtimeTargets.get(docker);
    if (!target) continue;
    const imgs = await authoritativeRead(
      docker.listProjectImages(project.id),
      `sweep images ${project.id}`,
    );
    for (const img of imgs) {
      const ref = img.repoTags[0] ?? img.id; // readable tag if present, else id
      const refKey = resourceKey(target, ref);
      const idKey = resourceKey(target, img.id);
      if (seenImages.has(refKey) || seenImages.has(idKey)) continue;
      seenImages.add(refKey);
      resources.push({
        type: "image",
        ref,
        label: `orphan image ${ref.slice(0, 24)}`,
        runtime: docker,
        ...targetFields(target),
      });
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
  const cloudWorkspaceTarget: CollectedTarget | null = project.cloudWorkspaceId
    ? {
        key: `cloud:${project.cloudWorkspaceId}`,
        serverId: null,
        runtimeMode: "cloud",
      }
    : null;
  if (
    project.cloudWorkspaceId &&
    cloudWorkspaceTarget &&
    !seenContainers.has(resourceKey(cloudWorkspaceTarget, project.cloudWorkspaceId))
  ) {
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
        seenContainers.add(resourceKey(cloudWorkspaceTarget, project.cloudWorkspaceId));
        resources.push({
          type: "cloud_workspace",
          ref: project.cloudWorkspaceId,
          label: `cloud workspace ${project.cloudWorkspaceId}`,
          runtime: cloudPlatform.runtime,
          ...targetFields(cloudWorkspaceTarget),
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
          runtimeMode: "cloud",
        });
      }
    }
  }

  // ── Project networks (always cleaned - they're clutter, not data) ──
  // One per docker runtime (Docker installs are per-machine), keyed off
  // project slug to match the `openship-<slug>` naming in DockerRuntime.
  for (const docker of dockerRuntimes) {
    const target = runtimeTargets.get(docker);
    if (!target) continue;
    resources.push({
      type: "network",
      ref: project.slug,
      label: `network openship-${project.slug}`,
      runtime: docker,
      ...targetFields(target),
    });
  }

  // ── Domain routes (project-level) ──────────────────────────────────
  const domains = await repos.domain.listByProject(project.id);
  for (const d of domains) {
    pushRoute(d.hostname, `route ${d.hostname}`);
  }

  // ── Service-route fallback ─────────────────────────────────────────
  // Deployed routes normally have domain rows and were added above. Derive the
  // configured routes as a legacy/crash fallback, then feed them through the
  // same hostname set so one vhost is never deleted twice.
  for (const svc of services) {
    const routes = buildServiceRouteDomains({
      project,
      service: svc,
      runtimeName: "bare",
      usesManagedRouting: true,
    });
    for (const route of routes) {
      pushRoute(route.hostname, `service route ${route.hostname}`);
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

  return {
    projectId: project.id,
    organizationId: project.organizationId,
    resources,
    runtimes: [...resolvedRuntimes],
    routeContexts: [...routeContexts.values()],
    unreachableRouteTargets: [...unreachableRouteTargets.values()],
  };
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
  const serviceContainerByServiceId = new Map<
    string,
    { containerId: string; runtime: RuntimeAdapter }
  >();

  for (const dep of allDeps) {
    let runtime: RuntimeAdapter;
    try {
      ({ runtime } = await resolveDeploymentRuntime(dep));
    } catch {
      continue;
    }
    // Only the runtime's KIND is read here (nothing is executed against it), so
    // release the transport immediately rather than at the end of the loop.
    disposeRuntime(runtime);
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

    // Repair the map against the HOST: an adopted container (foreign labels) or
    // one a redeploy replaced isn't the id the rows name, and the preview would
    // then show "no container / no volumes" for a service whose volumes the
    // teardown sweep goes on to delete. The confirmation must not understate the
    // blast radius, so identity is resolved the same way everywhere.
    if (runtime instanceof DockerRuntime && runtime.supports("hostContainerQuery")) {
      const containers = await withTimeout(
        runtime.listAllContainers(),
        INSPECT_TIMEOUT_MS,
        `preview host containers ${project.id}`,
      ).catch(() => [] as Awaited<ReturnType<DockerRuntime["listAllContainers"]>>);
      if (containers.length > 0) {
        const matches = resolveLiveServiceState({
          services: services.map((s) => ({ id: s.id, name: s.name })),
          live: containers,
          projectId: project.id,
          slug: project.slug,
          trackedIds: Object.fromEntries(serviceRows.map((sd) => [sd.serviceId, sd.containerId])),
          // Same restriction as the teardown sweep below — the preview must list
          // exactly what the delete will touch, never more.
          tiers: TEARDOWN_MATCH_TIERS,
        });
        for (const [serviceId, match] of matches) {
          if (match.containerId) {
            serviceContainerByServiceId.set(serviceId, { containerId: match.containerId, runtime });
          }
        }
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

  const totalVolumes =
    deploymentVolumes.length + previewServices.reduce((n, s) => n + s.volumes.length, 0);

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

export interface DeploymentCleanupOpts {
  /**
   * Skip artifacts a LIVE or RETAINED release still needs (D3).
   *
   * Required, not optional: a compose service that didn't change carries its
   * `containerId` / `imageRef` verbatim onto the next release's row, so every
   * per-deployment teardown is one decision away from destroying another
   * release's running container. A caller has to say which it wants.
   *
   * ON for delete / reject / build-cancel — those remove ONE release and the
   * project keeps running. OFF only for a whole-project teardown, which is
   * meant to remove everything (and builds its manifest elsewhere anyway).
   */
  protectRetained: boolean;
  /**
   * A release that must survive even if it isn't flagged active yet. Reject
   * passes the predecessor it just asked to restore — that restore only
   * ENQUEUES a deploy, so the active pointer can still name the deployment
   * being rejected when this runs.
   */
  alsoProtectDeploymentId?: string | null;
}

/**
 * Collect resources for a single deployment.
 * Used by deleteDeployment(), rejectDeployment() and cancelBuildSession().
 */
export async function collectDeploymentManifest(
  dep: Deployment,
  project: Project | null,
  opts: DeploymentCleanupOpts,
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

  // A project-less deployment has no retained releases to protect, so the keep
  // set is empty by definition rather than unavailable.
  const keep =
    opts.protectRetained && project
      ? await computeCleanupKeepSet(project, {
          excludeDeploymentId: dep.id,
          alsoProtectDeploymentId: opts.alsoProtectDeploymentId,
        }).catch((err) => {
          // Fail CLOSED: an unresolvable keep set must not license destroying a
          // live release. Cleanup is retried by the image GC sweep; a deleted
          // container is not.
          console.error(`[CLEANUP] ${dep.id}: keep set failed, protecting everything:`, err);
          return null;
        })
      : { images: new Set<string>(), containers: new Set<string>() };
  const skip = (kind: "container" | "image", ref: string): boolean => {
    if (!keep) return true;
    const held = kind === "container" ? keep.containers : keep.images;
    if (!held.has(ref)) return false;
    console.log(
      `[CLEANUP] ${dep.id}: keeping ${kind} ${ref.slice(0, 24)} — a live or retained release still references it`,
    );
    return true;
  };

  // Resolve the runtime once. Anything below this point that depends on the
  // runtime (containers, images) only fires when the runtime is reachable.
  let runtime: RuntimeAdapter | null = null;
  try {
    runtime = (await resolveDeploymentRuntime(dep)).runtime;
  } catch {
    return { projectId: dep.projectId, organizationId: dep.organizationId, resources };
  }

  for (const containerId of containerIds) {
    if (skip("container", containerId)) continue;
    // A static deploy's containerId is its release DIRECTORY (see isArtifactRef).
    // Same destroy verb either way; the type is what the orphan row and the
    // preview copy read.
    resources.push(
      isArtifactRef(containerId)
        ? { type: "artifact", ref: containerId, label: `files ${containerId}`, runtime }
        : {
            type: "container",
            ref: containerId,
            label: `container ${containerId.slice(0, 12)}`,
            runtime,
          },
    );
  }

  // The deployment's image tag + each service's — or, for a static unit, the
  // host DIRECTORY those same columns hold. Hoisted out of the old
  // `runtime instanceof DockerRuntime` wrapper: that gate silently dropped a
  // static release directory on a bare runtime, and it is not the right question
  // for a path in the first place (issue #640).
  //
  // The keep-set consult is preserved for BOTH shapes, and it matters more for a
  // path: computeCleanupKeepSet already puts every live/retained `imageRef` —
  // directories included — into keep.images, which is what stops a
  // single-deployment teardown from rm -rf'ing the doc-root the edge is serving.
  {
    const seenRefs = new Set<string>();
    const pushImageOrArtifact = (ref: string | null | undefined, tagLabel: string) => {
      if (!ref || seenRefs.has(ref)) return;
      seenRefs.add(ref);
      if (skip("image", ref)) return;
      if (isArtifactRef(ref)) {
        resources.push({ type: "artifact", ref, label: `static output ${ref}`, runtime });
        return;
      }
      if (!(runtime instanceof DockerRuntime)) return;
      if (!ownsBuiltImage(ref)) return;
      resources.push({ type: "image", ref, label: tagLabel, runtime });
    };
    pushImageOrArtifact(dep.imageRef, `image ${(dep.imageRef ?? "").slice(0, 24)}`);
    for (const sd of serviceRows) {
      pushImageOrArtifact(sd.imageRef, `service image ${(sd.imageRef ?? "").slice(0, 24)}`);
    }
  }

  return { projectId: dep.projectId, organizationId: dep.organizationId, resources };
}

// ─── Cleanup Executor ────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 6;
const RETRY_DELAY_MS = 2000;
const CLEANUP_PHASES: ReadonlyArray<ReadonlySet<CleanupResource["type"]>> = [
  new Set(["container", "cloud_workspace", "unreachable"]),
  new Set(["artifact", "image"]),
  new Set(["route"]),
  new Set(["volume"]),
  new Set(["network"]),
];

/**
 * Execute cleanup for all resources in a manifest.
 *
 * - Bounded concurrency (default 6 parallel ops)
 * - Per-item error isolation: one failure doesn't block others
 * - Single retry with backoff for transient failures
 */
class CleanupTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupTimeoutError";
  }
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new CleanupTimeoutError(`cleanup timed out after ${ms}ms: ${label}`));
    }, ms);
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
  // A project can have deployment history on several physical targets after a
  // migration. Remove its vhosts from each reachable target. Falling back to
  // the process edge preserves cleanup for old manifests with no target context.
  const routeContexts =
    manifest.routeContexts && manifest.routeContexts.length > 0
      ? manifest.routeContexts
      : (manifest.unreachableRouteTargets?.length ?? 0) > 0
        ? []
        : [
            {
              key: "fallback:process-edge",
              routing: platform().routing,
              hostPortTarget: null,
              edgeProxy: null,
            },
          ];
  const result: CleanupResult = { total: manifest.resources.length, succeeded: 0, failed: [] };
  // The manifest's resources CARRY their runtime — collection resolves one per
  // deployment and hands it over for destruction here, so this is the first point
  // at which the transports are finished with. See `disposeManifestRuntimes`.
  try {
    // Preserve teardown dependencies explicitly. Sorting a flat array is not an
    // ordering guarantee when one batch starts containers, volumes and networks
    // together. Concurrency exists only inside a phase; a failed phase blocks all
    // later destructive phases so attached data/network state remains retryable.
    for (const phase of CLEANUP_PHASES) {
      const resources = manifest.resources.filter((resource) => phase.has(resource.type));
      if (result.failed.length > 0) {
        for (const resource of resources) {
          result.failed.push({
            ref: resource.ref,
            label: resource.label,
            error: "blocked by an earlier cleanup phase failure",
            type: resource.type,
          });
        }
        continue;
      }
      for (let i = 0; i < resources.length; i += concurrency) {
        const batch = resources.slice(i, i + concurrency);
        const settled = await Promise.allSettled(
          batch.map((resource) =>
            destroyResource(resource, routeContexts, manifest.organizationId),
          ),
        );

        for (let j = 0; j < settled.length; j++) {
          if (settled[j].status === "fulfilled") {
            result.succeeded++;
          } else {
            const resource = batch[j]!;
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
    }

    // Claims are a resource too. Reclaim them only after ALL workload and route
    // cleanup succeeded. A fresh edge scan proves vhost absence, but it cannot
    // prove a failed/stopped container no longer owns the bind; releasing in
    // that state would let another project inherit its durable port reservation.
    if (result.failed.length === 0) {
      for (const routeContext of manifest.routeContexts ?? []) {
        result.total += 1;
        try {
          const converged = await convergeTargetHostPortClaims({
            target: routeContext.hostPortTarget,
            projectId: manifest.projectId,
            desiredPublishes: [],
            edgeProxy: routeContext.edgeProxy,
          });
          if (converged.retained.length > 0) {
            const ports = [...new Set(converged.retained.map((claim) => claim.port))].sort(
              (a, b) => a - b,
            );
            throw new Error(
              `the edge still references this project's host port(s): ${ports.join(", ")}`,
            );
          }
          result.succeeded += 1;
        } catch (error) {
          result.failed.push({
            ref: routeContext.key,
            label: `host-port claims on ${routeContext.key}`,
            error: safeErrorMessage(error),
            type: "route",
          });
        }
      }
    }

    return result;
  } finally {
    disposeManifestRuntimes(manifest);
  }
}

/**
 * Release the transports a cleanup manifest is holding.
 *
 * Collection resolves ONE runtime per deployment and attaches it to every
 * resource it produced, so the same handle repeats — dedupe before disposing.
 * Exported because `executeCleanup` is not the only end of a manifest's life: the
 * force-orphan teardown records the resources for the GC sweep and returns
 * WITHOUT executing, which would otherwise strand one Docker-over-SSH bridge per
 * deployment on every enforced delete.
 */
export function disposeManifestRuntimes(manifest: CleanupManifest): void {
  const runtimes = [
    ...manifest.resources.map((resource) => resource.runtime),
    ...(manifest.runtimes ?? []),
  ];
  for (const runtime of new Set(runtimes)) {
    disposeRuntime(runtime ?? undefined);
  }
}

/** Destroy a single resource with one retry on failure. */
async function destroyResource(
  resource: CleanupResource,
  routeContexts: ReadonlyArray<Pick<CleanupRouteContext, "key" | "routing">>,
  organizationId?: string,
): Promise<void> {
  // Never race a destructive mutation against an artificial Promise timeout.
  // `withTimeout` cannot stop SSH/provider work; returning while it continues
  // would release the project fence and let a late remove destroy a freshly
  // redeployed route. Runtime/executor transports own their real I/O ceilings,
  // and this layer keeps the project lock until the mutation genuinely settles.
  const attempt = () => destroyResourceOnce(resource, routeContexts, organizationId);
  try {
    await attempt();
  } catch (error) {
    // A settled rejection may be transient and is safe to retry once.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    await attempt();
  }
}

async function destroyResourceOnce(
  resource: CleanupResource,
  routeContexts: ReadonlyArray<Pick<CleanupRouteContext, "key" | "routing">>,
  organizationId?: string,
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
      // Remove the vhost from every physical target this project has reached.
      // A migration can leave old deployment history on the source host; using
      // only the process-global edge would report success while a remote vhost
      // continued serving the hostname. Isolate failures per target: stopping at
      // the first broken edge leaves every later (possibly healthy) edge dirty.
      const failures: string[] = [];
      const targetResults = await Promise.allSettled(
        routeContexts.map(({ routing }) => routing.removeRoute(resource.ref)),
      );
      for (const [index, result] of targetResults.entries()) {
        if (result.status === "rejected") {
          failures.push(`${routeContexts[index]!.key}: ${safeErrorMessage(result.reason)}`);
        }
      }
      // Then the Cloud edge record, which is a SEPARATE resource for a managed
      // `*.opsh.io` hostname. Without this a deleted project left its free URL
      // resolving and its globally-unique slug reserved, so the org could not
      // re-claim its own name. Non-managed hostnames short-circuit inside the
      // helper. Throws on failure so the cleanup result reports it as a failed
      // resource rather than swallowing a leak.
      // Do not deregister the public managed hostname while a physical target
      // still failed and the project row is therefore staying alive. The retry
      // will release it after every target has converged.
      if (organizationId && failures.length === 0) {
        try {
          const released = await releaseManagedHostnames([resource.ref], { organizationId });
          if (released.failures.length > 0) {
            failures.push(`cloud edge: ${released.failures.join(", ")}`);
          }
        } catch (error) {
          failures.push(`cloud edge: ${safeErrorMessage(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`Route ${resource.ref} cleanup failed (${failures.join("; ")})`);
      }
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
