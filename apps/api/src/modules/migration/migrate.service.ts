/**
 * Adopt a discovered Docker stack as an Openship project.
 *
 * Re-discovers the server (server truth, not client-sent config), filters to the
 * services the user selected, and creates a `services` project whose service
 * rows mirror the running containers. Same-server adoption reuses the EXISTING
 * named volumes in place by default (`namespaceVolumes=false`, original bare
 * names) so data survives — Openship would otherwise re-scope them to
 * `openship-<slug>-<name>` and mount empty volumes. A service the user marks
 * "copy" instead keeps the scoped name; its data is duplicated into that new
 * volume during moving_data, leaving the original volume untouched.
 *
 * This creates records only; deploy + cutover (stop old → start Openship's) is a
 * separate step so the user reviews before anything on the server changes.
 */

import { repos, restoreSubgraph, PkCollisionError, type Service } from "@repo/db";
import { slugify, safeErrorMessage } from "@repo/core";
import type { ContainerStatus } from "@repo/adapters";
import type { RequestContext } from "../../lib/request-context";
import { ensureProject, createServicesProjectWithId } from "../projects/project-crud.service";
import { getFileContent } from "../github/github.service";
import { parseComposeFile } from "../../lib/compose-parser";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { sshManager } from "../../lib/ssh-manager";
import { readProjectSnapshot } from "../../lib/openship-manifest";
import { discoverServerStack } from "./docker-inspect.service";
import {
  EDGE_PORTS,
  parseComposePort,
  type DiscoveredService,
  type DiscoveredVolumeMount,
  type OpenshipProjectGroup,
} from "./docker-reconcile";

type EnsureBody = Parameters<typeof ensureProject>[0];
type ParsedComposeList = Parameters<typeof repos.service.syncFromCompose>[1];

/** Openship deployment id shape — validated before trusting a server label as a PK. */
const DEPLOYMENT_ID_RE = /^dep_[A-Za-z0-9]+$/;

/** Compose file names to probe in a linked repo (mirrors prepare.service COMPOSE_FILES). */
const REPO_COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

/** Minimal compose-service shape returned to the migrate wizard's mapping step. */
export interface RepoComposeService {
  name: string;
  build?: string;
  dockerfile?: string;
  image?: string;
  ports: string[];
}

/**
 * Parse a LINKED repo's docker-compose into its services, so the migrate wizard
 * can map each discovered running container to a compose service (the matched
 * service's build context becomes that service's source subpath). Reads the file
 * over the GitHub REST API — no clone. Returns [] when the repo has no compose
 * file (or invalid YAML): the repo still links at project level, the map is just
 * empty. GitHub only (v1).
 */
export async function parseRepoCompose(
  ctx: RequestContext,
  owner: string,
  repo: string,
  branch?: string,
): Promise<RepoComposeService[]> {
  for (const file of REPO_COMPOSE_FILES) {
    let content: string | null = null;
    try {
      const res = await getFileContent(ctx, owner, repo, file, { branch });
      content = res?.content ?? null;
    } catch {
      continue; // not found at this name → try the next
    }
    if (!content) continue;
    try {
      return parseComposeFile(content).services.map((s) => ({
        name: s.name,
        build: s.build ?? undefined,
        dockerfile: s.dockerfile ?? undefined,
        image: s.image ?? undefined,
        ports: s.ports ?? [],
      }));
    } catch {
      return []; // invalid YAML → graceful empty
    }
  }
  return [];
}

/** Overall deployment status from the live per-container states. */
export function deriveDeploymentStatus(states: ContainerStatus[]): "ready" | "partial_failure" | "failed" {
  const running = states.filter((s) => s === "running").length;
  if (running === states.length && running > 0) return "ready";
  if (running > 0) return "partial_failure";
  return "failed";
}

export interface AdoptResult {
  projectId: string;
  slug: string;
  created: boolean;
  adopted: string[];
}

