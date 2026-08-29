/**
 * The migration's SECOND door: move a project Openship already owns onto another
 * server, instead of adopting a stranger's containers into a new one.
 *
 * The first door starts from a scan. It discovers containers, asks the operator which
 * ones to take, and `adoptServerStack` mints (or reuses) a project around them. The last
 * thing it does before moving anything is `excludeAlreadyManaged`, which REFUSES any
 * container this instance already manages — because adopting one would "mint a duplicate
 * project over live containers".
 *
 * Our containers are managed by definition. Feeding a project through that door therefore
 * excludes every service and fails with "None of the selected services were found." That
 * gate is not a bug to route around: it is the correct answer to a question we are not
 * asking. So this module answers a different one — "which live containers ARE this
 * project's, on the server it currently runs on?" — and hands back the exact shape the
 * rest of the pipeline already consumes, so `moveData`, the target deploy, verification,
 * the cutover gate, rollback and resume are shared code, not copied code.
 *
 * WHY THE WORKLOAD IS READ FROM THE HOST, NOT FROM `service.containerId`: that column
 * rotates on every redeploy, and for a compose service it can hold a sentinel rather than
 * an id (`!containerId` reads as "compose"). The `openship.project=<id>` label is stamped
 * at container create time and is authoritative for the host it was read from — which is
 * the same reason project teardown reclaims orphans by label rather than by row.
 *
 * The refusals below all fire BEFORE anything is stopped or copied. A migration that
 * discovers it cannot proceed after quiescing the source is a migration that took an
 * outage for nothing.
 */

import { deriveProjectDeployTarget } from "@repo/core";
import { repos } from "@repo/db";

import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { isControlPlaneProject } from "../../lib/controller-helpers";
import { discoverServerStack } from "./docker-inspect.service";
import type { AdoptResult } from "./migrate.service";
import type { DiscoveredService } from "./docker-reconcile";

/** Why a project cannot be moved. The `code` is for callers; the message is shown. */
export class ProjectMoveRefused extends Error {
  constructor(
    readonly code:
      | "not_server_hosted"
      | "same_server"
      | "control_plane"
      | "nothing_running"
      | "builds_from_source"
      | "scoped_move"
      | "unknown_service",
    message: string,
  ) {
    super(message);
    this.name = "ProjectMoveRefused";
  }
}

/**
 * The project fields this decision needs — a subset, so tests need no full row.
 *
 * `cloudWorkspaceId` + `serverId` rather than a target string: the project table
 * deliberately has NO `deployTarget` column, because the effective target is derived from
 * exactly these two by `deriveProjectDeployTarget`, and that rule is meant to have one
 * implementation. Taking the raw fields keeps this module a caller of that rule instead of
 * a second copy of it.
 */
export interface MovableProject {
  id: string;
  name: string;
  slug: string;
  cloudWorkspaceId?: string | null;
  serverId?: string | null;
}

/**
 * MOVE or DUPLICATE — the operator's two intents, and the only thing that separates them.
 *
 *   move — the project itself relocates. One project, new host. Its rows, domains and
 *          history follow it, and the source containers are retired at cutover.
 *   copy — the project stays exactly where it is and a SECOND project appears on the
 *          target, holding a copy of the data. Two independent projects afterwards.
 *
 * They share every mechanical step (quiesce, stream the volumes, deploy, verify) and
 * differ only in what exists at the end — which is why they are one pipeline with a flag,
 * not two features.
 */
export type ProjectMoveIntent = "move" | "copy";

export interface ProjectMoveWorkload {
  /** The server the project runs on today — the migration's source. */
  sourceServerId: string;
  /** The project's live services, in the discovered shape the pipeline speaks. */
  chosen: DiscoveredService[];
  /** For a MOVE: stands in for `adoptServerStack`'s result — nothing was adopted, the
   *  project already exists, so this describes it rather than reporting a creation.
   *  For a COPY the caller discards this and adopts a new project instead. */
  adopt: AdoptResult;
}

