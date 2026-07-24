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
  type Service,
  type BackupRunStatus,
  type BackupPolicy,
  type BackupDestination,
} from "@repo/db";
import { containerIdForService } from "../services/service-container";
import { backupRunBus } from "./backup.sse";
import { getJobRunner } from "../../lib/job-runner";
import { toAdapterRow } from "../backup-destinations/hydrate-server";
import {
  HashingPassthrough,
  artifactKey,
  buildManifest,
  manifestKey,
  resolveDestination,
  resolveExecutor,
  resolveProducer,
  resolveProducerForService,
  runPrefix,
  type Artifact,
  type BackupExecutor,
  type BackupTrigger,
  type PayloadKind,
  type ServiceHandle,
} from "@repo/adapters";
import { Readable } from "node:stream";
import { resolveDeploymentPlatform, resolveTargetPlatform } from "../../lib/deployment-runtime";
import { decryptEnvMap } from "../../lib/encryption";
import { notification } from "../../lib/notification-dispatcher";
import crypto from "node:crypto";
import { safeErrorMessage } from "@repo/core";

const TRUNCATE_ERROR = 4096;
const TRUNCATE_HOOK_LOG = 64 * 1024;

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
    const policyProject = policy.projectId
      ? await repos.project.findById(policy.projectId)
      : null;
    const organizationId =
      policyProject?.organizationId ?? destination.organizationId ?? null;

    // Resolve which SOURCE(s) this trigger backs up:
    //  - explicit serviceId (a fan-out child call) → that one service
    //  - mail_server policy → the mail server
    //  - per-service policy → its service
    //  - project-default policy (no serviceId) → fan out to every ENABLED
    //    service of the project, one child run each. Single-app projects have
    //    no service rows → nothing to back up (surfaced as an error).
    if (input.serviceId) {
      const runId = await this.spawnRun(policy, destination, organizationId, { serviceId: input.serviceId }, input.trigger);
      return { runId, runIds: [runId] };
    }
    if (policy.sourceKind === "mail_server") {
      const runId = await this.spawnRun(policy, destination, organizationId, { mailServerId: policy.mailServerId ?? null }, input.trigger);
      return { runId, runIds: [runId] };
    }
    if (policy.serviceId) {
      const runId = await this.spawnRun(policy, destination, organizationId, { serviceId: policy.serviceId }, input.trigger);
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
          await this.spawnRun(policy, destination, organizationId, { serviceId: svc.id }, input.trigger),
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
        trigger.source === "manual" || trigger.source === "webhook"
          ? trigger.userId
          : null,
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
          console.error(
            `[backup-orchestrator] run ${runId} crashed: ${safeErrorMessage(execErr)}`,
          );
        });
      });
    }

    return runId;
  }

  /**
   * Drive a queued run through its FSM. Updates the row at each
   * transition. Exported so a worker (Chunk 2) can call it directly.
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

    let policy = null as Awaited<ReturnType<typeof repos.backupPolicy.findById>> | null;
    let executor: BackupExecutor | null = null;
    let serviceHandle: ServiceHandle | null = null;

    try {
      await this.transition(runId, "preparing");

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
      const destination = resolveDestination(adapterRow);
      const preflight = await destination.preflight();
      if (!preflight.ok) {
        throw new Error(`Destination preflight failed: ${preflight.reason}`);
      }
      await repos.backupDestination.setLastVerified(destinationRow.id, true);

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
          throw new Error(
            `Backup run ${run.id} has no service to back up`,
          );
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
        const platform = await resolveDeploymentPlatform(
          (activeDeployment?.meta ?? {}) as Parameters<typeof resolveDeploymentPlatform>[0],
          { organizationId: destinationRow.organizationId },
        );
        executor = resolveExecutor(platform.platform.runtime.name, platform.platform.runtime);

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
        await this.runHook(serviceHandle, executor, policy.preHook, "pre", hookLog, policy.hookTimeoutSeconds);
      } else {
        await this.transition(runId, "snapshotting");
      }

      const baseKey = {
        pathPrefix: destinationRow.pathPrefix,
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

      const producerOpts = {
        sourceIds: (policy.payloadConfig as { sourceIds?: string[] })?.sourceIds,
        command: (policy.payloadConfig as { command?: string })?.command,
        exclude: (policy.payloadConfig as { exclude?: string[] })?.exclude,
      };

      for await (const artifact of producer.produce(serviceHandle, executor, producerOpts)) {
        const recorded = await this.uploadArtifact(destination, baseKey, artifact);
        artifactsRecorded.push(recorded);
        totalBytes += recorded.sizeBytes;
        await this.transition(runId, "uploading", {
          artifacts: artifactsRecorded,
          bytesTransferred: totalBytes,
        });
      }

      // 6. Manifest as the last artifact — restore considers a run
      //    "complete" iff its manifest exists.
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
      await destination.put(
        manifestK,
        Readable.from([Buffer.from(JSON.stringify(manifest, null, 2))]),
        { contentType: "application/json", size: 0 },
      );

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
          hookLog.push(
            `[post-hook] continued past failure: ${safeErrorMessage(err)}`,
          );
        }
      }

      await this.transition(runId, "succeeded", {
        manifestKey: manifestK,
        bytesTransferred: totalBytes,
        artifacts: artifactsRecorded,
        hookLog: hookLog.join("\n").slice(0, TRUNCATE_HOOK_LOG),
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
      const message = safeErrorMessage(err);
      console.error(`[backup-orchestrator] run ${runId} failed: ${message}`);

      if (policy?.destinationId) {
        // Note the destination verify failed so the UI surfaces it.
        await repos.backupDestination
          .setLastVerified(policy.destinationId, false, message.slice(0, 500))
          .catch(() => {});
      }

      await this.transition(runId, "failed", {
        errorMessage: message.slice(0, TRUNCATE_ERROR),
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
              errorMessage: message.slice(0, 500),
            },
          });
        }
      }
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
    baseKey: { pathPrefix: string | null; projectSlug: string; serviceName: string; runId: string },
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
    artifact.stream.pipe(hasher);

    await destination.put(key, hasher, {
      size: artifact.sizeHint,
      contentType: "application/octet-stream",
      metadata: artifact.metadata as Record<string, string>,
    });

    const { sha256, bytesWritten } = hasher.summary();
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
    const { stdout, awaitExit } = await executor.execStream(
      service,
      ["sh", "-c", command],
      { timeoutMs: timeoutSeconds * 1000 },
    );
    // Collect stdout for the hook log.
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => {
      if (chunks.length < 64) chunks.push(chunk);
    });
    const exit = await awaitExit;
    const stdoutText = Buffer.concat(chunks).toString("utf8").slice(0, 8 * 1024);
    log.push(stdoutText);
    if (exit.stderr) log.push(`[${phase}-hook stderr] ${exit.stderr.slice(0, 4 * 1024)}`);
    if (exit.code !== 0) {
      throw new Error(`${phase}-hook exited with code ${exit.code}`);
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
    const executor = resolveExecutor(
      targetPlatform.runtime.name,
      targetPlatform.runtime,
    );

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

    // Decrypt env vars at the boundary so producers can use them
    // (pg_dump -U $POSTGRES_USER etc.). Two sources:
    //   service.environment — plaintext defaults from compose
    //   env_var rows         — encrypted per-key (user-set)
    // Project env wins over service defaults.
    const envFromService =
      (serviceRow.environment as Record<string, string> | null) ?? {};
    const envFromProjectEncrypted = await repos.project
      .listEnvVars(serviceRow.projectId)
      .then((vars) => {
        const out: Record<string, string> = {};
        for (const v of vars) out[v.key] = v.value;
        return out;
      })
      .catch(() => ({}));
    const projectEnv = decryptEnvMap(envFromProjectEncrypted);
    const decrypted = { ...envFromService, ...projectEnv };

    return {
      id: serviceRow.id,
      projectId: serviceRow.projectId,
      name: serviceRow.name,
      image: serviceRow.image,
      env: decrypted,
      volumes: (serviceRow.volumes as string[] | null) ?? [],
      containerId: await this.resolveServiceContainerId(serviceRow),
      projectSlug: project.slug,
      namespaceVolumes: serviceRow.namespaceVolumes,
    };
  }

  /** Find the live container id for a service, via the shared resolver. */
  private async resolveServiceContainerId(serviceRow: Service): Promise<string | null> {
    const project = await repos.project.findById(serviceRow.projectId);
    if (!project?.activeDeploymentId) return null;
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    if (!dep) return null;
    return containerIdForService(dep, serviceRow);
  }
}

export const backupOrchestrator = new BackupOrchestrator();