export interface ReimportResult {
  projectId: string;
  slug: string;
  reimported: string[];
  /** Reconstructed/restored deployment id (project is live). */
  deploymentId?: string;
  /** True when the running containers were re-attached (project is immediately
   *  live: status/logs/services). False → records-only (containers gone or
   *  unreachable); a redeploy materializes it. */
  reattached: boolean;
  /** True when restored FAITHFULLY from the server's full subgraph snapshot
   *  (exact rows). False → best-effort reconstruction from live docker. */
  restored: boolean;
}

/** A discovered mount → compose volume string. Anonymous (no source) is dropped
 *  (its data isn't reusable in place). Named volumes keep their original bare
 *  name; bind mounts keep their host path. */
function volumeToComposeString(v: DiscoveredVolumeMount): string | null {
  if (!v.source) return null;
  const mode = v.rw ? "" : ":ro";
  return `${v.source}:${v.target}${mode}`;
}

/** Normalize an adopted service's ports for the shared Openship service group:
 *
 *   - Ports 80/443 belong to Openship's OpenResty edge → drop the host side,
 *     keep the container port (e.g. "80:3000" → "3000"); OpenResty routes to it.
 *   - Every OTHER host-published port must be UNIQUE across the group — two
 *     containers cannot bind the same host port (the classic "two postgres both
 *     on 127.0.0.1:5432" migration failure: `port is already allocated`). The
 *     first service to claim a host port keeps it; a later collision drops only
 *     the HOST binding and keeps the container port, so the service stays
 *     reachable by name on the group network (`postgres-2:5432`).
 *
 *  `claimed` is the shared set of host ports already taken by earlier services
 *  in the group (mutated here). Returns the rewritten ports + the host ports
 *  that were dropped as duplicates (for a user-facing note). */
function normalizeHostPorts(
  ports: string[],
  claimed: Set<number>,
): { ports: string[]; droppedDuplicates: number[] } {
  const droppedDuplicates: number[] = [];
  const out = ports.map((spec) => {
    const { host, container, proto } = parseComposePort(spec);
    const containerOnly = proto ? `${container}/${proto}` : container;
    if (host == null) return spec; // container-only expose — nothing published
    if (EDGE_PORTS.has(host)) return containerOnly; // edge → OpenResty
    if (claimed.has(host)) {
      droppedDuplicates.push(host);
      return containerOnly; // duplicate host port — keep only the container side
    }
    claimed.add(host);
    return spec; // unique host publish — keep as-is
  });
  return { ports: out, droppedDuplicates };
}

/**
 * Map selected discovered services → compose service rows for `syncFromCompose`.
 * Shared by adopt AND re-import so the two paths can't drift: unique names,
 * group-wide host-port de-dup, adopt-the-running-image (never rebuild), and —
 * critically — services are left UNEXPOSED. Exposing here would fire the
 * routing/OpenResty ensure mid-import (which needs the 80/443 takeover-consent
 * modal the wizard can't surface); instead the user adds routes from the
 * project's Domains tab, and THAT redeploy runs the one unified ensure-OpenResty
 * + takeover-consent flow. Pushes a per-service warning when a host port is
 * dropped as a duplicate.
 */
