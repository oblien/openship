/**
 * BackupOrchestrator — the FSM that glues Executor + Producer +
 * Destination + Trigger together. Pure orchestration: no concrete
 * adapter imports, everything resolves through the registry.
 *
 * Flow per backup run:
 *   queued → preparing → snapshotting → uploading → verifying → succeeded
 *                                                         ↘     ↗
 *                                                          failed/server_error
 *
 * Pre-hook errors abort (locked design decision — the most common
 * pre-hook produces the consistent dump the snapshot depends on).
 * Post-hook errors warn but don't fail (post-hook = cleanup).
 *
 * Chunk 1: the worker runs in-process via `setImmediate` (no BullMQ
 * yet). Chunk 2 replaces this with a BullMQ worker; the orchestrator
 * surface stays identical.
 */

import {
  repos,
  type Project,
  type Service,
  type BackupRunStatus,
  type BackupPolicy,
  type BackupDestination,
} from "@repo/db";
import { liveContainerForService } from "../services/service-container";
import { backupRunBus } from "./backup.sse";
import { getJobRunner } from "../../lib/job-runner";
import { toAdapterRow } from "../backup-destinations/hydrate-server";
import {
  HashingPassthrough,
  artifactKey,
  buildManifest,
  manifestKey,
  PRESERVED_ARTIFACT_METADATA_KEYS,
  resolveDestination,
  resolveExecutor,
  resolveProducer,
  resolveProducerForService,
  runPrefix,
  sanitizeProducerOpts,
  type Artifact,
  type BackupExecutor,
  type BackupTrigger,
  type PayloadKind,
  type RuntimeAdapter,
  type ServiceHandle,
} from "@repo/adapters";
import { Readable } from "node:stream";
import {
  disposeRuntime,
  resolveDeploymentPlatform,
  resolveTargetPlatform,
} from "../../lib/deployment-runtime";
import { notification } from "../../lib/notification-dispatcher";
import { serviceHandleFor, withContainerEnv } from "./service-handle";
import { resolveSourceExecutor } from "./source-platform";
import crypto from "node:crypto";
import { safeErrorMessage } from "@repo/core";
import {
  boundedStorableText,
  sanitizeStorableStringsExceptKeys,
} from "../deployments/build-log-sanitize";

/**
 * The artifacts list, made safe for jsonb WITHOUT scrubbing the recorded commands.
 *
 * The generic scrubber redacts URL userinfo, which is right for a log line and wrong
 * here: `restoreCommand` is the only record of how to put the artifact back, so
 * rewriting its DSN to `://***@` left a run that looked restorable and failed on
 * authentication — see PRESERVED_ARTIFACT_METADATA_KEYS. NULs and lone surrogates are
 * still repaired, because this value shares its write with the run's terminal status.
 */
function storableArtifacts<T>(artifacts: T): T {
  return sanitizeStorableStringsExceptKeys(artifacts, PRESERVED_ARTIFACT_METADATA_KEYS);
}

const TRUNCATE_ERROR = 4096;
const TRUNCATE_HOOK_LOG = 64 * 1024;
/** Cap on waiting for a finished hook's stdout to drain (see runHook). */
const HOOK_DRAIN_TIMEOUT_MS = 500;
/** Short form for the notification payload + destination verify note. */
const TRUNCATE_ERROR_SUMMARY = 500;
/** A `PutResult.etag` in this shape is a sha256 we can compare ours against. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

// ─── Public surface ──────────────────────────────────────────────────────────

export interface RunBackupInput {
  /** policyId resolves the (project, service?, destination) tuple +
   *  the payload kind + hooks. */
  policyId: string;
  trigger: BackupTrigger;
  /** Concrete service to back up. Set by the project-default fan-out to spawn
   *  one child run per service; omitted for direct per-service / mail / cron
   *  triggers (the source is then derived from the policy). */
  serviceId?: string;
}

/** Source-agnostic context the shared upload/manifest pipeline needs,
 *  produced by resolving either a project service or a mail server. */
interface RunContext {
  projectSlug: string;
  projectName: string;
  serviceName: string;
  manifest: {
    projectId: string;
    serviceId: string;
    serviceName: string;
    serviceImage: string | null;
    ports: string[];
    command: string | null;
    environmentKeys: string[];
  };
}

