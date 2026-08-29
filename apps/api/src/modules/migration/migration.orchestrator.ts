/**
 * MigrationOrchestrator — drives a full Docker migration:
 *
 *   adopt  → create the Openship `services` project from the selected stack
 *   moving_data → quiesce (stop) the originals on the source; for a
 *                 cross-server move, stream each named volume AND app-data bind
 *                 mount A→B directly
 *                 (executor.streamPath → executor.receiveStream; same sourceId
 *                 both sides, so the target volume — bare-named because adopt
 *                 keeps namespaceVolumes=false — is populated with no remap)
 *   deploying → deploy the adopted project on the target server
 *   verifying → wait for the target deployment to reach `ready`
 *   awaiting_cutover → success; wait for the user to confirm the destructive
 *                 teardown of the originals — OR keep, which (cross-server)
 *                 RESTARTS the quiesced originals so the old server runs as a
 *                 live standby. Same-server keep leaves them stopped (the target
 *                 now holds their ports/volumes).
 *   cutover → stop + remove the originals on the source (by scanned container
 *             id — they carry no openship.* labels). Never removes A volumes.
 *   rolled_back → any pre-cutover failure: tear down the target deployment and
 *                 restart the originals on the source. Never destroys A.
 *
 * A dedicated FSM (not the backup/restore orchestrators) because the source has
 * no Openship deployment to resolve an executor from, the target is
 * container-less pre-deploy, and we require no configured backup destination.
 */

import crypto from "node:crypto";
import { repos } from "@repo/db";
import { isServiceFailureStatus, safeErrorMessage, sanitizeProxySettings } from "@repo/core";
// The SHARED bounded-concurrency limiter. This module grew a private copy (`runPool`)
// of the very thing lib/map-with-limit.ts exists to prevent — and it was the copy
// driving the SSH-saturating volume transfer.
import { mapWithLimit } from "../../lib/map-with-limit";
import { probeOneVolume, probeTargetVolumeConflicts } from "./volume-conflict";
import { syncProjectManagedEdge } from "../projects/project-runtime.service";
import {
  resolveExecutor,
  transferVolume,
  transferImage,
  scopedVolumeName,
  readEdgeFile,
  writeEdgeFile,
  edgeProxy,
  edgeProxyFor,
  type EdgeProxyApi,
  type Platform,
  type ServiceHandle,
  type TransferEndpoint,
  type TransferMode,
  type TransferCompression,
} from "@repo/adapters";
import type { RequestContext } from "../../lib/request-context";
import {
  createServerDockerRuntime,
  createServerCommandExecutor,
  withDeploymentPlatform,
} from "../../lib/deployment-runtime";
import { establishDirectLink, PathMissingError, statPath, sq } from "./direct-transfer";
import type { MigrationRouteSpec } from "./migration-input";
import { sizeOfMoveSet, volumeBytes } from "./migration-size";
import { withKeyedMutex } from "../../lib/provision-lock";
import { requestBuildAccess } from "../deployments/build.service";
import { restartServiceContainer, updateService } from "../services/service.service";
import { describeLiveState, resolveLiveServiceState } from "../services/live-state";
import { applyProjectRouting } from "../domains/routing-apply.service";
import {
  resolveProjectRouteState,
  reapplyProjectLiveRoutes,
} from "../domains/project-route.service";
import { linkProjectRepo } from "../projects/project-crud.service";
import type { ProjectCompositeRoute, ProxySettings } from "@repo/core";
import { teardownProject } from "../projects/project-teardown";
import { discoverServerStack } from "./docker-inspect.service";
import {
  adoptServerStack,
  attachLiveRuntime,
  joinReusedContainersToGroup,
  parseRepoCompose,
} from "./migrate.service";
import type { AdoptResult, RepoComposeService } from "./migrate.service";
import type { DiscoveredService } from "./docker-reconcile";
import { loadProjectMoveWorkload, type ProjectMoveIntent } from "./project-move";
import { cloneProjectToServer } from "../projects/project-clone.service";
import { excludeAlreadyManaged } from "./managed-containers";
import { perService, selectDiscoveredServices } from "./select-services";
import { isMovableBind } from "./migration-preflight";
import { migrationRunBus } from "./migration.sse";
import type { HostPortTargetIdentity } from "../../lib/host-port-target";
import {
  convergeTargetHostPortClaimsUnlocked,
  withHostPortTargetLock,
} from "../deployments/pinned-host-ports";

/** Per-service volume ownership for a same-server migration.
 *  "reuse" (default) = seize the original volume in place (zero copy).
 *  "copy" = duplicate data into a new openship-<slug>-<name> volume, leaving the
 *  original untouched. Cross-server ignores this (it always copies A→B, keeps A). */
export type VolumeStrategy = "reuse" | "copy";

/** Aggregate data-move progress: bytes moved so far across ALL tasks, over the
 *  scanned payload size (null when unknown → the client shows bytes, not a %).
 *  `task`/`kind` name the current unit for a detail line. */
export interface ProgressUpdate {
  task: string;
  kind: "image" | "volume";
  movedBytes: number;
  totalBytes: number | null;
}

/**
 * Retire a project's managed routes on its old physical target and release only
 * claims that a strict, post-mutation edge inventory proves are no longer used.
 *
 * The route writes and convergence deliberately share the physical-target lock:
 * otherwise a concurrent deploy could reserve/re-register a port between the
 * removal and the scan. Any route failure suppresses the entire release pass;
 * an uncertain removal must fail closed. The convergence primitive itself uses
 * a forced-fresh strict scan and exact ownership checks.
 */
export async function retireSourceManagedRoutes(input: {
  projectId: string;
  hostnames: Iterable<string>;
  routing: Pick<Platform["routing"], "removeRoute">;
  target: HostPortTargetIdentity;
  edgeProxy: Pick<EdgeProxyApi, "listLoopbackUpstreamPortsStrict">;
  /** False while even one source workload survived destructive cutover. */
  releaseClaims: boolean;
}): Promise<void> {
  await withHostPortTargetLock(input.target, async () => {
    let routesRemoved = true;
    for (const hostname of new Set(input.hostnames)) {
      try {
        // Idempotent (rm -rf semantics), so a hostname the source never served
        // is a no-op rather than an error.
        await input.routing.removeRoute(hostname);
      } catch (err) {
        routesRemoved = false;
        console.warn(
          `[migration] source edge: removeRoute ${hostname} failed; host-port claims retained:`,
          safeErrorMessage(err),
        );
      }
    }

    // A surviving source container can still hold or later reclaim its bind.
    // Likewise, a failed route removal is uncertain even when the other vhosts
    // were removed successfully. In either case, retain every claim.
    if (!input.releaseClaims || !routesRemoved) return;

    try {
      await convergeTargetHostPortClaimsUnlocked({
        target: input.target,
        projectId: input.projectId,
        desiredPublishes: [],
        edgeProxy: input.edgeProxy,
      });
    } catch (err) {
      // Source destruction already completed and the target is serving. Claim
      // cleanup is best-effort; the safe failure mode is durable retention.
      console.warn(
        `[migration] source host-port claim convergence deferred (claims retained):`,
        safeErrorMessage(err),
      );
    }
  });
}

export interface StartMigrationInput {
  organizationId: string;
  sourceServerId: string;
  targetServerId: string;
  serviceNames: string[];
  projectName: string;
  killOriginals: boolean;
  /** serviceName → strategy. Same-server only; absent/"reuse" = current behavior. */
  volumeStrategies?: Record<string, VolumeStrategy>;
  /** Volume-transfer mechanism/compression (settings default or per-run override).
   *  Absent = "auto" (topology-aware) in the transfer core. */
  transferMode?: TransferMode;
  transferCompression?: TransferCompression;
  /** Optional project-level git repo to link to the migrated project (records
   *  source + binds push auto-deploy). The running image is still reused — no
   *  rebuild during migrate. Absent = no repo linked (today's behavior). */
  gitSource?: { provider: "github"; owner: string; repo: string; branch?: string };
  /** serviceName → build subpath inside the linked repo. Metadata only. */
  serviceSubpaths?: Record<string, string>;
  /** DISCOVERED service name → the repo compose service name to adopt the row AS
   *  (the wizard's step-2 mapping). Names the adopted row after the repo service
   *  so a later git-compose reconcile matches it in place instead of creating a
   *  duplicate row with a fresh empty volume. */
  serviceRenames?: Record<string, string>;
  /** serviceName → env override (defaults to the discovered container's env). */
  serviceEnv?: Record<string, Record<string, string>>;
  /** User-selected extra paths to move (cross-server): each a source path on the
   *  source host → a destination path on the target host (file or folder). */
  customPaths?: Array<{ source: string; dest: string }>;
  /** volumeName → how to resolve a target-volume conflict (target already has
   *  data): "override" (overwrite it), "clone" (copy into a fresh scoped volume
   *  the service then mounts), "keep" (use the existing target data as-is). Keyed
   *  by the unique VOLUME name (two services can share a display name). Chosen at
   *  the plan step; a resolved volume no longer hard-fails the move. */
  conflictResolution?: Record<string, "override" | "clone" | "keep">;
  /** serviceName → the domain/route to publish once the target is verified.
   *  Published SERVER-SIDE post-verify (was client-only, so it was lost when the
   *  wizard unmounted or a run was opened from the list). `targetPath` marks a
   *  service that serves a PATH of a shared domain (path fan-out). */
  routesByServiceName?: Record<string, MigrationRouteSpec>;
  /** Container ids of the selected services — globally unique, unlike a compose
   *  service name. Sent by the wizard; absent from older clients, which fall back to
   *  the ambiguous name match. See {@link selectDiscoveredServices}. */
  serviceContainerIds?: string[];
  /** Adopt in flat-docker mode — MUST match the scan the user selected from, or
   *  openship-labeled containers get treated as managed and "none are found". */
  flatDocker?: boolean;
  /** Present ⇒ this is a PROJECT MOVE or DUPLICATE (door B), not a scan-and-adopt: the
   *  subject is a project this instance already owns. The workload comes from that
   *  project's own live containers; `serviceNames` / `serviceContainerIds` are ignored
   *  because the project defines its own set. See {@link ProjectMoveIntent}. */
  projectMove?: {
    projectId: string;
    intent: ProjectMoveIntent;
    /** COPY only: duplicate just these services rather than the whole project. A scoped
     *  MOVE is refused — a project is bound to one server, so its services cannot be split
     *  across two. */
    serviceNames?: string[];
  };
}

/**
 * What a door hands the pipeline: the services to move, split into the sets the run
 * treats differently, plus the project they belong to.
 *
 * Deliberately the shape `run()` already derived inline, so neither door is privileged and
 * a third (Cloud, later) has one contract to satisfy.
 */
interface ResolvedWorkload {
  /** Every selected service. */
  chosen: DiscoveredService[];
  /** Taken over live, in place — never stopped, copied or cut over. Same-server only. */
  attachChosen: DiscoveredService[];
  /** Quiesced, copied, deployed on the target, then retired at cutover. */
  deployChosen: DiscoveredService[];
  /** The project these land in — created by door A, pre-existing for door B. */
  adopt: AdoptResult;
  /** Linked repo's compose services, when one was mapped (door A only). */
  repoServices?: Map<string, RepoComposeService>;
}

/** Re-key a DISCOVERED-name-keyed map onto the adopted ROW names via a
 *  discovered→row rename map. Keys with no rename entry pass through unchanged.
 *  Used so migrate inputs (e.g. routesByServiceName) land on renamed rows.
 *
 *  MUST be given `adopt.rowNameByDiscovered`, NOT `adopt.renames`: the latter is keyed
 *  by service IDENTITY (`serviceUid`), so a name lookup in it misses for every adopted
 *  container and the key passed through UNRENAMED — `publishRoutes` then looked the row
 *  up by the discovered name, found nothing, and dropped a renamed service's route with
 *  no warning. */
function remapKeys<T>(
  map: Record<string, T> | undefined,
  renames: Record<string, string>,
): Record<string, T> | undefined {
  if (!map) return map;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) out[renames[k] ?? k] = v;
  return out;
}

/** One source container the cutover could not remove. */
export interface LeftBehindContainer {
  name: string;
  containerId: string;
  reason: string;
}

/**
 * The line that tells an operator the old server is NOT clean — or `null` when it is.
 *
 * Its own function because both cutover paths (the unattended `killOriginals` one and the
 * operator-confirmed one) have to say the same thing, and because the empty case is the one
 * that matters: it must return null rather than an awkward "0 containers could not be
 * removed", so the caller can log a plain success.
 *
 * Names every container and its reason. "Some containers could not be removed" would leave
 * the operator to find them by hand on a host they were just told to stop thinking about.
 */
export function describeCutoverRemainder(failed: LeftBehindContainer[]): string | null {
  if (failed.length === 0) return null;
  const which = failed
    .map((f) => `${f.name} (${f.containerId.slice(0, 12)}: ${f.reason})`)
    .join("; ");
  return (
    `${failed.length} source container(s) could not be removed — remove them by hand on the ` +
    `old server: ${which}`
  );
}

/** A built image to move: probed/saved by `id` (reliable), re-tagged to `tag`
 *  on the target so the adopted service's deploy imageRef resolves. */
interface BuiltImage {
  id: string;
  tag: string;
}

/** A data path that did NOT transfer — a `partial` run's to-do list. `key` is
 *  the stable id a resume uses to apply an override / skip. */
export interface PendingItem {
  key: string;
  kind: "volume" | "bind" | "path";
  source: string;
  dest?: string;
  serviceName?: string;
  reason: "missing" | "denied" | "error";
  message?: string;
}

/**
 * The service's ORIGINAL container id on the SOURCE, for building a
 * `ServiceHandle` passed to `listSources()` — NOT null unless we genuinely
 * never scanned one. `listSources()` treats a null containerId as "not
 * deployed yet" and falls back to GUESSING the volume name from
 * `service.volumes` + `namespaceVolumes` (the name OpenShip's OWN deploy
 * pipeline would assign) — correct for the backup/restore use case
 * `listSources` was built for, but wrong for an adopted source service (e.g.
 * from Coolify), which was never namespaced by OpenShip: the guess doesn't
 * match any volume that actually exists on the source, and enumeration
 * silently produces a name the source (or target) rejects with "no such
 * volume". Passing the real id makes `listSources` inspect the live
 * container's actual `Mounts` instead, which is always correct.
 */
export function resolveScannedContainerId(
  serviceName: string,
  scannedContainerIds: Record<string, string>,
): string | null {
  return scannedContainerIds[serviceName] ?? null;
}

/** What `runResume` must actually call for one pending item, given any
 *  operator-supplied override. Centralizing the decision (rather than
 *  inlining it at each `link.transferX(...)` call site) is what makes an
 *  override for a "no such volume" volume item actually reach the transfer —
 *  a previous version computed `src` but then called
 *  `transferVolume(item.source, …)`, silently ignoring it. */
export type ResumeTransferPlan =
  | { kind: "volume"; source: string }
  | { kind: "bind"; asPath: true; source: string; dest: string }
  | { kind: "bind"; asPath: false; source: string }
  | { kind: "path"; source: string; dest: string };

export function planResumeTransfer(
  item: PendingItem,
  overrides: Record<string, string>,
): ResumeTransferPlan {
  const source = overrides[item.key] ?? item.source;
  if (item.kind === "volume") return { kind: "volume", source };
  if (item.kind === "bind") {
    // An override reads from a NEW source path but still writes to the
    // ORIGINAL bind path (where the target container mounts it).
    return source !== item.source
      ? { kind: "bind", asPath: true, source, dest: item.source }
      : { kind: "bind", asPath: false, source: item.source };
  }
  return { kind: "path", source, dest: item.dest ?? item.source };
}

/** moveData result: bytes written + the items that didn't make it + the volume
 *  names actually WRITTEN on the target (for optional cleanup after a failed
 *  deploy; excludes "keep"-resolved pre-existing volumes). */
interface MoveResult {
  bytesMoved: number;
  pendingItems: PendingItem[];
  targetVolumes: string[];
}

/** The single action the user picked for EVERY resolved conflict, or undefined
 *  if they mixed choices. A runtime conflict that the preview didn't surface
 *  (probe flake, reused-project row drift) inherits this — so "I chose Override
 *  for everything" applies to a straggler volume too, instead of dead-failing. */
function unanimousConflictAction(
  res: Record<string, "override" | "clone" | "keep">,
): "override" | "clone" | "keep" | undefined {
  const vals = Object.values(res);
  return vals.length > 0 && vals.every((v) => v === vals[0]) ? vals[0] : undefined;
}