function buildAdoptedServiceRows(
  chosen: DiscoveredService[],
  selected: Set<string>,
  serviceEnv?: Record<string, Record<string, string>>,
): ParsedComposeList {
  const nameCounts = new Map<string, number>();
  const firstUnique = new Map<string, string>();
  const uniqueNames = chosen.map((s) => {
    const n = (nameCounts.get(s.name) ?? 0) + 1;
    nameCounts.set(s.name, n);
    const unique = n === 1 ? s.name : `${s.name}-${n}`;
    if (!firstUnique.has(s.name)) firstUnique.set(s.name, unique);
    return unique;
  });

  const claimedHostPorts = new Set<number>();
  return chosen.map((s, i) => {
    const { ports, droppedDuplicates } = normalizeHostPorts(s.ports, claimedHostPorts);
    if (droppedDuplicates.length > 0) {
      s.warnings.push(
        `Host port(s) ${droppedDuplicates.join(", ")} already published by another service — ` +
          `kept ${uniqueNames[i]} on the internal network only (reachable as ${uniqueNames[i]}:<port>).`,
      );
    }
    return {
      name: uniqueNames[i],
      kind: "compose" as const,
      // Adopt the running container AS-IS via its current image — we don't have
      // its original build source, so never carry a build context (which would
      // make the deploy rebuild-from-source and fail preflight). Only an
      // image-less container (rare) falls back to its build context.
      image: s.image,
      build: s.image ? undefined : s.build,
      dockerfile: s.image ? undefined : s.dockerfile,
      ports,
      // Only keep dependencies on services we're also adopting.
      dependsOn: s.dependsOn.filter((d) => selected.has(d)).map((d) => firstUnique.get(d) ?? d),
      // Env override (edited in the wizard) keyed by the DISCOVERED name; default
      // = the container's live env.
      environment: serviceEnv?.[s.name] ?? s.env,
      volumes: s.volumes.map(volumeToComposeString).filter((v): v is string => v !== null),
      command: s.command,
      restart: s.restart,
      advanced: s.healthcheck ? { healthcheck: s.healthcheck } : undefined,
    };
  });
}


export async function adoptServerStack(opts: {
  serverId: string;
  organizationId: string;
  projectName: string;
  serviceNames: string[];
  /** True when target == source. Only then is "copy" (below) meaningful. */
  sameServer?: boolean;
  /** serviceName → "reuse" | "copy" (same-server volume ownership). */
  volumeStrategies?: Record<string, "reuse" | "copy">;
  /** serviceName → build subpath (rootDirectory) inside the project's linked
   *  repo. Recorded metadata only — sets no build/framework, so the adopted
   *  image is still reused; it takes effect on a later source rebuild. */
  serviceSubpaths?: Record<string, string>;
  /** serviceName → env override (edited in the wizard). Absent → the container's
   *  live env is adopted as-is. */
  serviceEnv?: Record<string, Record<string, string>>;
  /** Adopt in flat-docker mode — must match the scan the user selected from, or
   *  openship-labeled containers are treated as managed and none are found. */
  flatDocker?: boolean;
}): Promise<AdoptResult> {
  const { serverId, organizationId, projectName, serviceNames, sameServer, volumeStrategies, serviceSubpaths, serviceEnv, flatDocker } = opts;

  const stack = await discoverServerStack(serverId, organizationId, undefined, { flatDocker });
  const selected = new Set(serviceNames);
  // Drop the edge proxy (traefik/nginx/… on 80/443): OpenResty replaces it, so
  // adopting it would just replay the 80/443 conflict. Defense-in-depth — the
  // wizard already marks it non-importable and the orchestrator filters it too.
  const chosen = stack.services.filter((s) => selected.has(s.name) && !s.proxyKind);
  if (chosen.length === 0) {
    throw new Error("None of the selected services were found on the server.");
  }

  // Cross-server can't move a LOCALLY-BUILT image: it isn't in a registry, so a
  // different target host has nothing to pull. Registry-image stacks migrate
  // across servers fine (the target pulls them); built ones must be taken over
  // IN PLACE (same server, where the built image already exists). Moving built
  // images across hosts (docker save|load stream) is coming soon.
  if (!sameServer) {
    const built = chosen.filter((s) => Boolean(s.build)).map((s) => s.name);
    if (built.length > 0) {
      throw new Error(
        `Cross-server migration can't move locally-built images yet (${built.join(", ")}). ` +
          `Take these over in place (migrate to the same server), or rebuild them from a registry image. Cross-server for built images is coming soon.`,
      );
    }
  }

  // Only a container with NO resolvable image genuinely needs a build source.
  // A container that was originally built from source still RUNS an image on the
  // host, so we adopt that image rather than rebuild — see the mapping below.
  const anyBuild = chosen.some((s) => !s.image && Boolean(s.build));
  const ensureBody: EnsureBody = {
    name: projectName,
    projectType: "services",
    hasServer: true,
    hasBuild: anyBuild,
  };
  const { project_id, created } = await ensureProject(ensureBody, organizationId);

  const parsed = buildAdoptedServiceRows(chosen, selected, serviceEnv);
  const createdServices = await repos.service.syncFromCompose(project_id, parsed);

  // Volume ownership: reuse the original bare-named volumes in place
  // (namespaceVolumes=false) — EXCEPT same-server services the user marked
  // "copy", which keep the scoped openship-<slug>-<name> name so the deploy
  // mounts the fresh copy (populated in moving_data) and the original volume is
  // left untouched. Cross-server always reuses bare names (the A→B stream trick).
  for (const svc of createdServices) {
    const copy = Boolean(sameServer) && volumeStrategies?.[svc.name] === "copy";
    if (svc.namespaceVolumes !== copy) {
      await repos.service.update(svc.id, { namespaceVolumes: copy });
    }
  }

  // Per-service build subpath: point each adopted service at a folder inside the
  // project's linked repo. Pure metadata (rootDirectory only, no build/framework)
  // so it does NOT flip the row to build-from-source — the running image is still
  // reused. Applies on a later source rebuild.
  if (serviceSubpaths) {
    for (const svc of createdServices) {
      const sub = serviceSubpaths[svc.name]?.trim();
      if (sub && svc.rootDirectory !== sub) {
        await repos.service.update(svc.id, { rootDirectory: sub });
      }
    }
  }

  const project = await repos.project.findById(project_id);
  return {
    projectId: project_id,
    slug: project?.slug ?? "",
    created,
    adopted: chosen.map((s) => s.name),
  };
}

