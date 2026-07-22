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

import { repos } from "@repo/db";
import { slugify } from "@repo/core";
import { ensureProject, createServicesProjectWithId } from "../projects/project-crud.service";
import { discoverServerStack } from "./docker-inspect.service";
import {
  EDGE_PORTS,
  parseComposePort,
  type DiscoveredService,
  type DiscoveredVolumeMount,
} from "./docker-reconcile";

type EnsureBody = Parameters<typeof ensureProject>[0];
type ParsedComposeList = Parameters<typeof repos.service.syncFromCompose>[1];

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
  /** True: records + preserved id only; the user redeploys to finalize live state. */
  deferredDeployment: true;
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
function buildAdoptedServiceRows(chosen: DiscoveredService[], selected: Set<string>): ParsedComposeList {
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
      environment: s.env,
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
}): Promise<AdoptResult> {
  const { serverId, organizationId, projectName, serviceNames, sameServer, volumeStrategies } = opts;

  const stack = await discoverServerStack(serverId, organizationId);
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

  const parsed = buildAdoptedServiceRows(chosen, selected);
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
 * Re-import an ORPHANED Openship project recovered from a server (see
 * `reconcileOpenshipProjects`): the DB was reset (DR) or the server came from
 * another Openship instance. Rebuilds the project + compose service rows,
 * PRESERVING the original id (+ slug) so the still-running containers' labels
 * re-attach immediately — teardown/reclaim/network reconcile recognize them, and
 * a later redeploy replaces same-id containers cleanly. Records only: no data
 * move, no redeploy; the user redeploys from the project to finalize live state.
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

  return {
    projectId: created.id,
    slug: created.slug,
    reimported: chosen.map((s) => s.name),
    deferredDeployment: true,
  };
}