/**
 * Decide the workload for a project move, or refuse.
 *
 * Pure: every input is already-fetched data, so the whole refusal matrix is testable
 * without a database or a Docker daemon. The IO lives in the caller
 * ({@link loadProjectMoveWorkload}).
 *
 * `discovered` is a FLAT-DOCKER scan of the source server. Flat mode is what makes this
 * work at all: it "ignores the openship.* namespace", so the project's own managed
 * containers appear as ordinary candidates with full inspection detail (image, imageId,
 * volumes, ports, env) instead of being split off into the re-import set. `ourContainerIds`
 * is then the label-scoped filter that says which of those candidates are ours.
 */
/**
 * The refusals that need NO host round trip — decidable from the project row alone.
 *
 * Split out because of where the operator waits. Resolving the real workload means an SSH
 * scan of the source, which takes seconds and can fail (an unreachable host, a rejected
 * key). Doing that inside the request that starts a run means the operator stares at a
 * frozen button and then gets a toast; doing it inside the RUN means they watch it happen
 * in the session, with the reason in the run's own log, and can retry or resume from the
 * runs list.
 *
 * So: everything answerable for free is answered here, before a run exists (a bad request
 * stays a fast 400 and never takes the server-wide migration lock). Everything that needs
 * the host is left to {@link planProjectMove}, running in the pipeline's `adopting` phase.
 */
export function assertProjectMovable(input: {
  project: MovableProject;
  targetServerId: string;
  isControlPlane?: boolean;
  intent?: ProjectMoveIntent;
  serviceNames?: string[];
  /** Display name of the server the project currently runs on, so a refusal can name it. */
  sourceServerName?: string | null;
}): { sourceServerId: string } {
  const { project, targetServerId } = input;

  if (input.isControlPlane) {
    // Openship cannot migrate itself with itself: the run would stop the API executing
    // it. Moving a control plane is `openship` CLI work on the box, not a wizard.
    throw new ProjectMoveRefused(
      "control_plane",
      "This is the Openship control plane — it can't migrate itself. Move it with the Openship CLI on the server instead.",
    );
  }

  // Cloud (either direction) and server-host "local" are deliberately later work: the
  // transfer core moves data between two SSH-reachable Docker hosts, which is not what
  // either of those is.
  const target = deriveProjectDeployTarget(project);
  if (target !== "server" || !project.serverId) {
    throw new ProjectMoveRefused(
      "not_server_hosted",
      target === "cloud"
        ? `"${project.name}" runs on Openship Cloud. Moving between Cloud and a server isn't supported yet.`
        : `"${project.name}" isn't bound to a server, so there's no source host to move it from.`,
    );
  }

  if (project.serverId === targetServerId) {
    // NAMES the server. "already runs on that server" is true and unhelpful: after a migration
    // that rolled back, the operator's mental model of where the project lives is exactly what
    // is wrong, so the refusal has to state where it actually is rather than confirm a guess.
    throw new ProjectMoveRefused(
      "same_server",
      input.sourceServerName
        ? `"${project.name}" already runs on ${input.sourceServerName}. Pick a different destination.`
        : `"${project.name}" already runs on that server.`,
    );
  }

  if ((input.serviceNames ?? []).filter(Boolean).length > 0 && input.intent !== "copy") {
    throw new ProjectMoveRefused(
      "scoped_move",
      `A project is bound to one server, so its services can't be split across two. Duplicate the service instead, or move "${project.name}" whole.`,
    );
  }

  return { sourceServerId: project.serverId };
}

