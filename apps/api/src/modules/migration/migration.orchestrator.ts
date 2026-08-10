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
import { safeErrorMessage, sanitizeProxySettings } from "@repo/core";
import {
  resolveExecutor,
  transferVolume,
  transferImage,
  scopedVolumeName,
  readEdgeFile,
  writeEdgeFile,
  edgeProxy,
  type ServiceHandle,
  type TransferEndpoint,
  type TransferMode,
  type TransferCompression,
} from "@repo/adapters";
import type { RequestContext } from "../../lib/request-context";
import {
  createServerDockerRuntime,
  createServerCommandExecutor,
} from "../../lib/deployment-runtime";
import { establishDirectLink, PathMissingError, statPath, sq } from "./direct-transfer";
import type { MigrationRouteSpec } from "./migration-input";
import { sizeOfMoveSet } from "./migration-size";
import { withKeyedMutex } from "../../lib/provision-lock";
import { requestBuildAccess } from "../deployments/build.service";
import { restartServiceContainer, updateService } from "../services/service.service";
import { describeLiveState, resolveLiveServiceState } from "../services/live-state";
import { applyProjectRouting } from "../domains/routing-apply.service";
import { resolveProjectRouteState, reapplyProjectLiveRoutes } from "../domains/project-route.service";
import { linkProjectRepo } from "../projects/project-crud.service";
import type { ProjectCompositeRoute, ProxySettings } from "@repo/core";
import { teardownProject } from "../projects/project-teardown";
import { discoverServerStack } from "./docker-inspect.service";
import { adoptServerStack, attachLiveRuntime, joinReusedContainersToGroup, parseRepoCompose } from "./migrate.service";
import { isMovableBind } from "./migration-preflight";
import { migrationRunBus } from "./migration.sse";

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
  /** Adopt in flat-docker mode — MUST match the scan the user selected from, or
   *  openship-labeled containers get treated as managed and "none are found". */
  flatDocker?: boolean;
}

/** Re-key a DISCOVERED-name-keyed map onto the adopted ROW names via a
 *  discovered→row rename map. Keys with no rename entry pass through unchanged.
 *  Used so migrate inputs (e.g. routesByServiceName) land on renamed rows. */
function remapKeys<T>(
  map: Record<string, T> | undefined,
  renames: Record<string, string>,
): Record<string, T> | undefined {
  if (!map) return map;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) out[renames[k] ?? k] = v;
  return out;
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
]);
/** How many volumes move concurrently — a few in flight without saturating one SSH link. */
const TRANSFER_CONCURRENCY = 3;

/** Minimal bounded-concurrency runner (no dep): keeps ≤`limit` tasks in flight,
 *  preserves order, propagates the first rejection. */