/** Openship id shape — validated before we trust a server-supplied label as a PK. */
const PROJECT_ID_RE = /^proj_[A-Za-z0-9]+$/;

/**
 * Live re-attach: reconstruct the runtime graph (deployment + service_deployment
 * rows) from the ALREADY-RUNNING containers, PRESERVING the deployment id so the
 * live containers (labelled `openship.deployment=<id>`) stay attached — the
 * Services tab reads live docker by that label, so the project shows deployed +
 * running with NO redeploy and no container disruption. Best-effort: returns the
 * reconstructed deployment id, or null when it can't run (no preserved dep id, id
 * collision, or runtime unreachable) — the caller then keeps records-only.
 */
async function reattachRuntime(opts: {
  projectId: string;
  organizationId: string;
  serverId: string;
  group: OpenshipProjectGroup;
  chosen: DiscoveredService[];
  createdServices: Service[];
}): Promise<string | null> {
  const { projectId, organizationId, serverId, group, chosen, createdServices } = opts;

  // Need the ORIGINAL deployment id (from the openship.deployment label) so the
  // running containers match the live-status query. Absent / malformed → not a
  // standard deploy container; skip (records-only). Refuse if it already exists.
  const depId = group.deploymentId;
  if (!depId || !DEPLOYMENT_ID_RE.test(depId)) return null;
  if (await repos.deployment.findById(depId)) return null;

  const rt = await createServerDockerRuntime(serverId, organizationId);
  try {
    // Map each created service row → its live container (by name) → live info.
    const discByName = new Map(chosen.map((c) => [c.name, c]));
    const placements = await Promise.all(
      createdServices.map(async (service) => {
        const disc = discByName.get(service.name);
        let status: ContainerStatus = disc?.running ? "running" : "stopped";
        let ip: string | undefined;
        let hostPort: number | undefined;
        if (disc?.containerId) {
          const info = await rt.getContainerInfo(disc.containerId).catch(() => null);
          if (info) ({ status, ip, hostPort } = info);
        }
        return { service, containerId: disc?.containerId, image: disc?.image, status, ip, hostPort };
      }),
    );

    const dep = await repos.deployment.create({
      id: depId,
      projectId,
      organizationId,
      branch: group.source?.gitBranch ?? "main",
      environment: "production",
      status: deriveDeploymentStatus(placements.map((p) => p.status)),
      containerId: "compose", // multi-service sentinel (single-app modeled as 1 service)
      imageRef: chosen.find((c) => c.image)?.image ?? null,
      trigger: "manual",
      meta: { serverId, runtimeMode: "docker", adopt: true, serviceDeploymentMode: "services" },
    });
    if (!dep) return null;

    for (const p of placements) {
      await repos.service.upsertServiceDeployment({
        deploymentId: depId,
        serviceId: p.service.id,
        serviceName: p.service.name,
        containerId: p.containerId ?? null,
        status: p.status === "running" ? "success" : "failure",
        imageRef: p.image ?? null,
        hostPort: p.hostPort ?? null,
        ip: p.ip ?? null,
      });
    }

    await repos.project.setActiveDeployment(projectId, depId);
    return depId;
  } finally {
    await rt.dispose().catch(() => {});
  }
}

