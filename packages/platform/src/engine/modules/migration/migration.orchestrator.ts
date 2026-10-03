/**
 * MigrationOrchestrator — drives a full Docker migration:
 *
 *   adopt  → create the Openship `services` project from the selected stack
 *   moving_data → quiesce (stop) the originals on the source; copy volumes and
 *                 app-data bind mounts through the shared transfer adapters.
 *                 The storage plan maps source paths to project-owned target data.
 *   deploying → deploy the adopted project on the target server
 *   verifying → wait for the target deployment to reach `ready`
 *   awaiting_cutover → success; wait for the user to confirm the destructive
 *                 teardown of the originals — OR keep, which (cross-server)
 *                 restarts the quiesced originals for an external import.
 *                 Same-server imports and managed project moves keep them stopped.
 *   cutover → stop + remove the originals on the source (by scanned container
 *             id — they carry no openship.* labels). Never removes A volumes.
 *   rolled_back → any pre-cutover failure: tear down the target deployment and
 *                 restart the originals on the source. Never destroys A.
 *
 * A dedicated FSM (not the backup/restore orchestrators) because the source has
 * no Openship deployment to resolve an executor from, the target is
 * container-less pre-deploy, and we require no configured backup destination.
 */

import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import crypto from "node:crypto";
import { repos } from "@repo/db";
import { isServiceFailureStatus, safeErrorMessage, sanitizeProxySettings } from "@repo/core";
// The SHARED bounded-concurrency limiter. This module grew a private copy (`runPool`)
// of the very thing lib/map-with-limit.ts exists to prevent — and it was the copy
// driving the SSH-saturating volume transfer.
import { mapWithLimit } from "../../lib/map-with-limit";
import { retryProjectRouting, syncProjectManagedEdge } from "../projects/project-runtime.service";
import {
  resolveExecutor,
  transferImage,
  scopedVolumeName,
  ensureCloudProjectVolume,
  readEdgeFile,
  writeEdgeFile,
  edgeProxy,
  edgeProxyFor,
  type EdgeProxyApi,
  type Platform,
  type TransferMode,
  type TransferCompression,
} from "@repo/adapters";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import {
  withDeploymentPlatform,
} from "../../lib/deployment-runtime";
import { createMigrationDockerRuntime as createServerDockerRuntime, withMigrationExecution, openMigrationTransferEndpoints, withMigrationActivity, setMigrationContainerState } from "./migration-runtime";
import { migrationTargetPath, scopeImportedStorage } from "./migration-storage";
import { planMigrationData, prepareMigrationVolumes, resolveMigrationDataItem, transferMigrationItem, migrationUsesDirectLink } from "./migration-data";
import { assertMigrationEndpoints } from "./migration-access";
import { createProvisionLock, tryWithProvisionLock } from "../../lib/provision-lock";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { assertManagedServerCanWork } from "../../lib/cloud-workspace-access";
import { ensureCloudWorkspaceHost } from "../../lib/cloud-docker-workspace";
import { withCloudWorkspaceActivity } from "../../lib/cloud-workspace-lock";
import { captureExecutionAuthority, resolveExecutionAuthority } from "../../lib/execution-authority";
import { establishDirectLink, cleanupDirectTrust, stopDirectTransfer, PathMissingError, sq } from "./direct-transfer";
import type { MigrationServiceRoutes } from "./migration-input";
import { remapMigrationRoutes, saveMigrationRoutes } from "./migration-routes";
import { PromptRegistry, type PromptPayload } from "../../lib/prompt-gateway";
import { prepareServerEdge, applyProjectEdgeRoutes } from "../domains/project-edge.service";
import { sizeOfMoveSet } from "./migration-size";
import { requestBuildAccess, cancelBuildSession } from "../deployments/build.service";
import { describeLiveState, resolveLiveServiceState } from "../services/live-state";
import { linkProjectRepo } from "../projects/project-crud.service";
import type { ProxySettings } from "@repo/core";
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
  /** Container ID (legacy: service name) → reviewed routes. Ownership is saved
   *  before takeover; live routes are reconciled after attachment/deployment.
   *  `targetPath` selects a path of a shared hostname. */
  routesByServiceName?: MigrationServiceRoutes;
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
  | { kind: "volume"; source: string; dest?: string }
  | { kind: "bind"; asPath: true; source: string; dest: string }
  | { kind: "bind"; asPath: false; source: string }
  | { kind: "path"; source: string; dest: string };