export function planProjectMove(input: {
  project: MovableProject;
  targetServerId: string;
  /** A flat-docker scan of the source server. */
  discovered: DiscoveredService[];
  /** Container ids carrying `openship.project=<project.id>` on the source host. */
  ourContainerIds: string[];
  /** True when this project IS the Openship control plane. */
  isControlPlane?: boolean;
  /** What the operator is doing. Only a COPY may be scoped — see `serviceNames`. */
  intent?: ProjectMoveIntent;
  /**
   * Narrow the workload to these service names — a SERVICE-level duplicate ("copy just
   * the database onto the new box") rather than the whole project.
   *
   * Copy only, and that asymmetry is the data model, not a missing feature: a project is
   * bound to ONE server (`project.serverId`, the durable binding every deploy and live
   * read resolves through). Moving a subset would leave one project with containers on two
   * hosts and no way to say where it lives — so a scoped move is refused, and the operator
   * is pointed at the copy they almost certainly meant.
   *
   * Absent/empty = every service.
   */
  serviceNames?: string[];
}): ProjectMoveWorkload {
  const { project, discovered, ourContainerIds } = input;
  const scope = (input.serviceNames ?? []).filter(Boolean);

  // The free checks, delegated rather than repeated: the run re-asserts them because it may
  // start seconds after the request that passed them, and a project can be retargeted or
  // deleted in between.
  const { sourceServerId } = assertProjectMovable(input);

  // Identity, never name: a project's service name ("postgres", "web") is unique only
  // within the project, and this pool is the WHOLE host in flat mode — every other stack
  // on the box included. Matching by name here is how a migration adopts a neighbour's
  // database. Same rule, same reason, as `selectDiscoveredServices`.
  const ours = new Set(ourContainerIds.filter(Boolean));
  let chosen = discovered.filter((s) => s.containerId && ours.has(s.containerId));

  // Narrowing happens AFTER the ownership filter, never instead of it: a name is only
  // unique within the project, so scoping the whole-host pool by name first would select a
  // neighbouring stack's same-named container. The label set is what makes the name safe.
  if (scope.length > 0) {
    const want = new Set(scope);
    const scoped = chosen.filter((s) => want.has(s.name));
    const missing = scope.filter((n) => !chosen.some((s) => s.name === n));
    if (missing.length > 0) {
      // Named a service that isn't running (or isn't this project's). Say which, rather
      // than silently copying the subset that did match — that would hand back a
      // "successful" duplicate quietly missing a service.
      throw new ProjectMoveRefused(
        "unknown_service",
        `No running container for: ${missing.join(", ")}. Start the service, or leave it out of the copy.`,
      );
    }
    chosen = scoped;
  }

  if (chosen.length === 0) {
    // Either nothing is running, or the label is absent because these containers predate
    // it. Both mean the same thing for us: there is no live workload to stream. A
    // redeploy on the target reaches the same end state without a data move, so say that
    // rather than starting a run that would move zero bytes and then "succeed".
    throw new ProjectMoveRefused(
      "nothing_running",
      `No running containers were found for "${project.name}" on its current server. Start it, or deploy it to the new server directly — there's no data to move from a stopped project.`,
    );
  }

  // Door A blocks these too. A service built from source with no image is not something
  // the target can start: there is nothing to save-and-load and nothing to pull.
  const unbuildable = chosen.filter((s) => Boolean(s.build) && !s.image);
  if (unbuildable.length > 0) {
    throw new ProjectMoveRefused(
      "builds_from_source",
      `Can't move services with no published image: ${unbuildable.map((s) => s.name).join(", ")}. Deploy the project once so an image exists, then move it.`,
    );
  }

  return {
    sourceServerId,
    chosen,
    adopt: {
      projectId: project.id,
      slug: project.slug,
      // NEVER true. The orchestrator's rollback tears down the project it created; a
      // truthy value here would delete the operator's real project on any failure.
      created: false,
      adopted: chosen.map((s) => s.name),
      // Identity. The rows already carry their final names — there is no repo mapping
      // step and nothing to de-duplicate, because we are not adding rows to a project.
      renames: {},
      rowNameByDiscovered: {},
      // Reuse the image that is running right now, for every moved service. Door A only
      // needs this for native `build:` rows, because its other rows carry a registry
      // image the target can pull. Ours are OUR builds: the tag exists on the source
      // host and in no registry, so without a handover the target deploy would try to
      // pull it and fail. `moveDataDirect` filters this set by `imageExistsLocally` and
      // logs anything the target must pull instead, so listing a registry image here is
      // harmless.
      handover: Object.fromEntries(
        chosen.filter((s) => s.image).map((s) => [s.name, s.image as string]),
      ),
    },
  };
}

