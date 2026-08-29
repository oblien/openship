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
import { slugify, safeErrorMessage, mergeAdvanced } from "@repo/core";
import { buildNetworkAliases, type ContainerInfo, type ContainerStatus } from "@repo/adapters";
import { serviceAliasExtras } from "../../lib/deployable-service";
import { COMPOSE_SENTINEL } from "../../lib/container-ref";
import { isControlPlaneProject } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { ensureProject, createServicesProjectWithId } from "../projects/project-crud.service";
import { getFileContent } from "../github/github.service";
import {
  blockingComposeFields,
  describeBlockingComposeFields,
  parseComposeFile,
  type ComposeService,
} from "../../lib/compose-parser";
import { unmaskEnv } from "../../lib/secret-env";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { sshManager } from "../../lib/ssh-manager";
import { readProjectSnapshot } from "../../lib/openship-manifest";
import { discoverServerStack } from "./docker-inspect.service";
import { excludeAlreadyManaged } from "./managed-containers";
import { perService, selectDiscoveredServices, serviceUid } from "./select-services";
import {
  EDGE_PORTS,
  parseComposePort,
  isExternalHostPublish,
  type DiscoveredService,
  type DiscoveredVolumeMount,
  type OpenshipProjectGroup,
} from "./docker-reconcile";

type EnsureBody = Parameters<typeof ensureProject>[0];
type ParsedComposeList = Parameters<typeof repos.service.syncFromCompose>[1];

/** Openship deployment id shape — validated before trusting a server label as a PK. */
const DEPLOYMENT_ID_RE = /^dep_[A-Za-z0-9]+$/;

/** Compose file names to probe in a linked repo (mirrors prepare.service COMPOSE_FILES). */
const REPO_COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

/** Compose-service shape returned to the migrate wizard's mapping step. Carries
 *  enough to render a full native service card (env + deps), so a repo service
 *  with no running container (e.g. `redis`) is a first-class, editable unit. */
/** Parser service minus scan-only provenance. Deriving this shape prevents a
 * new compose-owned field from being stranded in another handwritten map. */
export type RepoComposeService = Omit<ComposeService, "environmentTemplates" | "environmentMeta">;

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
      const parsed = parseComposeFile(content);
      // A BLOCKING key refuses the file — the SAME gate the native repo import applies
      // (prepare.service.ts). Without it the migration wizard accepted a compose the
      // native path refuses: a service the author pinned to a VPN sidecar's namespace was
      // mapped into a row and deployed with its OWN interface, egressing in the clear and
      // looking healthy throughout — the #533 failure mode, verbatim.
      const blocking = blockingComposeFields(parsed.unsupported);
      if (blocking.length > 0) {
        throw new Error(
          "The repo's Docker Compose file declares options Openship can't deploy faithfully:\n" +
            describeBlockingComposeFields(blocking),
        );
      }
      return parsed.services.map(
        ({ environmentTemplates: _templates, environmentMeta: _meta, ...service }) => service,
      );
    } catch (err) {
      // RETHROWN, not swallowed. Returning [] showed the wizard's mapping step an empty
      // repo-service list with no reason why — issue #339's symptom, which the native path
      // fixed the same way. A blocking key (above) surfaces through here too: the file is
      // valid, it just asks for something that cannot be deployed faithfully, and unlike a
      // missing env value there is nothing the wizard could collect to resolve it.
      throw new Error(`Could not use the repo's Docker Compose file: ${safeErrorMessage(err)}`, {
        cause: err,
      });
    }
  }
  return [];
}

/**
 * A live container state → the canonical per-service deploy status.
 *
 * Adoption used to write `status === "running" ? "success" : "failure"`, which collapsed
 * three different things into a failure: a container the operator had deliberately
 * STOPPED, one that is MISSING, and a real failure. They are kept apart downstream —
 * `stopped` is the only record of intent, and health-watch reads `status !== "stopped"`
 * as "expect this to be running", so a migrated stack containing one exited container
 * raised an immediate incident and a notification for a service nobody expected up.
 */
export function containerStatusToServiceStatus(status: ContainerStatus): string {
  if (status === "running") return "success";
  if (status === "stopped" || status === "missing" || status === "cancelled") return status;
  return "failure";
}