const VERIFY_TIMEOUT_MS = 20 * 60 * 1000; // 20 min for the target deploy
const VERIFY_POLL_MS = 5000;
// Every status a deploy can SETTLE on. `action_required` is a settled failure
// (blocked on something the operator must clear), so it belongs here — omitting
// it would leave waitForDeployment polling for the full VERIFY_TIMEOUT_MS.
const TERMINAL_DEPLOY = new Set([
  "ready",
  "partial_failure",
  "failed",
  "action_required",
  "cancelled",
  // A no-op settle, for the poll only. The `status !== "ready"` abort downstream is
  // still right for a migration — a move must actually deploy — and unreachable in
  // practice, since moveData stops the scanned containers so nothing can be carried.
  "no_changes",
]);
/** How many volumes move concurrently — a few in flight without saturating one SSH link. */
const TRANSFER_CONCURRENCY = 3;

class MigrationOrchestratorImpl {
  /** Latest data-move progress per run, surfaced through getMigration so the
   *  wizard's existing poll can draw a bar without a second SSE subscription.
   *  Transient (in-memory) — cleared when the run reaches a terminal state.
   *  `totalBytes` is null when the payload size is unknown (relay path). */
  private readonly progressByRun = new Map<string, ProgressUpdate>();

  /** Per-run cancel state + the direct-transfer `runTag` (the ephemeral-key
   *  marker) so a cancel can pkill exactly this run's rsync/ssh. Entry is
   *  created when the pipeline starts and cleared on a terminal transition.
   *  Single API process (self-hosted), so a cancel POST reliably reaches the
   *  running pipeline through this map. */
  private readonly cancelByRun = new Map<string, { cancelled: boolean; runTag?: string }>();

  /** Durable per-run session log. run()'s log() closure appends here; a throttled
   *  flush mirrors it to the run row's `logs` column so a reloaded or failed run
   *  keeps its history (the in-memory buffer alone dies with the client reload).
   *  Kept until run()'s finally flushes-and-clears — NOT cleared by transition. */
  private readonly logsByRun = new Map<string, string[]>();
  private readonly logFlushAt = new Map<string, number>();

  /** Latest transfer progress for a run, or null. */
  getProgress(id: string): ProgressUpdate | null {
    return this.progressByRun.get(id) ?? null;
  }

  /** The in-memory log tail for a still-running run (fresher than the throttled
   *  DB copy) — getMigration prefers it while the run is live. */
  getLiveLogs(id: string): string | null {
    const buf = this.logsByRun.get(id);
    return buf && buf.length > 0 ? buf.join("\n") : null;
  }

  /** Append one line to a run's session log; console + buffer + throttled flush
   *  + live SSE publish (so the client streams logs in real time, like a deploy). */
  private appendLog(id: string, message: string): void {
    console.log(`[migration] ${id}: ${message}`);
    const line = `[${new Date().toISOString()}] ${message}`;
    const buf = this.logsByRun.get(id) ?? [];
    buf.push(line);
    this.logsByRun.set(id, buf);
    migrationRunBus.publish(id, { type: "log", line });
    const now = Date.now();
    if (now - (this.logFlushAt.get(id) ?? 0) < 2000) return;
    this.logFlushAt.set(id, now);
    void this.flushLogs(id);
  }

  /** Mirror the buffer to the DB, keeping only the last 256 KiB. */
  private async flushLogs(id: string): Promise<void> {
    const buf = this.logsByRun.get(id);
    if (!buf || buf.length === 0) return;
    const MAX = 256 * 1024;
    let text = buf.join("\n");
    if (text.length > MAX) text = text.slice(text.length - MAX);
    await repos.dockerMigrationRun.updateLogs(id, text).catch(() => {});
  }

  /** Throw if the run was cancelled — checked at phase boundaries so a cancel
   *  rides the existing `catch → rollback` (no new terminal status). */
  private throwIfCancelled(id: string | undefined): void {
    if (id && this.cancelByRun.get(id)?.cancelled) {
      throw new Error("Cancelled by user");
    }
  }

