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
import { unmaskEnv } from "../../lib/secret-env";
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

/** Compose-service shape returned to the migrate wizard's mapping step. Carries
 *  enough to render a full native service card (env + deps), so a repo service
 *  with no running container (e.g. `redis`) is a first-class, editable unit. */
export interface RepoComposeService {
  name: string;
  build?: string;
  dockerfile?: string;
  image?: string;
  ports: string[];
  environment: Record<string, string>;
  dependsOn: string[];
  volumes: string[];
  command?: string;
  commandArgv?: string[] | null; // #332
  restart?: string;
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
  // NB: we deliberately do NOT read the repo's `.env` for `${VAR}` interpolation.
  // Secrets live in Openship's ENCRYPTED env store — captured from the running
  // container for adopted services, or set via the wizard/env UI for new ones —
  // never a committed repo file. Pulling a `.env` here would drop those values
  // into the PLAINTEXT service.environment column. So a bare `${VAR}` with no
  // inline default resolves to "" and the real value comes from the env store.
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
        environment: s.environment ?? {},
        dependsOn: s.dependsOn ?? [],
        volumes: s.volumes ?? [],
        command: s.command ?? undefined,
        commandArgv: s.commandArgv ?? null, // #332
        restart: s.restart ?? undefined,
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
  /** DISCOVERED service name → the adopted ROW name (the repo compose name when
   *  the wizard mapped it, else the discovered name). Lets the orchestrator
   *  translate discovered-keyed attach/route inputs onto the (renamed) rows. */
  renames: Record<string, string>;
  /** ROW name → running image to reuse ONCE at the first deploy (handoverImages).
   *  Only populated for native `build:` rows (which would otherwise rebuild on
   *  their first deploy). Empty when no repo is linked / everything is image-only. */
  handover: Record<string, string>;
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
  const out: string[] = [];
  for (const spec of ports) {
    const { host, container, proto } = parseComposePort(spec);
    const containerOnly = proto ? `${container}/${proto}` : container;
    if (host == null) {
      // DROP a bare "<port>" — it does NOT mean "nothing published". A single-part
      // compose `ports:` entry publishes the container port on a RANDOM host port
      // (docker: `HostPort: ""`). Adoption deliberately leaves services UNEXPOSED
      // (routing + its pinned loopback host port are added later from the Domains
      // tab), so an internal / expose-only port — e.g. a database's 5432 that the
      // source never published — must not be host-published here: doing so
      // needlessly exposes the DB and collides with whatever already holds a host
      // port on the box (#388). Compose service-to-service still resolves the
      // container by name over the shared network with no `ports:` entry, so this
      // is safe; the discovered ports are untouched, so the wizard still shows the
      // port for the operator to route to.
      continue;
    }
    if (EDGE_PORTS.has(host)) {
      out.push(containerOnly); // edge → OpenResty owns 80/443
      continue;
    }
    if (claimed.has(host)) {
      droppedDuplicates.push(host);
      out.push(containerOnly); // duplicate host port — keep only the container side
      continue;
    }
    claimed.add(host);
    out.push(spec); // unique host publish — keep as-is
  }
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
export function buildAdoptedServiceRows(
  chosen: DiscoveredService[],
  selected: Set<string>,
  serviceEnv?: Record<string, Record<string, string>>,
  /** DISCOVERED service name → the repo compose service name to adopt AS. When
   *  the wizard mapped a moved container to a repo compose service, name the row
   *  after the REPO service so a later git-compose reconcile matches it in place
   *  (no duplicate row / no fresh empty volume). Keyed by discovered name to
   *  match serviceEnv/serviceSubpaths/volumeStrategies. */
  serviceRenames?: Record<string, string>,
  /** Mapped repo compose service spec, keyed by REPO service name. When a
   *  discovered container maps to one, the row takes that service's NATIVE
   *  build/image spec (so a later Redeploy reclones + rebuilds `build:` services
   *  / pulls `image:` ones) — the running image is reused only ONCE, via the
   *  returned `handover` map fed to the deploy's handoverImages. Absent (no repo
   *  linked / unmapped) → the row adopts the running image as-is (legacy). */
  repoServices?: Map<string, RepoComposeService>,
): {
  rows: ParsedComposeList;
  renames: Record<string, string>;
  handover: Record<string, string>;
  /** Host ports already claimed by the adopted rows — reused when normalizing the
   *  new (container-less) repo rows so both paths strip 80/443 + dedupe together. */
  claimedHostPorts: Set<number>;
} {
  const nameCounts = new Map<string, number>();
  const firstUnique = new Map<string, string>(); // discovered name → FINAL row name
  const renames: Record<string, string> = {};
  const uniqueNames = chosen.map((s) => {
    const desired = serviceRenames?.[s.name]?.trim() || s.name;
    const n = (nameCounts.get(desired) ?? 0) + 1;
    nameCounts.set(desired, n);
    const unique = n === 1 ? desired : `${desired}-${n}`;
    if (!firstUnique.has(s.name)) firstUnique.set(s.name, unique);
    renames[s.name] = unique;
    return unique;
  });

  const claimedHostPorts = new Set<number>();
  const handover: Record<string, string> = {};
  const rows = chosen.map((s, i) => {
    const { ports, droppedDuplicates } = normalizeHostPorts(s.ports, claimedHostPorts);
    if (droppedDuplicates.length > 0) {
      s.warnings.push(
        `Host port(s) ${droppedDuplicates.join(", ")} already published by another service — ` +
          `kept ${uniqueNames[i]} on the internal network only (reachable as ${uniqueNames[i]}:<port>).`,
      );
    }
    // Source of truth for build/image:
    //  • Mapped to a repo compose service → take its NATIVE spec (build path /
    //    registry image), so the project behaves like a native repo project:
    //    Redeploy reclones + rebuilds `build:` services and pulls `image:` ones.
    //    The running image is reused ONE TIME via the `handover` map below (fed to
    //    the deploy as handoverImages) — never frozen into the row.
    //  • No mapping (no repo linked / unmapped) → adopt the running image as-is
    //    (legacy: we have no build source, so reuse the image). Cross-server the
    //    image is transferred (docker save|load) so the target has it.
    const repo = repoServices?.get(uniqueNames[i]) ?? repoServices?.get(serviceRenames?.[s.name] ?? s.name);
    const native = repo && (repo.build || repo.image);
    const source = native
      ? { image: repo.image, build: repo.build, dockerfile: repo.dockerfile }
      : { image: s.image, build: s.image ? undefined : s.build, dockerfile: s.image ? undefined : s.dockerfile };
    // Hand the running image to the deploy for the one-time cutover: a native
    // `build:` row would otherwise rebuild on its very first deploy. Only when we
    // actually have a running image to reuse.
    if (native && s.image && repo?.build) handover[uniqueNames[i]] = s.image;
    return {
      name: uniqueNames[i],
      kind: "compose" as const,
      image: source.image,
      build: source.build,
      dockerfile: source.dockerfile,
      ports,
      // Only keep dependencies on services we're also adopting.
      dependsOn: s.dependsOn.filter((d) => selected.has(d)).map((d) => firstUnique.get(d) ?? d),
      // Env override (edited in the wizard) keyed by the DISCOVERED name; default
      // = the container's live env. #336: the wizard sees env masked, so restore
      // any echoed mask sentinel from the freshly-discovered live env (server truth).
      environment: serviceEnv?.[s.name] ? unmaskEnv(serviceEnv[s.name], s.env) : s.env,
      volumes: s.volumes.map(volumeToComposeString).filter((v): v is string => v !== null),
      command: s.command,
      commandArgv: s.commandArgv ?? null, // #332: adopt the real argv, not sh -c
      restart: s.restart,
      // Built additively: an adopted container's live cpu/memory caps must
      // survive even when it has no healthcheck (and vice versa).
      advanced:
        s.healthcheck || s.resources
          ? {
              ...(s.healthcheck && { healthcheck: s.healthcheck }),
              ...(s.resources && { resources: s.resources }),
            }
          : undefined,
    };
  });
  return { rows, renames, handover, claimedHostPorts };
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
  /** DISCOVERED service name → repo compose service name to adopt AS (the
   *  wizard's step-2 map). Names the adopted row after the repo service so a
   *  later reconcile matches it in place instead of duplicating. */
  serviceRenames?: Record<string, string>;
  /** Adopt in flat-docker mode — must match the scan the user selected from, or
   *  openship-labeled containers are treated as managed and none are found. */
  flatDocker?: boolean;
  /** Restrict `serviceNames` resolution to ONE discovered group: the compose
   *  project name, or `null` for the standalone (hand-run container) group.
   *  Omit for the legacy server-wide match.
   *
   *  Service names are only unique WITHIN a compose project, so on a server
   *  running several stacks a bare name like `app`/`db`/`redis` matches a
   *  container in each of them. Unscoped, those extra matches are not dropped —
   *  buildAdoptedServiceRows suffixes them (`app-2`, `redis-3`), silently
   *  adopting another stack's containers into this project. */
  composeProject?: string | null;
  /** Parsed repo compose services (name → spec). When present, adopted rows take
   *  their NATIVE build/image from the mapped repo service (Redeploy rebuilds),
   *  and the returned `handover` lets the first deploy reuse the running image. */
  repoServices?: Map<string, RepoComposeService>;
}): Promise<AdoptResult> {
  const { serverId, organizationId, projectName, serviceNames, sameServer, volumeStrategies, serviceSubpaths, serviceEnv, serviceRenames, flatDocker, repoServices } = opts;

  const stack = await discoverServerStack(serverId, organizationId, undefined, { flatDocker });
  const selected = new Set(serviceNames);
  // Resolve names within ONE group when the caller scoped the adopt — a bare
  // service name is ambiguous across compose projects (see `composeProject`).
  let pool = stack.services;
  if (opts.composeProject !== undefined) {
    const group = stack.groups.find((g) => g.project === opts.composeProject);
    if (!group) {
      const known = stack.groups.map((g) => g.project ?? "(standalone)").join(", ");
      throw new Error(
        `Compose project "${opts.composeProject ?? "(standalone)"}" was not found on the server. Found: ${known}.`,
      );
    }
    pool = group.services;
  }
  // Drop the edge proxy (traefik/nginx/… on 80/443): OpenResty replaces it, so
  // adopting it would just replay the 80/443 conflict. Defense-in-depth — the
  // wizard already marks it non-importable and the orchestrator filters it too.
  const chosen = pool.filter((s) => selected.has(s.name) && !s.proxyKind);
  if (chosen.length === 0) {
    throw new Error("None of the selected services were found on the server.");
  }

  // IDEMPOTENCY GATE: refuse to RE-ADOPT containers this instance already
  // manages as a project. Without it, re-importing the same running stack mints
  // a SECOND project on the SAME containers → duplicate `-2` services, routes
  // bound to the wrong (duplicate) service's port, and phantom domain claims.
  // A first-time adopt has no matching service_deployment rows, so this only
  // ever blocks a genuine re-import (redeploy/edit the existing project instead).
  const chosenContainerIds = chosen
    .map((s) => s.containerId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (chosenContainerIds.length > 0) {
    const managed = await repos.service.findByContainerIds(chosenContainerIds);
    for (const sd of managed) {
      const dep = await repos.deployment.findById(sd.deploymentId).catch(() => null);
      if (!dep || dep.organizationId !== organizationId) continue; // other org / stale row
      const proj = await repos.project.findById(dep.projectId).catch(() => null);
      if (proj && !proj.deletedAt) {
        throw new Error(
          `These containers are already managed here by project "${proj.name}". ` +
            `Redeploy or edit that project instead of re-importing — a re-import would ` +
            `duplicate its services and routes.`,
        );
      }
    }
  }

  // Cross-server DOES move locally-built images now: moving_data streams the
  // running image A→B as data (docker save | docker load), so the target adopts
  // the exact same image — no registry, no rebuild. Registry-image stacks still
  // migrate fine (the target pulls). The only unmovable case is a container with
  // a build config but NO resolvable image (nothing to save) — guarded below and
  // in the orchestrator's `blocked` check.

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

  const { rows: parsed, renames, handover, claimedHostPorts } = buildAdoptedServiceRows(
    chosen,
    selected,
    serviceEnv,
    serviceRenames,
    repoServices,
  );

  // Repo compose services with NO adopted container (e.g. `redis`, or a `build:`
  // app that isn't running) become native rows in the SAME create pass — so every
  // service, adopted or new, is created through ONE path with its env resolved
  // uniformly (wizard override wins, else the repo compose default). The migration
  // deploy then builds/pulls them; the deploy's own compose reconcile only
  // bootstraps their baseline afterwards (keep-ours), so nothing here is clobbered.
  const adoptedNames = new Set(parsed.map((r) => r.name));
  const newRows: ParsedComposeList = [];
  if (repoServices) {
    for (const [name, rs] of repoServices) {
      if (adoptedNames.has(name)) continue;
      // Run the compose host ports through the SAME normalizer + claimed-set as
      // the adopted rows: strip edge-owned 80/443 (OpenResty owns them) and dedupe
      // host ports already taken by a sibling — else a new `web` on "80:80" would
      // collide with the edge and fail the deploy.
      const { ports } = normalizeHostPorts(rs.ports ?? [], claimedHostPorts);
      newRows.push({
        name,
        kind: "compose",
        image: rs.image,
        build: rs.build,
        dockerfile: rs.dockerfile,
        ports,
        // Keep deps only on services this project actually has (adopted or new).
        dependsOn: (rs.dependsOn ?? []).filter((d) => repoServices.has(d) || adoptedNames.has(d)),
        // #336: restore masked sentinels from the repo compose env (real values).
        environment: serviceEnv?.[name]
          ? unmaskEnv(serviceEnv[name], rs.environment ?? {})
          : rs.environment ?? {},
        volumes: rs.volumes ?? [],
        command: rs.command,
        commandArgv: rs.commandArgv ?? null, // #332
        restart: rs.restart,
      });
    }
  }

  const createdServices = await repos.service.syncFromCompose(project_id, [...parsed, ...newRows]);

  // Apply the per-service options keyed by the DISCOVERED name: iterate `chosen`
  // (discovered), resolve the created row by its FINAL (possibly-renamed) name,
  // and look the option up by the discovered key. Doing it row-name-first would
  // miss every renamed row (svc.name is now the repo name, but the option maps
  // are keyed by discovered name).
  const rowByFinalName = new Map(createdServices.map((svc) => [svc.name, svc]));
  for (const s of chosen) {
    const svc = rowByFinalName.get(renames[s.name]);
    if (!svc) continue;
    // Volume ownership: reuse the original bare-named volumes in place
    // (namespaceVolumes=false) — EXCEPT same-server services the user marked
    // "copy", which keep the scoped openship-<slug>-<name> name so the deploy
    // mounts the fresh copy (populated in moving_data) and the original is left
    // untouched. Cross-server always reuses bare names (the A→B stream trick).
    const copy = Boolean(sameServer) && volumeStrategies?.[s.name] === "copy";
    if (svc.namespaceVolumes !== copy) {
      await repos.service.update(svc.id, { namespaceVolumes: copy });
    }
    // Per-service build subpath: point the adopted service at a folder inside the
    // project's linked repo. Pure metadata (rootDirectory only) — does NOT flip
    // the row to build-from-source; the running image is still reused.
    const sub = serviceSubpaths?.[s.name]?.trim();
    if (sub && svc.rootDirectory !== sub) {
      await repos.service.update(svc.id, { rootDirectory: sub });
    }
  }

  const project = await repos.project.findById(project_id);
  return {
    projectId: project_id,
    slug: project?.slug ?? "",
    created,
    adopted: chosen.map((s) => s.name),
    // discovered service name → adopted ROW name (repo name when mapped). The
    // orchestrator uses this to translate the discovered-keyed attach/route
    // inputs onto the renamed rows.
    renames,
    handover,
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
      // deployTarget:"server" is REQUIRED, not implied by serverId: target
      // re-derivation (resolveSnapshotTarget) drops serverId unless the meta
      // says deployTarget==="server", so without it a redeploy re-resolves to
      // the desktop cloud default and misroutes to Oblien. These reattach paths
      // always run against a migration serverId, so the target is always server.
      meta: { deployTarget: "server", serverId, runtimeMode: "docker", adopt: true, serviceDeploymentMode: "services" },
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
 * `openship.*`/compose labels — labels are immutable in place.
 *
 * Status/logs/terminal therefore CANNOT be label-scoped for these containers: the
 * live read matches them by canonical name and stored container id instead
 * (services/live-state.ts). Getting that wrong is what made an attached, running
 * service render "Stopped" — a label-filtered `docker ps` can never see it. A
 * LATER redeploy/teardown of the migrated project still won't recognize them by
 * label; that remains the accepted trade for "control it in place" on the same
 * server. `copy`/cross-server services take the deploy path.
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
  /** DISCOVERED name → adopted ROW name (from adoptServerStack). The service
   *  ROWS are keyed by their final (possibly-renamed) name, so we match the
   *  discovered containers to rows through this map — else a renamed row never
   *  matches its container and the same-server attach silently does nothing. */
  renames?: Record<string, string>;
}): Promise<void> {
  const { deploymentId, projectId, organizationId, serverId, attach, serviceRows, renames } = opts;
  if (attach.length === 0) return;

  const rt = await createServerDockerRuntime(serverId, organizationId);
  try {
    // Key the discovered containers by their ADOPTED ROW name so they join the
    // (possibly-renamed) rows. disc.containerId is used downstream — rename-safe.
    const discByName = new Map(attach.map((c) => [renames?.[c.name] ?? c.name, c]));
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
        // deployTarget:"server" required — see reattachRuntime above; without it a
        // later redeploy of this migrated project re-resolves to the cloud default.
        meta: { deployTarget: "server", serverId, runtimeMode: "docker", adopt: true, adoptLive: true, serviceDeploymentMode: "services" },
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
 * Pre-join the migration's reused (attach-live) containers to the target project's
 * `openship-<slug>` network with a DNS alias = each row's name, BEFORE the native
 * deploy runs. The deploy's ensureServiceGroup is idempotent (reuses this
 * network), so a freshly-built service resolves the reused container by name from
 * its very first start (e.g. `web` → `postgres:5432`). This is what makes the
 * migration fully unified with a native deploy instead of leaving the reused
 * container off the new project's network. Best-effort — never blocks the deploy.
 */
export async function joinReusedContainersToGroup(opts: {
  serverId: string;
  organizationId: string;
  slug: string;
  attach: DiscoveredService[];
  serviceRows: Service[];
  renames?: Record<string, string>;
}): Promise<void> {
  const { serverId, organizationId, slug, attach, serviceRows, renames } = opts;
  if (attach.length === 0 || !slug) return;
  const rt = await createServerDockerRuntime(serverId, organizationId);
  try {
    if (!rt.joinServiceGroupContainers) return; // non-docker runtime → skip
    const discByName = new Map(attach.map((c) => [renames?.[c.name] ?? c.name, c]));
    const members = serviceRows
      .filter((s) => discByName.has(s.name))
      .map((s) => ({ containerId: discByName.get(s.name)?.containerId ?? "", alias: s.name }))
      .filter((m) => m.containerId.length > 0);
    await rt.joinServiceGroupContainers(slug, members);
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

  // Re-import preserves the original service names (from the manifest/labels),
  // so no rename map — buildAdoptedServiceRows returns identity renames here.
  const { rows: parsed } = buildAdoptedServiceRows(chosen, selected);
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