/**
 * Overall deployment status from the live per-container states.
 *
 * DELIBERATELY NOT `rollupDeploymentStatus`, and not a drifted copy of it — the two answer
 * different questions:
 *   • the native rollup asks "did the DEPLOY succeed?", so a deliberately-stopped service
 *     is not a failure and an empty set is vacuously `ready`;
 *   • this asks "is this re-attached stack actually UP?", which is the one piece of
 *     fabricated state in a re-import, so a stopped or missing container must NOT read as
 *     ready and zero containers must not either.
 * Hence `stopped` counts against readiness here and `[]` is `failed`. Pinned by
 * reattach-status.test.ts; delegating to the native rollup silently turned a half-down
 * re-attached stack green.
 */
export function deriveDeploymentStatus(
  states: ContainerStatus[],
): "ready" | "partial_failure" | "failed" {
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
  /** Service IDENTITY (`serviceUid`) → the adopted ROW name (the repo compose name
   *  when the wizard mapped it, else the discovered name). Keyed by identity, not
   *  name, so two same-named picks can't overwrite each other — read it with
   *  `perService(renames, svc)`, never `renames[name]`. */
  renames: Record<string, string>;
  /** DISCOVERED NAME → the adopted ROW name, for callers that hold only a name and
   *  therefore cannot resolve through the identity-keyed map above. */
  rowNameByDiscovered: Record<string, string>;
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

/** Normalize an adopted service's ports for the shared Openship service group.
 *
 *  Adoption deliberately leaves every service UNEXPOSED and drops the HOST side of
 *  ALL published ports, keeping only the container port. Three reasons, one rule:
 *
 *   - 80/443 belong to Openship's OpenResty edge — a service can't bind them, the
 *     edge routes to the container port instead.
 *   - A pinned host port (e.g. "5432:5432") collides with whatever already holds
 *     it on the box: another adopted service, a second project's Postgres, or
 *     Openship's OWN Postgres. That collision is the exact `port is already
 *     allocated` failure #388 reports — and it aborts the whole deploy, not just
 *     the one service. Stripping the host binding removes the entire class.
 *   - Exposure is added LATER from the project's Domains tab, which runs the one
 *     unified OpenResty-ensure + 80/443 takeover-consent flow (the wizard can't
 *     surface that modal mid-import). Host-publishing here would both skip that
 *     flow and re-introduce the collision.
 *
 *  A stripped service stays reachable by name on the group network
 *  (`postgres-2:5432`) — compose service-to-service resolves the container with no
 *  `ports:` entry — and the DISCOVERED ports are untouched, so the wizard still
 *  shows the port for the operator to route to. Returns the rewritten ports + the
 *  concrete host publishes that were dropped, each flagged `external` when it was
 *  reachable off-box (so the warning can name the genuine exposure loss, not just
 *  a port number; bare/random and edge publishes carry no host port to report). */
function normalizeHostPorts(ports: string[]): {
  ports: string[];
  stripped: { host: number; external: boolean }[];
} {
  const stripped: { host: number; external: boolean }[] = [];
  const out: string[] = [];
  for (const spec of ports) {
    const { host, hostIp, container, proto } = parseComposePort(spec);
    const containerOnly = proto ? `${container}/${proto}` : container;
    if (host == null) {
      // A bare "<port>" is NOT "nothing published": compose publishes it on a
      // RANDOM host port (docker `HostPort: ""`). Drop it for the same reason as a
      // pinned one — adopted services are left unexposed and reached by name.
      continue;
    }
    // Edge ports carry no host port worth reporting; every other concrete host
    // publish is stripped and noted so the operator knows to re-route it — and
    // whether it was externally reachable, which is what the strip actually costs.
    if (!EDGE_PORTS.has(host)) stripped.push({ host, external: isExternalHostPublish(hostIp) });
    out.push(containerOnly);
  }
  return { ports: out, stripped };
}

/**
 * Map selected discovered services → compose service rows for `syncFromCompose`.
 * Shared by adopt AND re-import so the two paths can't drift: unique names,
 * host-port stripping (see normalizeHostPorts), adopt-the-running-image (never
 * rebuild), and — critically — services are left UNEXPOSED. Exposing here would
 * fire the routing/OpenResty ensure mid-import (which needs the 80/443
 * takeover-consent modal the wizard can't surface); instead the user adds routes
 * from the project's Domains tab, and THAT redeploy runs the one unified
 * ensure-OpenResty + takeover-consent flow. Pushes a per-service warning when a
 * host publish is stripped.
 */
export function buildAdoptedServiceRows(
  chosen: DiscoveredService[],
  /** Discovered names that count as part of this adopt set — used only to drop
   *  `depends_on` edges pointing at services that are NOT being adopted. Omit to
   *  derive it from `chosen`, which is the only correct value: passing the user's
   *  raw request instead keeps an edge to a service that was never found. */
  selected?: Set<string>,
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
  /**
   * DISCOVERED NAME → adopted ROW name.
   *
   * `renames` above is keyed by service IDENTITY (`serviceUid`) so two same-named picks
   * can't overwrite each other — correct, but it means a caller holding only a NAME
   * cannot look up through it, and a miss silently falls through to the unrenamed key.
   * Callers that hold the DiscoveredService use `perService(renames, svc)`; this is the
   * accessor for the ones that don't.
   */
  rowNameByDiscovered: Record<string, string>;
  handover: Record<string, string>;
} {
  const adoptedNames = selected ?? new Set(chosen.map((s) => s.name));
  const nameCounts = new Map<string, number>();
  const firstUnique = new Map<string, string>(); // discovered name → FINAL row name
  const renames: Record<string, string> = {};
  const uniqueNames = chosen.map((s) => {
    const desired = perService(serviceRenames, s)?.trim() || s.name;
    const n = (nameCounts.get(desired) ?? 0) + 1;
    nameCounts.set(desired, n);
    const unique = n === 1 ? desired : `${desired}-${n}`;
    if (!firstUnique.has(s.name)) firstUnique.set(s.name, unique);
    // Keyed by IDENTITY, not name: this map is exactly where two same-named picks
    // used to overwrite each other, and it decides row resolution, the attach/join
    // container match and the route remap — so one collision here mis-assigned all
    // four. `serviceUid` falls back to the name, so a service with no container (and
    // every existing caller/test that passes none) is unaffected.
    renames[serviceUid(s)] = unique;
    return unique;
  });

  const handover: Record<string, string> = {};
  const rows = chosen.map((s, i) => {
    const { ports, stripped } = normalizeHostPorts(s.ports);
    if (stripped.length > 0) {
      // Call out an off-box publish specifically: that exposure is the real thing
      // the strip drops, and it's the security-meaningful signal (a raw compose
      // publish DNATs past the host firewall). Loopback-only publishes never left
      // the box, so they get the plainer note.
      const external = stripped.filter((p) => p.external).map((p) => p.host);
      const loopback = stripped.filter((p) => !p.external).map((p) => p.host);
      const clauses: string[] = [];
      if (external.length > 0)
        clauses.push(
          `Port(s) ${external.join(", ")} were published externally (reachable off-box) and are not re-published`,
        );
      if (loopback.length > 0)
        clauses.push(`Loopback-only port(s) ${loopback.join(", ")} are not re-published`);
      s.warnings.push(
        `${clauses.join("; ")} — kept ${uniqueNames[i]} on the internal network ` +
          `(reachable as ${uniqueNames[i]}:<port>). Add a route from the project's Domains tab to expose it.`,
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
    const repo =
      repoServices?.get(uniqueNames[i]) ??
      repoServices?.get(perService(serviceRenames, s) ?? s.name);
    const native = repo && (repo.build || repo.image);
    const source = native
      ? {
          image: repo.image,
          build: repo.build,
          dockerfile: repo.dockerfile,
          buildArgs: repo.buildArgs,
        }
      : {
          image: s.image,
          build: s.image ? undefined : s.build,
          dockerfile: s.image ? undefined : s.dockerfile,
          buildArgs: s.image ? undefined : s.buildArgs,
        };
    // Hand the running image to the deploy for the one-time cutover: a native
    // `build:` row would otherwise rebuild on its very first deploy. Only when we
    // actually have a running image to reuse.
    if (native && s.image && repo?.build) handover[uniqueNames[i]] = s.image;
    /**
     * The container's own listen port, recorded WITHOUT publishing it.
     *
     * `ports` is a publish instruction — a bare `"3000"` entry makes the next deploy
     * bind a random loopback port — so a container that only EXPOSEs ports (published
     * nothing) has every spec stripped and lands with `ports: []`. Nothing then records
     * what it listens on, and a port is exactly what routing is keyed on: neither the
     * Domains tab's `findServiceByPort` nor the project-level route resolver could match
     * it, so the operator could not add a route to that service at all (#618).
     *
     * `exposedPort` is the publish-neutral answer: "the container port to expose
     * publicly", read by `resolveServicePort` (so both matchers find it) and gated
     * behind `service.exposed` everywhere it could act — `resolveServicePublicPort`
     * returns undefined for an unexposed service, so this adds no publish, no port
     * probe and no route. Set ONLY when stripping left nothing, so a service whose
     * container port `ports` still records is untouched.
     */
    const exposedPort = (() => {
      if (ports.length > 0) return undefined;
      for (const spec of s.ports) {
        const port = Number(parseComposePort(spec).container);
        if (Number.isFinite(port) && port > 0) return String(port);
      }
      return undefined;
    })();
    return {
      name: uniqueNames[i],
      kind: "compose" as const,
      image: source.image,
      build: source.build,
      dockerfile: source.dockerfile,
      buildArgs: source.buildArgs,
      ports,
      ...(exposedPort ? { exposedPort } : {}),
      // Only keep dependencies on services we're also adopting.
      dependsOn: s.dependsOn.filter((d) => adoptedNames.has(d)).map((d) => firstUnique.get(d) ?? d),
      // Env override (edited in the wizard) keyed by the DISCOVERED name; default
      // = the container's live env. #336: the wizard sees env masked, so restore
      // any echoed mask sentinel from the freshly-discovered live env (server truth).
      environment: (() => {
        const override = perService(serviceEnv, s);
        return override ? unmaskEnv(override, s.env) : s.env;
      })(),
      volumes: s.volumes.map(volumeToComposeString).filter((v): v is string => v !== null),
      command: s.command,
      commandArgv: s.commandArgv ?? null, // #332: adopt the real argv, not sh -c
      restart: s.restart,
      /**
       * The repo's whole `advanced` blob, with LIVE truth layered on top.
       *
       * `mergeAdvanced` — the helper @repo/core exports for exactly this — not a
       * hand-written field list. `ComposeAdvanced` has eleven keys and the list named
       * four, so everything else the repo compose declared was dropped on the floor:
       * `entrypoint` (#575, where `entrypoint: []` + `command` IS the documented way to
       * bypass an image's wrapper), `stopSignal`, `stopGracePeriod`, `alias` (the
       * east-west DNS name `serviceAliasExtras` reads), `readiness`, `files`. The row is
       * what the NEXT deploy recreates the container from, so a migrated service came back
       * up running the wrapper it was configured to bypass and got SIGKILLed at 10s
       * mid-flush. Two services in the same migrated project were even treated
       * differently — the `newRows` branch below already passes `rs.advanced` wholesale.
       *
       * Order is deliberate: healthcheck and resources come from the LIVE container (the
       * whole adopt model), and they must win over whatever the file claims. Everything
       * else can only come from the repo spec, because live inspect doesn't report it.
       */
      advanced: (() => {
        const merged = mergeAdvanced(repo?.advanced, {
          ...(s.healthcheck ? { healthcheck: s.healthcheck } : {}),
          ...(s.resources ? { resources: s.resources } : {}),
        });
        return Object.keys(merged).length > 0 ? merged : undefined;
      })(),
    };
  });
  return { rows, renames, rowNameByDiscovered: Object.fromEntries(firstUnique), handover };
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
  /** Container ids of the selected services — the wizard's `svcUid`. Preferred over
   *  `serviceNames`: a name is unique only within a compose project, so a name match
   *  over the whole server also picked up the control plane's own same-named
   *  containers (#584). See {@link selectDiscoveredServices}. */
  serviceContainerIds?: string[];
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
  const {
    serverId,
    organizationId,
    projectName,
    serviceNames,
    serviceContainerIds,
    sameServer,
    volumeStrategies,
    serviceSubpaths,
    serviceEnv,
    serviceRenames,
    flatDocker,
    repoServices,
  } = opts;

  const stack = await discoverServerStack(serverId, organizationId, undefined, { flatDocker });
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
  // Identity-first (see select-services): matching a selection by bare NAME against
  // a server-wide pool pulled in same-named containers from every other stack on the
  // host — including the control plane's own `postgres` (#584).
  let chosen = selectDiscoveredServices(pool, {
    containerIds: serviceContainerIds,
    names: serviceNames,
  }).filter((s) => !s.proxyKind);
  if (chosen.length === 0) {
    throw new Error("None of the selected services were found on the server.");
  }

  chosen = await excludeAlreadyManaged(chosen, organizationId);

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

  // `ensureProject` REUSES a project whose slug matches the name, and
  // slugify("Openship") is the control-plane self-app's own slug — so naming a
  // migration "Openship" adopted the user's foreign containers INTO Openship's own
  // project, with `created:false` so a rollback would not even remove it. Refuse the
  // name instead. Checked on the result rather than by re-deriving the slug: the
  // matching rules live in ensureProject and must not be duplicated here.
  if (!created && isControlPlaneProject(await repos.project.findById(project_id))) {
    throw new Error(
      `"${projectName}" is reserved — that is Openship's own project on this instance. ` +
        `Pick a different project name.`,
    );
  }

  const {
    rows: parsed,
    renames,
    rowNameByDiscovered,
    handover,
  } = buildAdoptedServiceRows(
    chosen,
    // Derived from `chosen`, which is post-scope and post-control-plane-exclusion.
    undefined,
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
      // Run the compose host ports through the SAME normalizer as the adopted
      // rows: strip every host binding (edge-owned 80/443 AND pinned ports) so a
      // new `web` on "80:80" doesn't collide with the edge and a `db` on "5432:5432"
      // doesn't collide with whatever holds it on the box — reachable by name,
      // routed later from the Domains tab.
      const { ports } = normalizeHostPorts(rs.ports ?? []);
      newRows.push({
        name,
        kind: "compose",
        image: rs.image,
        build: rs.build,
        dockerfile: rs.dockerfile,
        buildArgs: rs.buildArgs,
        ports,
        // Keep deps only on services this project actually has (adopted or new).
        dependsOn: (rs.dependsOn ?? []).filter((d) => repoServices.has(d) || adoptedNames.has(d)),
        // #336: restore masked sentinels from the repo compose env (real values).
        environment: serviceEnv?.[name]
          ? unmaskEnv(serviceEnv[name], rs.environment ?? {})
          : (rs.environment ?? {}),
        volumes: rs.volumes ?? [],
        command: rs.command,
        commandArgv: rs.commandArgv ?? null, // #332
        restart: rs.restart,
        // The other half of the parser passthrough: without this the blob reaches
        // RepoComposeService and stops there, so the migrated row still loses its
        // healthcheck, caps, and shared namespaces.
        advanced: rs.advanced,
      });
    }
  }

  // `removeMissing: false`, like BOTH native deploy-time callers (build.service,
  // build-pipeline). The default is true — "this list is the project's authoritative
  // full compose inventory" — and ours is not: it is the adopted SUBSET plus the repo
  // services. `ensureProject` reuses an existing project matched by slug (adopt relies
  // on that, see the `created === false` control-plane guard below), so the default
  // deleted every OTHER compose service row of that project, cascading its
  // service_deployment history and orphaning its running containers.
  const createdServices = await repos.service.syncFromCompose(project_id, [...parsed, ...newRows], {
    removeMissing: false,
  });

  // Apply the per-service options keyed by the DISCOVERED name: iterate `chosen`
  // (discovered), resolve the created row by its FINAL (possibly-renamed) name,
  // and look the option up by the discovered key. Doing it row-name-first would
  // miss every renamed row (svc.name is now the repo name, but the option maps
  // are keyed by discovered name).
  const rowByFinalName = new Map(createdServices.map((svc) => [svc.name, svc]));
  for (const s of chosen) {
    const svc = rowByFinalName.get(perService(renames, s) ?? s.name);
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
    const sub = perService(serviceSubpaths, s)?.trim();
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
    rowNameByDiscovered,
    handover,
  };
}

/** One live container's contribution to a re-attached runtime graph. */
interface AttachPlacement {
  service: Service;
  containerId?: string;
  image?: string;
  /** Content-addressable digest of the image actually running (`repo@sha256:…`).
   *  The update scanner's ONLY anchor for a moved mutable tag — see below. */
  imageDigest?: string;
  status: ContainerStatus;
  ip?: string;
  hostPort?: number;
  hostPorts?: Record<string, number> | null;
}

/** Convert the runtime's numeric-keyed binding map into the JSON shape stored on
 * `service_deployment`. An inspected container with no publishes is explicit null. */
function durableHostPorts(
  bindings: ContainerInfo["hostPortByContainerPort"],
): Record<string, number> | null {
  const entries = Object.entries(bindings ?? {}).filter(([container, host]) => {
    const parsed = Number(container);
    return (
      Number.isInteger(parsed) &&
      parsed > 0 &&
      parsed <= 65_535 &&
      Number.isInteger(host) &&
      host > 0
    );
  });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * Resolve each (row, discovered container) pair against LIVE docker.
 *
 * Shared by both re-attach paths. They had byte-identical copies of this loop, which is
 * why every fix to it had to be made twice — and why an omission in one (no `imageDigest`)
 * silently applied to both.
 */
async function readAttachPlacements(
  rt: {
    getContainerInfo: (
      id: string,
    ) => Promise<Pick<ContainerInfo, "status" | "ip" | "hostPort" | "hostPortByContainerPort">>;
    resolveImageDigest?: (ref: string) => Promise<string | undefined>;
  },
  entries: Array<{ service: Service; disc?: DiscoveredService }>,
): Promise<AttachPlacement[]> {
  return Promise.all(
    entries.map(async ({ service, disc }) => {
      let status: ContainerStatus = disc?.running ? "running" : "stopped";
      let ip: string | undefined;
      let hostPort: number | undefined;
      let hostPorts: Record<string, number> | null | undefined;
      if (disc?.containerId) {
        const info = await rt.getContainerInfo(disc.containerId).catch(() => null);
        if (info) {
          ({ status, ip, hostPort } = info);
          hostPorts = durableHostPorts(info.hostPortByContainerPort);
        }
      }
      // The digest of the image this container is ACTUALLY running. A deploy records it
      // (deploy.service → `result.imageDigest`); adopt recorded nothing, and since
      // `resolveDeployedDrift` reads it as the only anchor that can tell a moved `:latest`
      // from an unchanged one, an adopted stack reported "up to date" forever. Best-effort:
      // a locally-built image has no RepoDigests, which is a legitimate undefined.
      const imageDigest = disc?.image
        ? await rt.resolveImageDigest?.(disc.image).catch(() => undefined)
        : undefined;
      return {
        service,
        containerId: disc?.containerId,
        image: disc?.image,
        imageDigest,
        status,
        ip,
        hostPort,
        hostPorts,
      };
    }),
  );
}

/**
 * Write a re-attached runtime graph: the deployment row (when this run owns it) plus one
 * `service_deployment` per placement, then point the project at it.
 *
 * ONE writer for both re-attach paths. They were parallel implementations of the same four
 * steps in the same order, and the only differences turned out to be accidental rather
 * than intended — which is the whole hazard: three copies of this upsert meant the same
 * `imageDigest` omission and the same status collapse existed in all three.
 *
 * `createDeployment: false` is the mixed-run case — the native deploy already created and
 * activated the row, and these placements are added TO it.
 */
async function writeAttachedRuntime(opts: {
  deploymentId: string;
  projectId: string;
  organizationId: string;
  serverId: string;
  placements: AttachPlacement[];
  /** The branch to record. Passed explicitly because the two callers legitimately know
   *  different things: a re-import carries the group's tracked branch, a same-server reuse
   *  has no source to read one from. */
  branch: string;
  imageRef: string | null;
  createDeployment: boolean;
  /** Merged onto the shared adopt meta — e.g. `adoptLive` for the reuse path. */
  extraMeta?: Record<string, unknown>;
}): Promise<boolean> {
  const { deploymentId, projectId, organizationId, serverId, placements } = opts;

  if (opts.createDeployment) {
    const dep = await repos.deployment.create({
      id: deploymentId,
      projectId,
      organizationId,
      branch: opts.branch,
      environment: "production",
      status: deriveDeploymentStatus(placements.map((p) => p.status)),
      containerId: COMPOSE_SENTINEL, // no single primary container: this is a service set
      imageRef: opts.imageRef,
      trigger: "manual",
      // deployTarget:"server" is REQUIRED, not implied by serverId: target re-derivation
      // (resolveSnapshotTarget) drops serverId unless the meta says deployTarget==="server",
      // so without it a redeploy re-resolves to the desktop cloud default and misroutes to
      // Oblien. These re-attach paths always run against a migration serverId.
      meta: {
        deployTarget: "server",
        serverId,
        runtimeMode: "docker",
        adopt: true,
        serviceDeploymentMode: "services",
        ...opts.extraMeta,
      },
    });
    if (!dep) return false;
  }

  for (const p of placements) {
    await repos.service.upsertServiceDeployment({
      deploymentId,
      serviceId: p.service.id,
      serviceName: p.service.name,
      containerId: p.containerId ?? null,
      status: containerStatusToServiceStatus(p.status),
      imageRef: p.image ?? null,
      imageDigest: p.imageDigest ?? null,
      hostPort: p.hostPort ?? null,
      hostPorts: p.hostPorts ?? null,
      ip: p.ip ?? null,
    });
  }

  if (opts.createDeployment) await repos.project.setActiveDeployment(projectId, deploymentId);
  return true;
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
    const placements = await readAttachPlacements(
      rt,
      createdServices.map((service) => ({ service, disc: discByName.get(service.name) })),
    );

    const ok = await writeAttachedRuntime({
      deploymentId: depId,
      projectId,
      organizationId,
      serverId,
      placements,
      branch: group.source?.gitBranch ?? "main",
      imageRef: chosen.find((c) => c.image)?.image ?? null,
      createDeployment: true,
    });
    return ok ? depId : null;
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
    // `perService`, not a bare uid lookup: adopt builds this map keyed by identity, but a
    // caller may still hand over a NAME-keyed one, and resolving only by uid silently
    // matched nothing — the renamed row then never joined the network / re-attached.
    const discByName = new Map(attach.map((c) => [perService(renames, c) ?? c.name, c]));
    const attachRows = serviceRows.filter((s) => discByName.has(s.name));
    const placements = await readAttachPlacements(
      rt,
      attachRows.map((service) => ({ service, disc: discByName.get(service.name) })),
    );

    // Create the deployment row only for a pure-reuse run (the deploy path already
    // created + activated it in a mixed run).
    const existing = await repos.deployment.findById(deploymentId);
    await writeAttachedRuntime({
      deploymentId,
      projectId,
      organizationId,
      serverId,
      placements,
      // A same-server reuse has no source group to read a tracked branch from, unlike
      // re-import. Left explicit rather than defaulted so the difference is visible.
      branch: "main",
      imageRef: attach.find((c) => c.image)?.image ?? null,
      createDeployment: !existing,
      extraMeta: { adoptLive: true },
    });
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
    // `perService`, not a bare uid lookup: adopt builds this map keyed by identity, but a
    // caller may still hand over a NAME-keyed one, and resolving only by uid silently
    // matched nothing — the renamed row then never joined the network / re-attached.
    const discByName = new Map(attach.map((c) => [perService(renames, c) ?? c.name, c]));
    const members = serviceRows
      .filter((s) => discByName.has(s.name))
      .map((s) => ({
        containerId: discByName.get(s.name)?.containerId ?? "",
        // The SAME alias set a natively-deployed container gets (row name +
        // `advanced.alias`), so east-west by a custom alias resolves for a reused
        // container too instead of only for deployed ones.
        aliases: buildNetworkAliases(s.name, serviceAliasExtras(s)),
      }))
      .filter((m) => m.containerId.length > 0);
    await rt.joinServiceGroupContainers(slug, members);
  } finally {
    await rt.dispose().catch(() => {});
  }
}

/**
 * Refresh a RESTORED deployment's runtime rows against live docker: the snapshot
 * carried each container's ip/host-port bindings as of the last deploy, but IPs change on
 * restart. Re-read `getContainerInfo` per service_deployment container, update
 * ip/host-port map/status, and recompute the deployment badge from the live states.
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
      // A NARROW write, not the full-row upsert. `upsertServiceDeployment` assigns EVERY
      // column, so this partial payload NULLED `image_digest` (and `reason`) on every row
      // of a project that had just been restored FAITHFULLY from the server's snapshot —
      // and `resolveDeployedDrift` reads `imageDigest` as its only anchor, so the
      // restored project could never report an available image update again. The compose
      // deploy hit the same trap and fixed it this way.
      await repos.service.updateServiceDeployment(sd.id, {
        status: containerStatusToServiceStatus(status),
        // A live inspect that ANSWERED replaces the snapshot outright, including
        // "publishes nothing" → null. Keeping the restored port here is what made
        // the row claim a 127.0.0.1 publish the container doesn't have (#506).
        // `info === null` = couldn't ask → keep the last-known values.
        hostPort: info ? (info.hostPort ?? null) : (sd.hostPort ?? null),
        hostPorts: info ? durableHostPorts(info.hostPortByContainerPort) : (sd.hostPorts ?? null),
        ip: info ? (info.ip ?? null) : (sd.ip ?? null),
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