export class BackupOrchestrator {
  /**
   * Create a backup_run row in 'queued' state and kick off the
   * execution in the background. Returns the run id immediately —
   * callers (HTTP handlers, BullMQ workers, webhook receivers) get
   * back a handle they can poll via the DB.
   *
   * In Chunk 1 the actual work runs via setImmediate. Chunk 2 swaps
   * to BullMQ.add() — this method's contract doesn't change.
   */
  async enqueue(input: RunBackupInput): Promise<{ runId: string; runIds: string[] }> {
    const policy = await repos.backupPolicy.findById(input.policyId);
    if (!policy) {
      throw new Error(`Backup policy ${input.policyId} not found`);
    }
    if (!policy.enabled) {
      throw new Error(`Backup policy ${input.policyId} is disabled`);
    }
    const destination = await repos.backupDestination.findById(policy.destinationId);
    if (!destination) {
      throw new Error(`Destination ${policy.destinationId} not found for policy ${policy.id}`);
    }

    // Derive the org scope from the policy's project first, fall back
    // to the destination's org. Both should agree (ownership-aligned);
    // the explicit fallback keeps cron/webhook triggers working when
    // a destination has a NULL organizationId. Mail-server policies have
    // no project, so they always fall through to the destination's org.
    const policyProject = policy.projectId ? await repos.project.findById(policy.projectId) : null;
    const organizationId = policyProject?.organizationId ?? destination.organizationId ?? null;

    // Resolve which SOURCE(s) this trigger backs up:
    //  - explicit serviceId (a fan-out child call) → that one service
    //  - mail_server policy → the mail server
    //  - per-service policy → its service
    //  - project-default policy (no serviceId) → fan out to every ENABLED
    //    service of the project, one child run each. Single-app projects have
    //    no service rows → nothing to back up (surfaced as an error).
    if (input.serviceId) {
      const runId = await this.spawnRun(
        policy,
        destination,
        organizationId,
        { serviceId: input.serviceId },
        input.trigger,
      );
      return { runId, runIds: [runId] };
    }
    if (policy.sourceKind === "mail_server") {
      const runId = await this.spawnRun(
        policy,
        destination,
        organizationId,
        { mailServerId: policy.mailServerId ?? null },
        input.trigger,
      );
      return { runId, runIds: [runId] };
    }
    if (policy.serviceId) {
      const runId = await this.spawnRun(
        policy,
        destination,
        organizationId,
        { serviceId: policy.serviceId },
        input.trigger,
      );
      return { runId, runIds: [runId] };
    }

    // Project-default: fan out across the project's enabled services.
    if (!policy.projectId) {
      throw new Error(`Backup policy ${policy.id} has neither a service nor a project to back up`);
    }
    const services = (await repos.service.listByProject(policy.projectId)).filter((s) => s.enabled);
    if (services.length === 0) {
      throw new Error("Project has no services to back up — add a service or pick one.");
    }
    const runIds: string[] = [];
    for (const svc of services) {
      try {
        runIds.push(
          await this.spawnRun(
            policy,
            destination,
            organizationId,
            { serviceId: svc.id },
            input.trigger,
          ),
        );
      } catch (err) {
        console.warn(
          `[backup-orchestrator] failed to enqueue service ${svc.id} for policy ${policy.id}: ${safeErrorMessage(err)}`,
        );
      }
    }
    if (runIds.length === 0) {
      throw new Error("Failed to enqueue any service backups for this project.");
    }
    return { runId: runIds[0], runIds };
  }

  /**
   * Create one queued backup_run row for a concrete source (a single service or
   * a mail server) and hand it to the JobRunner. The runner is BullMQ-backed
   * when Redis is reachable, in-process otherwise — the backup_run row is the
   * crash-safe record either way (stale-run sweep on boot reconciles). Falls
   * back to inline execution if the runner enqueue throws. Returns the run id.
   */
  private async spawnRun(
    policy: BackupPolicy,
    destination: BackupDestination,
    organizationId: string,
    target: { serviceId: string } | { mailServerId: string | null },
    trigger: BackupTrigger,
  ): Promise<string> {
    const runId = `bkr_${crypto.randomUUID()}`;
    await repos.backupRun.create({
      id: runId,
      policyId: policy.id,
      destinationId: destination.id,
      sourceKind: policy.sourceKind,
      projectId: policy.projectId,
      serviceId: "serviceId" in target ? target.serviceId : null,
      mailServerId: "mailServerId" in target ? target.mailServerId : null,
      organizationId,
      status: "queued",
      triggeredBy: trigger.source,
      triggeredByUserId:
        trigger.source === "manual" || trigger.source === "webhook" ? trigger.userId : null,
      clientIp: trigger.clientIp ?? null,
    });

    try {
      const runner = await getJobRunner();
      await runner.enqueueRun(runId);
    } catch (err) {
      console.warn(
        `[backup-orchestrator] runner enqueue failed for ${runId}; falling back to inline: ${safeErrorMessage(err)}`,
      );
      setImmediate(() => {
        void this.execute(runId).catch((execErr) => {
          console.error(`[backup-orchestrator] run ${runId} crashed: ${safeErrorMessage(execErr)}`);
        });
      });
    }

    return runId;
  }

