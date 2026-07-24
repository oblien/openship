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
 *                 teardown of the originals (opt-in)
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
import { safeErrorMessage } from "@repo/core";
import {
  resolveExecutor,
  transferVolume,
  type ServiceHandle,
  type TransferEndpoint,
  type TransferMode,
  type TransferCompression,
} from "@repo/adapters";
import type { RequestContext } from "../../lib/request-context";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { withKeyedMutex } from "../../lib/provision-lock";
import { requestBuildAccess } from "../deployments/build.service";
import { linkProjectRepo } from "../projects/project-crud.service";
import { teardownProject } from "../projects/project-teardown";
import { discoverServerStack } from "./docker-inspect.service";
import { adoptServerStack, attachLiveRuntime } from "./migrate.service";
import { isMovableBind } from "./migration-preflight";
import { migrationRunBus } from "./migration.sse";

/** Per-service volume ownership for a same-server migration.
 *  "reuse" (default) = seize the original volume in place (zero copy).
 *  "copy" = duplicate data into a new openship-<slug>-<name> volume, leaving the
 *  original untouched. Cross-server ignores this (it always copies A→B, keeps A). */
export type VolumeStrategy = "reuse" | "copy";

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
  /** serviceName → env override (defaults to the discovered container's env). */
  serviceEnv?: Record<string, Record<string, string>>;
  /** Adopt in flat-docker mode — MUST match the scan the user selected from, or
   *  openship-labeled containers get treated as managed and "none are found". */
  flatDocker?: boolean;
}

const VERIFY_TIMEOUT_MS = 20 * 60 * 1000; // 20 min for the target deploy
const VERIFY_POLL_MS = 5000;
const TERMINAL_DEPLOY = new Set(["ready", "partial_failure", "failed", "cancelled"]);
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

    try {
      // ── adopt ──
      await this.transition(id, "adopting");
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

      const adopt = await adoptServerStack({
        serverId: sourceServerId,
        organizationId,
        projectName: input.projectName,
        serviceNames,
        sameServer,
        volumeStrategies: input.volumeStrategies,
        serviceSubpaths: input.serviceSubpaths,
        serviceEnv: input.serviceEnv,
        flatDocker: input.flatDocker,
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

      const attachNames = new Set(attachChosen.map((s) => s.name));
      const attachRows = (await repos.service.listByProject(projectId)).filter((r) =>
        attachNames.has(r.name),
      );

      if (deployChosen.length > 0) {
        // ── moving_data: quiesce the deploy set's originals + copy volumes ──
        await this.transition(id, "moving_data");
        const bytesMoved = await this.moveData(
          projectId,
          sourceServerId,
          targetServerId,
          organizationId,
          scannedContainerIds,
          sameServer,
          input.volumeStrategies ?? {},
          { mode: input.transferMode, compression: input.transferCompression },
          (m) => console.log(`[migration] ${id}: ${m}`),
        );
        await this.transition(id, "moving_data", { bytesMoved });

        // ── deploying ──
        // Scope the compose deploy to the deploy set: attach-live rows are
        // temporarily disabled so the build skips them (deployComposeServices
        // only deploys enabled rows), then re-enabled + attached below. Restored
        // in finally so a failure never leaves rows disabled.
        await this.transition(id, "deploying");
        for (const r of attachRows) {
          await repos.service.update(r.id, { enabled: false });
        }
        try {
          const dep = await requestBuildAccess(ctx, {
            projectId,
            deployTarget: "server",
            serverId: targetServerId,
            runtimeMode: "docker",
            serviceDeploymentMode: "services",
          });
          deploymentId = dep.deployment_id;
        } finally {
          for (const r of attachRows) {
            await repos.service.update(r.id, { enabled: true }).catch(() => {});
          }
        }
        await this.transition(id, "deploying", { deploymentId });

        // ── verifying ──
        await this.transition(id, "verifying");
        const verified = await this.waitForDeployment(deploymentId);
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
        await this.transition(id, "verifying");
        await attachLiveRuntime({
          deploymentId: deploymentId!,
          projectId,
          organizationId,
          serverId: sourceServerId,
          attach: attachChosen,
          serviceRows: await repos.service.listByProject(projectId),
        });
      }

      // ── cutover (opt-in) / awaiting_cutover ──
      // Only the deploy set has originals to retire. A pure attach-live run
      // adopted the live containers in place, so there is nothing to cut over.
      if (deployChosen.length > 0) {
        const run = await repos.dockerMigrationRun.findById(id);
        if (run?.killOriginals) {
          await this.transition(id, "cutover");
          await this.cutover(sourceServerId, organizationId, scannedContainerIds);
          await this.transition(id, "succeeded");
        } else {
          await this.transition(id, "awaiting_cutover");
        }
      } else {
        await this.transition(id, "succeeded");
      }
    } catch (err) {
      await this.rollback(
        ctx,
        id,
        { sourceServerId, targetServerId },
        scannedContainerIds,
        deploymentId,
        createdProjectId,
        safeErrorMessage(err),
      );
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
    transfer: { mode?: TransferMode; compression?: TransferCompression },
    log: (message: string) => void,
  ): Promise<number> {
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

      const services = await repos.service.listByProject(projectId);
      const project = await repos.project.findById(projectId);
      const projectSlug = project?.slug ?? "";
      const execA = resolveExecutor("docker", rtA);

      // Collect (src → dst) transfer tasks for BOTH topologies, then run them
      // through the ONE transfer core. No per-topology pipe duplication — same
      // vs cross only differ in which executor/handle each end uses.
      const tasks: Array<{ label: string; src: TransferEndpoint; dst: TransferEndpoint }> = [];

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
          const sources = await execA.listSources(handle);
          for (const src of sources) {
            if (src.type === "bind") {
              if (!isMovableBind(src.source)) continue;
            } else if (src.type !== "volume") {
              continue;
            }
            tasks.push({
              label: svc.name,
              src: { exec: execA, handle, sourceId: src.id },
              dst: { exec: execB, handle, sourceId: src.id },
            });
          }
        }

        // Cross-server reuses BARE volume names on the target, and transfer runs
        // with clearTarget:true — so a same-named volume already holding data on
        // B (from an unrelated stack) would be silently wiped. Refuse BEFORE any
        // destructive write; the caller's rollback then restarts the originals.
        const conflicts: string[] = [];
        for (const task of tasks) {
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
      const results = await runPool(tasks, TRANSFER_CONCURRENCY, async (t) => {
        const r = await transferVolume(t.src, t.dst, {
          mode: transfer.mode,
          compression: transfer.compression,
          clearTarget: true,
          log: (m) => log(`${t.label}/${t.src.sourceId}: ${m}`),
        });
        log(`${t.label}/${t.src.sourceId}: ${r.strategy} (${r.compression}) — ${r.bytesMoved} bytes`);
        return r.bytesMoved;
      });
      return results.reduce((sum, n) => sum + n, 0);
    } finally {
      await rtA.dispose().catch(() => {});
      if (rtB) await rtB.dispose().catch(() => {});
    }
  }

  /** Poll the target deployment until terminal. Returns the terminal row (its
   *  status/errorMessage tell the caller why it ended), or null if the verify
   *  window elapsed before it reached a terminal state. */
  private async waitForDeployment(
    deploymentId: string,
  ): Promise<Awaited<ReturnType<typeof repos.deployment.findById>> | null> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
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
    }
    await this.transition(id, "succeeded");
    return { ok: true };
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
    try {
      const rtA = await createServerDockerRuntime(ctx.sourceServerId, ctx.organizationId);
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
      if (run.status === "awaiting_cutover") continue;
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