export function planResumeTransfer(
  item: PendingItem,
  overrides: Record<string, string>,
): ResumeTransferPlan {
  const source = overrides[item.key] ?? item.source;
  if (item.kind === "volume") return { kind: "volume", source, ...(item.dest ? { dest: item.dest } : {}) };
  if (item.kind === "bind") {
    // An override reads from a NEW source path but still writes to the
    // ORIGINAL bind path (where the target container mounts it).
    return source !== item.source || (item.dest && item.dest !== item.source)
      ? { kind: "bind", asPath: true, source, dest: item.dest ?? item.source }
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
  private readonly cancelByRun = new Map<string, { cancelled: boolean; runTag?: string; abort?: AbortController }>();

  /** Durable per-run session log. run()'s log() closure appends here; a throttled
   *  flush mirrors it to the run row's `logs` column so a reloaded or failed run
   *  keeps its history (the in-memory buffer alone dies with the client reload).
   *  Kept until run()'s finally flushes-and-clears — NOT cleared by transition. */
  private readonly logsByRun = new Map<string, string[]>();
  private readonly logFlushAt = new Map<string, number>();
  private readonly prompts = new PromptRegistry();
  private readonly pendingPrompts = new Map<string, PromptPayload>();

  getPendingPrompt(id: string): PromptPayload | null {
    return this.pendingPrompts.get(id) ?? null;
  }

  private async promptUser(id: string, prompt: PromptPayload): Promise<string> {
    await this.throwIfCancelled(id);
    const pending = { ...prompt, promptId: crypto.randomUUID(), expiresAt: this.prompts.deadlineFromNow() };
    const answer = this.prompts.wait(id);
    this.pendingPrompts.set(id, pending);
    migrationRunBus.publish(id, { type: "prompt", prompt: pending });
    try {
      return await answer;
    } finally {
      this.pendingPrompts.delete(id);
      migrationRunBus.publish(id, { type: "prompt", prompt: null });
    }
  }

  async respondToPrompt(id: string, organizationId: string, promptId: string, action: string): Promise<boolean> {
    const run = await repos.dockerMigrationRun.findById(id);
    if (!run || run.organizationId !== organizationId) return false;
    const prompt = this.pendingPrompts.get(id);
    if (!prompt || prompt.promptId !== promptId || !prompt.actions.some((choice) => choice.id === action)) return false;
    return this.prompts.respond(id, action);
  }

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
  private async throwIfCancelled(id: string | undefined): Promise<void> {
    if (id && (this.cancelByRun.get(id)?.cancelled || (await repos.dockerMigrationRun.findById(id))?.recovery?.cancelRequested)) {
      throw new Error("Cancelled by user");
    }
  }

  private async runWorker<T>(id: string, work: () => Promise<T>, ctx?: RequestContext): Promise<T> {
    return createProvisionLock(`migration:run:${id}`).run(async () => {
      const current = await repos.dockerMigrationRun.findById(id);
      if (!current || current.executionFinishedAt || ["succeeded", "failed", "rolled_back"].includes(current.status))
        throw new Error("Migration execution already finished or was recovered");
      const reg = this.cancelByRun.get(id) ?? { cancelled: false };
      reg.abort = new AbortController();
      this.cancelByRun.set(id, reg);
      let checking = false;
      const poll = setInterval(() => {
        if (checking) return;
        checking = true;
        void repos.dockerMigrationRun.findById(id).then(run => {
          if (run?.recovery?.cancelRequested) { reg.cancelled = true; reg.abort?.abort(new Error("Cancelled by user")); }
        }).catch(() => {}).finally(() => { checking = false; });
      }, 1000);
      poll.unref?.();
      try { return await work(); }
      finally {
        clearInterval(poll);
        try {
          await repos.dockerMigrationRun.acknowledgeExecutionFinished(id);
          const ended = await repos.dockerMigrationRun.findById(id);
          // Teardown waits for migration workers. Acknowledge our final remote
          // operation before deleting a draft, otherwise we wait for ourselves.
          if (ctx && ended?.status === "rolled_back" && ended.recovery.createdProjectId) {
            try { await this.cleanupDraft(ctx, ended); }
            catch (error) {
              const message = `Draft cleanup will retry: ${safeErrorMessage(error)}`;
              console.warn(`[migration] ${id}: ${message}`);
              await repos.dockerMigrationRun.transition(id, "rolled_back", {
                errorMessage: [ended.errorMessage, message].filter(Boolean).join("\n").slice(0, 4096),
              });
            }
          }
        } finally {
          this.cancelByRun.delete(id);
          this.progressByRun.delete(id);
        }
      }
    });
  }

  private async cleanupDraft(ctx: RequestContext, run: NonNullable<Awaited<ReturnType<typeof repos.dockerMigrationRun.findById>>>) {
    if (!run.recovery.createdProjectId || run.projectId !== run.recovery.createdProjectId) return;
    await teardownProject(ctx, run.recovery.createdProjectId, { force: true, wipeVolumes: false, recordOnly: true });
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
    // Same organization-scoped admission as source removal, with a database
    // advisory lock across API replicas.
    return withServerInventoryLock(input.organizationId, async () => {
      const { target } = await assertMigrationEndpoints(input.organizationId, input.sourceServerId, input.targetServerId);
      if (target.workspaceId) await assertManagedServerCanWork(input.organizationId, target.workspaceId);
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
        executionStartedAt: new Date(),
        recovery: { worker: "initial", sourceRunningContainerIds: {}, authority: await captureExecutionAuthority(ctx) },
      });
      if (!run) {
        throw new Error(
          "The project is being deleted, so this migration can no longer be started.",
        );
      }
      setImmediate(() => {
        void this.runWorker(run.id, () => this.run(ctx, run.id, input), ctx).catch((err) =>
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
        errorMessage: (patch as { errorMessage?: string })?.errorMessage ??
          (await repos.dockerMigrationRun.findById(id))?.errorMessage ?? null,
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
      targetServerId: input.targetServerId,
      ctx,
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
      await this.throwIfCancelled(id);
      await this.transition(id, "adopting");
      const { target: destination } = await assertMigrationEndpoints(organizationId, sourceServerId, targetServerId);
      if (destination.workspaceId) {
        log("Preparing the managed server before importing…");
        await withMigrationActivity(organizationId, sourceServerId, targetServerId, id, () => ensureCloudWorkspaceHost({
          organizationId, ownerWorkspaceId: destination.workspaceId!,
          signal: this.cancelByRun.get(id)?.abort?.signal, onProgress: log,
        }));
        await this.throwIfCancelled(id);
      }
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
      if (adopt.created) {
        createdProjectId = projectId;
        await repos.dockerMigrationRun.updateRecovery(id, { createdProjectId });
      }

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

      // Save the reviewed service identities/routes before any source is stopped.
      // The edge then imports existing sites under the normal consent flow; the
      // final live reconcile replaces the selected sites with owned service routes.
      const routeHostnames = await saveMigrationRoutes(
        ctx, projectId, remapMigrationRoutes(input.routesByServiceName, chosen, adopt.renames), log,
      );
      const needsEdge = routeHostnames.length > 0 || Boolean(input.projectMove && (
        (await repos.service.listByProject(projectId)).some((service) => service.enabled && service.exposed) ||
        (await repos.domain.listByProject(projectId)).length > 0
      ));
      const targetServer = (await assertMigrationEndpoints(organizationId, sourceServerId, targetServerId)).target;
      await repos.dockerMigrationRun.placeProject(id, organizationId, targetServerId);
      await scopeImportedStorage(projectId, !!targetServer.workspaceId,
        new Map(deployChosen.map(s => [rowNameOf(s), s.volumes])), sameServer);
      if (needsEdge && !targetServer.workspaceId) {
        await this.throwIfCancelled(id);
        log("Preparing the target server's edge and reviewing existing sites…");
        await prepareServerEdge(targetServerId, organizationId, {
          projectId,
          onLog: (entry) => log(entry.message),
          promptUser: (prompt) => this.promptUser(id, prompt),
        });
        await this.throwIfCancelled(id);
      }

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
      await this.throwIfCancelled(id);

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
        await this.throwIfCancelled(id);
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
        const move = await withMigrationActivity(organizationId, sourceServerId, targetServerId, id, () => this.moveData(
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
        ));
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
        if (cloneVolumes.length > 0 && !targetServer.workspaceId) {
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
                await repos.service.update(row.id, { volumes: rewritten });
                log(`clone: ${vol} → ${scoped} (${row.name} mounts the clone)`);
              }
            }
          }
        }

        // ── deploying ──
        // Scoped by `serviceIds` (see deployRowIds): the pipeline builds/deploys ONLY the
        // new/moved services, carries the still-running reused containers forward
        // untouched, and never reaps them — without mutating any persisted row.
        await this.throwIfCancelled(id);
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
            {
              strictServiceScope: true,
              // Internal-only artifact provenance. A public deploy request must
              // never be able to bypass build/pull with an arbitrary host ref.
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
               * Set only when the workload IS one service, so compose keeps using the map.
               */
              ...(Object.keys(adopt.handover).length === 1
                ? { handoverAppImage: Object.values(adopt.handover)[0] }
                : {}),
            },
          );
          deploymentId = dep.deployment_id;
          await this.transition(id, "deploying", { deploymentId });
          log(`target deployment ${deploymentId} started; verifying health…`);

          // ── verifying ──
          await this.throwIfCancelled(id);
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
        await this.throwIfCancelled(id);
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

      // Workload is live. Route/TLS trouble must not tear it down; retain an
      // actionable warning and keep the originals until the operator reviews it.
      const routingWarnings = !needsEdge ? [] : targetServer.workspaceId
        ? await retryProjectRouting(projectId, organizationId, { onLog: log })
          .then(result => result.ok ? [] : [result.warning ?? "Review managed routing before cutover"])
          .catch(error => [safeErrorMessage(error)])
        : await applyProjectEdgeRoutes(ctx, projectId, { onLog: log }).catch(error => [safeErrorMessage(error)]);
      if (routingWarnings.length > 0) {
        const message = `Workload migrated; routing needs attention: ${routingWarnings.join("; ")}`;
        log(message);
        await this.transition(id, "verifying", { errorMessage: message.slice(0, 4096) });
      }

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
       * project was leaving. It must also run AFTER live route application, because the mapping only
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
        await withMigrationActivity(organizationId, sourceServerId, targetServerId, id, () =>
          this.restartSourceOriginals(sourceServerId, organizationId, scannedContainerIds, id));
        await this.transition(id, "succeeded");
        log(`duplicate succeeded — the original is running again on its own server`);
      } else if (deployChosen.length > 0) {
        // Only the deploy set has originals to retire. A pure attach-live run
        // adopted the live containers in place, so there is nothing to cut over.
        const run = await repos.dockerMigrationRun.findById(id);
        if (run?.killOriginals && routingWarnings.length === 0) {
          await this.throwIfCancelled(id);
          await this.transition(id, "cutover");
          log(`cutover: stopping + removing the source originals`);
          const { failed } = await withMigrationActivity(organizationId, sourceServerId, targetServerId, id, () => this.cutover(
            sourceServerId,
            organizationId,
            scannedContainerIds,
          ));
          const incomplete = describeCutoverRemainder(failed);
          await this.transition(id, incomplete ? "cutover" : "succeeded", { errorMessage: incomplete });
          log(incomplete ? `Target is healthy; source cleanup needs attention: ${incomplete}` : "migration succeeded");
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
      if ((await repos.dockerMigrationRun.findById(id))?.status === "cutover") {
        await this.transition(id, "cutover", { errorMessage: `Source cleanup needs attention: ${reason}`.slice(0, 4096) });
        return;
      }
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
      this.prompts.reject(id, "Migration finished");
      this.pendingPrompts.delete(id);
      // Persist the tail (throttling may have skipped the last lines), then
      // release the buffer — the DB copy is now the source of truth.
      await this.flushLogs(id);
      this.logsByRun.delete(id);
      this.logFlushAt.delete(id);
    }
  }

  /** Plan once, prepare the transfer while the source is live, then quiesce
   * and copy through the existing direct or backup-executor transport. */
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
  ): Promise<MoveResult> {
    const { source, target } = await assertMigrationEndpoints(organizationId, sourceServerId, targetServerId);
    const rtA = await createServerDockerRuntime(sourceServerId, organizationId);
    let rtB: typeof rtA | undefined;
    let endpoints: Awaited<ReturnType<typeof openMigrationTransferEndpoints>> | undefined;
    let link: Awaited<ReturnType<typeof establishDirectLink>> = null;
    let runTag: string | undefined;
    try {
      rtB = sameServer ? rtA : await createServerDockerRuntime(targetServerId, organizationId);
      await rtA.assertReachable();
      if (!sameServer) await rtB.assertReachable();
      const plan = await planMigrationData({ projectId, organizationId,
        sourceRuntime: rtA, targetRuntime: rtB, scannedContainerIds, sameServer,
        managedTarget: !!target.workspaceId, volumeStrategies, customPaths, conflictResolution, log });
      const direct = migrationUsesDirectLink({ sameServer, managedSource: !!source.workspaceId,
        managedTarget: !!target.workspaceId, mode: transfer.mode });
      const signal = runId ? this.cancelByRun.get(runId)?.abort?.signal : undefined;
      if (direct) {
        endpoints = await openMigrationTransferEndpoints(sourceServerId, targetServerId, organizationId);
        runTag = crypto.randomBytes(6).toString("hex");
        if (runId) {
          const reg = this.cancelByRun.get(runId);
          if (reg) reg.runTag = runTag;
          await repos.dockerMigrationRun.updateRecovery(runId, { transferRunTag: runTag });
        }
        if (transfer.mode === "direct") log("Two servers: using rsync over SSH for the direct transfer.");
        if (transfer.compression === "zstd") log("rsync uses zlib compression for this transfer instead of zstd.");
        link = await establishDirectLink({ sourceExec: endpoints.source.executor, targetExec: endpoints.target.executor,
          sourceConn: endpoints.source.conn, targetConn: endpoints.target.conn, runId: runTag, signal,
          compress: transfer.compression === "zstd" || transfer.compression === "gzip", log });
        if (!link) throw new Error("The servers cannot connect over SSH. Allow the transfer connection or choose Relay via control host.");
        log(`transfer: server-to-server rsync (${link.direction})`);
      } else if (!sameServer) {
        log("transfer: streaming through the authenticated control connections");
      }
      const images: BuiltImage[] = [];
      if (!sameServer) for (const image of builtImages) {
        if (await rtA.imageExistsLocally(image.id)) images.push(image);
        else log(`image ${image.tag}: not present on source — target will pull`);
      }
      const sized = endpoints ? await sizeOfMoveSet(endpoints.source.executor, {
        volumeNames: plan.items.filter(item => item.kind === "volume").map(item => item.source),
        bindPaths: plan.items.filter(item => item.kind === "bind").map(item => item.source),
        customPaths: plan.items.filter(item => item.kind === "path").map(item => item.source), images,
      }).catch(() => null) : null;
      const totalBytes = sized && !sized.partial && sized.totalBytes > 0 ? sized.totalBytes : null;
      const bytes = new Map<string, number>();
      const track = (task: string, kind: ProgressUpdate["kind"]) => (value: number) => {
        bytes.set(task, Math.max(bytes.get(task) ?? 0, value));
        onProgress?.({ task, kind, totalBytes, movedBytes: [...bytes.values()].reduce((a, b) => a + b, 0) });
      };
      // Image transfer is immutable; failures here must not stop production.
      for (const image of images) {
        await this.throwIfCancelled(runId);
        const progress = track(`image:${image.tag}`, "image");
        if (link) await link.transferImage(image, progress);
        else await transferImage(rtA, rtB, image, { onProgress: progress, log, signal });
      }
      // Record before creation, and require our exact label when cleaning up.
      if (runId) {
        await repos.dockerMigrationRun.updateTargetVolumes(runId, plan.createdVolumes);
        await repos.dockerMigrationRun.updateRecovery(runId, { targetPaths: plan.managedPaths });
      }
      await prepareMigrationVolumes({ runtime: rtB, projectId, runId, plan, managed: !!target.workspaceId });
      await this.throwIfCancelled(runId);
      const running: Record<string, string> = {};
      for (const [name, cid] of Object.entries(scannedContainerIds)) {
        const container = await rtA.inspectContainer(cid);
        if (!container) throw new Error(`Source container ${name} disappeared; scan it again`);
        if (["running", "restarting"].includes(container.state)) running[name] = cid;
      }
      if (runId) await repos.dockerMigrationRun.updateRecovery(runId, { sourceRunningContainerIds: running });
      log("Stopping selected source containers for a consistent data copy…");
      for (const cid of Object.values(running)) await setMigrationContainerState(rtA, cid, false);
      const pendingItems: PendingItem[] = [];
      await mapWithLimit(plan.items, TRANSFER_CONCURRENCY, async item => {
        try {
          await this.throwIfCancelled(runId);
          await transferMigrationItem(item, { link, mode: sameServer ? transfer.mode : "stream",
            compression: transfer.compression, signal, log, onProgress: track(item.key, "volume") });
          log(`copied ${item.source} → ${item.dest}`);
        } catch (error) {
          pendingItems.push({ key: item.key, kind: item.kind, source: item.source, dest: item.dest,
            serviceName: item.serviceName, reason: error instanceof PathMissingError ? "missing" : "error",
            message: safeErrorMessage(error) });
          log(`Pending ${item.key}: ${safeErrorMessage(error)}`);
        }
      });
      // Await every writer before cleanup/rollback, including a cancelled
      // sibling. Rejecting a pool worker early could race a still-live copy.
      await this.throwIfCancelled(runId);
      signal?.throwIfAborted();
      return { bytesMoved: [...bytes.values()].reduce((a, b) => a + b, 0), pendingItems, targetVolumes: plan.createdVolumes };
    } finally {
      try {
        if (endpoints && runTag) {
          await cleanupDirectTrust(endpoints.source.executor, endpoints.target.executor, runTag);
          if (runId) await repos.dockerMigrationRun.updateRecovery(runId, { transferRunTag: null });
        }
      } finally {
        try { await endpoints?.release(); }
        finally {
          try { if (rtB && rtB !== rtA) await rtB.dispose(); } finally { await rtA.dispose(); }
        }
      }
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
        ? await findActiveDeployment(project)
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
    const { target: targetServer } = await assertMigrationEndpoints(organizationId, sourceServerId, targetServerId);
    if (targetServer.workspaceId) return; // TLS is owned by the managed edge.
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

    const endpoints = await openMigrationTransferEndpoints(sourceServerId, targetServerId, organizationId);
    const { source, target } = endpoints;
    try {
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
    } finally { await endpoints.release(); }
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
      if (runId) await this.throwIfCancelled(runId); // a cancel during verify breaks out
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
    runId?: string,
  ): Promise<void> {
    const source = await repos.server.getInOrganization(sourceServerId, organizationId);
    try {
      const hostnames = (await repos.domain.listByProject(projectId)).map((d) => d.hostname);
      if (source?.workspaceId) {
        const run = runId ? await repos.dockerMigrationRun.findById(runId) : undefined;
        const oldDeploymentId = run?.recovery?.sourceProject?.activeDeploymentId;
        const oldDeployment = oldDeploymentId ? await repos.deployment.findById(oldDeploymentId) : undefined;
        if (!oldDeployment || oldDeployment.projectId !== projectId || oldDeployment.organizationId !== organizationId)
          throw new Error("The source deployment's managed routing binding is missing");
        await withDeploymentPlatform(oldDeployment, async ({ routing }) => {
          for (const hostname of new Set(hostnames)) await routing.removeRoute(hostname);
        });
        const routed = await retryProjectRouting(projectId, organizationId);
        if (!routed.ok) throw new Error(routed.warning ?? "Retry target routing after source cutover");
        return;
      }
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
      if (source?.workspaceId) throw err;
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
    if (!await repos.dockerMigrationRun.requestCancel(id, organizationId))
      return { ok: false, status: 409, error: "Migration state changed; refresh its status" };
    const reg = this.cancelByRun.get(id);
    if (reg) {
      reg.cancelled = true;
      reg.abort?.abort(new Error("Cancelled by user"));
    }
    this.prompts.reject(id, "Migration cancelled");
    await this.killTransfer(run.sourceServerId, run.targetServerId, run.organizationId, reg?.runTag ?? run.recovery?.transferRunTag ?? undefined);
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
    if (!runTag) return;
    const serverIds = [...new Set([sourceServerId, targetServerId].filter(Boolean))] as string[];
    await Promise.all(
      serverIds.map(async (sid) => {
        try {
          await withMigrationExecution(sid, organizationId, executor =>
            stopDirectTransfer(executor, runTag));
        } catch {
          /* best-effort — the boundary flag-check still rolls the run back */
        }
      }),
    );
  }

  /** Confirm the destructive cutover or explicitly retain the originals.
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

    return this.runWorker(id, () => withMigrationActivity(organizationId, claimed.sourceServerId!, claimed.targetServerId!, id, async () => {
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
        if (remainder) throw new Error(remainder);
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
            id,
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
          id,
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
      await this.transition(id, kill ? "cutover" : "awaiting_cutover", {
        errorMessage: `Cutover incomplete — retry source cleanup: ${safeErrorMessage(err)}`.slice(
          0,
          4096,
        ),
      }).catch(() => {});
      throw err;
    }
    }));
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
          await this.runWorker(id, () => withMigrationActivity(organizationId, claimed.sourceServerId!, claimed.targetServerId!, id, () => this.runResume(ctx, claimed, organizationId, opts)));
        } catch (err) {
          console.error(`[migration] resume ${id} crashed:`, safeErrorMessage(err));
        }
      })();
    });
    return { ok: true };
  }

  /** Clean only artifacts created by a failed run, with the same run/host
   * locks as its worker. A reconnect or double-click cannot race the cleanup. */
  async cleanupTargetData(
    id: string,
    organizationId: string,
  ): Promise<{ ok: true; removed: number } | { ok: false; status: number; error: string }> {
    const result = await tryWithProvisionLock(`migration:run:${id}`, async () => {
      const run = await repos.dockerMigrationRun.findById(id);
      if (!run || run.organizationId !== organizationId)
        return { ok: false as const, status: 404, error: "Migration not found" };
      if (!["failed", "rolled_back"].includes(run.status) || (run.executionStartedAt && !run.executionFinishedAt))
        return { ok: false as const, status: 409, error: "Wait for the failed migration's worker to finish before cleanup." };
      if (!run.targetServerId)
        return { ok: false as const, status: 409, error: "Target server is no longer available." };
      const target = await repos.server.getInOrganization(run.targetServerId, organizationId);
      if (!target) return { ok: false as const, status: 404, error: "Target server not found" };
      return withCloudWorkspaceActivity(target.workspaceId, async () => {
        const removed = await this.removeTargetData(run);
        return { ok: true as const, removed };
      }, undefined, { scope: `migration:${id}` });
    });
    return result ?? { ok: false, status: 409, error: "Migration work is still running." };
  }

  private async removeTargetData(run: NonNullable<Awaited<ReturnType<typeof repos.dockerMigrationRun.findById>>>): Promise<number> {
    if (!run.targetServerId) throw new Error("Target server unavailable for data cleanup");
    const projectId = run.projectId ?? run.recovery.createdProjectId;
    const removed = await this.removeTargetVolumes(run.targetServerId, run.organizationId, run.targetVolumes ?? [], projectId, run.id);
    await repos.dockerMigrationRun.updateTargetVolumes(run.id, []);
    const paths = run.recovery.targetPaths ?? [];
    if (paths.length) {
      const target = await repos.server.getInOrganization(run.targetServerId, run.organizationId);
      if (!target?.workspaceId || !projectId || paths.some(path => migrationTargetPath(projectId, path, true) !== path))
        throw new Error("Cannot verify ownership of the target paths");
      // The same Docker inventory that protects volumes also protects binds.
      const runtime = await createServerDockerRuntime(run.targetServerId, run.organizationId);
      try {
        const containers = await runtime.docker.listContainers({ all: true });
        if (containers.some(container => container.Mounts?.some(mount => mount.Source && paths.some(path =>
          mount.Source === path || mount.Source.startsWith(`${path}/`) || path.startsWith(`${mount.Source}/`)))))
          throw new Error("The copied paths are still mounted by a target container");
        await withMigrationExecution(run.targetServerId, run.organizationId, async executor => {
          for (const path of paths) await executor.exec(`rm -rf -- ${sq(path)}`);
        });
        await repos.dockerMigrationRun.updateRecovery(run.id, { targetPaths: [] });
      } finally { await runtime.dispose(); }
    }
    return removed;
  }

  /** Labels, not names, establish which run created a cleanup candidate.
   * Docker additionally refuses to remove volumes mounted by any container. */
  private async removeTargetVolumes(
    targetServerId: string,
    organizationId: string,
    volumes: string[],
    projectId: string | null | undefined,
    runId: string,
  ): Promise<number> {
    if (!volumes.length) return 0;
    if (!projectId) throw new Error("Cannot verify the migration's project for data cleanup");
    const runtime = await createServerDockerRuntime(targetServerId, organizationId);
    try {
      let removed = 0;
      for (const name of volumes) {
        try {
          const volume = await runtime.docker.getVolume(name).inspect();
          if (volume.Labels?.["openship.project"] !== projectId || volume.Labels?.["openship.migration"] !== runId)
            continue; // Creation raced another owner; this run never owned it.
          await runtime.docker.getVolume(name).remove({ force: false });
          removed++;
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        }
      }
      return removed;
    } finally { await runtime.dispose(); }
  }

  private async runResume(
    ctx: RequestContext,
    run: NonNullable<Awaited<ReturnType<typeof repos.dockerMigrationRun.findById>>>,
    organizationId: string,
    opts: { overrides?: Record<string, string>; skip?: string[] },
  ): Promise<void> {
    const id = run.id;
    const log = (message: string) => this.appendLog(id, message);
    const pending = (run.pendingItems ?? []) as PendingItem[];
    const skip = new Set(opts.skip ?? []);
    const remaining = pending.filter(item => !skip.has(item.key));
    const stillPending = new Map(remaining.map(item => [item.key, item]));
    const input = run.inputSnapshot as unknown as StartMigrationInput;
    try {
      log(`resume: retrying ${remaining.length}, skipping ${pending.length - remaining.length} item(s)`);
      await this.restoreRecoveryArtifacts(run);
      if (remaining.length) {
        const project = run.projectId ? await repos.project.findByIdInOrganization(run.projectId, organizationId) : null;
        if (!project) throw new Error("The migration's target project is unavailable");
        const { source: sourceServer, target: targetServer } = await assertMigrationEndpoints(organizationId, run.sourceServerId!, run.targetServerId!);
        const sourceRuntime = await createServerDockerRuntime(run.sourceServerId!, organizationId);
        let targetRuntime: typeof sourceRuntime | undefined;
        let endpoints: Awaited<ReturnType<typeof openMigrationTransferEndpoints>> | undefined;
        let link: Awaited<ReturnType<typeof establishDirectLink>> = null;
        let runningTargets: string[] = [];
        try {
          targetRuntime = await createServerDockerRuntime(run.targetServerId!, organizationId);
          const sourceExec = resolveExecutor("docker", sourceRuntime);
          const targetExec = resolveExecutor("docker", targetRuntime);
          const direct = migrationUsesDirectLink({ sameServer: run.sourceServerId === run.targetServerId,
            managedSource: !!sourceServer.workspaceId, managedTarget: !!targetServer.workspaceId, mode: input?.transferMode });
          if (direct) {
            endpoints = await openMigrationTransferEndpoints(run.sourceServerId!, run.targetServerId!, organizationId);
            const runTag = crypto.randomBytes(6).toString("hex");
            await repos.dockerMigrationRun.updateRecovery(id, { transferRunTag: runTag });
            link = await establishDirectLink({
              sourceExec: endpoints.source.executor, targetExec: endpoints.target.executor,
              sourceConn: endpoints.source.conn, targetConn: endpoints.target.conn,
              runId: runTag, log, signal: this.cancelByRun.get(id)?.abort?.signal,
              compress: input?.transferCompression === "gzip" || input?.transferCompression === "zstd",
            });
            if (!link) throw new Error("No direct SSH link is available for this migration");
          }
          // Stop every target container sharing this project's data, including
          // siblings of the first service that referenced a shared volume.
          const targetContainers = await targetRuntime.listAllContainers();
          runningTargets = [...new Set([...(run.recovery.targetRunningContainerIds ?? []),
            ...targetContainers.filter(container => container.labels["openship.project"] === project.id &&
              ["running", "restarting"].includes(container.state)).map(container => container.id)])];
          await repos.dockerMigrationRun.updateRecovery(id, { targetRunningContainerIds: runningTargets });
          for (const cid of runningTargets) await setMigrationContainerState(targetRuntime, cid, false);
          const sourceRunning = { ...run.recovery.sourceRunningContainerIds };
          for (const [name, cid] of Object.entries(run.scannedContainerIds ?? {})) {
            const source = await sourceRuntime.inspectContainer(cid);
            if (source && ["running", "restarting"].includes(source.state)) sourceRunning[name] = cid;
          }
          await repos.dockerMigrationRun.updateRecovery(id, { sourceRunningContainerIds: sourceRunning });
          for (const cid of Object.values(sourceRunning)) await setMigrationContainerState(sourceRuntime, cid, false);

          for (const item of remaining) {
            await this.throwIfCancelled(id);
            const plan = planResumeTransfer(item, opts.overrides ?? {});
            const destination = "dest" in plan && plan.dest ? plan.dest : item.dest ?? item.source;
            try {
              if (targetServer.workspaceId && plan.kind === "volume")
                await ensureCloudProjectVolume(targetRuntime.docker, destination, project.id);
              if (targetServer.workspaceId && plan.kind !== "volume" && migrationTargetPath(project.id, destination, true) !== destination)
                throw new Error("The transfer destination is outside this project's managed storage");
              const transferItem = await resolveMigrationDataItem({ key: item.key, kind: item.kind,
                source: plan.source, dest: destination, serviceName: item.serviceName ?? "data",
                projectId: project.id, projectSlug: project.slug, sourceExecutor: sourceExec, targetExecutor: targetExec });
              await transferMigrationItem(transferItem, { link, mode: "stream", compression: input?.transferCompression,
                log, signal: this.cancelByRun.get(id)?.abort?.signal });
              stillPending.delete(item.key);
              log(`resolved ${item.key}`);
            } catch (error) {
              await this.throwIfCancelled(id);
              stillPending.set(item.key, { ...item, source: plan.source,
                reason: error instanceof PathMissingError ? "missing" : "error", message: safeErrorMessage(error) });
              log(`still pending ${item.key}: ${safeErrorMessage(error)}`);
            }
            await repos.dockerMigrationRun.updatePending(id, [...stillPending.values()]);
          }
        } finally {
          try {
            const current = await repos.dockerMigrationRun.findById(id);
            if (endpoints && current?.recovery.transferRunTag) {
              if (current.recovery.cancelRequested) await this.killTransfer(run.sourceServerId, run.targetServerId, organizationId, current.recovery.transferRunTag);
              await cleanupDirectTrust(endpoints.source.executor, endpoints.target.executor, current.recovery.transferRunTag);
              await repos.dockerMigrationRun.updateRecovery(id, { transferRunTag: null });
            }
            if (targetRuntime) await this.restoreTargetContainers(id, targetRuntime, runningTargets);
          } finally {
            try { await endpoints?.release(); }
            finally {
              try { await targetRuntime?.dispose(); } finally { await sourceRuntime.dispose(); }
            }
          }
        }
      }
      await repos.dockerMigrationRun.updatePending(id, [...stillPending.values()]);
      if (stillPending.size) {
        await this.transition(id, "partial", { pendingItems: [...stillPending.values()] });
        log(`resume incomplete — ${stillPending.size} path(s) still pending`);
      } else if (input?.projectMove?.intent === "copy") {
        await this.restartSourceOriginals(run.sourceServerId!, organizationId, run.scannedContainerIds ?? {}, id);
        await this.transition(id, "succeeded");
        log("duplicate complete — the original is running again on its server");
      } else {
        // Data was incomplete before this retry. Always let the operator review
        // target health before retiring the only original copy.
        await this.transition(id, "awaiting_cutover");
        log("resume complete — review the target and confirm cutover");
      }
    } catch (error) {
      await this.transition(id, "partial", { pendingItems: [...stillPending.values()],
        errorMessage: `Resume needs attention: ${safeErrorMessage(error)}`.slice(0, 4096) });
      log(`resume failed: ${safeErrorMessage(error)}`);
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
  private async stopTargetDeployment(deploymentId: string | null | undefined): Promise<void> {
    if (!deploymentId) return;
    const deployment = await repos.deployment.findById(deploymentId);
    if (deployment && (!TERMINAL_DEPLOY.has(deployment.status) ||
        await repos.deployment.hasLiveBuildExecution(deployment.id, deployment.projectId))) {
      const result = await cancelBuildSession(deployment.id, { keepProvisioned: true });
      if (result.pending) throw new Error("Waiting for the target deployment to stop. Recovery will retry automatically.");
    }
  }

  private async teardownTargetAndRestoreSource(
    ctx: { sourceServerId: string; targetServerId: string; organizationId: string },
    scannedContainerIds: Record<string, string>,
    deploymentId: string | undefined,
    runId?: string,
  ): Promise<void> {
    if (deploymentId) {
      const target = await createServerDockerRuntime(ctx.targetServerId, ctx.organizationId);
      try {
        for (const container of await target.listDeploymentContainers(deploymentId))
          await target.destroy(container.containerId);
      } finally { await target.dispose(); }
    }
    await this.restartSourceOriginals(ctx.sourceServerId, ctx.organizationId, scannedContainerIds, runId);
  }

  /** Restores the recorded running set, never starts an originally stopped service. */
  private async restartSourceOriginals(
    sourceServerId: string,
    organizationId: string,
    scannedContainerIds: Record<string, string>,
    runId?: string,
  ): Promise<void> {
    if (runId) {
      const run = await repos.dockerMigrationRun.findById(runId);
      scannedContainerIds = run?.recovery?.sourceRunningContainerIds ?? {};
    }
    if (!Object.keys(scannedContainerIds).length) return;
    const source = await createServerDockerRuntime(sourceServerId, organizationId);
    try {
      const results = await Promise.allSettled(Object.values(scannedContainerIds).map(cid => setMigrationContainerState(source, cid, true)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new Error(`Could not restart ${failures.length} source container(s): ${safeErrorMessage(failures[0]!.reason)}`);
    } finally { await source.dispose(); }
  }

  private async restoreTargetContainers(id: string, runtime: Awaited<ReturnType<typeof createServerDockerRuntime>>, ids: string[]) {
    if (!ids.length) return;
    const results = await Promise.allSettled(ids.map(cid => setMigrationContainerState(runtime, cid, true)));
    const failures = ids.filter((_, index) => results[index]?.status === "rejected");
    await repos.dockerMigrationRun.updateRecovery(id, { targetRunningContainerIds: failures });
    if (failures.length) throw new Error(`${failures.length} target service(s) could not restart; retry the migration resume.`);
  }

  /** A lost worker can leave a direct transfer or resume's stopped target behind.
   * Run under the same host admission before marking a parked/terminal run settled. */
  private async restoreRecoveryArtifacts(run: NonNullable<Awaited<ReturnType<typeof repos.dockerMigrationRun.findById>>>) {
    const tag = run.recovery?.transferRunTag;
    if (tag) {
      if (!run.sourceServerId || !run.targetServerId) throw new Error("Reconnect both migration endpoints to remove temporary SSH access");
      await this.killTransfer(run.sourceServerId, run.targetServerId, run.organizationId, tag);
      const endpoints = await openMigrationTransferEndpoints(run.sourceServerId, run.targetServerId, run.organizationId);
      try { await cleanupDirectTrust(endpoints.source.executor, endpoints.target.executor, tag); }
      finally { await endpoints.release(); }
      await repos.dockerMigrationRun.updateRecovery(run.id, { transferRunTag: null });
    }
    const targets = run.recovery?.targetRunningContainerIds ?? [];
    if (targets.length) {
      if (!run.targetServerId) throw new Error("The target server is unavailable for recovery");
      const target = await createServerDockerRuntime(run.targetServerId, run.organizationId);
      try { await this.restoreTargetContainers(run.id, target, targets); }
      finally { await target.dispose(); }
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
    await this.stopTargetDeployment(deploymentId);
    await withMigrationActivity(ctx.organizationId, servers.sourceServerId, servers.targetServerId, id, async () => {
    const current = await repos.dockerMigrationRun.findById(id);
    if (current) await this.restoreRecoveryArtifacts(current);
    await this.teardownTargetAndRestoreSource(
      {
        sourceServerId: servers.sourceServerId,
        targetServerId: servers.targetServerId,
        organizationId: ctx.organizationId,
      },
      scannedContainerIds,
      deploymentId,
      id,
    );

    // Undo what the run did to the TARGET and to the project's own record. Shared with boot
    // recovery, which used to skip both — see `undoTargetSideEffects`.
    await this.undoTargetSideEffects(
      await repos.dockerMigrationRun.findById(id).catch(() => null),
      servers,
      ctx.organizationId,
      (m) => this.appendLog(id, m),
    );
    });

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
    // The outer worker owns draft cleanup after its execution lease closes.
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

    if (servers.targetServerId) {
      try {
        const removed = await this.removeTargetData(run);
        log(`removed ${removed} volume(s) created by this migration`);
      } catch (error) {
        log(`Target data cleanup needs attention: ${safeErrorMessage(error)}. Use Remove target data to retry.`);
      }
    }

    if (run.mode === "project_move" && run.projectId && servers.sourceServerId) {
      await repos.dockerMigrationRun.restoreProject(run.id, organizationId);
    }
  }

  /** Recovery is safe on any replica: acquire the run's advisory lock without
   * waiting, then re-read its state. Recent claims get time to start their worker. */
  async recoverInterruptedMigrations(): Promise<void> {
    for (const candidate of await repos.dockerMigrationRun.listInFlight()) {
      if (Date.now() - new Date(candidate.lastEventAt).getTime() < 30_000) continue;
      await tryWithProvisionLock(`migration:run:${candidate.id}`, async () => {
        const run = await repos.dockerMigrationRun.findById(candidate.id);
        if (!run) return;
        try {
        const parked = ["awaiting_cutover", "partial", "succeeded", "failed", "rolled_back"].includes(run.status);
        const artifacts = !!run.recovery?.transferRunTag || !!run.recovery?.targetRunningContainerIds?.length;
        if (!parked || artifacts) {
          if (!run.sourceServerId || !run.targetServerId) throw new Error("A migration endpoint is unavailable; reconnect it to recover");
          if (run.status !== "cutover" && run.recovery?.worker !== "resume" && !parked)
            await this.stopTargetDeployment(run.deploymentId);
          await withMigrationActivity(run.organizationId, run.sourceServerId, run.targetServerId, run.id, async () => {
            await this.restoreRecoveryArtifacts(run);
            await this.recoverRun(run);
          });
        }
        await repos.dockerMigrationRun.acknowledgeExecutionFinished(run.id);
        const ended = await repos.dockerMigrationRun.findById(run.id);
        if (ended?.status === "rolled_back" && ended.recovery.createdProjectId && ended.recovery.authority) {
          const ctx = await resolveExecutionAuthority(ended.recovery.authority, `migration:${ended.id}`);
          await this.cleanupDraft(ctx, ended);
        }
        } catch (error) {
          const message = safeErrorMessage(error);
          console.warn(`[migration] recovery ${run.id}: ${message}`);
          const current = await repos.dockerMigrationRun.findById(run.id);
          if (current) await repos.dockerMigrationRun.transition(run.id, current.status as Parameters<typeof repos.dockerMigrationRun.transition>[1],
            { errorMessage: `Recovery needs attention: ${message}`.slice(0, 4096) });
        }
      });
    }
  }

  private async recoverRun(run: NonNullable<Awaited<ReturnType<typeof repos.dockerMigrationRun.findById>>>) {
    if (["awaiting_cutover", "partial", "succeeded", "failed", "rolled_back"].includes(run.status)) return;
    if (run.recovery?.worker === "resume") {
      await this.transition(run.id, "partial", { errorMessage: "Resume was interrupted. Review the pending paths and retry." });
      return;
    }
    if (run.status === "cutover") {
      const result = await this.cutover(run.sourceServerId!, run.organizationId, run.scannedContainerIds ?? {});
      const remainder = describeCutoverRemainder(result.failed);
      if (remainder) throw new Error(remainder);
      if (run.mode === "project_move" && run.projectId)
        await this.retireSourceRoutes(run.projectId, run.sourceServerId!, run.organizationId, true, run.id);
      await this.transition(run.id, "succeeded");
      return;
    }
    await this.teardownTargetAndRestoreSource({ sourceServerId: run.sourceServerId!,
      targetServerId: run.targetServerId!, organizationId: run.organizationId },
      run.scannedContainerIds ?? {}, run.deploymentId ?? undefined, run.id);
    await this.undoTargetSideEffects(run, { sourceServerId: run.sourceServerId!, targetServerId: run.targetServerId },
      run.organizationId, message => this.appendLog(run.id, message));
    await this.transition(run.id, "rolled_back", {
      errorMessage: "Recovered after an interruption. The source's original running state was restored.",
    });
    await this.flushLogs(run.id);
    this.logsByRun.delete(run.id);
    this.logFlushAt.delete(run.id);
  }
}

export const migrationOrchestrator = new MigrationOrchestratorImpl();