async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
      const mode =
        input.sourceServerId === input.targetServerId ? "same_server" : "cross_server";
      const run = await repos.dockerMigrationRun.create({
        id: `dmr_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        sourceServerId: input.sourceServerId,
        targetServerId: input.targetServerId,
        projectName: input.projectName,
        serviceNames: input.serviceNames,
        status: "queued",
        mode,
        killOriginals: input.killOriginals,
        confirmationToken,
        // Snapshot the start input so a `partial` run can be resumed and a
        // `failed` run re-opened pre-filled (edit & retry).
        inputSnapshot: input as unknown as Record<string, unknown>,
      });
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

  private async run(
    ctx: RequestContext,
    id: string,
    input: StartMigrationInput,
  ): Promise<void> {
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
      log(`${sameServer ? "same-server" : "cross-server"} migration of ${serviceNames.length} service(s): ${serviceNames.join(", ")}`);
      const stack = await discoverServerStack(sourceServerId, organizationId, undefined, {
        flatDocker: input.flatDocker,
      });
      const selected = stack.services.filter((s) => serviceNames.includes(s.name));
      if (selected.length === 0) {
        throw new Error("None of the selected services were found on the server.");
      }
      // Never adopt the edge proxy (traefik/nginx/… on 80/443) — Openship's
      // OpenResty replaces it. Drop it from the workload set and leave it
      // UNTOUCHED (absent from scannedContainerIds, so moveData won't stop it):
      // we never blind-stop the user's proxy. It's reclaimed later — with
      // consent — when the user adds a domain to a migrated service and the
      // routed deploy's edge-takeover modal offers to take over 80/443.
      const chosen = selected.filter((s) => !s.proxyKind);
      if (chosen.length === 0) {
        throw new Error(
          "Only a reverse proxy was selected. Openship installs its own edge on 80/443 — pick the app services to migrate instead.",
        );
      }
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
      const isAttach = (name: string) =>
        sameServer && (input.volumeStrategies?.[name] ?? "reuse") !== "copy";
      const attachChosen = chosen.filter((s) => isAttach(s.name));
      const deployChosen = chosen.filter((s) => !isAttach(s.name));

      // Only the DEPLOY set's originals are quiesced / copied / cut over —
      // attach-live containers are adopted as-is and must never be stopped or
      // killed (that would take down the very containers we're taking control of).
      scannedContainerIds = Object.fromEntries(
        deployChosen.filter((s) => s.containerId).map((s) => [s.name, s.containerId as string]),
      );

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
        flatDocker: input.flatDocker,
        repoServices,
      });
      const projectId = adopt.projectId;
      if (adopt.created) createdProjectId = projectId;
      await this.transition(id, "adopting", { projectId, scannedContainerIds });

      // Link the repo (if the user picked one) BEFORE deploy so source + push
      // auto-deploy are bound from the first release. Best-effort: adopted rows
      // carry an image, so the deploy reuses it regardless — a GitHub hiccup must
      // never block the (destructive) migration.
      if (input.gitSource) {
        const linked = await linkProjectRepo(ctx, projectId, input.gitSource).catch(
          (err) => ({ ok: false as const, code: "invalid" as const, message: safeErrorMessage(err) }),
        );
        if (!linked.ok) {
          console.warn(`[migration] ${id}: repo link skipped (${linked.code})`);
        }
      }

      // Translate the discovered attach names onto the adopted ROW names (repo
      // names when the wizard mapped them) — the rows are keyed by their final
      // name, so matching by the discovered name would miss every renamed row.
      const attachNames = new Set(attachChosen.map((s) => adopt.renames[s.name] ?? s.name));
      const attachRows = (await repos.service.listByProject(projectId)).filter((r) =>
        attachNames.has(r.name),
      );

      // Repo compose services with no adopted container (e.g. a same-server run
      // whose only running container is `postgres`, but the repo compose also
      // declares web/dashboard/api/redis) are already created as native rows —
      // with their env — by adoptServerStack. This just gates whether the native
      // deploy has to run to build/pull them (and publish their domains).
      const adoptedRowNames = new Set(chosen.map((s) => adopt.renames[s.name] ?? s.name));
      const hasNewRepoServices = repoServices
        ? [...repoServices.keys()].some((n) => !adoptedRowNames.has(n))
        : false;

      // Cancel checkpoint on the attach-live path too: a same-server reuse run
      // has an empty deploy set (skips every check below), so without this a
      // cancel during `adopting` would never take effect and the run would
      // proceed to `succeeded`. (Same-server has no killable transfer process.)
      this.throwIfCancelled(id);

      // Run the native deploy when there are containers to move (cross-server /
      // copy) OR new repo services to build/pull. Attach-live services are
      // disabled during the build (below) so they stay zero-downtime; the deploy
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
        const move = await this.moveData(
          projectId,
          sourceServerId,
          targetServerId,
          organizationId,
          scannedContainerIds,
          sameServer,
          input.volumeStrategies ?? {},
          builtImages,
          input.customPaths ?? [],
          { mode: input.transferMode, compression: input.transferCompression },
          input.conflictResolution ?? {},
          log,
          emitProgress,
          id,
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
        // Scope the compose deploy to the reuse set: attach-live rows are disabled
        // so the pipeline builds/deploys ONLY the new/moved services and never
        // recreates the still-running reused containers. requestBuildAccess kicks
        // the build off in the BACKGROUND and returns immediately, so the rows must
        // stay disabled for the ENTIRE build+verify — re-enabling right after the
        // call returns would race the async build into reading them enabled and
        // recreating the reused containers. Re-enabled in the finally only AFTER
        // waitForDeployment resolves (by then the build has read the disabled set);
        // the finally still restores them on any failure/cancel.
        this.throwIfCancelled(id);
        await this.transition(id, "deploying");
        for (const r of attachRows) {
          await repos.service.update(r.id, { enabled: false });
        }
        // Unify with a native deploy: join the reused (attach-live) containers to
        // the project network (alias = row name) BEFORE the build, so a freshly-
        // built service resolves them by name from its first start (web →
        // postgres:5432). The deploy's ensureServiceGroup reuses this network.
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
        log(`deploying to target server…`);
        try {
          const dep = await requestBuildAccess(ctx, {
            projectId,
            deployTarget: "server",
            serverId: targetServerId,
            runtimeMode: "docker",
            serviceDeploymentMode: "services",
            // One-time cutover: native `build:` rows reuse the transferred/running
            // image on THIS deploy (no rebuild); a later Redeploy has no handover
            // and rebuilds from the repo.
            handoverImages: adopt.handover,
          });
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
        } finally {
          for (const r of attachRows) {
            await repos.service.update(r.id, { enabled: true }).catch(() => {});
          }
        }

        // Carry the source's existing TLS certs onto the target (cross-server)
        // BEFORE the post-verify domain publish reads them — so a kept domain
        // reuses its cert instead of re-issuing via ACME. Best-effort.
        if (!sameServer) {
          await this.carrySourceCerts(sourceServerId, targetServerId, organizationId, chosen).catch(
            (err) => console.warn(`[migration] ${id}: cert carry skipped: ${safeErrorMessage(err)}`),
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
        remapKeys(input.routesByServiceName, adopt.renames),
        log,
      );

      // Read back what the migration actually produced: one line per service
      // naming the container it resolves to on the host, how it was identified,
      // and any leftover duplicate. Without this, a service whose container was
      // adopted (foreign labels) or replaced looks identical in the run log to
      // one that landed cleanly — the operator only found out from the panel.
      // Log-only: never changes the run's outcome.
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
      } else if (deployChosen.length > 0) {
        // Only the deploy set has originals to retire. A pure attach-live run
        // adopted the live containers in place, so there is nothing to cut over.
        const run = await repos.dockerMigrationRun.findById(id);
        if (run?.killOriginals) {
          this.throwIfCancelled(id);
          await this.transition(id, "cutover");
          log(`cutover: stopping + removing the source originals`);
          await this.cutover(sourceServerId, organizationId, scannedContainerIds);
          await this.transition(id, "succeeded");
          log(`migration succeeded`);
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
  ): Promise<MoveResult> {
    const rtA = await createServerDockerRuntime(sourceServerId, organizationId);
    const rtB = sameServer
      ? null
      : await createServerDockerRuntime(targetServerId, organizationId);
    try {
      // Quiesce originals for a consistent copy (and to free ports/volumes on
      // a same-server redeploy). Best-effort — a missing container is fine.
      for (const cid of Object.values(scannedContainerIds)) {
        await rtA.stop(cid).catch(() => {});
      }

      // Cross-server DEFAULT: move data DIRECTLY server-to-server (rsync +
      // docker save|ssh|load), single hop, no byte through the API host. The
      // "stream" transfer mode is the explicit opt-back-in to the API-host relay
      // below (for when the two servers can't reach each other).
      if (rtB && transfer.mode !== "stream") {
        // On-the-wire rsync compression is opt-in ("zstd"/"gzip" → -z); "auto"/
        // unset stays OFF (a fast LAN link usually beats the compressor).
        const compress =
          transfer.compression === "zstd" || transfer.compression === "gzip";
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
        );
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
          const handle: ServiceHandle = {
            id: svc.id,
            projectId,
            name: svc.name,
            image: svc.image ?? null,
            env: {},
            volumes: svc.volumes ?? [],
            containerId: null, // force the DB-fallback branch → bare-named ids
            projectSlug,
            namespaceVolumes: svc.namespaceVolumes,
          };
          // Scoped dst handle for a "clone"-resolved volume (target volume →
          // openship-<slug>-<name>); mirrors the same-server copy branch. Lazy —
          // only computed when this service actually has a clone volume.
          const scopedHandle: ServiceHandle = { ...handle, namespaceVolumes: true };
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
            let dst: TransferEndpoint = { exec: execB, handle, sourceId: src.id };
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
        const conflicts: string[] = [];
        for (const task of tasks) {
          if (conflictResolution[task.source] || relayFallback) continue; // resolved / inherited
          const probe = await task.dst.exec.probeVolume?.(task.dst.handle, task.dst.sourceId);
          if (probe?.exists && !probe.empty) conflicts.push(`${task.label}/${task.dst.sourceId}`);
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
      const results = await runPool(tasks, TRANSFER_CONCURRENCY, async (t) => {
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
          log(`${t.label}/${t.src.sourceId}: ${r.strategy} (${r.compression}) — ${r.bytesMoved} bytes`);
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
      // Cross-server target volumes written (for optional post-failure cleanup);
      // same-server "copies" live on the same daemon but are recorded too.
      const targetVolumes = rtB
        ? tasks.filter((t) => t.targetVolume).map((t) => t.targetVolume as string)
        : [];
      return {
        bytesMoved: imageBytes + results.reduce((sum, n) => sum + n, 0),
        pendingItems,
        targetVolumes,
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

      // Enumerate the source's movable data FIRST: bare-named volumes + movable
      // bind paths (same enumeration the relay path uses; forced DB-fallback
      // ids) + the built images actually present on the source.
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
      log(
        `conflict resolution: ${Object.keys(conflictResolution).length ? JSON.stringify(conflictResolution) : "none"}` +
          `; enumerated volumes: ${[...volumeNames].join(", ") || "none"}`,
      );
      const conflicts: string[] = [];
      for (const name of volumeNames) {
        if (resolution[name]) continue; // resolved (by volume) — not blocking
        const out = await target.executor
          .exec(
            `if docker volume inspect ${sq(name)} >/dev/null 2>&1; then ` +
              `mp=$(docker volume inspect ${sq(name)} -f '{{.Mountpoint}}'); ` +
              `[ -n "$(ls -A "$mp" 2>/dev/null)" ] && echo CONFLICT || true; fi`,
          )
          .catch(() => "");
        if (!out.includes("CONFLICT")) continue;
        if (fallback) {
          resolution[name] = fallback;
          log(`conflict ${name}: no explicit choice — applying '${fallback}' (matches your other choices)`);
        } else {
          conflicts.push(name);
        }
      }
      if (conflicts.length > 0) {
        throw new Error(
          `Target server already has data in volume(s): ${conflicts.join(", ")}. ` +
            "Remove or rename them on the target, then retry — refusing to overwrite existing data.",
        );
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
      log(`transfer plan: ${totalBytes ?? "?"} bytes across ${volumeNames.size} volume(s), ` +
        `${bindPaths.size} bind(s), ${imagesToMove.length} image(s), ${customPaths.length} path(s)`);

      const bytesByTask = new Map<string, number>();
      const track =
        (task: string, kind: "image" | "volume") =>
        (bytes: number) => {
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
      const targetVolumes: string[] = [];
      // src volume name → target volume name, for the post-transfer size check.
      const verifyVolumes: Array<{ src: string; dst: string }> = [];
      await runPool(items, TRANSFER_CONCURRENCY, async (it) => {
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
              const dstName = action === "clone" ? scopedVolumeName(projectSlug, it.ref) : undefined;
              targetVolumes.push(dstName ?? it.ref); // written on the target (for optional cleanup)
              await link.transferVolume(it.ref, track(`volume:${it.ref}`, "volume"), dstName);
              verifyVolumes.push({ src: it.ref, dst: dstName ?? it.ref });
            }
          } else if (it.kind === "bind") await link.transferBind(it.ref, track(`bind:${it.ref}`, "volume"));
          else await link.transferPath(it.source, it.dest, track(`path:${it.source}`, "volume"));
        } catch (err) {
          const missing = err instanceof PathMissingError;
          const message = safeErrorMessage(err);
          const pending: PendingItem =
            it.kind === "path"
              ? { key: `path:${it.source}`, kind: "path", source: it.source, dest: it.dest, reason: missing ? "missing" : "error", message }
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
      const duVolume = async (
        exec: { exec: (c: string) => Promise<string> },
        name: string,
      ): Promise<number | null> => {
        const out = await exec
          .exec(
            `mp=$(docker volume inspect ${sq(name)} -f '{{.Mountpoint}}' 2>/dev/null) && ` +
              `du -sb "$mp" 2>/dev/null | cut -f1 || echo`,
          )
          .catch(() => "");
        const n = Number(out.trim());
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      for (const v of verifyVolumes) {
        const [srcBytes, dstBytes] = await Promise.all([
          duVolume(source.executor, v.src),
          duVolume(target.executor, v.dst),
        ]);
        if (srcBytes == null || dstBytes == null) {
          log(`verify ${v.dst}: size unavailable — skipped`);
          continue;
        }
        const ok = Math.abs(srcBytes - dstBytes) <= Math.max(4096, srcBytes * 0.01);
        log(`verify ${v.dst}: source ${srcBytes} → target ${dstBytes} bytes ${ok ? "✓" : "⚠ size mismatch"}`);
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
  ): Promise<void> {
    // Every TLS-served domain among the kept services. The cert MATERIAL comes from
    // the source proxy's own reader, not from cert paths on the discovered route:
    // caddy and traefik declare no paths (their certs live in a data dir and in
    // acme.json), so a path-driven carry silently moved nothing from those boxes and
    // every migrated domain re-issued through ACME on the target.
    const domains = new Set<string>();
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
      const failed = rows.filter((r) => /fail|error/i.test(r.status));
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

  /** Destroy the originals on the source (by scanned container id — they carry
   *  no openship.* labels). Never removes the source's volumes. */
  private async cutover(
    sourceServerId: string,
    organizationId: string,
    scannedContainerIds: Record<string, string>,
  ): Promise<void> {
    const rtA = await createServerDockerRuntime(sourceServerId, organizationId);
    try {
      for (const cid of Object.values(scannedContainerIds)) {
        await rtA.stop(cid).catch(() => {});
        await rtA.destroy(cid).catch(() => {});
      }
    } finally {
      await rtA.dispose().catch(() => {});
    }
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
      return { ok: false, status: 409, error: `Migration is not cancellable (status: ${run.status})` };
    }
    const reg = this.cancelByRun.get(id) ?? { cancelled: false };
    reg.cancelled = true;
    this.cancelByRun.set(id, reg);
    await this.killTransfer(
      run.sourceServerId,
      run.targetServerId,
      run.organizationId,
      reg.runTag,
    );
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
   *  Timing-safe token compare. Only valid from `awaiting_cutover`. */
  async resolveCutover(
    id: string,
    organizationId: string,
    confirmationToken: string,
    kill: boolean,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const run = await repos.dockerMigrationRun.findById(id);
    if (!run || run.organizationId !== organizationId) {
      return { ok: false, status: 404, error: "Migration not found" };
    }
    if (run.status !== "awaiting_cutover") {
      return { ok: false, status: 409, error: `Migration is not awaiting cutover (status: ${run.status})` };
    }
    const expected = Buffer.from(run.confirmationToken ?? "");
    const supplied = Buffer.from(confirmationToken ?? "");
    if (
      expected.length !== supplied.length ||
      !crypto.timingSafeEqual(expected, supplied)
    ) {
      return { ok: false, status: 403, error: "Invalid confirmation token" };
    }

    if (kill && run.sourceServerId) {
      await this.transition(id, "cutover");
      await this.cutover(
        run.sourceServerId,
        organizationId,
        (run.scannedContainerIds ?? {}) as Record<string, string>,
      );
    } else if (!kill && run.sourceServerId && run.sourceServerId !== run.targetServerId) {
      // Keep + cross-server: moveData quiesced the source for a consistent copy,
      // so bring the originals back UP — the old server returns to running as a
      // live standby until the user manually cleans it up (nothing is removed).
      // Same-server keep leaves them stopped: the target now holds the same
      // ports/volumes, so both can't run at once.
      await this.restartSourceOriginals(
        run.sourceServerId,
        organizationId,
        (run.scannedContainerIds ?? {}) as Record<string, string>,
      );
    }
    await this.transition(id, "succeeded");
    return { ok: true };
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
      return { ok: false, status: 409, error: `Migration is not resumable (status: ${run.status})` };
    }
    if (!run.sourceServerId || !run.targetServerId) {
      return { ok: false, status: 409, error: "Source/target server is no longer available" };
    }
    // Flip out of `partial` first (guards a concurrent resume), then run async.
    await this.transition(id, "moving_data");
    setImmediate(() => {
      void this.runResume(ctx, run, organizationId, opts).catch((err) =>
        console.error(`[migration] resume ${id} crashed:`, safeErrorMessage(err)),
      );
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
    const vols = (run.targetVolumes ?? []) as string[];
    if (vols.length === 0) return { ok: true, removed: 0 };
    const { executor } = await createServerCommandExecutor(run.targetServerId, organizationId);
    let removed = 0;
    for (const v of vols) {
      // -f so an anonymous/unused volume goes even if dangling; `|| true` keeps
      // one stubborn volume (e.g. still referenced) from failing the whole sweep.
      await executor.exec(`docker volume rm -f ${sq(v)} 2>&1 || true`).catch(() => {});
      removed++;
    }
    await repos.dockerMigrationRun.updateTargetVolumes(id, []).catch(() => {});
    return { ok: true, removed };
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
      log(`resume: retrying ${toRetry.length}, skipping ${pending.length - toRetry.length} item(s)`);
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

    // A failed migration must not leave the draft project it created behind.
    // Only projects THIS run created are dropped (never a pre-existing one the
    // user already had). Reuse the canonical teardown (force = cancel the
    // in-flight/timed-out deploy first, then drop rows) so no divergent delete
    // path — but never wipe volumes (the reused originals hold production data),
    // and never let a cleanup hiccup mask the real migration error.
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

    await this.transition(id, "rolled_back", {
      errorMessage: errorMessage.slice(0, 4096),
    });
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
      // Parked states survive a restart untouched: the target is UP and the run
      // waits on an interactive resolve (cutover confirm / pending-path resume).
      if (run.status === "awaiting_cutover" || run.status === "partial") continue;
      const scanned = (run.scannedContainerIds ?? {}) as Record<string, string>;

      // A crash mid-CUTOVER is NOT a rollback: the target was already verified
      // healthy and the operator opted to destroy the source, so tearing the
      // target down + trying to restart already-destroyed originals would leave
      // BOTH sides down and invert a succeeded migration. Instead finish the
      // (idempotent) cutover — destroying an already-gone container is a no-op —
      // and mark it succeeded.
      if (run.status === "cutover") {
        if (run.sourceServerId) {
          try {
            await this.cutover(run.sourceServerId, run.organizationId, scanned);
          } catch (err) {
            console.warn(`[migration] recovery cutover ${run.id} failed:`, safeErrorMessage(err));
          }
        }
        await repos.dockerMigrationRun
          .transition(run.id, "succeeded")
          .catch((err) =>
            console.warn(`[migration] recovery transition ${run.id} failed:`, safeErrorMessage(err)),
          );
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
      }
      await repos.dockerMigrationRun
        .transition(run.id, "rolled_back", {
          errorMessage:
            "Recovered after an interruption — the original containers were restarted.",
        })
        .catch((err) =>
          console.warn(`[migration] recovery transition ${run.id} failed:`, safeErrorMessage(err)),
        );
    }
  }
}

export const migrationOrchestrator = new MigrationOrchestratorImpl();