  /** Create the run row and kick the async pipeline. Returns immediately.
   *  Serialized + in-flight-guarded so two concurrent starts (double-click,
   *  client retry, two operators) can't race the SAME server — which would stop
   *  the same source containers, clobber the same volumes, and could both cut
   *  over, destroying the source. */
  async begin(
    ctx: RequestContext,
    input: StartMigrationInput,
  ): Promise<{ migrationId: string; confirmationToken: string }> {
    // Global begin lock: migrations are rare, so serializing the (check → create)
    // makes the guard atomic in-process. (A multi-process API would additionally
    // need a DB constraint; self-hosted runs one API process.)
    return withKeyedMutex("docker-migration:begin", async () => {
      const active = [
        ...(await repos.dockerMigrationRun.findActiveForServer(input.sourceServerId)),
        ...(await repos.dockerMigrationRun.findActiveForServer(input.targetServerId)),
      ];
      if (active.length > 0) {
        throw new Error(
          "A migration is already in progress for this server. Wait for it to finish (or resolve its cutover) before starting another.",
        );
      }

      const confirmationToken = crypto.randomBytes(8).toString("hex");
      const mode = input.projectMove
        ? input.projectMove.intent === "copy"
          ? "project_copy"
          : "project_move"
        : input.sourceServerId === input.targetServerId
          ? "same_server"
          : "cross_server";
      const run = await repos.dockerMigrationRun.create({
        id: `dmr_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        sourceServerId: input.sourceServerId,
        targetServerId: input.targetServerId,
        // Bound from the start, not at adopt: this run's whole subject is an existing
        // project, and the runs list / detail panel should say which one even if the
        // pipeline fails in its first second.
        ...(input.projectMove ? { projectId: input.projectMove.projectId } : null),
        projectName: input.projectName,
        serviceNames: input.serviceNames,
        status: "queued",
        mode,
        // A project move NEVER auto-retires the source. The operator's live project is
        // running there; the run parks at `awaiting_cutover` with the source stopped but
        // intact so a bad target can still be rolled back to it. Forced here rather than
        // trusted from the request, so no caller can opt a project into an unattended
        // destructive finish.
        killOriginals: input.projectMove ? false : input.killOriginals,
        confirmationToken,
        // Snapshot the start input so a `partial` run can be resumed and a
        // `failed` run re-opened pre-filled (edit & retry).
        inputSnapshot: input as unknown as Record<string, unknown>,
      });
      if (!run) {
        throw new Error(
          "The project is being deleted, so this migration can no longer be started.",
        );
      }
      setImmediate(() => {
        void this.run(ctx, run.id, input).catch((err) =>
          console.error(`[migration] ${run.id} crashed:`, safeErrorMessage(err)),
        );
      });
      return { migrationId: run.id, confirmationToken };
    });
  }

  private async transition(
    id: string,
    status: Parameters<typeof repos.dockerMigrationRun.transition>[1],
    patch?: Parameters<typeof repos.dockerMigrationRun.transition>[2],
  ): Promise<void> {
    await repos.dockerMigrationRun.transition(id, status, patch);
    migrationRunBus.publish(id, {
      type: "transition",
      status,
      bytesMoved: (patch as { bytesMoved?: number })?.bytesMoved ?? null,
      deploymentId: (patch as { deploymentId?: string })?.deploymentId ?? null,
    });
    if (status === "succeeded" || status === "failed" || status === "rolled_back") {
      this.progressByRun.delete(id);
      this.cancelByRun.delete(id);
      migrationRunBus.publish(id, {
        type: "complete",
        status,
        errorMessage: (patch as { errorMessage?: string })?.errorMessage ?? null,
      });
    }
  }

  /**
   * Door B — move a project this instance already owns.
   *
   * Adopts nothing: the project, its rows, its domains and its slug all exist, so the
   * "adopt" result {@link planProjectMove} returns simply DESCRIBES them. Three of its
   * fields are load-bearing and explained there: `created: false` (or rollback deletes the
   * operator's project), identity `renames`, and a `handover` covering every service (our
   * image tags exist on the source host and in no registry).
   *
   * No attach set. Attach-in-place is a same-server optimisation — it takes over a
   * container that is already on the target host — and a project move is cross-server by
   * definition (`same_server` is refused up front). So every service deploys, which is
   * also what makes the volume transfer the meaningful part of the run.
   */
  private async resolveOwnedProjectWorkload(
    input: StartMigrationInput,
    log: (message: string) => void,
  ): Promise<ResolvedWorkload> {
    const move = input.projectMove;
    if (!move) throw new Error("resolveOwnedProjectWorkload called without projectMove");
    const copying = move.intent === "copy";
    log(
      copying
        ? `duplicating project "${input.projectName}" onto the target server`
        : `moving project "${input.projectName}" to the target server`,
    );
    const workload = await loadProjectMoveWorkload(
      {
        organizationId: input.organizationId,
        projectId: move.projectId,
        targetServerId: input.targetServerId,
        intent: move.intent,
        serviceNames: move.serviceNames,
      },
      log,
    );
    log(
      `${workload.chosen.length} live service(s): ${workload.chosen.map((s) => s.name).join(", ")}`,
    );

    // A DUPLICATE creates a second project — by COPYING this one's records, not by
    // reverse-engineering a new project out of Docker.
    //
    // It used to call `adoptServerStack`, the same call the scan flow makes for a stranger's
    // containers. That worked, and it quietly produced a worse project: an adopt can only see
    // what a container shows, so the copy lost its framework and build settings, its declared
    // volumes, its per-service kind, its route strategy, its resource limits and its compose
    // drift baselines. It also re-scanned the whole source server a second time, having just
    // been handed the exact workload. We own the source rows; copying them is both cheaper and
    // faithful. See `cloneProjectToServer` for the one field that still comes from the runtime
    // (volume names — the transfer does not remap them) and why.
    //
    // `created: true` comes back from it, which is exactly right: on any failure the
    // rollback tears down the project THIS run made and leaves the original alone.
    if (copying) {
      const adopt = await cloneProjectToServer({
        sourceProjectId: move.projectId,
        organizationId: input.organizationId,
        targetServerId: input.targetServerId,
        chosen: workload.chosen,
        name: input.projectName,
      });
      log(`created project "${adopt.project.name}" (${adopt.slug}) as a copy of this one`);
      return {
        chosen: workload.chosen,
        attachChosen: [],
        deployChosen: workload.chosen,
        adopt,
        repoServices: undefined,
      };
    }

    return {
      chosen: workload.chosen,
      attachChosen: [],
      deployChosen: workload.chosen,
      adopt: workload.adopt,
      // No repo compose step: the rows already describe how each service is built, and a
      // move must not silently re-point them at a repo's current compose file.
      repoServices: undefined,
    };
  }

  /**
   * Door A — adopt what a SCAN of the source server found.
   *
   * Unchanged behaviour, moved verbatim out of `run()` so a second door can reach the
   * same pipeline (see {@link resolveOwnedProjectWorkload}). Everything specific to
   * adopting a stranger's containers lives here: the identity-first selection, the
   * reverse-proxy exclusion, the already-managed gate, and `adoptServerStack` itself.
   */
  private async resolveScannedWorkload(
    ctx: RequestContext,
    input: StartMigrationInput,
    log: (message: string) => void,
  ): Promise<ResolvedWorkload> {
    const { organizationId, sourceServerId, serviceNames } = input;
    const sameServer = sourceServerId === input.targetServerId;
    log(
      `${sameServer ? "same-server" : "cross-server"} migration of ${serviceNames.length} service(s): ${serviceNames.join(", ")}`,
    );
    const stack = await discoverServerStack(sourceServerId, organizationId, undefined, {
      flatDocker: input.flatDocker,
    });
    // Identity-first (see select-services): a bare name is only unique within its
    // compose project, so a name match over the whole server also selected the
    // control plane's own same-named containers (#584).
    const selected = selectDiscoveredServices(stack.services, {
      containerIds: input.serviceContainerIds,
      names: serviceNames,
    });
    if (selected.length === 0) {
      throw new Error("None of the selected services were found on the server.");
    }
    // Never adopt the edge proxy (traefik/nginx/… on 80/443) — Openship's
    // OpenResty replaces it. Drop it from the workload set and leave it
    // UNTOUCHED (absent from scannedContainerIds, so moveData won't stop it):
    // we never blind-stop the user's proxy. It's reclaimed later — with
    // consent — when the user adds a domain to a migrated service and the
    // routed deploy's edge-takeover modal offers to take over 80/443.
    let chosen = selected.filter((s) => !s.proxyKind);
    if (chosen.length === 0) {
      throw new Error(
        "Only a reverse proxy was selected. Openship installs its own edge on 80/443 — pick the app services to migrate instead.",
      );
    }
    // The SAME gate adoptServerStack applies, applied HERE too — this set is not
    // adopt's. It decides `scannedContainerIds`, and moveData's first act is
    // `rtA.stop(cid)` on every id in it. A name-only client cannot tell the user's
    // `postgres` from the control plane's, so without this the run would stop
    // Openship's own database to copy its volume (#584). Also fails a genuine
    // re-import before any container is touched, rather than after.
    chosen = await excludeAlreadyManaged(chosen, organizationId);
    const blocked = chosen.filter((s) => Boolean(s.build) && !s.image);
    if (blocked.length > 0) {
      throw new Error(
        `Cannot migrate built-from-source services: ${blocked
          .map((s) => s.name)
          .join(", ")}. Publish an image or link a repo first.`,
      );
    }
    // Per-service volume strategy decides the takeover mode on the SAME server:
    //   reuse → ATTACH the already-running container live, in place (no
    //           redeploy, no volume move, zero downtime).
    //   copy  → DEPLOY a fresh container on a duplicated volume.
    // Cross-server is always a deploy (the volume streams to a fresh target).
    // Resolved per SERVICE, not per name: two selected containers sharing a name
    // (trivial across compose projects) collapsed onto one strategy entry, so a
    // service the operator set to "reuse in place" could be copied instead — or a
    // "copy" service attached live, taking over the original in place (#584 class).
    const isAttach = (svc: (typeof chosen)[number]) =>
      sameServer && (perService(input.volumeStrategies, svc) ?? "reuse") !== "copy";
    const attachChosen = chosen.filter((s) => isAttach(s));
    const deployChosen = chosen.filter((s) => !isAttach(s));

    // Parse the linked repo's compose so adopted rows take their NATIVE
    // build/image spec (mapped by the wizard) instead of a frozen running-image
    // tag — the fix that makes a later Redeploy reclone + rebuild rather than
    // 404 on a stale build tag. Best-effort: a GitHub hiccup falls back to
    // legacy image-only adoption (the migration must never fail on this).
    const repoServices = await (async () => {
      const gs = input.gitSource;
      if (!gs?.owner || !gs?.repo) return undefined;
      const parsed = await parseRepoCompose(ctx, gs.owner, gs.repo, gs.branch).catch(() => []);
      return parsed.length ? new Map(parsed.map((s) => [s.name, s])) : undefined;
    })();

    const adopt = await adoptServerStack({
      serverId: sourceServerId,
      organizationId,
      projectName: input.projectName,
      serviceNames,
      sameServer,
      volumeStrategies: input.volumeStrategies,
      serviceSubpaths: input.serviceSubpaths,
      serviceEnv: input.serviceEnv,
      serviceRenames: input.serviceRenames,
      serviceContainerIds: input.serviceContainerIds,
      flatDocker: input.flatDocker,
      repoServices,
    });
    return { chosen, attachChosen, deployChosen, adopt, repoServices };
  }

  private async run(ctx: RequestContext, id: string, input: StartMigrationInput): Promise<void> {
    const { organizationId, sourceServerId, targetServerId, serviceNames } = input;
    const sameServer = sourceServerId === targetServerId;
    let scannedContainerIds: Record<string, string> = {};
    let deploymentId: string | undefined;
    // Set only when adopt CREATED the project (not when it reused an existing
    // same-name one) — so rollback tears down our own draft, never the user's.
    let createdProjectId: string | undefined;
    // Data paths that didn't transfer — non-empty ⇒ the run parks `partial`.
    let pendingItems: PendingItem[] = [];

    // Register cancel state up front so a cancel POST can flag + target this
    // run. Don't clobber: a cancel may already have flagged it between begin()
    // and this setImmediate'd run() starting (throwIfCancelled at adopt catches it).
    if (!this.cancelByRun.has(id)) this.cancelByRun.set(id, { cancelled: false });

    // Central session logger — mirrors to the durable `logs` column so the run
    // is debuggable after a client reload or a failure.
    const log = (message: string) => this.appendLog(id, message);

    try {
      // ── adopt ──
      this.throwIfCancelled(id);
      await this.transition(id, "adopting");
      // ── Which workload, and under whose project? ──
      //
      // The two DOORS into this pipeline meet here and nowhere else. Door A adopts what a
      // scan of the source found. Door B moves a project this instance ALREADY owns, and
      // adopts nothing — it cannot use door A, because `excludeAlreadyManaged` would
      // correctly refuse every one of its containers (see project-move.ts).
      //
      // Everything after this point is shared by both doors: quiesce, transfer, deploy,
      // verify, cutover, rollback, resume. Only the identification differs.
      const { chosen, attachChosen, deployChosen, adopt, repoServices } = input.projectMove
        ? await this.resolveOwnedProjectWorkload(input, log)
        : await this.resolveScannedWorkload(ctx, input, log);
      const projectId = adopt.projectId;
      if (adopt.created) createdProjectId = projectId;

      // Only the DEPLOY set's originals are quiesced / copied / cut over —
      // attach-live containers are adopted as-is and must never be stopped or
      // killed (that would take down the very containers we're taking control of).
      //
      // Keyed by the FINAL ROW NAME, which `buildAdoptedServiceRows` guarantees is
      // unique. Keying by discovered name did two things wrong: two same-named picks
      // collapsed to one entry, so moveData stopped only one original (inconsistent
      // volume copy) and rollback restarted only one; and `resolveScannedContainerId`
      // looks this up BY ROW NAME, so a renamed or `-2`-suffixed row never resolved
      // its container and fell back to a guessed volume name.
      const rowNameOf = (svc: (typeof chosen)[number]) =>
        perService(adopt.renames, svc) ?? svc.name;
      scannedContainerIds = Object.fromEntries(
        deployChosen
          .filter((s) => s.containerId)
          .map((s) => [rowNameOf(s), s.containerId as string]),
      );
      // Row-keyed too: moveData works in adopted service ROWS, so handing it the
      // request's identity-keyed map would match nothing.
      const rowVolumeStrategies: Record<string, VolumeStrategy> = Object.fromEntries(
        chosen.map((s) => [rowNameOf(s), perService(input.volumeStrategies, s) ?? "reuse"]),
      );
      // A scan/adopt run did not have a project at enqueue time, and a copy has
      // just minted a new target project. Bind the durable run through the same
      // project-row admission lock before any later stop/copy/deploy work. If a
      // concurrent delete claimed the new row first, rollback restores the
      // source and this worker never proceeds under an untracked project.
      const bound = await repos.dockerMigrationRun.bindProject(id, projectId, organizationId, {
        scannedContainerIds,
      });
      if (!bound) {
        throw new Error("The migration project is being deleted; aborting before data movement.");
      }
      await this.transition(id, "adopting", { scannedContainerIds });

      // Link the repo (if the user picked one) BEFORE deploy so source + push
      // auto-deploy are bound from the first release. Best-effort: adopted rows
      // carry an image, so the deploy reuses it regardless — a GitHub hiccup must
      // never block the (destructive) migration.
      if (input.gitSource) {
        const linked = await linkProjectRepo(ctx, projectId, input.gitSource).catch((err) => ({
          ok: false as const,
          code: "invalid" as const,
          message: safeErrorMessage(err),
        }));
        if (!linked.ok) {
          console.warn(`[migration] ${id}: repo link skipped (${linked.code})`);
        }
      }

      // Translate the discovered attach names onto the adopted ROW names (repo
      // names when the wizard mapped them) — the rows are keyed by their final
      // name, so matching by the discovered name would miss every renamed row.
      // `rowNameOf` (above), NOT `adopt.renames[s.name]`: that map is keyed by service
      // IDENTITY (serviceUid = containerId), so for any RUNNING container a bare-name
      // lookup is always undefined and this silently fell back to DISCOVERED names while
      // the rows are keyed by FINAL ones. `attachRows` then came back empty for a renamed
      // or `-2`-suffixed row, so the reuse set was never disabled for the build and
      // `joinReusedContainersToGroup` never ran — the native deploy went on to RECREATE
      // the still-running containers that reuse mode exists to keep.
      const attachNames = new Set(attachChosen.map((s) => rowNameOf(s)));
      const projectRows = await repos.service.listByProject(projectId);
      const attachRows = projectRows.filter((r) => attachNames.has(r.name));
      /**
       * The rows this deploy may touch: everything EXCEPT the reuse set.
       *
       * Handed to `requestBuildAccess` as `serviceIds`, which the compose pipeline turns
       * into "deploy only these, carry live siblings forward untouched, never reap them" —
       * the exact contract the migration needs, and the one the native per-service deploy
       * already uses.
       *
       * It replaces flipping `enabled:false` on every reuse row for the whole build+verify
       * window (up to VERIFY_TIMEOUT_MS). That window was PERSISTED, operator-visible
       * state that nothing recovered: `recoverInterruptedMigrations` restarts source
       * containers and repairs `project.serverId` but never touched `service.enabled`, so
       * an API restart mid-verify left the operator's still-running reused services
       * permanently disabled — and the next full redeploy of that project then destroyed
       * the container of every disabled service.
       */
      const deployRowIds = projectRows
        .filter((r) => !attachNames.has(r.name) && r.enabled)
        .map((r) => r.id);

      // Repo compose services with no adopted container (e.g. a same-server run
      // whose only running container is `postgres`, but the repo compose also
      // declares web/dashboard/api/redis) are already created as native rows —
      // with their env — by adoptServerStack. This just gates whether the native
      // deploy has to run to build/pull them (and publish their domains).
      // Same accessor, same reason: with discovered names here every wizard-mapped
      // service read as NEW (`repoServices` is keyed by repo name), so
      // `hasNewRepoServices` was true and a pure-reuse run that should skip the deploy
      // entirely entered the deploy branch.
      const adoptedRowNames = new Set(chosen.map((s) => rowNameOf(s)));
      const hasNewRepoServices = repoServices
        ? [...repoServices.keys()].some((n) => !adoptedRowNames.has(n))
        : false;

      // Cancel checkpoint on the attach-live path too: a same-server reuse run
      // has an empty deploy set (skips every check below), so without this a
      // cancel during `adopting` would never take effect and the run would
      // proceed to `succeeded`. (Same-server has no killable transfer process.)
      this.throwIfCancelled(id);

      // Unify with a native deploy: join the reused (attach-live) containers to
      // the project network (row name + custom alias) so east-west resolution
      // works exactly as it does for a deployed service. Runs for EVERY attach
      // run, not just ones that also deploy — a pure-reuse project used to end up
      // with no `openship-<slug>` network at all, so a service added later
      // couldn't resolve the reused ones by name. Must precede the build below, so
      // a freshly-built service resolves them from its first start (web →
      // postgres:5432); the deploy's ensureServiceGroup reuses this network.
      // Best-effort — a join failure must never block the migration.
      if (attachRows.length > 0) {
        await joinReusedContainersToGroup({
          serverId: targetServerId,
          organizationId,
          slug: adopt.slug,
          attach: attachChosen,
          serviceRows: attachRows,
          renames: adopt.renames,
        }).catch((err) => log(`network join skipped: ${safeErrorMessage(err)}`));
      }

      // Run the native deploy when there are containers to move (cross-server /
      // copy) OR new repo services to build/pull. Attach-live services are excluded by the
      // deploy's own `strictServiceScope` (below) so they stay zero-downtime; the deploy
      // only builds the new ones. Only a pure same-server reuse with NO new repo
      // services skips the deploy entirely (the `else`).
      if (deployChosen.length > 0 || hasNewRepoServices) {
        // ── moving_data: quiesce the deploy set's originals + copy volumes ──
        this.throwIfCancelled(id);
        await this.transition(id, "moving_data");
        // Cross-server: move EVERY image the source has locally as data
        // (docker save|load) — not just compose `build:` ones. A locally-built
        // image referenced only by tag (e.g. `onvo-new-api:latest`, no build
        // context) isn't in any registry, so the target's pull would fail with
        // "pull access denied … requires docker login". moveDataDirect filters
        // this set by `imageExistsLocally`, so a pure-registry image (not present
        // on the source) is skipped and the target pulls it normally. Saved/probed
        // by IMAGE ID (a create-time tag can fail to resolve → silent drop);
        // re-tagged on the target. Deduped by id — services often share an image.
        const builtImages: BuiltImage[] = sameServer
          ? []
          : [
              ...new Map(
                deployChosen
                  .filter((s) => s.image)
                  .map((s) => {
                    const tag = s.image as string;
                    const id = s.imageId ?? tag;
                    return [id, { id, tag }] as const;
                  }),
              ).values(),
            ];
        // Throttle progress to the SSE bus (a fast stream fires per chunk;
        // ~once/400ms is plenty for a bar). The snapshot is always updated (the
        // poll reads the latest); only the bus publish is throttled.
        let lastEmit = 0;
        const emitProgress = (u: ProgressUpdate) => {
          this.progressByRun.set(id, u);
          const now = Date.now();
          if (now - lastEmit < 400) return;
          lastEmit = now;
          migrationRunBus.publish(id, { type: "progress", ...u });
        };
        // Whose volumes are these? For a DUPLICATE, `projectId` above is the copy the run just
        // created, while the volumes coming across are the SOURCE project's and carry its slug.
        // The "reuse our own debris on the target" rule matches on that slug, so without this a
        // failed duplicate stayed stuck in exactly the loop the rule exists to break.
        const sourceProjectSlug = input.projectMove
          ? ((await repos.project.findById(input.projectMove.projectId).catch(() => null))?.slug ??
            undefined)
          : undefined;
        const move = await this.moveData(
          projectId,
          sourceServerId,
          targetServerId,
          organizationId,
          scannedContainerIds,
          sameServer,
          rowVolumeStrategies,
          builtImages,
          input.customPaths ?? [],
          { mode: input.transferMode, compression: input.transferCompression },
          input.conflictResolution ?? {},
          log,
          emitProgress,
          id,
          sourceProjectSlug,
        );
        pendingItems = move.pendingItems;
        await this.transition(id, "moving_data", {
          bytesMoved: move.bytesMoved,
          targetVolumes: move.targetVolumes,
        });
        log(
          `data move complete: ${move.bytesMoved} bytes` +
            (pendingItems.length ? ` · ${pendingItems.length} path(s) pending` : ""),
        );

        // A "clone"-resolved conflict landed the data in a SCOPED volume; rewrite
        // that volume's source in the owning service's spec so the deploy MOUNTS
        // the clone (not the bare volume that held pre-existing data). Per-VOLUME
        // (matched by membership, not name) so two same-named services stay
        // isolated; keeps namespaceVolumes untouched so sibling volumes are
        // unaffected. Done AFTER the move (source enumerated bare) and BEFORE the
        // deploy (which reads the row).
        const cloneVolumes = Object.entries(input.conflictResolution ?? {})
          .filter(([, a]) => a === "clone")
          .map(([vol]) => vol);
        if (cloneVolumes.length > 0) {
          const rows = await repos.service.listByProject(projectId);
          const proj = await repos.project.findById(projectId);
          const slug = proj?.slug ?? "";
          for (const vol of cloneVolumes) {
            const scoped = scopedVolumeName(slug, vol);
            for (const row of rows) {
              const vols = (row.volumes ?? []) as string[];
              let changed = false;
              const rewritten = vols.map((spec) => {
                const parts = spec.split(":");
                if (parts[0] === vol) {
                  parts[0] = scoped;
                  changed = true;
                  return parts.join(":");
                }
                return spec;
              });
              if (changed) {
                await repos.service.update(row.id, { volumes: rewritten }).catch(() => {});
                log(`clone: ${vol} → ${scoped} (${row.name} mounts the clone)`);
              }
            }
          }
        }

        // ── deploying ──
        // Scoped by `serviceIds` (see deployRowIds): the pipeline builds/deploys ONLY the
        // new/moved services, carries the still-running reused containers forward
        // untouched, and never reaps them — without mutating any persisted row.
        this.throwIfCancelled(id);
        // An EMPTY scope must never reach `requestBuildAccess`: it drops `serviceIds` when
        // the list is empty, and an unscoped compose deploy recreates every service — the
        // reuse set included, which is the one outcome adopt-in-place exists to prevent.
        // Reaching here with nothing to deploy would be a bug in the branch condition
        // above (`deployChosen.length > 0 || hasNewRepoServices`), so say so and stop
        // rather than deploying the wrong thing.
        if (deployRowIds.length === 0) {
          throw new Error(
            "Nothing to deploy on the target, but the run reached the deploy step — " +
              "refusing to run an unscoped deploy that would recreate the reused containers.",
          );
        }
        await this.transition(id, "deploying");
        log(`deploying to target server…`);
        {
          const dep = await requestBuildAccess(
            ctx,
            {
              projectId,
              deployTarget: "server",
              serverId: targetServerId,
              runtimeMode: "docker",
              serviceDeploymentMode: "services",
              // Deploy ONLY the new/moved rows. `requestBuildAccess` ignores an EMPTY list
              // (`serviceIds && length > 0`), which would silently mean "deploy everything"
              // and recreate the reuse set — so the caller refuses to get here with one
              // (see the guard above this block).
              serviceIds: deployRowIds,
              // One-time cutover: native `build:` rows reuse the transferred/running
              // image on THIS deploy (no rebuild); a later Redeploy has no handover
              // and rebuilds from the repo.
              handoverImages: adopt.handover,
              /**
               * The SINGLE-APP twin of the map above, and the reason a moved single app rebuilt
               * itself from source on the target.
               *
               * `handoverImages` is the COMPOSE field: `pinnedServiceImage` looks a service NAME up
               * in it. A single-app deploy asks `pinnedAppImage`, which reads this scalar — and
               * `snapshotNeedsGitSource` keys off the same thing, so with it unset the target cloned
               * the repo and ran a full `docker build`. For `makieon` that meant streaming 725 MB of
               * image across, then rebuilding it from git anyway: minutes of wasted work whose only
               * visible symptom was a migration that looked stuck on its last step.
               *
               * Set only when the workload IS one service, so a compose project keeps using the map.
               */
              ...(Object.keys(adopt.handover).length === 1
                ? { handoverAppImage: Object.values(adopt.handover)[0] }
                : {}),
            },
            /**
             * EXCLUSIVE scope, not just "prefer these".
             *
             * `serviceIds` on its own means "build these, CARRY the rest forward", and carry
             * reads `project.activeDeploymentId` — which is null here: a freshly adopted
             * project has no previous release, and this run's own runtime rows are written by
             * `attachLiveRuntime` AFTER the deploy. So without this the reuse rows would be
             * neither carried nor skipped: enabled and holding a real image, they'd deploy
             * normally and put a SECOND container on the still-running originals' bare
             * volumes (reuse rows keep `namespaceVolumes: false`) — two writers on one
             * dataset, the exact opposite of what reuse mode promises.
             */
            { strictServiceScope: true },
          );
          deploymentId = dep.deployment_id;
          await this.transition(id, "deploying", { deploymentId });
          log(`target deployment ${deploymentId} started; verifying health…`);

          // ── verifying ──
          this.throwIfCancelled(id);
          await this.transition(id, "verifying");
          const verified = await this.waitForDeployment(deploymentId, id);
          if (!verified || verified.status !== "ready") {
            // Surface WHY, not a dead-end "did not become ready": a timeout, or the
            // deployment's own error PLUS which service(s) failed (so a
            // "partial_failure" names the culprit instead of a bare status).
            const mins = Math.round(VERIFY_TIMEOUT_MS / 60000);
            const reason = !verified
              ? `it was still deploying after ${mins} minutes`
              : await this.describeDeployFailure(deploymentId, verified);
            throw new Error(`The target deployment did not become ready — ${reason}.`);
          }
        }

        // Carry the source's existing TLS certs onto the target (cross-server)
        // BEFORE the post-verify domain publish reads them — so a kept domain
        // reuses its cert instead of re-issuing via ACME. Best-effort.
        if (!sameServer) {
          await this.carrySourceCerts(
            sourceServerId,
            targetServerId,
            organizationId,
            chosen,
            // A project move: carry certs for the project's own domains, which the
            // foreign-proxy scan never sees.
            input.projectMove ? projectId : undefined,
          ).catch((err) =>
            console.warn(`[migration] ${id}: cert carry skipped: ${safeErrorMessage(err)}`),
          );
        }
      } else {
        // Pure attach-live (same-server reuse only): no data move, no build.
        // Mint the deployment id the reconstructed runtime rows hang off of. No
        // `deploying` transition WITH this id → the run panel shows no (empty)
        // build terminal, and the volume-collision guard never runs.
        deploymentId = `dep_${crypto.randomUUID().replace(/-/g, "")}`;
      }

      // Attach the reuse set's live containers straight into the deployment
      // (reconstruct service_deployment rows by container id — no redeploy).
      if (attachRows.length > 0) {
        this.throwIfCancelled(id);
        await this.transition(id, "verifying");
        await attachLiveRuntime({
          deploymentId: deploymentId!,
          projectId,
          organizationId,
          serverId: sourceServerId,
          attach: attachChosen,
          serviceRows: await repos.service.listByProject(projectId),
          renames: adopt.renames,
        });
      }

      // Carry the source vhosts' proxy tunables onto the project BEFORE the
      // publish below renders any vhost, so a migrated site keeps its upload
      // limit / upstream timeouts instead of silently reverting to nginx's
      // 1 MB / 60 s defaults.
      await this.adoptSourceProxySettings(projectId, chosen, log).catch((err) =>
        log(`proxy tunables not adopted: ${safeErrorMessage(err)}`),
      );

      // Publish the chosen domains/routes SERVER-SIDE now the target is verified
      // (was client-only → lost when the wizard unmounted or a run was opened
      // from the list; same-server included). Best-effort — domains never fail a
      // migration. Route keys are DISCOVERED names → translate onto the adopted
      // ROW names so a renamed service still gets its routes.
      await this.publishRoutes(
        ctx,
        projectId,
        remapKeys(input.routesByServiceName, adopt.rowNameByDiscovered),
        log,
      );

      // Read back what the migration actually produced: one line per service
      // naming the container it resolves to on the host, how it was identified,
      // and any leftover duplicate. Without this, a service whose container was
      // adopted (foreign labels) or replaced looks identical in the run log to
      // one that landed cleanly — the operator only found out from the panel.
      // Log-only: never changes the run's outcome.
      /**
       * Re-point what RECORDED the old server.
       *
       * A free `*.opsh.io` subdomain is a hostname→SERVER mapping held by the cloud edge, and
       * `syncProjectManagedEdge` reads the server from the project's ACTIVE deployment — which
       * is why it runs HERE and not in the deploy: at that point the target deployment was not
       * active yet, so the sync inside the deploy re-pointed the subdomain at the server the
       * project was leaving. It must also run AFTER `publishRoutes`, because the mapping only
       * exists once the routes do.
       *
       * Best-effort, and deliberately so: the workload is already up and verified on the
       * target, so failing the migration over a record the dashboard's own "Retry routing" can
       * repair would tear down a working stack. The warning the operator sees is set by the
       * sync itself.
       *
       * Inline. This used to be a 186-line `RelocationEffect` registry — interface, ordered
       * list, per-effect logging, plus a test asserting the shape of a one-element array — for
       * this single call, justified prospectively by "the set only grows". It didn't. A second
       * effect can be added right here, where the ordering constraint it depends on is
       * actually visible.
       */
      if (input.projectMove && !sameServer) {
        try {
          const moved = await repos.project.findById(projectId);
          if (!moved) {
            log("free subdomain routing: project not found — nothing to update");
          } else {
            const { ok, failures } = await syncProjectManagedEdge(moved, organizationId);
            log(
              ok
                ? "free subdomain routing: re-pointed at the new server"
                : `free subdomain routing: still pointing at the old server — ${
                    failures.join("; ") || "sync failed"
                  }`,
            );
          }
        } catch (err) {
          log(`free subdomain routing: not updated — ${safeErrorMessage(err)}`);
        }
      }

      await this.logLiveState(projectId, targetServerId, organizationId, log);

      // ── partial / cutover / awaiting_cutover ──
      // Some paths didn't move → PARK as `partial` (target UP, source
      // stopped-but-kept): cutover is gated (killing the source now would lose
      // the un-moved data). The user resolves (edit path / skip) + resumes.
      if (pendingItems.length > 0) {
        await this.transition(id, "partial", { pendingItems });
        log(
          `migration PARTIAL — ${pendingItems.length} path(s) pending ` +
            `(${pendingItems.map((p) => p.key).join(", ")}); resolve + resume to finish`,
        );
      } else if (input.projectMove?.intent === "copy") {
        // A DUPLICATE retires nothing, so there is no destructive step to confirm and
        // `awaiting_cutover` would be a prompt about an act that never happens. The
        // originals were only quiesced so their volumes copied consistently — bring them
        // straight back up and finish.
        //
        // The source keeps its containers, its domains, its edge and its server binding.
        // What exists at the end is two independent projects.
        await this.restartSourceOriginals(sourceServerId, organizationId, scannedContainerIds);
        await this.transition(id, "succeeded");
        log(`duplicate succeeded — the original is running again on its own server`);
      } else if (deployChosen.length > 0) {
        // Only the deploy set has originals to retire. A pure attach-live run
        // adopted the live containers in place, so there is nothing to cut over.
        const run = await repos.dockerMigrationRun.findById(id);
        if (run?.killOriginals) {
          this.throwIfCancelled(id);
          await this.transition(id, "cutover");
          log(`cutover: stopping + removing the source originals`);
          const { failed } = await this.cutover(
            sourceServerId,
            organizationId,
            scannedContainerIds,
          );
          await this.transition(id, "succeeded");
          // The migration DID succeed — the target is live — so the status stays `succeeded`.
          // But a container still standing on the old server is something the operator has to
          // act on (it holds its ports, and a restart policy will bring it back), so it is
          // named in the log rather than dropped.
          const remainder = describeCutoverRemainder(failed);
          log(remainder ? `migration succeeded, BUT ${remainder}` : `migration succeeded`);
        } else {
          await this.transition(id, "awaiting_cutover");
          log(`target verified healthy — awaiting cutover confirmation`);
        }
      } else {
        await this.transition(id, "succeeded");
        log(
          hasNewRepoServices
            ? `migration succeeded (attached running service(s); built/pulled + routed the new repo service(s))`
            : `migration succeeded (attach-live, no cutover)`,
        );
      }
    } catch (err) {
      // A cancelled run rolls back like any pre-cutover failure, but with a
      // clean, user-facing reason instead of the raw (killed-rsync) error.
      const reason = this.cancelByRun.get(id)?.cancelled
        ? "Cancelled by user"
        : safeErrorMessage(err);
      log(`FAILED — ${reason}; rolling back (restart source, tear down target)`);
      await this.rollback(
        ctx,
        id,
        { sourceServerId, targetServerId },
        scannedContainerIds,
        deploymentId,
        createdProjectId,
        reason,
      );
    } finally {
      // Persist the tail (throttling may have skipped the last lines), then
      // release the buffer — the DB copy is now the source of truth.
      await this.flushLogs(id);
      this.logsByRun.delete(id);
      this.logFlushAt.delete(id);
    }
  }

  /** Stop originals on the source; then move volume data:
   *   - cross-server: stream every named/app-data source A→B (bare ids match).
   *   - same-server "copy" services: stream each NAMED volume from its original
   *     bare name into the scoped openship-<slug>-<name> volume on the SAME
   *     daemon, so the deploy mounts the copy and the original is left intact.
   *   - same-server "reuse" services: nothing — the deploy reuses the volume in place.
   *  Returns total bytes written. */
  private async moveData(
    projectId: string,
    sourceServerId: string,
    targetServerId: string,
    organizationId: string,
    scannedContainerIds: Record<string, string>,
    sameServer: boolean,
    volumeStrategies: Record<string, VolumeStrategy>,
    builtImages: BuiltImage[],
    customPaths: Array<{ source: string; dest: string }>,
    transfer: { mode?: TransferMode; compression?: TransferCompression },
    conflictResolution: Record<string, "override" | "clone" | "keep">,
    log: (message: string) => void,
    onProgress?: (u: ProgressUpdate) => void,
    runId?: string,
    /**
     * Slug of the project the volumes BELONG TO, when that isn't `projectId`.
     *
     * For a move they are the same. For a DUPLICATE they are not: `projectId` is the copy being
     * created (`clincai-copy`) while the volumes are the source's (`openship-clincai-*`), so
     * recognising "our own debris on the target" has to key off the SOURCE slug or it silently
     * stops working for exactly the flow that needs it most.
     */
    sourceProjectSlug?: string,
  ): Promise<MoveResult> {
    const rtA = await createServerDockerRuntime(sourceServerId, organizationId);
    const rtB = sameServer ? null : await createServerDockerRuntime(targetServerId, organizationId);
    try {
      // Quiesce originals for a consistent copy (and to free ports/volumes on
      // a same-server redeploy). Best-effort — a missing container is fine.
      for (const cid of Object.values(scannedContainerIds)) {
        await rtA.stop(cid).catch(() => {});
      }

      /**
       * Which MECHANISM moves the bytes — decided once, in the adapter's own vocabulary.
       *
       * The four mode names the settings API validates (`auto | stream | direct | rsync`)
       * used to collapse to `mode !== "stream"`, which made the vocabulary lie in both
       * directions: `"direct"` on a CROSS-server run did rsync-over-SSH rather than the
       * adapter's direct (one helper mounting both volumes on one daemon), and `"rsync"` on
       * a SAME-server run reached `transferVolume`, whose `resolvePlan` logs
       * "rsync not yet available → stream". An operator who picked a mechanism got a
       * different one with nothing saying so.
       *
       * Server-to-server rsync only exists here (the adapter reserves `"rsync"` for it and
       * falls back to stream until it lands), so this is the one place that can honour it:
       *   • cross-server + `rsync`/`direct`/`auto` → the server-to-server pipeline;
       *   • cross-server + `stream`               → the API-host relay (the documented
       *                                             opt-in for firewalled server↔server);
       *   • same-server                           → the relay's local copy, where the
       *                                             adapter's own `direct` applies.
       * Anything that is NOT what the operator asked for is LOGGED, matching `resolvePlan`'s
       * "never silently downgrades" contract.
       */
      const requestedMode = transfer.mode ?? "auto";
      if (rtB && requestedMode !== "stream") {
        if (requestedMode === "direct") {
          log(
            "transfer mode 'direct' applies to a single daemon; these are two servers — " +
              "moving server-to-server (rsync over SSH) instead",
          );
        }
        /**
         * rsync's `-z` is ZLIB, not zstd. Reporting the requested name would claim a
         * compression that never ran, so both the flag and the log say what actually
         * happens. "auto"/unset stays OFF — a fast LAN link usually beats the compressor.
         */
        const compress = transfer.compression === "zstd" || transfer.compression === "gzip";
        if (transfer.compression === "zstd") {
          log("compression 'zstd' is not available over rsync — using rsync -z (zlib)");
        }
        log(
          `transfer: server-to-server rsync${compress ? " with zlib compression" : ", uncompressed"}`,
        );
        return await this.moveDataDirect(
          projectId,
          sourceServerId,
          targetServerId,
          organizationId,
          rtA,
          builtImages,
          customPaths,
          compress,
          conflictResolution,
          log,
          onProgress,
          runId,
          scannedContainerIds,
          sourceProjectSlug,
        );
      }

      if (rtB) log("transfer: relaying through the control host (mode 'stream')");
      else if (requestedMode === "rsync") {
        // Say what the adapter will ACTUALLY do. `resolvePlan` has no rsync mechanism — it
        // notes "rsync not yet available → stream" — so claiming "the local copy applies"
        // named the one thing that does not happen. (`direct` needs no note: on one daemon
        // it IS the adapter's direct, which is what it asked for.)
        log("transfer mode 'rsync' is not available on a single daemon — streaming locally");
      }

      // Relay path (same-server copy, or the explicit "stream" override): the
      // API host relays bytes. Aggregate movedBytes across tasks; totalBytes is
      // unknown here (no upfront scan) so the bar shows raw bytes, not a %.
      const relayBytes = new Map<string, number>();
      const relayMoved = () => {
        let n = 0;
        for (const b of relayBytes.values()) n += b;
        return n;
      };

      // Cross-server: stream each locally-built image A→B as data so the target
      // adopts the exact same image (docker save | docker load). Immutable, so
      // order-independent; deduped by the caller. A missing-on-source image is
      // skipped (the target pulls it). Runs before volumes so a huge image fails
      // fast, before we spend time on volume copies.
      let imageBytes = 0;
      if (rtB && builtImages.length > 0) {
        for (const image of builtImages) {
          if (!(await rtA.imageExistsLocally(image.id))) {
            log(`image ${image.tag}: not present on source — target will pull`);
            continue;
          }
          const task = `image:${image.tag}`;
          const r = await transferImage(rtA, rtB, image, {
            onProgress: (bytes) => {
              relayBytes.set(task, bytes);
              onProgress?.({ task, kind: "image", movedBytes: relayMoved(), totalBytes: null });
            },
            log: (m) => log(`image ${image}: ${m}`),
          });
          imageBytes += r.bytesMoved;
        }
      }

      const services = await repos.service.listByProject(projectId);
      const project = await repos.project.findById(projectId);
      const projectSlug = project?.slug ?? "";
      const execA = resolveExecutor("docker", rtA);

      // Collect (src → dst) transfer tasks for BOTH topologies, then run them
      // through the ONE transfer core. No per-topology pipe duplication — same
      // vs cross only differ in which executor/handle each end uses.
      const tasks: Array<{
        label: string;
        kind: "volume" | "bind";
        source: string;
        /** Volume name written on the TARGET (for optional post-failure cleanup);
         *  undefined for binds (host paths, not docker volumes). */
        targetVolume?: string;
        src: TransferEndpoint;
        dst: TransferEndpoint;
      }> = [];

      if (sameServer || !rtB) {
        // Same daemon: copy the volumes of "copy"-marked services bare→scoped.
        for (const svc of services) {
          if (volumeStrategies[svc.name] !== "copy") continue;
          const base = {
            id: svc.id,
            projectId,
            name: svc.name,
            image: svc.image ?? null,
            env: {},
            volumes: svc.volumes ?? [],
            containerId: null, // DB-fallback branch → resolvable ids both ways
            projectSlug,
          } as const;
          const bareHandle: ServiceHandle = { ...base, namespaceVolumes: false };
          const scopedHandle: ServiceHandle = { ...base, namespaceVolumes: true };
          const bareSrcs = await execA.listSources(bareHandle);
          const scopedSrcs = await execA.listSources(scopedHandle);
          for (const src of bareSrcs) {
            // Named volumes only — a bind mount can't be copied onto its own
            // host path on the same daemon, so it stays in place.
            if (src.type !== "volume") continue;
            const dst = scopedSrcs.find((d) => d.type === "volume" && d.target === src.target);
            if (!dst) continue;
            tasks.push({
              label: svc.name,
              kind: "volume",
              source: src.source,
              targetVolume: scopedVolumeName(projectSlug, src.source),
              src: { exec: execA, handle: bareHandle, sourceId: src.id },
              dst: { exec: execA, handle: scopedHandle, sourceId: dst.id },
            });
          }
        }
      } else {
        // Cross daemon: stream every movable source A→B (bare id = same name on
        // both, so data lands with no remap).
        const execB = resolveExecutor("docker", rtB);
        for (const svc of services) {
          /**
           * SOURCE enumeration reads the LIVE container, exactly as the direct path does.
           *
           * This used to force `containerId: null` "→ bare-named ids", which made the two
           * transfer paths enumerate different data for the same run:
           * `resolveScannedContainerId`'s own docblock says passing null for an adopted
           * service makes `listSources` GUESS the volume name, and adopted rows get their
           * `volumes` from `volumeToComposeString`, which DROPS anonymous volumes. So a
           * service with an anonymous volume had it moved on the default path and silently
           * left behind on the relay path — same run, same services, different data moved
           * depending on which transferMode the operator picked.
           */
          const handle: ServiceHandle = {
            id: svc.id,
            projectId,
            name: svc.name,
            image: svc.image ?? null,
            env: {},
            volumes: svc.volumes ?? [],
            containerId: resolveScannedContainerId(svc.name, scannedContainerIds),
            projectSlug,
            namespaceVolumes: svc.namespaceVolumes,
          };
          /**
           * DESTINATION handles stay DB-declared (`containerId: null`): the target has no
           * container yet, and cross-server lands on BARE names. Built per source so the
           * dst enumerates exactly the volume this task writes — a live-read source id can
           * be an anonymous volume's hash, which the target's declared list would not
           * contain at all.
           */
          const dstHandleFor = (src: { source: string; target: string }): ServiceHandle => ({
            ...handle,
            containerId: null,
            volumes: [`${src.source}:${src.target || "/data"}`],
            namespaceVolumes: false,
          });
          // Scoped dst handle for a "clone"-resolved volume (target volume →
          // openship-<slug>-<name>); mirrors the same-server copy branch. Lazy —
          // only computed when this service actually has a clone volume.
          const scopedHandle: ServiceHandle = {
            ...handle,
            containerId: null,
            namespaceVolumes: true,
          };
          let scopedSrcs: Awaited<ReturnType<typeof execB.listSources>> | null = null;
          const sources = await execA.listSources(handle);
          for (const src of sources) {
            if (src.type === "bind") {
              if (!isMovableBind(src.source)) continue;
            } else if (src.type !== "volume") {
              continue;
            }
            // Per-VOLUME conflict resolution (keyed by the unique volume name):
            // keep = don't transfer (use existing); clone = land in the scoped
            // target volume; override/none = bare (clearTarget overwrites).
            const action = src.type === "volume" ? conflictResolution[src.source] : undefined;
            if (action === "keep") continue;
            // Resolve the dst id from the target's OWN enumeration of that bare name, so a
            // source id that came from live Mounts (possibly an anonymous volume's hash)
            // still lands on a name the target can address.
            const dstHandle = dstHandleFor(src);
            const dstSource = (await execB.listSources(dstHandle)).find(
              (d) => d.type === src.type && d.source === src.source,
            );
            let dst: TransferEndpoint = {
              exec: execB,
              handle: dstHandle,
              sourceId: dstSource?.id ?? src.id,
            };
            if (action === "clone") {
              if (!scopedSrcs) scopedSrcs = await execB.listSources(scopedHandle);
              const sd = scopedSrcs.find((d) => d.type === "volume" && d.target === src.target);
              if (sd) dst = { exec: execB, handle: scopedHandle, sourceId: sd.id };
            }
            tasks.push({
              label: svc.name,
              kind: src.type === "bind" ? "bind" : "volume",
              source: src.source,
              targetVolume:
                src.type === "volume"
                  ? action === "clone"
                    ? scopedVolumeName(projectSlug, src.source)
                    : src.source
                  : undefined,
              src: { exec: execA, handle, sourceId: src.id },
              dst,
            });
          }
        }

        // Cross-server reuses BARE volume names on the target, and transfer runs
        // with clearTarget:true — so a same-named volume already holding data on
        // B (from an unrelated stack) would be silently wiped. Refuse BEFORE any
        // destructive write — UNLESS the user resolved that service's conflict at
        // the plan step (override/clone/keep). The caller's rollback restarts the
        // originals otherwise.
        // A straggler conflict (not surfaced at the plan step) inherits the
        // user's unanimous override/keep choice — a bare→bare task already
        // overwrites (= override), so here we only need to not hard-fail.
        const relayFallbackRaw = unanimousConflictAction(conflictResolution);
        const relayFallback = relayFallbackRaw === "clone" ? undefined : relayFallbackRaw;
        // Same self-healing rule as the direct path, for the same reason — see the long comment
        // there. A volume carrying THIS project's own namespace prefix, on a server the project
        // doesn't live on, is debris from an earlier attempt at this move; refusing over it is a
        // loop no retry can break. Kept here as well rather than only on the direct path,
        // because "which transfer mode did you use" must not decide whether you get stuck.
        const relayOurSlug = sourceProjectSlug || projectSlug;
        const relayOurPrefix = relayOurSlug ? scopedVolumeName(relayOurSlug, "") : null;
        const conflicts: string[] = [];
        for (const task of tasks) {
          if (conflictResolution[task.source] || relayFallback) continue; // resolved / inherited
          // The SHARED verdict, so this path has the same fail-safe as the other two. It
          // used to read `!probe?.exists` — which is TRUE when the executor has no
          // `probeVolume` at all, i.e. "cannot check" silently became "no conflict", the
          // same fail-OPEN the shell copies had.
          const verdict = await probeOneVolume(
            task.dst.exec,
            task.dst.handle,
            task.dst.sourceId,
            log,
          );
          if (!verdict) continue;
          const name = task.dst.sourceId;
          if (
            relayOurPrefix &&
            name.startsWith(relayOurPrefix) &&
            name.length > relayOurPrefix.length
          ) {
            log(
              `${name}: left on the target by an earlier attempt at this move — ` +
                `its contents are replaced by this transfer`,
            );
            continue;
          }
          conflicts.push(`${task.label}/${name}`);
        }
        if (conflicts.length > 0) {
          throw new Error(
            `Target server already has data in volume(s): ${conflicts.join(", ")}. ` +
              "Remove or rename them on the target, then retry — refusing to overwrite existing data.",
          );
        }
      }

      // Bounded parallelism — a few volumes move at once without saturating a
      // single SSH link. transferVolume picks direct (same-daemon) vs stream and
      // the compression per the mode/compression request (auto = topology-aware).
      // Per-item resilient (parity with the direct path): a task that fails
      // becomes a PENDING item (→ `partial`, resolvable + resumable) instead of
      // aborting the whole migration.
      const pendingItems: PendingItem[] = [];
      // Recorded BEFORE the transfer, for the same reason as the direct path: an abort
      // mid-transfer must still leave a record of what we put on the target, or those volumes
      // become orphans that block every retry with nothing pointing at them.
      const plannedTargetVolumes = rtB
        ? tasks.filter((t) => t.targetVolume).map((t) => t.targetVolume as string)
        : [];
      // `runId` is optional on this path (it also serves the cancel registry). Nothing can be
      // recorded without it, and the caller still gets the list back on success.
      if (runId && plannedTargetVolumes.length > 0) {
        await repos.dockerMigrationRun
          .updateTargetVolumes(runId, plannedTargetVolumes)
          .catch(() => {});
      }
      const results = await mapWithLimit(tasks, TRANSFER_CONCURRENCY, async (t) => {
        // Cancel check BEFORE the resilience try (see the direct path).
        this.throwIfCancelled(runId);
        const task = `volume:${t.label}/${t.src.sourceId}`;
        try {
          const r = await transferVolume(t.src, t.dst, {
            mode: transfer.mode,
            compression: transfer.compression,
            clearTarget: true,
            log: (m) => log(`${t.label}/${t.src.sourceId}: ${m}`),
            onProgress: (bytes) => {
              relayBytes.set(task, bytes);
              onProgress?.({ task, kind: "volume", movedBytes: relayMoved(), totalBytes: null });
            },
          });
          log(
            `${t.label}/${t.src.sourceId}: ${r.strategy} (${r.compression}) — ${r.bytesMoved} bytes`,
          );
          return r.bytesMoved;
        } catch (err) {
          const message = safeErrorMessage(err);
          pendingItems.push({
            key: `${t.kind}:${t.source}`,
            kind: t.kind,
            source: t.source,
            serviceName: t.label,
            reason: "error",
            message,
          });
          log(`SKIPPED ${t.kind}:${t.source}: ${message} → pending (resolve + resume to finish)`);
          return 0;
        }
      });
      return {
        bytesMoved: imageBytes + results.reduce((sum, n) => sum + n, 0),
        pendingItems,
        targetVolumes: plannedTargetVolumes,
      };
    } finally {
      await rtA.dispose().catch(() => {});
      if (rtB) await rtB.dispose().catch(() => {});
    }
  }

  /**
   * Direct server-to-server move: the SOURCE box rsyncs volumes/binds and pipes
   * `docker save | ssh | docker load` straight to the TARGET (or the reverse,
   * for asymmetric firewalls) — no byte touches the API host. An ephemeral,
   * per-run SSH trust is bootstrapped and torn down here. Fails loudly if
   * neither direction connects (the caller's rollback restarts the originals).
   * Returns total bytes moved.
   */
  private async moveDataDirect(
    projectId: string,
    sourceServerId: string,
    targetServerId: string,
    organizationId: string,
    rtA: Awaited<ReturnType<typeof createServerDockerRuntime>>,
    builtImages: BuiltImage[],
    customPaths: Array<{ source: string; dest: string }>,
    compress: boolean,
    conflictResolution: Record<string, "override" | "clone" | "keep">,
    log: (message: string) => void,
    onProgress?: (u: ProgressUpdate) => void,
    runId?: string,
    scannedContainerIds: Record<string, string> = {},
    /** See {@link moveData}'s parameter of the same name. */
    sourceProjectSlug?: string,
  ): Promise<MoveResult> {
    const [source, target] = await Promise.all([
      createServerCommandExecutor(sourceServerId, organizationId),
      createServerCommandExecutor(targetServerId, organizationId),
    ]);
    const runTag = crypto.randomBytes(6).toString("hex");
    // Record the marker so a cancel can pkill exactly this run's rsync/ssh.
    if (runId) {
      const reg = this.cancelByRun.get(runId);
      if (reg) reg.runTag = runTag;
    }
    const link = await establishDirectLink({
      sourceExec: source.executor,
      targetExec: target.executor,
      sourceConn: source.conn,
      targetConn: target.conn,
      runId: runTag,
      compress,
      log,
    });
    if (!link) {
      throw new Error(
        `Neither server can open a direct SSH connection to the other ` +
          `(checked source→target ${target.conn.host}:${target.conn.port} and ` +
          `target→source ${source.conn.host}:${source.conn.port}). Open server-to-server ` +
          `SSH (port 22) between them, or retry with the "Relay via control host" transfer mode.`,
      );
    }

    try {
      log(`direct link established (${link.direction})`);

      // Enumerate the source's movable data FIRST: bare-named volumes + movable bind
      // paths + the built images actually present on the source. The SAME enumeration the
      // relay path uses — both read the LIVE container via `resolveScannedContainerId`.
      // (That claim used to be false: this path passed a real id and the relay path forced
      // the DB fallback, so an adopted service's anonymous volumes moved on one and not
      // the other.)
      const services = await repos.service.listByProject(projectId);
      const project = await repos.project.findById(projectId);
      const projectSlug = project?.slug ?? "";
      const execA = resolveExecutor("docker", rtA);
      const volumeNames = new Set<string>();
      const bindPaths = new Set<string>();
      // ref → owning service name, so a pending item names the service to restart.
      const owner = new Map<string, string>();
      for (const svc of services) {
        const handle: ServiceHandle = {
          id: svc.id,
          projectId,
          name: svc.name,
          image: svc.image ?? null,
          env: {},
          volumes: svc.volumes ?? [],
          containerId: resolveScannedContainerId(svc.name, scannedContainerIds),
          projectSlug,
          namespaceVolumes: svc.namespaceVolumes,
        };
        for (const src of await execA.listSources(handle)) {
          if (src.type === "volume") {
            volumeNames.add(src.source);
            if (!owner.has(src.source)) owner.set(src.source, svc.name);
          } else if (src.type === "bind" && isMovableBind(src.source)) {
            bindPaths.add(src.source);
            if (!owner.has(src.source)) owner.set(src.source, svc.name);
          }
        }
      }
      const imagesToMove: BuiltImage[] = [];
      for (const image of builtImages) {
        if (await rtA.imageExistsLocally(image.id)) imagesToMove.push(image);
        else log(`image ${image.tag}: not present on source — target will pull`);
      }

      // Effective resolution = the user's explicit per-volume choices, plus (for
      // any conflict the plan step didn't surface) their unanimous choice. A
      // volume with a resolution isn't a blocking conflict; a truly unresolved
      // one (mixed choices, none inferable) still hard-fails (safe). Clone
      // targets a fresh scoped name, so it never conflicts anyway.
      const resolution: Record<string, "override" | "clone" | "keep"> = { ...conflictResolution };
      // Only override/keep are inheritable — both are self-contained in the move.
      // Clone also needs a post-move metadata rewrite keyed off the EXPLICIT map,
      // so an inherited clone would land data the deploy wouldn't mount → exclude.
      const inheritRaw = unanimousConflictAction(conflictResolution);
      const fallback = inheritRaw === "clone" ? undefined : inheritRaw;

      /**
       * Is this volume name one OUR deploy of THIS project would produce?
       *
       * Exact prefix on the project's own slug, never a loose "starts with openship-": a
       * substring rule would match `openship-clincai-staging-pgdata` while moving `clincai`, and
       * a stranger's project is exactly what must never be overwritten. `scopedVolumeName` is the
       * one place that name is formed, so the test is built from it rather than re-spelled.
       *
       * Empty slug ⇒ never matches. A project we couldn't read is not a project we can claim
       * volumes for.
       */
      // The SOURCE project's slug, which for a duplicate is not this run's project — see
      // `moveData`'s `sourceProjectSlug`. Falls back to the run's own project, which is correct
      // for a move and for door A.
      const ourSlug = sourceProjectSlug || projectSlug;
      const ourVolumePrefix = ourSlug ? scopedVolumeName(ourSlug, "") : null;
      const isOurNamespacedVolume = (name: string) =>
        Boolean(ourVolumePrefix) &&
        name.startsWith(ourVolumePrefix!) &&
        name.length > ourVolumePrefix!.length;
      log(
        `conflict resolution: ${Object.keys(conflictResolution).length ? JSON.stringify(conflictResolution) : "none"}` +
          `; enumerated volumes: ${[...volumeNames].join(", ") || "none"}`,
      );
      // Through the ADAPTER, fail-safe, like the relay path — not the shell probe this
      // replaces, whose `.catch(() => "")` meant an unreadable root-only
      // /var/lib/docker/volumes (any non-root SSH account) read as "no conflict" and this
      // path overwrote a populated volume that `transferMode: "stream"` would have refused.
      const unresolved = [...volumeNames].filter((name) => !resolution[name]);
      const occupied = await probeTargetVolumeConflicts({
        targetServerId,
        organizationId,
        projectId,
        projectSlug,
        queries: unresolved.map((name) => ({ serviceName: owner.get(name) ?? name, volume: name })),
        onLog: log,
      });
      const conflicts: string[] = [];
      for (const name of unresolved) {
        if (!occupied.has(name)) continue;
        if (fallback) {
          resolution[name] = fallback;
          log(
            `conflict ${name}: no explicit choice — applying '${fallback}' (matches your other choices)`,
          );
          continue;
        }
        // OUR OWN DEBRIS IS NOT A CONFLICT.
        //
        // `openship-<slug>-<vol>` is the name OUR deploy gives THIS project's volumes. Finding
        // one on a server the project doesn't live on means an earlier attempt at this same move
        // wrote it and didn't clean up — and refusing over it left the operator in a loop no
        // retry could break, only `docker volume rm` on the box by hand. Rollback now removes
        // what it wrote, but that only helps runs that recorded it: anything stranded by an
        // earlier version, or by a crash between writing and recording, is invisible to it. This
        // is the part that makes the flow self-healing rather than merely tidy from here on.
        //
        // Still refuses if a container is USING it. That is the line: a name we recognise is
        // ours to overwrite, a volume something is actually running on is not, whoever named it.
        if (isOurNamespacedVolume(name)) {
          const users = await target.executor
            .exec(`docker ps --filter volume=${sq(name)} --format '{{.Names}}' 2>/dev/null || true`)
            .catch(() => "");
          const running = users
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          if (running.length === 0) {
            resolution[name] = "override";
            log(
              `${name}: left on the target by an earlier attempt at this move and unused — ` +
                `reusing it (its contents are replaced by this transfer)`,
            );
            continue;
          }
          log(`${name}: in use by ${running.join(", ")} on the target — refusing`);
        }
        conflicts.push(name);
      }
      if (conflicts.length > 0) {
        // Two different sentences, because they need two different actions. "Already has
        // data" is a lie when the daemon never answered — that reads as a data problem and
        // sends the operator looking for volumes that may be empty, while the real fault
        // (target unreachable, or its docker API unusable by the SSH account) goes unnamed.
        const unverified = conflicts.filter((n) => occupied.get(n) === "unknown");
        const holdingData = conflicts.filter((n) => occupied.get(n) !== "unknown");
        const parts: string[] = [];
        if (holdingData.length > 0) {
          parts.push(
            `Target server already has data in volume(s): ${holdingData.join(", ")}. ` +
              "Remove or rename them on the target, then retry.",
          );
        }
        if (unverified.length > 0) {
          parts.push(
            `Could not verify target volume(s): ${unverified.join(", ")}. ` +
              "Check the target is reachable and its docker API is usable by the SSH account.",
          );
        }
        throw new Error(`${parts.join(" ")} Refusing to overwrite data we cannot rule out.`);
      }

      // Scan the payload size on the source → the progress-bar denominator.
      // Best-effort: an unmeasurable item leaves totalBytes a lower bound (the
      // bar still advances, just against a slightly-low total).
      const sized = await sizeOfMoveSet(source.executor, {
        volumeNames: [...volumeNames],
        bindPaths: [...bindPaths],
        images: imagesToMove,
        customPaths: customPaths.map((c) => c.source),
      }).catch(() => null);
      const totalBytes = sized && sized.totalBytes > 0 ? sized.totalBytes : null;
      log(
        `transfer plan: ${totalBytes ?? "?"} bytes across ${volumeNames.size} volume(s), ` +
          `${bindPaths.size} bind(s), ${imagesToMove.length} image(s), ${customPaths.length} path(s)`,
      );

      const bytesByTask = new Map<string, number>();
      const track = (task: string, kind: "image" | "volume") => (bytes: number) => {
        // Per-task floor: a resumed rsync re-reports from a lower offset, so
        // clamp to the max seen — the bar never rewinds on a resume/retry.
        bytesByTask.set(task, Math.max(bytesByTask.get(task) ?? 0, bytes));
        let movedBytes = 0;
        for (const b of bytesByTask.values()) movedBytes += b;
        onProgress?.({ task, kind, movedBytes, totalBytes });
      };

      // Images first — sequential (large; save|load contends on the link). Every
      // image the source has locally is MOVED as data (docker save|load), so a
      // locally-built/tagged image never triggers a registry pull on the target.
      for (const image of imagesToMove) {
        log(`image ${image.tag}: moving as data (docker save|load) — no registry pull`);
        await link.transferImage(image, track(`image:${image.tag}`, "image"));
      }

      // Volumes + binds + user custom paths, bounded concurrency over the link.
      const items: Array<
        | { kind: "volume"; ref: string }
        | { kind: "bind"; ref: string }
        | { kind: "path"; source: string; dest: string }
      > = [
        ...[...volumeNames].map((ref) => ({ kind: "volume" as const, ref })),
        ...[...bindPaths].map((ref) => ({ kind: "bind" as const, ref })),
        ...customPaths.map((c) => ({ kind: "path" as const, source: c.source, dest: c.dest })),
      ];
      // Per-item resilient: one bad/missing path becomes a PENDING item (→ the
      // run parks `partial`, resolvable + resumable) instead of aborting the
      // whole migration. A genuine link/tool failure also lands here.
      const pendingItems: PendingItem[] = [];
      // src volume name → target volume name, for the post-transfer size check.
      const verifyVolumes: Array<{ src: string; dst: string }> = [];

      /**
       * Record what we are ABOUT to write on the target, before writing any of it.
       *
       * This used to be collected as each transfer succeeded and returned at the end, which
       * meant a run that aborted mid-transfer (a cancel, a link failure) recorded NOTHING —
       * so the volumes it had already written on the target became invisible orphans. The
       * next attempt then hit "target already has data" and there was no record telling
       * anyone which volumes to remove, or that we were the ones who put them there.
       *
       * Known up front, so no incremental writes to race: every non-`keep` volume is one we
       * will write. Over-approximating is safe and deliberate — cleanup removes with
       * `rm -f … || true`, so naming a volume that never got created costs nothing, while
       * missing one strands data on the target.
       */
      const targetVolumes = [...volumeNames]
        .filter((ref) => resolution[ref] !== "keep")
        .map((ref) => (resolution[ref] === "clone" ? scopedVolumeName(projectSlug, ref) : ref));
      if (runId && targetVolumes.length > 0) {
        await repos.dockerMigrationRun.updateTargetVolumes(runId, targetVolumes).catch(() => {});
      }
      await mapWithLimit(items, TRANSFER_CONCURRENCY, async (it) => {
        // Cancel check BEFORE the resilience try — a cancel must abort the run,
        // not get swallowed into pendingItems as if the path failed.
        this.throwIfCancelled(runId);
        try {
          if (it.kind === "volume") {
            // Conflict resolution (per VOLUME): keep = don't transfer (use
            // existing target data); clone = land in a fresh scoped volume;
            // override/none = overwrite the bare target (clearTarget default).
            const action = resolution[it.ref];
            if (action === "keep") {
              log(`volume ${it.ref}: keeping existing target data (not transferred)`);
            } else {
              const dstName =
                action === "clone" ? scopedVolumeName(projectSlug, it.ref) : undefined;
              // No push here — `targetVolumes` was recorded in full before the pool started,
              // precisely so a mid-transfer abort still leaves a cleanable record.
              await link.transferVolume(it.ref, track(`volume:${it.ref}`, "volume"), dstName);
              verifyVolumes.push({ src: it.ref, dst: dstName ?? it.ref });
            }
          } else if (it.kind === "bind")
            await link.transferBind(it.ref, track(`bind:${it.ref}`, "volume"));
          else await link.transferPath(it.source, it.dest, track(`path:${it.source}`, "volume"));
        } catch (err) {
          const missing = err instanceof PathMissingError;
          const message = safeErrorMessage(err);
          const pending: PendingItem =
            it.kind === "path"
              ? {
                  key: `path:${it.source}`,
                  kind: "path",
                  source: it.source,
                  dest: it.dest,
                  reason: missing ? "missing" : "error",
                  message,
                }
              : {
                  key: `${it.kind}:${it.ref}`,
                  kind: it.kind,
                  source: it.ref,
                  serviceName: owner.get(it.ref),
                  reason: missing ? "missing" : "error",
                  message,
                };
          pendingItems.push(pending);
          log(`SKIPPED ${pending.key}: ${message} → pending (resolve + resume to finish)`);
        }
        return 0;
      });

      // Integrity check: rsync (-a) / docker load already make the target an
      // EXACT copy, but re-`du` both sides so the session log VISIBLY confirms
      // the bytes landed (and flags a surprise mismatch). Best-effort; a small
      // delta is normal (filesystem block/overhead differences), so it warns
      // rather than fails.
      // `volumeBytes`, not a local re-spelling of it. The copy dropped BOTH of that
      // helper's timeouts (inspect 10s, du 20s) — which migration-size.ts documents as
      // existing precisely "so a giant/slow `du` yields null … rather than hanging the
      // wizard or the move". This loop runs on both hosts for every moved volume AFTER the
      // data has already landed, so an unbounded `du` parked a finished migration in
      // `moving_data` with nothing to break it.
      for (const v of verifyVolumes) {
        const [srcBytes, dstBytes] = await Promise.all([
          volumeBytes(source.executor, v.src),
          volumeBytes(target.executor, v.dst),
        ]);
        if (srcBytes == null || dstBytes == null) {
          log(`verify ${v.dst}: size unavailable — skipped`);
          continue;
        }
        const ok = Math.abs(srcBytes - dstBytes) <= Math.max(4096, srcBytes * 0.01);
        log(
          `verify ${v.dst}: source ${srcBytes} → target ${dstBytes} bytes ${ok ? "✓" : "⚠ size mismatch"}`,
        );
      }

      let total = 0;
      for (const b of bytesByTask.values()) total += b;
      return { bytesMoved: total, pendingItems, targetVolumes };
    } finally {
      // rtA/rtB are disposed by moveData's own finally (this runs on its return).
      await link.cleanup();
    }
  }

  /**
   * Carry the SOURCE's existing TLS certs onto the TARGET so a kept domain
   * reuses its cert instead of re-issuing via ACME. Reads the foreign-proxy
   * cert/key (already discovered per service as `existingRoute.ssl`) on the
   * source and writes the PEM pair to the target's canonical edge path
   * `/etc/letsencrypt/live/<domain>/{fullchain,privkey}.pem` — the exact path the
   * target edge + `reuseServerCertForDomain` read at publish time, for bare host
   * AND docker-edge (shared volume). Best-effort: any read/write failure just
   * falls back to ACME on publish (domains never fail a deploy).
   */
  /** Expose the migrated services + set their domains once the target is up.
   *  Mirrors the wizard's old client-side applyRoutes, but server-driven so it
   *  survives the client leaving the flow. Reuses `updateService` (which
   *  reconciles the edge routes). Best-effort per service. */
  /**
   * Read the migrated project's REAL runtime state off the host and write it to
   * the run log — one line per service: which container it resolves to, by which
   * identity key, its live state, and any duplicate that also claims it.
   *
   * This is the migration's own read-back. A same-server "reuse" run adopts
   * containers whose `openship.*` labels still name the PREVIOUS project (labels
   * are immutable in place), so "did every service actually land?" can't be
   * answered from the DB — only by matching the host. Best-effort, log-only.
   */
  private async logLiveState(
    projectId: string,
    serverId: string,
    organizationId: string,
    log: (m: string) => void,
  ): Promise<void> {
    try {
      const project = await repos.project.findById(projectId);
      const services = await repos.service.listByProject(projectId);
      if (!project || services.length === 0) return;
      const dep = project.activeDeploymentId
        ? await repos.deployment.findById(project.activeDeploymentId)
        : null;
      const trackedIds = Object.fromEntries(
        (dep ? await repos.service.listByDeployment(dep.id) : []).map((r) => [
          r.serviceId,
          r.containerId,
        ]),
      );
      const rt = await createServerDockerRuntime(serverId, organizationId);
      try {
        const containers = await rt.listAllContainers();
        const targets = services.map((s) => ({ id: s.id, name: s.name }));
        const matches = resolveLiveServiceState({
          services: targets,
          live: containers,
          projectId,
          slug: project.slug,
          trackedIds,
        });
        log(`live state after migration:`);
        for (const line of describeLiveState(targets, containers, matches)) log(`  ${line}`);
      } finally {
        await rt.dispose().catch(() => {});
      }
    } catch (err) {
      log(`live-state read-back skipped: ${safeErrorMessage(err)}`);
    }
  }

  private async publishRoutes(
    ctx: RequestContext,
    projectId: string,
    routes: StartMigrationInput["routesByServiceName"],
    log: (m: string) => void,
  ): Promise<void> {
    // Snapshot the hostnames the project's edge serves NOW, BEFORE publishing —
    // so the symmetric reconcile at the end can TEAR DOWN any hostname this
    // migration drops (a service set to "None", or a domain reassigned). Without
    // this, publishRoutes was publish-only: a dropped domain's legacy <slug>.conf
    // kept proxying the hostname to its OLD upstream port (stale exposure — a
    // security gap). This runs even when `routes` is empty (everything → None).
    const project = await repos.project.findById(projectId).catch(() => null);
    const before = project ? await resolveProjectRouteState(project).catch(() => null) : null;
    const previousHostnames = before?.projectDomains.map((d) => d.hostname) ?? [];

    const services = await repos.service.listByProject(projectId).catch(() => []);
    const byName = new Map(services.map((s) => [s.name, s]));

    // Group by DOMAIN: a domain can be shared by several services at different
    // paths (path fan-out, e.g. api.onvo.me `/` → web, `/v3` → api). `domain` is
    // globally unique, so exactly one service can own its row.
    type Entry = { name: string; svcId: string; spec: MigrationRouteSpec; domain: string };
    const byDomain = new Map<string, Entry[]>();
    for (const [name, spec] of Object.entries(routes ?? {})) {
      const svc = byName.get(name);
      const domain = (spec.domainType === "custom" ? spec.customDomain : spec.domain)
        ?.trim()
        .toLowerCase();
      if (!svc || !domain) continue;
      const list = byDomain.get(domain) ?? [];
      list.push({ name, svcId: svc.id, spec, domain });
      byDomain.set(domain, list);
    }

    const composites: ProjectCompositeRoute[] = [];
    for (const [domain, entries] of byDomain) {
      // Root = the `/` entry (no targetPath), else the shortest path, else first.
      const root =
        entries.find((e) => !e.spec.targetPath) ??
        [...entries].sort(
          (a, b) => (a.spec.targetPath ?? "/").length - (b.spec.targetPath ?? "/").length,
        )[0];
      const extras = entries.filter((e) => e !== root && e.spec.targetPath);

      // Root mints the domain row + exposes.
      try {
        await updateService(ctx, projectId, root.svcId, {
          exposed: true,
          ...(root.spec.exposedPort ? { exposedPort: root.spec.exposedPort } : {}),
          domainType: root.spec.domainType,
          ...(root.spec.domainType === "custom" ? { customDomain: domain } : { domain }),
        });
        log(`published route ${root.name} → ${domain}${root.spec.targetPath ?? ""}`);
      } catch (err) {
        log(`route ${root.name} skipped: ${safeErrorMessage(err)}`);
        continue; // couldn't publish the domain at all
      }

      // Extras share the domain at a path — just EXPOSE them (no own domain) so
      // their upstream resolves for the fan-out proxy locations.
      for (const e of extras) {
        try {
          await updateService(ctx, projectId, e.svcId, {
            exposed: true,
            ...(e.spec.exposedPort ? { exposedPort: e.spec.exposedPort } : {}),
          });
          log(`published fan-out ${e.name} → ${domain}${e.spec.targetPath}`);
        } catch (err) {
          log(`fan-out ${e.name} skipped: ${safeErrorMessage(err)}`);
        }
      }

      if (extras.length > 0) {
        composites.push({
          hostname: domain,
          isCustomDomain: root.spec.domainType === "custom",
          rootServiceId: root.svcId,
          locations: extras.map((e) => ({ pathPrefix: e.spec.targetPath!, serviceId: e.svcId })),
        });
      }
    }

    // Persist the fan-out map + apply it NOW (proxyLocations, last so it wins over
    // the root's plain route). Persistence makes every future redeploy re-emit it
    // (deploy.service + routing-apply read project.compositeRoutes). Best-effort.
    if (composites.length > 0) {
      try {
        await repos.project.update(projectId, { compositeRoutes: composites });
        await applyProjectRouting(projectId);
        log(`published ${composites.length} path-routed domain(s)`);
      } catch (err) {
        log(`path-routing apply skipped: ${safeErrorMessage(err)}`);
      }
    }

    // SYMMETRIC RECONCILE (the security fix): re-apply the CURRENT live routes and
    // REMOVE every hostname that was served before but is NOT published now — via
    // the same atomic path the interactive edits use (reconcileProjectRoutes →
    // NginxProvider.removeRoute deletes <slug>.conf + <slug>.route.json + validates
    // and reloads, plus deregisters dropped free *.opsh.io slugs). This makes a
    // migrated route set to "None" actually take the domain DOWN on the edge
    // instead of leaving a legacy vhost pointed at the old port.
    const refreshed = await repos.project.findById(projectId).catch(() => null);
    if (refreshed) {
      await reapplyProjectLiveRoutes(refreshed, previousHostnames).catch((err) =>
        log(`edge reconcile skipped: ${safeErrorMessage(err)}`),
      );
    }
  }

  /**
   * Carry the source vhosts' reverse-proxy tunables onto the migrated project.
   *
   * A foreign nginx that allowed 200 MB uploads and 10-minute upstream reads is
   * REPLACED by our edge at cutover, and our edge starts from nginx's defaults —
   * 1 MB and 60 s. Nothing in the wizard mentioned it, so the first big upload
   * after a migration 413'd and the operator had no way to connect that to the
   * move. The scan already parsed these values (`ImportedSite.proxy`, carried
   * through the by-port index onto each discovered route), so adopting them is
   * just persistence.
   *
   * Union across the kept services, and only ever ADDITIVE over what the project
   * already has: an operator who set a limit by hand outranks a value we inferred
   * from the box. Values arrive pre-validated (`sanitizeProxySettings` inside the
   * parser) and are re-validated on write; anything unrepresentable was already
   * dropped and stays visible in the drift view instead.
   *
   * Best-effort — a tunable never fails a migration.
   */
  private async adoptSourceProxySettings(
    projectId: string,
    chosen: Array<{ existingRoute?: Array<{ proxy?: ProxySettings }> }>,
    log: (m: string) => void,
  ): Promise<void> {
    const merged: Record<string, unknown> = {};
    for (const s of chosen) {
      for (const r of s.existingRoute ?? []) {
        for (const [k, v] of Object.entries(r.proxy ?? {})) {
          if (!(k in merged)) merged[k] = v;
        }
      }
    }
    const adopted = sanitizeProxySettings(merged);
    if (!adopted) return;

    const project = await repos.project.findById(projectId).catch(() => null);
    if (!project) return;
    const routingConfig = (project.routingConfig ?? {}) as Record<string, unknown>;
    const existing = (routingConfig.proxy ?? {}) as Record<string, unknown>;
    // The project's own values win key-by-key; we only fill what it hasn't set.
    const next = { ...adopted, ...existing };
    const added = Object.keys(adopted).filter((k) => !(k in existing));
    if (added.length === 0) return;

    await repos.project.update(projectId, {
      routingConfig: { ...routingConfig, proxy: next },
    } as never);
    log(`adopted proxy tunables from the source proxy: ${added.join(", ")}`);
  }

  private async carrySourceCerts(
    sourceServerId: string,
    targetServerId: string,
    organizationId: string,
    chosen: Array<{
      existingRoute?: Array<{ domains: string[]; ssl: { enabled?: boolean } }>;
    }>,
    /**
     * The project being MOVED, when there is one.
     *
     * Without this the carry did nothing for a project move, and the symptom looked like a
     * different bug entirely: every migrated domain re-issued through ACME on the target and
     * failed while DNS still pointed at the source, so a working stack arrived with no HTTPS
     * and three pages of certbot output.
     *
     * The reason is where the domains come from. `chosen[].existingRoute` is populated by the
     * FOREIGN-proxy scan — it reads another box's nginx/caddy/traefik config and indexes it by
     * published host port. That is the right source when adopting a stranger's stack, and the
     * wrong one for a project we already own: our domains live in our own `domain` table and
     * our containers publish on loopback ports, so the scan contributes nothing and the set
     * came out empty. Same certs, sitting on the source, never looked at.
     */
    projectId?: string,
  ): Promise<void> {
    // Every TLS-served domain among the kept services. The cert MATERIAL comes from
    // the source proxy's own reader, not from cert paths on the discovered route:
    // caddy and traefik declare no paths (their certs live in a data dir and in
    // acme.json), so a path-driven carry silently moved nothing from those boxes and
    // every migrated domain re-issued through ACME on the target.
    const domains = new Set<string>();
    // The project's OWN hostnames first — the authoritative set for a move (see `projectId`).
    // Every hostname is offered, not a pre-filtered "valid" subset: `certCandidateFor` below
    // already checks that a cert covers the domain and hasn't expired, and skips with a reason
    // when it doesn't. Filtering here on our own `sslStatus` would add a second, staler opinion
    // about validity — and a domain we wrongly skipped would silently re-issue instead.
    if (projectId) {
      for (const row of await repos.domain.listByProject(projectId).catch(() => [])) {
        if (row.hostname) domains.add(row.hostname.toLowerCase());
      }
    }
    for (const s of chosen) {
      for (const r of s.existingRoute ?? []) {
        if (r.ssl?.enabled === false) continue;
        for (const domain of r.domains) {
          // Hostname-only guard — the domain becomes a filesystem path segment.
          if (!/^[a-z0-9.-]+$/i.test(domain) || domain.includes("..")) continue;
          domains.add(domain);
        }
      }
    }
    if (domains.size === 0) return;

    const source = await createServerCommandExecutor(sourceServerId, organizationId);
    const target = await createServerCommandExecutor(targetServerId, organizationId);
    const proxy = await edgeProxy(source.executor).catch(() => null);
    if (!proxy) return;

    for (const domain of domains) {
      try {
        // certFor validates that the cert covers THIS domain and hasn't expired
        // before we plant it at the target's certbot path. That gate matters here
        // more than anywhere: whatever lands at that path is what the target's
        // `verifyExistingCert` will later accept as this domain's cert, so an
        // unchecked carry writes a mismatched cert straight into the trusted spot.
        const candidate = await proxy.certCandidateFor(domain);
        if (!candidate.cert) {
          console.log(`[migration] no cert carried for ${domain}: ${candidate.reason}`);
          continue;
        }
        // writeEdgeFile, not plain writeFile: the target may run a containerized
        // edge whose cert dir the HOST can't see, where a plain write lands
        // somewhere the edge never reads.
        const dir = `/etc/letsencrypt/live/${domain}`;
        await writeEdgeFile(target.executor, `${dir}/fullchain.pem`, candidate.cert.certPem);
        await writeEdgeFile(target.executor, `${dir}/privkey.pem`, candidate.cert.keyPem);
        console.log(
          `[migration] carried TLS cert for ${domain} → target ${dir} ` +
            `(from ${candidate.cert.source}, expires ${candidate.cert.expiresAt})`,
        );
      } catch (err) {
        console.warn(`[migration] cert carry failed for ${domain}: ${safeErrorMessage(err)}`);
      }
    }
  }

  /** Poll the target deployment until terminal. Returns the terminal row (its
   *  status/errorMessage tell the caller why it ended), or null if the verify
   *  window elapsed before it reached a terminal state. */
  private async waitForDeployment(
    deploymentId: string,
    runId?: string,
  ): Promise<Awaited<ReturnType<typeof repos.deployment.findById>> | null> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (runId) this.throwIfCancelled(runId); // a cancel during verify breaks out
      const dep = await repos.deployment.findById(deploymentId);
      if (dep && TERMINAL_DEPLOY.has(dep.status)) return dep;
      await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
    }
    return null;
  }

  /** A human reason for a non-ready terminal deploy: the deployment's own error
   *  if set, PLUS which service(s) failed and why — so "partial_failure" tells
   *  the operator the culprit inline (full logs are on the deploy's build
   *  screen, linked from the wizard). Best-effort; falls back to the status. */
  private async describeDeployFailure(
    deploymentId: string,
    dep: NonNullable<Awaited<ReturnType<typeof repos.deployment.findById>>>,
  ): Promise<string> {
    let failedSvcs = "";
    try {
      const rows = await repos.serviceDeployment.listByDeployment(deploymentId);
      // The shared classifier, not a regex over the status string. `/fail|error/` misses
      // `cancelled` — which the canonical set includes and the build-cancel paths write —
      // so a run that ended `partial_failure` because a service was CANCELLED named no
      // culprit at all and fell back to a bare status, the one thing this function exists
      // to prevent. It would also have matched an in-flight status containing "error".
      const failed = rows.filter((r) => isServiceFailureStatus(r.status));
      if (failed.length > 0) {
        failedSvcs = failed
          .map((r) => {
            const name = r.serviceName || r.serviceId;
            const err = (r.errorMessage || r.error || "").trim();
            return err ? `${name} (${err})` : name;
          })
          .join(", ");
      }
    } catch {
      /* best-effort — never let diagnostics enrichment throw */
    }
    const base = dep.errorMessage?.trim();
    if (base && failedSvcs) return `${base} — failed: ${failedSvcs}`;
    if (failedSvcs) return `${dep.status} — failed: ${failedSvcs}`;
    return base || `the deployment ended as "${dep.status}"`;
  }

  /**
   * Remove this project's vhosts from the SOURCE server's edge, after a confirmed
   * project-move cutover.
   *
   * Bound to the source by a synthetic snapshot rather than the deployment's: by now the
   * project's active deployment is the TARGET's, so `withDeploymentPlatform` would resolve
   * the wrong box and delete the vhosts that just started serving.
   *
   * Best-effort, and deliberately so — unlike the pause path, which fails loudly because
   * a failed removal means a site the operator asked to stop is still up. Here the target
   * is already serving and source cleanup has already been attempted; a leftover vhost is
   * a 502 (or an unsafe surviving copy) on the old box. Failing the cutover for route/claim
   * maintenance would strand a run whose destructive half already ran. Claims are released
   * only when every original was removed and every route removal succeeded.
   */
  private async retireSourceRoutes(
    projectId: string,
    sourceServerId: string,
    organizationId: string,
    releaseClaims: boolean,
  ): Promise<void> {
    try {
      const hostnames = (await repos.domain.listByProject(projectId)).map((d) => d.hostname);
      await withDeploymentPlatform(
        {
          meta: { deployTarget: "server", serverId: sourceServerId, runtimeMode: "docker" },
          organizationId,
        } as Parameters<typeof withDeploymentPlatform>[0],
        async ({ routing, executor, hostPortTarget }) => {
          if (!hostPortTarget || !executor) {
            throw new Error("Source server did not resolve a physical host-port target");
          }

          await retireSourceManagedRoutes({
            projectId,
            hostnames,
            routing,
            target: hostPortTarget,
            edgeProxy: edgeProxyFor(executor, "openresty", { ours: true }),
            releaseClaims,
          });
        },
      );
    } catch (err) {
      console.warn(
        `[migration] retiring source routes for project ${projectId} failed:`,
        safeErrorMessage(err),
      );
    }
  }

  /**
   * Retire the source originals. Returns the ones it could NOT remove.
   *
   * NOT atomic, and it cannot be: there is no transaction spanning two Docker daemons, and
   * by this point the target is already live and serving. What it can be is honest.
   *
   * Two rules follow from that. It keeps going after a failure — aborting on the first would
   * leave MORE behind than finishing does. And it REPORTS what survived instead of
   * swallowing it, which is the bug this replaces: every error was caught and dropped, and
   * the caller then transitioned to `succeeded` regardless. A container that failed to
   * destroy (busy, in-use, or a `restart: always` policy racing the daemon) stayed up on the
   * old server, holding its published ports, while the run told the operator the old box was
   * clean. Silent partial success on a destructive step is worse than a loud partial one.
   *
   * VOLUMES ARE DELIBERATELY LEFT. Only containers are removed. Until the operator has run
   * on the target long enough to trust it, the source volumes are the only other copy of
   * their data, and no migration should delete that on its own. Reclaiming that disk is a
   * separate, explicit act.
   */
  private async cutover(
    sourceServerId: string,
    organizationId: string,
    scannedContainerIds: Record<string, string>,
  ): Promise<{ failed: LeftBehindContainer[] }> {
    const failed: LeftBehindContainer[] = [];
    const rtA = await createServerDockerRuntime(sourceServerId, organizationId);
    try {
      for (const [name, cid] of Object.entries(scannedContainerIds)) {
        // A stop failure is not itself fatal — `destroy` force-removes a running container —
        // so only the destroy verdict decides whether this one is still there.
        await rtA.stop(cid).catch(() => {});
        try {
          await rtA.destroy(cid);
        } catch (err) {
          failed.push({ name, containerId: cid, reason: safeErrorMessage(err) });
        }
      }
    } finally {
      await rtA.dispose().catch(() => {});
    }
    return { failed };
  }

  /**
   * Cancel an in-flight migration: flag it (so the pipeline's boundary checks
   * throw) AND kill the running transfer on both boxes (a flag alone can't
   * interrupt the long `moveData` await). The killed rsync/ssh exits non-zero →
   * the pipeline's `catch → rollback` restarts the source + tears down the
   * target, ending `rolled_back` "Cancelled by user". Not valid once parked at
   * `awaiting_cutover` (use resolveCutover) or terminal.
   */
  async cancel(
    id: string,
    organizationId: string,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const run = await repos.dockerMigrationRun.findById(id);
    if (!run || run.organizationId !== organizationId) {
      return { ok: false, status: 404, error: "Migration not found" };
    }
    const CANCELLABLE = ["queued", "adopting", "moving_data", "deploying", "verifying"];
    if (!CANCELLABLE.includes(run.status)) {
      return {
        ok: false,
        status: 409,
        error: `Migration is not cancellable (status: ${run.status})`,
      };
    }
    const reg = this.cancelByRun.get(id) ?? { cancelled: false };
    reg.cancelled = true;
    this.cancelByRun.set(id, reg);
    await this.killTransfer(run.sourceServerId, run.targetServerId, run.organizationId, reg.runTag);
    return { ok: true };
  }

  /** Kill the direct-transfer's rsync/ssh by its ephemeral-key marker on BOTH
   *  boxes (the initiator carries the marked argv; the other pkill is a no-op).
   *  Best-effort — the per-server begin-guard makes the broad fallback pattern
   *  unambiguous. */
  private async killTransfer(
    sourceServerId: string | null,
    targetServerId: string | null,
    organizationId: string,
    runTag?: string,
  ): Promise<void> {
    const pattern = runTag ? `openship-migration-${runTag}` : "openship-migration-";
    const serverIds = [...new Set([sourceServerId, targetServerId].filter(Boolean))] as string[];
    await Promise.all(
      serverIds.map(async (sid) => {
        try {
          const { executor } = await createServerCommandExecutor(sid, organizationId);
          await executor.exec(`pkill -f ${sq(pattern)} 2>/dev/null || true`).catch(() => {});
        } catch {
          /* best-effort — the boundary flag-check still rolls the run back */
        }
      }),
    );
  }

  /** Confirm the destructive cutover (or finish keeping the originals stopped).
   *  A failed destructive attempt remains `cutover` and may retry only the same
   *  irreversible choice. Timing-safe token compare on every attempt. */
  async resolveCutover(
    id: string,
    organizationId: string,
    confirmationToken: string,
    kill: boolean,
  ): Promise<
    { ok: true; leftBehind: LeftBehindContainer[] } | { ok: false; status: number; error: string }
  > {
    const run = await repos.dockerMigrationRun.findById(id);
    if (!run || run.organizationId !== organizationId) {
      return { ok: false, status: 404, error: "Migration not found" };
    }
    if (run.status !== "awaiting_cutover" && run.status !== "cutover") {
      return {
        ok: false,
        status: 409,
        error: `Migration is not awaiting or retrying cutover (status: ${run.status})`,
      };
    }
    if (run.status === "cutover" && !kill) {
      return {
        ok: false,
        status: 409,
        error: "Source removal already started; retry with kill=true to finish cutover",
      };
    }
    const expected = Buffer.from(run.confirmationToken ?? "");
    const supplied = Buffer.from(confirmationToken ?? "");
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      return { ok: false, status: 403, error: "Invalid confirmation token" };
    }

    // The HTTP precheck above protects the token; the DB claim below owns the
    // state transition and project-deletion admission atomically. Keeping the
    // status parked for a non-destructive "keep" is intentional: boot recovery
    // must never infer that source destruction was requested.
    const claimed = await repos.dockerMigrationRun.claimExecution({
      id,
      organizationId,
      from: run.status,
      to: kill ? "cutover" : "awaiting_cutover",
    });
    if (!claimed) {
      return {
        ok: false,
        status: 409,
        error: "Migration state changed or one of its projects is being deleted",
      };
    }

    try {
      const leftBehind: LeftBehindContainer[] = [];
      if (kill && claimed.sourceServerId) {
        const { failed } = await this.cutover(
          claimed.sourceServerId,
          organizationId,
          (claimed.scannedContainerIds ?? {}) as Record<string, string>,
        );
        leftBehind.push(...failed);
        const remainder = describeCutoverRemainder(failed);
        if (remainder) this.appendLog(id, `cutover: ${remainder}`);
        // A project move also has to leave the OLD EDGE. Door A never needs this: an
        // adopted stack sat behind the operator's own proxy, which the migration
        // deliberately never touches. Ours was served by Openship's edge on the source,
        // and destroying a container does not remove the vhost pointing at it.
        if (claimed.mode === "project_move" && claimed.projectId) {
          await this.retireSourceRoutes(
            claimed.projectId,
            claimed.sourceServerId,
            organizationId,
            failed.length === 0,
          );
        }
      } else if (
        !kill &&
        claimed.sourceServerId &&
        claimed.sourceServerId !== claimed.targetServerId &&
        // A project move's originals must stay stopped; restarting them would
        // make one project's writable data live on two servers.
        claimed.mode !== "project_move"
      ) {
        await this.restartSourceOriginals(
          claimed.sourceServerId,
          organizationId,
          (claimed.scannedContainerIds ?? {}) as Record<string, string>,
        );
      }
      await this.transition(id, "succeeded");
      // Reported, not swallowed: the caller shows any source containers that
      // could not be retired. Empty is the normal fully-clean result.
      return { ok: true, leftBehind };
    } catch (err) {
      // Destructive intent is irreversible: some originals/routes may already
      // be gone. Keep `cutover`, record why it parked, and allow only kill=true
      // to claim a later idempotent retry.
      await this.transition(id, "cutover", {
        errorMessage: `Cutover incomplete — retry source cleanup: ${safeErrorMessage(err)}`.slice(
          0,
          4096,
        ),
      }).catch(() => {});
      throw err;
    } finally {
      await repos.dockerMigrationRun.acknowledgeExecutionFinished(id);
    }
  }

  /**
   * Resume a `partial` run: re-transfer the pending paths (with per-item source
   * overrides), skip the ones the user chose to drop, restart the services whose
   * data changed, and — if nothing remains pending — finish the migration the
   * normal way (cutover / awaiting_cutover). Fire-and-forget like `begin`; the
   * status flips out of `partial` synchronously so a double-resume 409s.
   */
  async resume(
    ctx: RequestContext,
    id: string,
    organizationId: string,
    opts: { overrides?: Record<string, string>; skip?: string[] },
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const run = await repos.dockerMigrationRun.findById(id);
    if (!run || run.organizationId !== organizationId) {
      return { ok: false, status: 404, error: "Migration not found" };
    }
    if (run.status !== "partial") {
      return {
        ok: false,
        status: 409,
        error: `Migration is not resumable (status: ${run.status})`,
      };
    }
    if (!run.sourceServerId || !run.targetServerId) {
      return { ok: false, status: 409, error: "Source/target server is no longer available" };
    }
    const claimed = await repos.dockerMigrationRun.claimExecution({
      id,
      organizationId,
      from: "partial",
      to: "moving_data",
    });
    if (!claimed) {
      return {
        ok: false,
        status: 409,
        error: "Migration state changed or one of its projects is being deleted",
      };
    }

    // The durable claim above, not process-local scheduling, guards duplicate
    // deliveries across API replicas and survives a crash between this response
    // and the callback starting.
    setImmediate(() => {
      void (async () => {
        try {
          await this.runResume(ctx, claimed, organizationId, opts);
        } catch (err) {
          console.error(`[migration] resume ${id} crashed:`, safeErrorMessage(err));
        } finally {
          await repos.dockerMigrationRun.acknowledgeExecutionFinished(id);
        }
      })();
    });
    return { ok: true };
  }

  /**
   * Remove the volumes this run copied to the TARGET. Only for a failed/rolled-
   * back run (its target draft is already torn down, so the copies are orphaned)
   * — never for a succeeded run (those volumes are the live data). Lets the user
   * clear stale copies so a retry doesn't hit "target already has data". The
   * SOURCE is untouched. Best-effort per volume.
   */
  async cleanupTargetData(
    id: string,
    organizationId: string,
  ): Promise<{ ok: true; removed: number } | { ok: false; status: number; error: string }> {
    const run = await repos.dockerMigrationRun.findById(id);
    if (!run || run.organizationId !== organizationId) {
      return { ok: false, status: 404, error: "Migration not found" };
    }
    if (run.status !== "failed" && run.status !== "rolled_back") {
      return { ok: false, status: 409, error: "Target cleanup is only for a failed migration." };
    }
    if (!run.targetServerId) {
      return { ok: false, status: 409, error: "Target server is no longer available." };
    }
    const removed = await this.removeTargetVolumes(
      run.targetServerId,
      organizationId,
      (run.targetVolumes ?? []) as string[],
    );
    await repos.dockerMigrationRun.updateTargetVolumes(id, []).catch(() => {});
    return { ok: true, removed };
  }

  /**
   * Remove volumes THIS RUN wrote on the target. Never touches the source.
   *
   * Shared by the manual "remove target data" action and by rollback, which is the one that
   * matters: a rolled-back move used to leave its half-written target volumes behind, and the
   * volume-conflict guard then refused every retry ("target already has data") — so the operator
   * was stuck in a loop that only manual `docker volume rm` on the box could break. Restoring
   * the source but leaving debris on the target is not a rollback.
   *
   * Safe because of what is (and isn't) in the list: a `keep` volume was never transferred and
   * is never recorded, so the target's own pre-existing data is never in scope. A volume the
   * operator chose to `override` is in scope, and removing it loses nothing the override had not
   * already destroyed — a half-overwritten volume left behind is strictly worse, because it
   * looks like data.
   */
  private async removeTargetVolumes(
    targetServerId: string,
    organizationId: string,
    vols: string[],
  ): Promise<number> {
    if (vols.length === 0) return 0;
    const { executor } = await createServerCommandExecutor(targetServerId, organizationId);
    let removed = 0;
    for (const v of vols) {
      // -f so an anonymous/unused volume goes even if dangling; `|| true` keeps
      // one stubborn volume (e.g. still referenced) from failing the whole sweep.
      await executor.exec(`docker volume rm -f ${sq(v)} 2>&1 || true`).catch(() => {});
      removed++;
    }
    return removed;
  }

  private async runResume(
    ctx: RequestContext,
    run: Awaited<ReturnType<typeof repos.dockerMigrationRun.findById>> & object,
    organizationId: string,
    opts: { overrides?: Record<string, string>; skip?: string[] },
  ): Promise<void> {
    const id = run.id;
    const log = (m: string) => this.appendLog(id, m);
    const pending = (run.pendingItems ?? []) as PendingItem[];
    const skipSet = new Set(opts.skip ?? []);
    const overrides = opts.overrides ?? {};
    const toRetry = pending.filter((p) => !skipSet.has(p.key));
    const stillPending: PendingItem[] = [];
    const resolvedServices = new Set<string>();
    try {
      log(
        `resume: retrying ${toRetry.length}, skipping ${pending.length - toRetry.length} item(s)`,
      );
      const [source, target] = await Promise.all([
        createServerCommandExecutor(run.sourceServerId!, organizationId),
        createServerCommandExecutor(run.targetServerId!, organizationId),
      ]);
      const runTag = crypto.randomBytes(6).toString("hex");
      const link = await establishDirectLink({
        sourceExec: source.executor,
        targetExec: target.executor,
        sourceConn: source.conn,
        targetConn: target.conn,
        runId: runTag,
        log,
      });
      if (!link) {
        throw new Error(
          "Neither server can open a direct SSH connection to the other — cannot resume the transfer.",
        );
      }
      try {
        for (const item of toRetry) {
          const plan = planResumeTransfer(item, overrides);
          const src = plan.source;
          try {
            if (plan.kind === "volume") {
              await link.transferVolume(plan.source, () => {});
            } else if (plan.kind === "bind") {
              if (plan.asPath) await link.transferPath(plan.source, plan.dest, () => {});
              else await link.transferBind(plan.source, () => {});
            } else {
              await link.transferPath(plan.source, plan.dest, () => {});
            }
            if (item.serviceName) resolvedServices.add(item.serviceName);
            log(`resolved ${item.key}`);
          } catch (err) {
            const missing = err instanceof PathMissingError;
            stillPending.push({
              ...item,
              source: src,
              reason: missing ? "missing" : "error",
              message: safeErrorMessage(err),
            });
            log(`still pending ${item.key}: ${safeErrorMessage(err)}`);
          }
        }
      } finally {
        await link.cleanup();
      }

      // Restart the services whose data changed so they re-read it.
      if (resolvedServices.size > 0 && run.projectId) {
        const rows = await repos.service.listByProject(run.projectId);
        for (const name of resolvedServices) {
          const row = rows.find((r) => r.name === name);
          if (row) {
            await restartServiceContainer(ctx, run.projectId, row.id).catch((err) =>
              log(`restart ${name} failed: ${safeErrorMessage(err)}`),
            );
          }
        }
      }

      if (stillPending.length > 0) {
        await this.transition(id, "partial", { pendingItems: stillPending });
        log(`resume incomplete — ${stillPending.length} path(s) still pending`);
      } else {
        await repos.dockerMigrationRun.updatePending(id, []);
        const scanned = (run.scannedContainerIds ?? {}) as Record<string, string>;
        if (run.killOriginals && run.sourceServerId) {
          await this.transition(id, "cutover");
          await this.cutover(run.sourceServerId, organizationId, scanned);
          await this.transition(id, "succeeded");
          log(`resume complete — all paths moved; cutover done`);
        } else {
          await this.transition(id, "awaiting_cutover");
          log(`resume complete — all paths moved; awaiting cutover confirmation`);
        }
      }
    } catch (err) {
      // Resume couldn't run (no link, etc): leave it PARTIAL (target stays up —
      // never roll back a partial). Restore the pending list so the user retries.
      await this.transition(id, "partial", {
        pendingItems: stillPending.length > 0 ? stillPending : pending,
      }).catch(() => {});
      log(`resume failed: ${safeErrorMessage(err)}`);
    } finally {
      await this.flushLogs(id);
      this.logsByRun.delete(id);
      this.logFlushAt.delete(id);
    }
  }

  /**
   * Tear down whatever landed on the target, then restart the originals on the
   * source. Shared by the live rollback path and boot recovery. Never destroys
   * the source's volumes/data.
   *
   * Same-server is INCLUDED (the previous `!sameServer` gate was the bug): a
   * partial same-server deploy holds the reused ports/volumes in place, so its
   * containers MUST be removed before the originals can start — otherwise the
   * restart fails on a port/mount clash and both stacks stay down. Teardown
   * happens before restart for exactly this reason.
   */
  private async teardownTargetAndRestoreSource(
    ctx: { sourceServerId: string; targetServerId: string; organizationId: string },
    scannedContainerIds: Record<string, string>,
    deploymentId: string | undefined,
  ): Promise<void> {
    if (deploymentId) {
      try {
        const rtB = await createServerDockerRuntime(ctx.targetServerId, ctx.organizationId);
        try {
          const containers = await rtB.listDeploymentContainers(deploymentId);
          for (const c of containers) {
            await rtB.destroy(c.containerId).catch(() => {});
          }
        } finally {
          await rtB.dispose().catch(() => {});
        }
      } catch (err) {
        console.warn(`[migration] target teardown failed:`, safeErrorMessage(err));
      }
    }
    await this.restartSourceOriginals(ctx.sourceServerId, ctx.organizationId, scannedContainerIds);
  }

  /**
   * Start the (quiesced) source originals back up by their scanned container ids.
   * `moveData` stops them for a consistent volume copy; this restores them.
   * Shared by the rollback/boot-recovery restore and the keep-source cutover
   * decision. Best-effort per container; never throws.
   */
  private async restartSourceOriginals(
    sourceServerId: string,
    organizationId: string,
    scannedContainerIds: Record<string, string>,
  ): Promise<void> {
    try {
      const rtA = await createServerDockerRuntime(sourceServerId, organizationId);
      try {
        for (const cid of Object.values(scannedContainerIds)) {
          await rtA.start(cid).catch(() => {});
        }
      } finally {
        await rtA.dispose().catch(() => {});
      }
    } catch (err) {
      console.warn(`[migration] source restore failed:`, safeErrorMessage(err));
    }
  }

  private async rollback(
    ctx: RequestContext,
    id: string,
    servers: { sourceServerId: string; targetServerId: string },
    scannedContainerIds: Record<string, string>,
    deploymentId: string | undefined,
    createdProjectId: string | undefined,
    errorMessage: string,
  ): Promise<void> {
    // Restore the user's production stack FIRST — it's the priority; the draft
    // cleanup below is secondary bookkeeping.
    await this.teardownTargetAndRestoreSource(
      {
        sourceServerId: servers.sourceServerId,
        targetServerId: servers.targetServerId,
        organizationId: ctx.organizationId,
      },
      scannedContainerIds,
      deploymentId,
    );

    // Undo what the run did to the TARGET and to the project's own record. Shared with boot
    // recovery, which used to skip both — see `undoTargetSideEffects`.
    await this.undoTargetSideEffects(
      await repos.dockerMigrationRun.findById(id).catch(() => null),
      servers,
      ctx.organizationId,
      (m) => this.appendLog(id, m),
    );

    await this.transition(id, "rolled_back", {
      errorMessage: errorMessage.slice(0, 4096),
    });

    // A failed migration must not leave the draft project it created behind.
    // Only projects THIS run created are dropped (never a pre-existing one the
    // user already had). This MUST run after the migration is terminal: project
    // teardown now correctly treats this run as active work, so invoking it
    // while this sole worker is still `adopting`/`deploying` would ask the run to
    // cancel itself and then deadlock waiting for its own terminal transition.
    //
    // All source/target migration effects are already undone above. The final
    // draft cleanup is protected by the draft project's own deletion lock, and
    // a cleanup hiccup must never mask the real migration error.
    if (createdProjectId) {
      try {
        await teardownProject(ctx, createdProjectId, {
          force: true,
          wipeVolumes: false,
          forceOrphan: true,
        });
      } catch (err) {
        console.warn(
          `[migration] draft project cleanup failed for ${createdProjectId}:`,
          safeErrorMessage(err),
        );
      }
    }
  }

  /**
   * Undo the two things a failed run leaves on the TARGET side: the volumes it wrote there, and a
   * project record that has been re-pointed at a server it is no longer running on.
   *
   * Shared because boot recovery did neither. It tore the target down and restarted the source —
   * then left `project.serverId` naming the box it had just emptied, so every live-state read, the
   * Access URL and the next deploy went to a server with nothing on it while the containers
   * actually serving traffic sat on the source, unmanaged. Plus the transferred volumes, which
   * then blocked the next attempt. A crash is exactly when nobody is watching, so it is the worst
   * path to leave un-restored.
   *
   * `project.serverId` is re-pointed at the target by the DEPLOY (deployment-lifecycle persists it
   * on every successful server deploy, so a later redeploy stays on its server). That happens
   * before the operator confirms anything, which is why undoing it is part of failing — not
   * bookkeeping.
   *
   * MOVE only for the binding: a duplicate's project genuinely lives on the target, so there is
   * nothing to put back. Volumes are removed for both.
   *
   * Best-effort throughout, and deliberately so: the source is already back up by the time this
   * runs, and a cleanup hiccup must not mask the failure that caused it.
   */
  private async undoTargetSideEffects(
    run: Awaited<ReturnType<typeof repos.dockerMigrationRun.findById>> | null,
    servers: { sourceServerId: string; targetServerId?: string | null },
    organizationId: string,
    log: (message: string) => void,
  ): Promise<void> {
    if (!run) return;

    const wrote = (run.targetVolumes ?? []) as string[];
    if (wrote.length > 0 && servers.targetServerId) {
      try {
        const removed = await this.removeTargetVolumes(
          servers.targetServerId,
          organizationId,
          wrote,
        );
        log(`removed ${removed} volume(s) written on the target`);
        await repos.dockerMigrationRun.updateTargetVolumes(run.id, []).catch(() => {});
      } catch (err) {
        console.warn(`[migration] ${run.id}: target volume cleanup failed:`, safeErrorMessage(err));
        log(
          `could not remove the volumes written on the target (${wrote.join(", ")}) — ` +
            `remove them there before retrying`,
        );
      }
    }

    if (run.mode === "project_move" && run.projectId && servers.sourceServerId) {
      await repos.project
        .update(run.projectId, { serverId: servers.sourceServerId })
        .catch((err) =>
          console.warn(
            `[migration] ${run.id}: restoring the server binding to ${servers.sourceServerId} failed:`,
            safeErrorMessage(err),
          ),
        );
    }
  }

  /**
   * Boot recovery. A process restart mid-migration leaves the in-memory pipeline
   * dead with the source containers STOPPED (moveData quiesces them before the
   * deploy) — so a crash would strand a stopped production stack forever. For
   * every run stuck in a destructive in-flight phase, restart the originals and
   * mark it rolled_back.
   *
   *   - `awaiting_cutover` is a parked SUCCESS (resolveCutover is DB-driven and
   *     survives a restart) → leave it untouched.
   *   - `queued` never stopped anything → just mark it rolled_back, no restart.
   */
  async recoverInterruptedMigrations(): Promise<void> {
    let runs: Awaited<ReturnType<typeof repos.dockerMigrationRun.listInFlight>>;
    try {
      runs = await repos.dockerMigrationRun.listInFlight();
    } catch (err) {
      console.warn(`[migration] recovery scan failed:`, safeErrorMessage(err));
      return;
    }
    for (const run of runs) {
      const hasLiveExecution = Boolean(run.executionStartedAt && !run.executionFinishedAt);

      // listInFlight deliberately includes terminal-looking rows whose callback
      // had not acknowledged exit. On a self-hosted boot the prior process is
      // gone, so closing that orphaned lease is safe; Cloud never runs this
      // process-local recovery sweep.
      if (["succeeded", "failed", "rolled_back"].includes(run.status)) {
        if (hasLiveExecution) {
          await repos.dockerMigrationRun.acknowledgeExecutionFinished(run.id).catch(() => {});
        }
        continue;
      }

      // Parked states survive a restart untouched: the target is UP and the run
      // waits on an interactive resolve (cutover confirm / pending-path resume).
      // A keep/cutover callback can crash after claiming but before doing work;
      // process restart proves that callback is gone, so release only its lease.
      if (run.status === "awaiting_cutover" || run.status === "partial") {
        if (hasLiveExecution) {
          await repos.dockerMigrationRun.acknowledgeExecutionFinished(run.id).catch(() => {});
        }
        continue;
      }

      // `claimExecution(partial → moving_data)` marks resumed work. Unlike an
      // initial migration failure, a resume must never tear down the already-live
      // target. Put it back in its parked state; an empty pending list is valid
      // and the next resume advances it to cutover without copying anything.
      if (run.status === "moving_data" && hasLiveExecution) {
        try {
          await repos.dockerMigrationRun.transition(run.id, "partial", {
            errorMessage: "Resume was interrupted — review pending paths and retry.",
          });
          await repos.dockerMigrationRun.acknowledgeExecutionFinished(run.id);
        } catch (err) {
          console.warn(`[migration] recovery resume ${run.id} failed:`, safeErrorMessage(err));
        }
        continue;
      }
      const scanned = (run.scannedContainerIds ?? {}) as Record<string, string>;

      // A crash mid-CUTOVER is NOT a rollback: the target was already verified
      // healthy and the operator opted to destroy the source, so tearing the
      // target down + trying to restart already-destroyed originals would leave
      // BOTH sides down and invert a succeeded migration. Instead finish the
      // (idempotent) cutover — destroying an already-gone container is a no-op —
      // and mark it succeeded.
      if (run.status === "cutover") {
        try {
          let sourceFullyRetired = false;
          if (run.sourceServerId) {
            const { failed } = await this.cutover(run.sourceServerId, run.organizationId, scanned);
            sourceFullyRetired = failed.length === 0;

            // A crash can land after source destruction but before route/claim
            // retirement. Replay that half idempotently. If cleanup was partial or
            // unreachable, remove stale routes but retain claims for survivors.
            if (run.mode === "project_move" && run.projectId) {
              await this.retireSourceRoutes(
                run.projectId,
                run.sourceServerId,
                run.organizationId,
                sourceFullyRetired,
              );
            }
          }
          await repos.dockerMigrationRun.transition(run.id, "succeeded");
        } catch (err) {
          const message = safeErrorMessage(err);
          console.warn(`[migration] recovery cutover ${run.id} failed:`, message);
          await repos.dockerMigrationRun
            .transition(run.id, "cutover", {
              errorMessage: `Cutover recovery incomplete — retry source cleanup: ${message}`.slice(
                0,
                4096,
              ),
            })
            .catch(() => {});
        }
        if (hasLiveExecution) {
          await repos.dockerMigrationRun.acknowledgeExecutionFinished(run.id).catch(() => {});
        }
        continue;
      }

      if (run.status !== "queued" && run.sourceServerId) {
        await this.teardownTargetAndRestoreSource(
          {
            sourceServerId: run.sourceServerId,
            targetServerId: run.targetServerId ?? run.sourceServerId,
            organizationId: run.organizationId,
          },
          scanned,
          run.deploymentId ?? undefined,
        );
        // The SAME undo the live rollback performs. Recovery used to stop at the line above —
        // target torn down, source restarted — and leave the project bound to the server it had
        // just emptied, with the transferred volumes still on it. A crash is precisely when
        // nobody is watching, so an un-restored binding would sit there silently sending every
        // read and the next deploy to an empty box.
        await this.undoTargetSideEffects(
          run,
          { sourceServerId: run.sourceServerId, targetServerId: run.targetServerId },
          run.organizationId,
          (m) => this.appendLog(run.id, m),
        );
      }
      await repos.dockerMigrationRun
        .transition(run.id, "rolled_back", {
          errorMessage: "Recovered after an interruption — the original containers were restarted.",
        })
        .catch((err) =>
          console.warn(`[migration] recovery transition ${run.id} failed:`, safeErrorMessage(err)),
        );
      if (hasLiveExecution) {
        await repos.dockerMigrationRun.acknowledgeExecutionFinished(run.id).catch(() => {});
      }
    }
  }
}

export const migrationOrchestrator = new MigrationOrchestratorImpl();