/**
 * Same-server "reuse" takeover: attach the ALREADY-RUNNING source containers to a
 * migrated project's deployment WITHOUT redeploying — no new container, no volume
 * move, zero downtime. Reconstructs the service_deployment rows straight from the
 * live containers (by their existing container id), so the Services tab reads them
 * live immediately. The migrated project is a NEW id, so (unlike re-import) the
 * caller MINTS the deployment id and the adopted containers keep their ORIGINAL
 * `openship.*`/compose labels — status/logs work now via the stored container id,
 * but a LATER redeploy/teardown of the migrated project won't recognize them
 * (labels are immutable in place). This is the accepted trade for "control it in
 * place" on the same server; `copy`/cross-server services take the deploy path.
 *
 * When `deploymentId` already exists (a mixed run whose `copy` services were just
 * deployed) the attach rows are added to THAT deployment and the active-deployment
 * pointer is left as the deploy set it. When it does not (pure reuse run) the row
 * is created here and set active.
 */
export async function attachLiveRuntime(opts: {
  deploymentId: string;
  projectId: string;
  organizationId: string;
  serverId: string;
  attach: DiscoveredService[];
  serviceRows: Service[];
}): Promise<void> {
  const { deploymentId, projectId, organizationId, serverId, attach, serviceRows } = opts;
  if (attach.length === 0) return;

  const rt = await createServerDockerRuntime(serverId, organizationId);
  try {
    const discByName = new Map(attach.map((c) => [c.name, c]));
    const attachRows = serviceRows.filter((s) => discByName.has(s.name));
    const placements = await Promise.all(
      attachRows.map(async (service) => {
        const disc = discByName.get(service.name);
        let status: ContainerStatus = disc?.running ? "running" : "stopped";
        let ip: string | undefined;
        let hostPort: number | undefined;
        if (disc?.containerId) {
          const info = await rt.getContainerInfo(disc.containerId).catch(() => null);
          if (info) ({ status, ip, hostPort } = info);
        }
        return { service, containerId: disc?.containerId, image: disc?.image, status, ip, hostPort };
      }),
    );

    // Create the deployment row only for a pure-reuse run (the deploy path already
    // created + activated it in a mixed run).
    const existing = await repos.deployment.findById(deploymentId);
    if (!existing) {
      const dep = await repos.deployment.create({
        id: deploymentId,
        projectId,
        organizationId,
        branch: "main",
        environment: "production",
        status: deriveDeploymentStatus(placements.map((p) => p.status)),
        containerId: "compose", // multi-service sentinel
        imageRef: attach.find((c) => c.image)?.image ?? null,
        trigger: "manual",
        meta: { serverId, runtimeMode: "docker", adopt: true, adoptLive: true, serviceDeploymentMode: "services" },
      });
      if (!dep) return;
    }

    for (const p of placements) {
      await repos.service.upsertServiceDeployment({
        deploymentId,
        serviceId: p.service.id,
        serviceName: p.service.name,
        containerId: p.containerId ?? null,
        status: p.status === "running" ? "success" : "failure",
        imageRef: p.image ?? null,
        hostPort: p.hostPort ?? null,
        ip: p.ip ?? null,
      });
    }

    if (!existing) await repos.project.setActiveDeployment(projectId, deploymentId);
  } finally {
    await rt.dispose().catch(() => {});
  }
}