  /**
   * Atomically claim and drive a queued run through its FSM. Exported so every
   * worker backend uses the same database-owned execution boundary.
   */
  async execute(runId: string): Promise<void> {
    const run = await repos.backupRun.findById(runId);
    if (!run) {
      console.warn(`[backup-orchestrator] run ${runId} disappeared`);
      return;
    }
    if (run.status !== "queued") {
      console.warn(`[backup-orchestrator] run ${runId} already in status=${run.status}`);
      return;
    }

    // More than one delivery is normal here: the in-process fast path races its
    // DB poller, BullMQ retries, and an enqueue that reached Redis but timed out
    // also schedules the inline fallback. The durable conditional update — not
    // any runner-local Set/jobId — is the one execution owner across all of them.
    const claim = await repos.backupRun.claimExecution(runId, run.projectId, run.organizationId);
    if (claim === "project_unavailable") {
      // Returning success here makes BullMQ drop its only delivery while the DB
      // row remains queued forever. Throw so the durable queue retries after a
      // graceful delete releases its short-lived admission fence; force delete
      // atomically cancels the queued row before the retry.
      throw new Error(`Backup run ${runId} is temporarily blocked by project deletion`);
    }
    if (claim !== "claimed") {
      console.warn(`[backup-orchestrator] run ${runId} execution refused: ${claim}`);
      return;
    }
    this.publishTransition(runId, "preparing");

    let policy = null as Awaited<ReturnType<typeof repos.backupPolicy.findById>> | null;
    let executor: BackupExecutor | null = null;
    let serviceHandle: ServiceHandle | null = null;
    // The runtime the BackupExecutor wraps. Held for the whole run (it shells into
    // the container to produce the dump) and released in the `finally` — on a
    // remote server it carries a Docker-over-SSH loopback bridge that only
    // `dispose()` closes, so a scheduled policy would otherwise strand one per run.
    let sourceRuntime: RuntimeAdapter | null = null;
    /** Did `destination.preflight()` succeed this run? Gates the failure path's
     *  verdict on the destination — see the catch block. */
    let destinationProven = false;
    /**
     * Keys this run actually put at the destination, for the failure path to reclaim.
     *
     * Run-scoped rather than local to the upload loop because retention only ever prunes
     * runs whose status is `succeeded` (`retention-prune.ts`), so ANYTHING a failed run
     * uploaded is orphaned permanently — unrestorable, since a run without a manifest is
     * not a restore point, and never collected. A nightly policy that fails after its
     * first artifact would leak that artifact every single night.
     */
    const uploadedKeys: string[] = [];
    let destination: ReturnType<typeof resolveDestination> | null = null;

    try {
      // 1. Reload policy + destination + service.
      if (!run.policyId) throw new Error("Run has no policyId");
      policy = (await repos.backupPolicy.findById(run.policyId)) ?? null;
      if (!policy) throw new Error(`Policy ${run.policyId} disappeared`);
      const destinationRow = await repos.backupDestination.findById(policy.destinationId);
      if (!destinationRow) throw new Error(`Destination ${policy.destinationId} disappeared`);

      // 2. Resolve the destination up front (shared by both source kinds).
      //    toAdapterRow handles openship_server by hydrating creds from the
      //    user's `servers` row; other kinds are a straight passthrough.
      const adapterRow = await toAdapterRow(destinationRow);
      destination = resolveDestination(adapterRow);
      const preflight = await destination.preflight();
      if (!preflight.ok) {
        throw new Error(`Destination preflight failed: ${preflight.reason}`);
      }
      await repos.backupDestination.setLastVerified(destinationRow.id, true);
      // Preflight is THE destination health signal, and it just passed. Remembered so
      // the catch below does not undo it over a failure that says nothing about the
      // destination — see there.
      destinationProven = true;

      // 3. Materialize the SOURCE — a deployed project service, or a bare
      //    mail server. Both yield an opaque ServiceHandle + an executor +
      //    the key/manifest metadata the shared pipeline below needs.
      let ctx: RunContext;
      if (policy.sourceKind === "mail_server") {
        if (!policy.mailServerId) throw new Error("mail_server policy has no mailServerId");
        const built = await this.buildMailSource(
          policy.mailServerId,
          destinationRow.organizationId,
        );
        serviceHandle = built.handle;
        executor = built.executor;
        ctx = built.ctx;
      } else {
        // The concrete service lives on the RUN row (set at spawn for both
        // per-service policies and project-default fan-out children), so a
        // project-default policy resolves to a real service here.
        if (!run.serviceId) {
          throw new Error(`Backup run ${run.id} has no service to back up`);
        }
        const serviceRow = await repos.service.findById(run.serviceId);
        if (!serviceRow) throw new Error(`Service ${run.serviceId} disappeared`);

        const project = await repos.project.findById(serviceRow.projectId);
        if (!project) throw new Error(`Project ${serviceRow.projectId} disappeared`);

        // Defense-in-depth: project + destination must be in the same org.
        if (project.organizationId !== destinationRow.organizationId) {
          throw new Error(
            `Org mismatch — refusing to run: project.org=${project.organizationId}, destination.org=${destinationRow.organizationId}`,
          );
        }
        if (serviceRow.projectId !== policy.projectId) {
          throw new Error(
            `Service ${serviceRow.id} does not belong to policy's project ${policy.projectId}`,
          );
        }

        serviceHandle = await this.buildServiceHandle(serviceRow);

        const activeDeployment = project.activeDeploymentId
          ? await repos.deployment.findById(project.activeDeploymentId)
          : null;
        // Resolved from the SERVICE, not just the snapshot: an adopted service (the
        // control plane's own compose stack above all) is a container whose adopt
        // deployment is recorded as bare, and the bare executor cannot see into a
        // container. See source-platform.ts for the rule and its guards.
        const source = await resolveSourceExecutor({
          meta: activeDeployment?.meta ?? {},
          organizationId: destinationRow.organizationId,
          containerId: serviceHandle.containerId,
          serviceName: serviceRow.name,
        });
        sourceRuntime = source.runtime;
        executor = source.executor;
        // Enrich BEFORE the producer is chosen: `detects()` reads this env, so a
        // service whose credentials live only in its container must have them here
        // or it is misdetected as "not a database" and silently volume-snapshotted.
        serviceHandle = await withContainerEnv(serviceHandle, executor);

        ctx = {
          projectSlug: project.slug,
          projectName: project.name,
          serviceName: serviceRow.name,
          manifest: {
            projectId: project.id,
            serviceId: serviceRow.id,
            serviceName: serviceRow.name,
            serviceImage: serviceRow.image,
            ports: (serviceRow.ports as string[] | null) ?? [],
            command: serviceRow.command,
            environmentKeys: Object.keys(
              (serviceRow.environment as Record<string, string> | null) ?? {},
            ),
          },
        };
      }

      const producer =
        policy.payloadKind === "auto"
          ? resolveProducerForService(serviceHandle)
          : resolveProducer(policy.payloadKind as PayloadKind);

      // 4. Snapshot. Pre-hook runs first; failure aborts.
      const hookLog: string[] = [];
      if (policy.preHook) {
        await this.transition(runId, "snapshotting");
        await this.runHook(
          serviceHandle,
          executor,
          policy.preHook,
          "pre",
          hookLog,
          policy.hookTimeoutSeconds,
        );
      } else {
        await this.transition(runId, "snapshotting");
      }

      // No pathPrefix here: the destination applies its own on every put/get/delete,
      // and passing it a second time is what stored every prefixed S3/SFTP artifact
      // one level deeper than the key this run records. See key-builder.ts.
      const baseKey = {
        projectSlug: ctx.projectSlug,
        serviceName: ctx.serviceName,
        runId,
      };
      const keyPrefix = runPrefix(baseKey);
      await this.transition(runId, "uploading", {
        objectKeyPrefix: keyPrefix,
      });

      // 5. Iterate the producer's artifacts. Each one streams through
      //    the destination + a sha256 hasher in parallel.
      const artifactsRecorded: Array<{
        name: string;
        key: string;
        sizeBytes: number;
        sha256: string;
        payloadKind: PayloadKind;
        metadata: Record<string, unknown>;
      }> = [];
      let totalBytes = 0;

      // D5: forward the payloadConfig WHOLE. Hand-picking sourceIds/command/
      // exclude here dropped every custom_command key — produceCommand,
      // restoreCommand, artifactName — which is exactly what a mail-server
      // policy writes, so every mail backup captured an unrestorable artifact.
      // The producer's own cast hid it from the typechecker; the keys are
      // declared on ProducerOpts now, and this forwards unfiltered so a new
      // payload key can never be silently lost again.
      // Through `sanitizeProducerOpts`, not a bare cast: the cast asserted that jsonb
      // matched the declared field types and nothing checked it, so a `compression`
      // value outside the codec vocabulary reached the shell layer and produced an
      // artifact whose recorded codec no restore can read. See that function.
      const producerOpts = sanitizeProducerOpts(policy.payloadConfig);

      for await (const artifact of producer.produce(serviceHandle, executor, producerOpts)) {
        const recorded = await this.uploadArtifact(destination, baseKey, artifact);
        uploadedKeys.push(recorded.key);
        artifactsRecorded.push(recorded);
        totalBytes += recorded.sizeBytes;
        await this.transition(runId, "uploading", {
          artifacts: storableArtifacts(artifactsRecorded),
          bytesTransferred: totalBytes,
        });
      }

      // 5b. A run that captured nothing is a FAILED run, whichever producer ran.
      //
      // This is the backstop behind #611: the volume producer used to return
      // silently when it found no sources and the run went to `succeeded` with
      // `bytesTransferred: 0` and `artifacts: []`, so a nightly policy on the
      // control plane's own postgres reported green forever while uploading nothing
      // but a manifest describing nothing. A failed run is strictly safer than a
      // succeeded-empty one: it pages someone, and it cannot be mistaken later for
      // a restore point that exists.
      //
      // Deliberately here rather than only in each producer: the producers that can
      // hit this now say so themselves with a specific reason, but "the payload was
      // empty" must not depend on every future producer remembering to check. Both
      // shapes are caught — no artifacts at all, and artifacts that carry no bytes
      // (an exec whose command wrote nothing to stdout, which no dump ever does).
      if (artifactsRecorded.length === 0) {
        throw new Error(
          `Backup captured nothing: the ${producer.kind} payload produced no artifacts for ` +
            `service "${ctx.serviceName}". Nothing was uploaded, so this run is not a restore ` +
            `point.`,
        );
      }
      const empty = artifactsRecorded.filter((a) => a.sizeBytes === 0);
      if (empty.length > 0) {
        // No reclaim here — the run-level catch owns that for EVERY failure path, not
        // just this one. A copy in each branch is how the next branch forgets.
        const allEmpty = empty.length === artifactsRecorded.length;
        throw new Error(
          `Backup captured nothing: ${allEmpty ? "every" : `${empty.length} of ${artifactsRecorded.length}`} ` +
            `${producer.kind} artifact${allEmpty && empty.length === 1 ? "" : "s"} for service ` +
            `"${ctx.serviceName}" ${empty.length === 1 ? "is" : "are"} 0 bytes ` +
            `(${empty.map((a) => a.name).join(", ")}). An empty artifact cannot be restored from, ` +
            `so this run is not a restore point.`,
        );
      }

      // 6. Manifest last.
      //
      //    It is a CROSS-CHECK, not the commit marker — worth stating precisely, because
      //    the comment here used to claim restore "considers a run complete iff its
      //    manifest exists" and it does not: a missing manifest records
      //    `meta.manifest: "missing"` and falls back to verifying against the recorded
      //    artifact list. The actual gate is the run's STATUS — `beginPrepare` refuses
      //    anything but `succeeded` ("Can only restore from a succeeded backup run").
      //
      //    That is what makes capture atomic, and it is also why the terminal-status guard
      //    in `backup.repo.ts` matters: without it a racing writer could flip a partial
      //    `failed` run to `succeeded`, and a partial run becoming restorable is the whole
      //    failure this module is built to prevent. The manifest's job is to catch the
      //    destination disagreeing with the DB, which is a different question.
      await this.transition(runId, "verifying");
      const manifest = buildManifest({
        runId,
        projectId: ctx.manifest.projectId,
        projectSlug: ctx.projectSlug,
        serviceId: ctx.manifest.serviceId,
        serviceName: ctx.manifest.serviceName,
        serviceImage: ctx.manifest.serviceImage,
        capturedAt: new Date(),
        artifacts: artifactsRecorded,
        envVarKeys: Object.keys(serviceHandle.env),
        serviceConfig: {
          image: ctx.manifest.serviceImage,
          ports: ctx.manifest.ports,
          command: ctx.manifest.command,
          environmentKeys: ctx.manifest.environmentKeys,
        },
      });
      const manifestK = manifestKey(baseKey);
      const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2));
      uploadedKeys.push(manifestK);
      await destination.put(manifestK, Readable.from([manifestBody]), {
        contentType: "application/json",
        // Buffered, so both the real length and the digest are knowable up
        // front. That makes this the one put in this file that can hand the
        // destination a sha256 to gate on (the previous `size: 0` also lied to
        // S3's multipart threshold), and the manifest is the file restore keys
        // "is this run complete" off.
        size: manifestBody.byteLength,
        sha256: crypto.createHash("sha256").update(manifestBody).digest("hex"),
      });