/**
 * {@link planProjectMove}'s IO shell: fetch the project, scan its source server, ask that
 * host which containers are ours, then decide.
 *
 * The scan is FLAT-DOCKER on purpose — see `planProjectMove`. `onProgress` is threaded so
 * the run's log carries the scan's own steps ("Inspecting 6 container(s)…"), which is the
 * only visible activity during what can be a slow first SSH.
 */
export async function loadProjectMoveWorkload(
  input: {
    organizationId: string;
    projectId: string;
    targetServerId: string;
    intent?: ProjectMoveIntent;
    /** Service-level scope — copy only. See {@link planProjectMove}. */
    serviceNames?: string[];
  },
  onProgress?: (message: string) => void,
): Promise<ProjectMoveWorkload> {
  const project = await repos.project.findByIdInOrganization(input.projectId, input.organizationId);
  if (!project) {
    throw new ProjectMoveRefused("not_server_hosted", "That project no longer exists.");
  }

  // Checked before the scan: the refusals that need no host round trip should not cost one.
  // `planProjectMove` re-checks them (it is the single decision), this just fails faster.
  if (
    deriveProjectDeployTarget(project) !== "server" ||
    !project.serverId ||
    isControlPlaneProject(project)
  ) {
    return planProjectMove({
      project,
      targetServerId: input.targetServerId,
      discovered: [],
      ourContainerIds: [],
      isControlPlane: isControlPlaneProject(project),
      intent: input.intent,
      serviceNames: input.serviceNames,
    });
  }

  // OUR CONTAINERS FIRST, then a scan scoped to them — this order is the point.
  //
  // Reversed (scan the whole box, then filter by label) the operator waits through
  // "Inspecting 20 container(s)…" so we can keep 5, and pays for compose-file reads and
  // per-image env lookups across every unrelated stack on the host. The label query is one
  // cheap call and it is the answer; the scan's job is only to turn those ids into the
  // `DiscoveredService` shape the pipeline speaks.
  const rt = await createServerDockerRuntime(project.serverId, input.organizationId);
  let ourContainerIds: string[];
  try {
    ourContainerIds = await rt.listProjectContainerIds(project.id);
  } finally {
    await rt.dispose().catch(() => {});
  }

  // Nothing of ours is running → don't scan at all. `planProjectMove` refuses on an empty
  // workload anyway, and a full scan on the way to a guaranteed refusal is the one case where
  // the operator waits longest for the least: the answer was already known one call ago.
  if (ourContainerIds.length === 0) {
    return planProjectMove({
      project,
      targetServerId: input.targetServerId,
      discovered: [],
      ourContainerIds: [],
      isControlPlane: false,
      intent: input.intent,
      serviceNames: input.serviceNames,
    });
  }

  const stack = await discoverServerStack(project.serverId, input.organizationId, onProgress, {
    // Without this the scan splits our own containers into the re-import set and the
    // candidate pool comes back empty — see the module header.
    flatDocker: true,
    // The pre-set selection. A PERFORMANCE scope, not the ownership check: `planProjectMove`
    // still filters by `ourContainerIds` below, so if this option ever widened, nothing
    // foreign could reach the workload.
    onlyContainerIds: ourContainerIds,
  });

  return planProjectMove({
    project,
    targetServerId: input.targetServerId,
    discovered: stack.services,
    ourContainerIds,
    isControlPlane: false,
    intent: input.intent,
    serviceNames: input.serviceNames,
  });
}