/**
 * Refresh a RESTORED deployment's runtime rows against live docker: the snapshot
 * carried each container's ip/hostPort as of the last deploy, but IPs change on
 * restart. Re-read `getContainerInfo` per service_deployment container, update
 * ip/hostPort/status, and recompute the deployment badge from the live states.
 * Best-effort — the Services tab is a live read anyway, so a failure here only
 * leaves the stored ip/status at their (last-deploy) snapshot values.
 */
async function refreshRestoredRuntime(
  serverId: string,
  organizationId: string,
  deploymentId: string,
): Promise<void> {
  const sdeps = (await repos.service.listByDeployment(deploymentId)).filter((s) => s.containerId);
  if (sdeps.length === 0) return;
  const rt = await createServerDockerRuntime(serverId, organizationId);
  try {
    const states: ContainerStatus[] = [];
    for (const sd of sdeps) {
      const info = await rt.getContainerInfo(sd.containerId!).catch(() => null);
      const status: ContainerStatus = info?.status ?? "missing";
      states.push(status);
      await repos.service.upsertServiceDeployment({
        deploymentId,
        serviceId: sd.serviceId,
        serviceName: sd.serviceName ?? undefined,
        containerId: sd.containerId,
        status: status === "running" ? "success" : "failure",
        imageRef: sd.imageRef ?? null,
        hostPort: info?.hostPort ?? sd.hostPort ?? null,
        ip: info?.ip ?? sd.ip ?? null,
      });
    }
    await repos.deployment.updateStatus(deploymentId, deriveDeploymentStatus(states));
  } finally {
    await rt.dispose().catch(() => {});
  }
}

/**
 * FAITHFUL restore path: read the server's full project-subgraph snapshot
 * (`dumpSubgraph`) and `restoreSubgraph` it — the exact original rows (services,
 * deployments, service_deployments, domains, env structure), ORIGINAL ids
 * preserved, org remapped to the current org. Then refresh live ip/status.
 * Returns null when no usable snapshot exists (caller falls back to live
 * reconstruction). Maps a PK/unique collision to a friendly error.
 */
async function restoreFromSnapshot(opts: {
  serverId: string;
  organizationId: string;
  projectId: string;
}): Promise<ReimportResult | null> {
  const { serverId, organizationId, projectId } = opts;
  const dump = await sshManager
    .withExecutor(serverId, (exec) => readProjectSnapshot(exec, projectId))
    .catch(() => null);
  // Only restore a snapshot that IS this project's (guards a stale/mismatched file).
  if (!dump || dump.scope.kind !== "project" || dump.scope.projectId !== projectId) return null;

  try {
    await restoreSubgraph(dump, { mode: "merge", remapOrgId: organizationId });
  } catch (err) {
    if (err instanceof PkCollisionError) {
      throw new Error(
        "A project or domain with this name already exists here — resolve the conflict, then re-import.",
      );
    }
    throw err;
  }

  const project = await repos.project.findById(projectId);
  const deploymentId = project?.activeDeploymentId ?? null;
  if (deploymentId) {
    await refreshRestoredRuntime(serverId, organizationId, deploymentId).catch(() => {});
  }
  const svcRows = await repos.service.listByProject(projectId).catch(() => []);
  return {
    projectId,
    slug: project?.slug ?? "",
    reimported: svcRows.map((s) => s.name),
    reattached: true,
    restored: true,
    ...(deploymentId ? { deploymentId } : {}),
  };
}

/**
 * Re-import an ORPHANED Openship project recovered from a server (see
 * `reconcileOpenshipProjects`): the DB was reset (DR) or the server came from
 * another Openship instance. Rebuilds the project + compose service rows,
 * PRESERVING the original id (+ slug) so the still-running containers' labels
 * re-attach immediately — teardown/reclaim/network reconcile recognize them. Then
 * LIVE RE-ATTACHES the runtime graph (deployment + service_deployment rows) from
 * the running containers (`reattachRuntime`) so the project is immediately live
 * (status/logs/services) with no redeploy and no container disruption.
 *
 * Uses the SAME service mapping as adopt (`buildAdoptedServiceRows`) — services
 * land UNEXPOSED, so routing/OpenResty is untouched here; adding a domain later
 * runs the unified ensure-OpenResty + 80/443 takeover-consent flow.
 */