      // 7. Post-hook. Failure is logged but doesn't fail the run.
      if (policy.postHook) {
        try {
          await this.runHook(
            serviceHandle,
            executor,
            policy.postHook,
            "post",
            hookLog,
            policy.hookTimeoutSeconds,
          );
        } catch (err) {
          hookLog.push(`[post-hook] continued past failure: ${safeErrorMessage(err)}`);
        }
      }

      await this.transition(runId, "succeeded", {
        manifestKey: manifestK,
        bytesTransferred: totalBytes,
        artifacts: storableArtifacts(artifactsRecorded),
        hookLog: boundedStorableText(hookLog.join("\n"), TRUNCATE_HOOK_LOG),
      });

      notification.emit({
        organizationId: destinationRow.organizationId,
        eventType: "backup_run.succeeded",
        resourceType: "backup_run",
        resourceId: runId,
        payload: {
          projectName: ctx.projectName,
          serviceName: ctx.serviceName,
          destinationName: destinationRow.name,
          bytesTransferred: totalBytes,
          artifactCount: artifactsRecorded.length,
        },
      });
    } catch (err) {
      // Both forms are scrubbed independently: a second `.slice` over an
      // already-scrubbed string can split a surrogate pair back open.
      const raw = safeErrorMessage(err);
      const message = boundedStorableText(raw, TRUNCATE_ERROR);
      const summary = boundedStorableText(raw, TRUNCATE_ERROR_SUMMARY);
      console.error(`[backup-orchestrator] run ${runId} failed: ${message}`);

      // Reclaim every object this run put at the destination, whatever went wrong.
      //
      // A failed run is not a restore point — restore requires a manifest, and retention
      // skips non-succeeded runs — so these bytes can only ever be billed, never used.
      // ONE place, so a future failure path cannot forget. Best-effort by construction: a
      // cleanup that fails must never replace the operator's real error.
      if (destination && uploadedKeys.length > 0) {
        // `deleteMany` reports per-key failures instead of throwing, so catching alone
        // saw only a total collapse — a bucket policy that denies delete on half the
        // keys resolved cleanly and the orphans went unnamed.
        await destination
          .deleteMany(uploadedKeys)
          .then(({ failed }) => {
            if (failed.length === 0) return;
            console.warn(
              `[backup-orchestrator] run ${runId}: ${failed.length}/${uploadedKeys.length} ` +
                `object(s) could not be reclaimed after the failure and are now orphaned ` +
                `at the destination: ` +
                failed.map((f) => `${f.key}: ${f.error}`).join("; "),
            );
          })
          .catch((cleanupErr) =>
            console.warn(
              `[backup-orchestrator] run ${runId}: ${uploadedKeys.length} object(s) could not ` +
                `be reclaimed after the failure and are now orphaned at the destination: ` +
                `${safeErrorMessage(cleanupErr)}`,
            ),
          );
      }

      // Only a destination that failed PREFLIGHT is marked unhealthy. Once preflight
      // has passed, this run has proved the destination reachable and writable, and
      // everything that can still go wrong is about the SOURCE — a dump command that
      // exited non-zero, a service with no volumes, a container that vanished.
      //
      // Flipping the flag on any failure conflated the two, and one destination is
      // shared by many policies: a single project-default policy fanning out over a
      // stateless service ("nothing to back up") would mark the destination every
      // other project backs up to as unverified, and the UI would tell the operator
      // their storage is broken when it is fine. The run's own errorMessage carries
      // the real reason either way.
      if (policy?.destinationId && !destinationProven) {
        await repos.backupDestination
          .setLastVerified(policy.destinationId, false, summary)
          .catch(() => {});
      }

      // The artifact list goes with the bytes.
      //
      // `artifacts` is written INCREMENTALLY as each one uploads (step 5), so a capture
      // that refuses on its third folder — or on its first, once the producer's exit
      // status arrives after an empty payload stream — leaves entries naming objects the
      // reclaim above just deleted. Every reader treats that list as real: the restore
      // path reads it (`recordedArtifacts`), retention derives delete keys from it, the
      // `restoreCommand` backfill scans it with no status filter, and the restore wizard
      // shows its LENGTH to the operator as "N artifacts". A failed run advertising an
      // artifact whose key 404s is the same lie as a green run that captured nothing,
      // pointed the other way.
      //
      // `bytesTransferred` for the same reason: storage accounting already counts only
      // succeeded runs (`backup.repo.ts` `storedBytes`), and the run cards render this
      // number as the size of what was captured. Nothing was.
      //
      // Objects the reclaim could NOT delete stay named in the warning it logs — this
      // row is not their record, because retention skips non-succeeded runs and would
      // never act on them anyway.
      await this.transition(runId, "failed", {
        errorMessage: message,
        artifacts: [],
        bytesTransferred: 0,
      });

      // Fan-out to subscribers. We re-fetch destination if needed —
      // the catch block may have lost the closure depending on where
      // we threw, so look it up by policy.
      if (policy?.destinationId) {
        const destForNotify = await repos.backupDestination
          .findById(policy.destinationId)
          .catch(() => null);
        if (destForNotify) {
          notification.emit({
            organizationId: destForNotify.organizationId,
            eventType: "backup_run.failed",
            resourceType: "backup_run",
            resourceId: runId,
            payload: {
              destinationName: destForNotify.name,
              errorMessage: summary,
            },
          });
        }
      }
    } finally {
      disposeRuntime(sourceRuntime);
      // Status says what happened; this acknowledgement says the worker can no
      // longer mutate project resources. It must be the last durable write in
      // the outermost worker boundary so project teardown never treats an early
      // terminal/stale verdict as quiescence.
      await repos.backupRun.acknowledgeExecutionFinished(runId);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Persist a state transition AND publish it to the SSE bus.
   * Centralizes the two-write pattern so every transition stays
   * subscriber-visible. If the bus emit throws (no subscribers, or
   * downstream error), we swallow — the DB write is what matters.
   */
  private async transition(
    runId: string,
    status: BackupRunStatus,
    patch?: Parameters<typeof repos.backupRun.transition>[2],
  ): Promise<void> {
    await repos.backupRun.transition(runId, status, patch);
    this.publishTransition(runId, status, patch);
  }

  /** Publish a transition already persisted by either the FSM or atomic claim. */
  private publishTransition(
    runId: string,
    status: BackupRunStatus,
    patch?: Parameters<typeof repos.backupRun.transition>[2],
  ): void {
    try {
      backupRunBus.publish(runId, {
        type: "transition",
        status,
        bytesTransferred:
          typeof patch?.bytesTransferred === "number" ? patch.bytesTransferred : undefined,
        artifacts: Array.isArray(patch?.artifacts) ? (patch.artifacts as unknown[]) : undefined,
      });
      const TERMINAL: BackupRunStatus[] = ["succeeded", "failed", "cancelled", "server_error"];
      if (TERMINAL.includes(status)) {
        backupRunBus.publish(runId, {
          type: "complete",
          status: status as "succeeded" | "failed" | "cancelled" | "server_error",
          errorMessage: typeof patch?.errorMessage === "string" ? patch.errorMessage : undefined,
        });
      }
    } catch {
      // bus failures never block the FSM
    }
  }

  private async uploadArtifact(
    destination: ReturnType<typeof resolveDestination>,
    baseKey: { projectSlug: string; serviceName: string; runId: string },
    artifact: Artifact,
  ): Promise<{
    name: string;
    key: string;
    sizeBytes: number;
    sha256: string;
    payloadKind: PayloadKind;
    metadata: Record<string, unknown>;
  }> {
    const key = artifactKey(baseKey, artifact.name);
    const hasher = new HashingPassthrough();

    // Pipe artifact stream → hasher → destination. The hasher computes
    // sha256 + byte count as bytes flow.
    //
    // The error forward is not optional. `pipe()` does not carry errors, and the
    // executor destroys its stdout stream with an Error on every abnormal end — an
    // idle-timeout, a ceiling, a desynchronized frame boundary. With no listener
    // that is an unhandled 'error' event, i.e. the API process dies mid-backup; and
    // if it somehow survived, `hasher` would never end and `put()` would wait on an
    // EOF that is never coming. Destroying the hasher instead turns a broken
    // producer into a rejected upload, which is a failed run — the only honest
    // outcome for an artifact whose bytes stopped early.
    artifact.stream.on("error", (err: Error) => hasher.destroy(err));
    artifact.stream.pipe(hasher);

    // S3 stores each metadata key as an `x-amz-meta-*` HTTP header, and
    // header values may only contain printable ASCII — no newlines. Some
    // producers (e.g. custom_command) stash multiline shell commands in
    // metadata for restore, so only header-safe values go to the put call.
    // The unfiltered `artifact.metadata` is still recorded on the backup
    // run below (`recorded.metadata`), which is what restore reads from.
    const headerSafeMetadata = Object.fromEntries(
      Object.entries(artifact.metadata ?? {}).filter(
        ([, v]) => typeof v === "string" && /^[\x20-\x7e]*$/.test(v),
      ),
    );

    const result = await destination.put(key, hasher, {
      size: artifact.sizeHint,
      contentType: "application/octet-stream",
      metadata: headerSafeMetadata as Record<string, string>,
    });

    const { sha256, bytesWritten } = hasher.summary();

    // An artifact's digest doesn't exist until its bytes have already been
    // written, so it can't be handed to `put` as a precondition (see
    // PutOpts.sha256). Where the destination reports one back — local hashes as
    // it lands the file — compare: a disagreement means what's stored is not
    // what we hashed, and recording OUR digest would make restore's verification
    // pass against corrupt bytes. S3's ETag is an MD5/multipart composite and
    // SFTP reports none, so the shape guard keeps this to destinations where the
    // comparison means something.
    if (result?.etag && SHA256_HEX.test(result.etag) && result.etag.toLowerCase() !== sha256) {
      throw new Error(
        `Artifact "${artifact.name}" changed in transit: hashed ${sha256} on the way out, destination stored ${result.etag.toLowerCase()}`,
      );
    }

    return {
      name: artifact.name,
      key,
      sizeBytes: bytesWritten,
      sha256,
      payloadKind: artifact.payloadKind,
      metadata: artifact.metadata,
    };
  }

  private async runHook(
    service: ServiceHandle,
    executor: BackupExecutor,
    command: string,
    phase: "pre" | "post",
    log: string[],
    timeoutSeconds: number,
  ): Promise<void> {
    log.push(`[${phase}-hook] $ ${command}`);
    const { stdout, awaitExit } = await executor.execStream(service, ["sh", "-c", command], {
      timeoutMs: timeoutSeconds * 1000,
    });
    // Collect stdout for the hook log.
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => {
      if (chunks.length < 64) chunks.push(chunk);
    });
    // `awaitExit` can settle before the stream has delivered its buffered chunks,
    // which loses the hook's output entirely for a hook that finishes fast. Wait
    // for the stream as well — bounded, because a killed exec can leave it open
    // forever and a hook log must never hold up the backup.
    const drained = new Promise<void>((resolve) => {
      stdout.once("end", () => resolve());
      stdout.once("close", () => resolve());
      stdout.once("error", () => resolve());
    });
    const exit = await awaitExit;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      drained,
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, HOOK_DRAIN_TIMEOUT_MS);
      }),
    ]);
    if (drainTimer) clearTimeout(drainTimer);
    const stdoutText = Buffer.concat(chunks)
      .toString("utf8")
      .slice(0, 8 * 1024);
    log.push(stdoutText);
    if (exit.stderr) log.push(`[${phase}-hook stderr] ${exit.stderr.slice(0, 4 * 1024)}`);
    // An UNKNOWN exit status is not success. Executors can surface a null exit
    // code (docker reports ExitCode: null while an exec is still reaping, ssh2
    // reports none when a channel dies), and the pre-hook is what guarantees the
    // snapshot is consistent — reading "don't know" as 0 would ship a torn dump.
    const code: number | null | undefined = exit.code;
    if (code !== 0) {
      throw new Error(
        `${phase}-hook exited with code ${code ?? "unknown (no exit status reported)"}`,
      );
    }
  }

  /**
   * Materialize a mail server as a backup source. A mail server is a bare
   * SSH host (no project/service), so we build a synthetic ServiceHandle
   * from the `mail_servers` + `servers` rows and resolve the `bare`
   * executor bound to that server. resolveTargetPlatform enforces org
   * membership (throws if the server isn't in the destination's org).
   */
  private async buildMailSource(
    mailServerId: string,
    destinationOrgId: string,
  ): Promise<{ handle: ServiceHandle; executor: BackupExecutor; ctx: RunContext }> {
    const mailRow = await repos.mailServer.get(mailServerId);
    if (!mailRow) throw new Error(`Mail server ${mailServerId} not found`);
    const domain = mailRow.domain ?? "mail";
    const slug = (domain.replace(/[^a-zA-Z0-9.-]/g, "-").toLowerCase() || "mail").slice(0, 63);

    const targetPlatform = await resolveTargetPlatform(
      "server",
      "bare",
      mailServerId,
      destinationOrgId,
    );
    const executor = resolveExecutor(targetPlatform.runtime.name, targetPlatform.runtime);

    const handle: ServiceHandle = {
      id: mailServerId,
      projectId: "",
      name: "mail",
      image: null,
      env: {},
      volumes: ["/var/vmail"],
      containerId: null,
      projectSlug: slug,
      namespaceVolumes: false,
    };

    return {
      handle,
      executor,
      ctx: {
        projectSlug: slug,
        projectName: domain,
        serviceName: "mail",
        manifest: {
          projectId: mailServerId,
          serviceId: mailServerId,
          serviceName: "mail",
          serviceImage: null,
          ports: [],
          command: null,
          environmentKeys: [],
        },
      },
    };
  }

  private async buildServiceHandle(serviceRow: Service): Promise<ServiceHandle> {
    const project = await repos.project.findById(serviceRow.projectId);
    if (!project) throw new Error(`Project ${serviceRow.projectId} not found`);

    const live = await this.resolveServiceContainer(project, serviceRow);
    return serviceHandleFor(serviceRow, {
      projectSlug: project.slug,
      containerId: live.containerId,
      containerRunning: live.running,
      environment: live.environment,
    });
  }

  /** Find the live container for a service, via the shared resolver — verified
   *  against the host, so a backup never targets a container a redeploy already
   *  replaced. The RUNNING flag rides along because a logical dump has to exec
   *  inside the container, and a stopped one still has an id; the ENVIRONMENT rides
   *  along because the producer's env has to be read at the scope the running
   *  container was built from. */
  private async resolveServiceContainer(
    project: Project,
    serviceRow: Service,
  ): Promise<{ containerId: string | null; running: boolean | null; environment?: string }> {
    if (!project.activeDeploymentId) return { containerId: null, running: null };
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    if (!dep) return { containerId: null, running: null };
    const live = await liveContainerForService(project, dep, serviceRow, {
      projectId: project.id,
    });
    return { ...live, environment: dep.environment ?? undefined };
  }
}

export const backupOrchestrator = new BackupOrchestrator();