export async function reimportOpenshipProject(opts: {
  serverId: string;
  organizationId: string;
  projectId: string;
  projectName?: string;
  serviceNames?: string[];
}): Promise<ReimportResult> {
  const { serverId, organizationId, projectId, projectName, serviceNames } = opts;

  // Never trust a raw label as a primary key without shape-checking it.
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error("Invalid Openship project id.");
  }
  // Refuse-not-merge: if ANY project (any org, incl. soft-deleted) already owns
  // this id, do not graft server-supplied state onto it.
  const existing = await repos.project.findById(projectId);
  if (existing) {
    throw new Error("A project with this id already exists here — nothing to re-import.");
  }

  const stack = await discoverServerStack(serverId, organizationId);
  const group = stack.openshipProjects.find((p) => p.projectId === projectId);
  if (!group) {
    throw new Error("That Openship project was not found on the server.");
  }
  if (group.knownHere) {
    throw new Error("That Openship project is already managed by this instance.");
  }

  // PRIMARY: a full server-side subgraph snapshot → restore it faithfully (exact
  // rows). Falls through to the live-reconstruction path below when no usable
  // snapshot exists (pre-snapshot deploy, or the file was removed).
  if (group.hasSnapshot) {
    const restored = await restoreFromSnapshot({ serverId, organizationId, projectId });
    if (restored) return restored;
  }

  // FALLBACK (no snapshot): reconstruct config + runtime from the live containers.
  const selected = serviceNames?.length
    ? new Set(serviceNames)
    : new Set(group.services.map((s) => s.name));
  const chosen = group.services.filter((s) => selected.has(s.name) && !s.proxyKind);
  if (chosen.length === 0) {
    throw new Error("None of the selected services were found on the server.");
  }

  const name = projectName?.trim() || group.suggestedName;
  const anyBuild = chosen.some((s) => !s.image && Boolean(s.build));
  const created = await createServicesProjectWithId({
    id: projectId,
    name,
    slug: group.slug || slugify(name),
    organizationId,
    hasBuild: anyBuild,
    runtimeMode: group.runtimeMode === "bare" ? "bare" : "docker",
    gitProvider: group.source?.gitProvider ?? undefined,
    gitOwner: group.source?.gitOwner ?? undefined,
    gitRepo: group.source?.gitRepo ?? undefined,
    gitBranch: group.source?.gitBranch ?? undefined,
  });

  const parsed = buildAdoptedServiceRows(chosen, selected);
  const createdServices = await repos.service.syncFromCompose(created.id, parsed);

  // Reuse the original bare-named volumes in place (data survives) — combined
  // with the preserved id, the running containers count as this project's own in
  // the deploy volume-owner guard, so a redeploy reattaches without conflict.
  for (const svc of createdServices) {
    if (svc.namespaceVolumes !== false) {
      await repos.service.update(svc.id, { namespaceVolumes: false });
    }
  }

  // Live re-attach the runtime graph so the project is immediately usable.
  // Best-effort — on any failure the config rows stand and the result reports
  // records-only (a redeploy would then materialize the runtime).
  let deploymentId: string | null = null;
  try {
    deploymentId = await reattachRuntime({
      projectId: created.id,
      organizationId,
      serverId,
      group,
      chosen,
      createdServices,
    });
  } catch (err) {
    console.warn(`[reimport] live re-attach failed (records-only): ${safeErrorMessage(err)}`);
  }

  return {
    projectId: created.id,
    slug: created.slug,
    reimported: chosen.map((s) => s.name),
    reattached: deploymentId !== null,
    restored: false,
    ...(deploymentId ? { deploymentId } : {}),
  };
}
