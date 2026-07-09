/**
 * Deployment lifecycle hooks - shared onSuccess / onFailure for the
 * entire build→deploy process.
 *
 * The orchestrator (build.service.ts) creates a lifecycle context once
 * at the start of a deployment, then calls onSuccess or onFailure at
 * the end. These hooks handle everything:
 *
 *   onFailure  →  destroy resources → mark DB failed → finish session → SSE → notify
 *   onSuccess  →  persist container → mark DB ready → finish session → SSE → notify
 *
 * This keeps the orchestrator focused on sequencing (build → deploy)
 * while all side-effects on completion live here.
 */

import { repos, type Project, type Deployment, type NewDeployment } from "@repo/db";
import { DockerRuntime, type LogEntry } from "@repo/adapters";
import type { RuntimeAdapter } from "@repo/adapters";
import { SYSTEM, safeErrorMessage } from "@repo/core";
import { env } from "../../config";
import type { DeploymentMeta } from "../../lib/deployment-runtime";
import { notification } from "../../lib/notification-dispatcher";
import { audit } from "../../lib/audit";
import * as sessionManager from "./session-manager";
import type { BuildSessionState } from "./session-manager";
import { detectAndStoreFavicon } from "../../lib/favicon-detector";
import {
  markWebmailInstalled,
  mailServerIdFromWebmailSlug,
} from "../mail/webmail/webmail-project.service";

export interface LifecycleContext {
  /**
   * Optional - runtime is only touched when cleanup of a provisioned
   * image or service container is needed. Bespoke pipelines (e.g.
   * webmail) that don't go through `runtime.build` can omit it.
   */
  runtime?: RuntimeAdapter;
  project: Project;
  dep: Deployment;
  buildSessionId: string;
  /** Returns collapsed logs for DB persistence. */
  persistLogs: () => LogEntry[];
  /** Provisioned resources - set by the orchestrator as phases progress. */
  provisioned: { imageRef?: string };
}

function truncateError(msg: string): string {
  const max = SYSTEM.DEPLOYMENTS.MAX_ERROR_MESSAGE_LENGTH;
  return msg.length > max ? msg.slice(0, max) + "…" : msg;
}

export async function cleanupBuildArtifact(
  runtime: RuntimeAdapter,
  artifactRef: string,
): Promise<void> {
  if (runtime instanceof DockerRuntime) {
    await runtime.removeImage(artifactRef);
    return;
  }

  await runtime.destroy(artifactRef);
}

/**
 * Set a deployment's status on BOTH layers in one call: the DB row
 * (repos.deployment.updateStatus) and the in-memory SSE session
 * (sessionManager.updateStatus). Every non-terminal transition needs
 * both, and they were previously hand-written at each call site.
 *
 * The SSE layer only knows the legacy statuses, so for a DB-only status
 * (e.g. "partial_failure") pass an explicit `sse.status` (typically
 * "ready" + a warningMessage); otherwise the SSE status mirrors the DB
 * status.
 *
 * NOTE: terminal completion (ready/failed/cancelled) is owned by
 * onSuccess/onFailure/onCancelled — use those, not this helper.
 */
export async function setDeploymentStatus(
  deploymentId: string,
  dbStatus: string,
  opts?: {
    extra?: Partial<NewDeployment>;
    sse?: {
      status?: BuildSessionState["status"];
      meta?: {
        errorCode?: string;
        errorDetails?: Record<string, unknown>;
        warningMessage?: string;
        errorMessage?: string;
      };
    };
  },
): Promise<void> {
  await repos.deployment.updateStatus(deploymentId, dbStatus, opts?.extra);
  sessionManager.updateStatus(
    deploymentId,
    opts?.sse?.status ?? (dbStatus as BuildSessionState["status"]),
    opts?.sse?.meta,
  );
}

/**
 * INDETERMINATE completion: the connection to the server dropped after
 * container(s) started, so we can neither confirm success nor declare failure.
 *
 * Persist `reconciling` and finish the build stream — but, unlike onFailure,
 * DO NOT destroy the build artifact or the service containers (they may be
 * running perfectly) and DO NOT advance the project's active pointer
 * (forward-only: only a confirmed success advances it). A later
 * `reconcileDeployment` reads the true remote state and settles this to
 * ready / partial_failure / failed.
 */
export async function onReconciling(
  ctx: LifecycleContext,
  result: { containerId?: string; warningMessage?: string; durationMs?: number },
): Promise<void> {
  const { dep, buildSessionId, persistLogs } = ctx;

  if (result.containerId) {
    await repos.deployment.setContainerId(dep.id, result.containerId).catch(() => {});
  }

  const collapsed = persistLogs();
  await repos.deployment.updateStatus(dep.id, "reconciling", { errorMessage: null });
  // The build stream is finished; the SSE layer has no "reconciling", so close
  // it as "ready" with a warning. The dashboard reads the DB row's `reconciling`
  // status for the actual state (same split as partial_failure).
  await repos.deployment.finishBuildSession(
    buildSessionId,
    "ready",
    result.durationMs ?? 0,
    collapsed,
  );
  sessionManager.updateStatus(dep.id, "ready", {
    warningMessage:
      result.warningMessage ?? "Connection lost during deploy — verifying remote state.",
  });
}

export async function onFailure(
  ctx: LifecycleContext,
  error?: string,
  durationMs?: number,
  errorMeta?: { errorCode?: string; errorDetails?: Record<string, unknown>; errorMessage?: string },
): Promise<void> {
  const { runtime, project, dep, buildSessionId, persistLogs, provisioned } = ctx;

  // Always delete the workspace/container on failure so the user doesn't
  // have to manually clean up.
  if (runtime && provisioned.imageRef) {
    try {
      await cleanupBuildArtifact(runtime, provisioned.imageRef);
    } catch (destroyErr) {
      console.error(
        `[DEPLOY] Failed to destroy ${provisioned.imageRef} on failure:`,
        destroyErr,
      );
      // Retry once after a short delay
      await new Promise((r) => setTimeout(r, 2000));
      await cleanupBuildArtifact(runtime, provisioned.imageRef).catch((retryErr) => {
        console.error(
          `[DEPLOY] Retry destroy also failed for ${provisioned.imageRef}:`,
          retryErr,
        );
      });
    }
  }

  if (runtime) {
    const serviceDeps = await repos.service.listByDeployment(dep.id).catch(() => []);
    for (const serviceDep of serviceDeps) {
      if (!serviceDep.containerId) continue;
      try {
        await runtime.destroy(serviceDep.containerId);
      } catch (destroyErr) {
        console.error(
          `[DEPLOY] Failed to destroy service container ${serviceDep.containerId} on failure:`,
          destroyErr,
        );
      }
    }
  }

  // INVARIANT: failure writes the DEPLOYMENT row only — NEVER the project row.
  // The project's live-release pointer (activeDeploymentId) advances solely on
  // success (onSuccess) so a failed deploy has zero effect on the project's
  // live state. Do not add a setActiveDeployment call here.
  const errorMessage = error ? truncateError(error) : undefined;
  const collapsed = persistLogs();
  await repos.deployment.updateStatus(dep.id, "failed", { errorMessage });
  await repos.deployment.finishBuildSession(buildSessionId, "failed", durationMs ?? 0, collapsed);
  sessionManager.updateStatus(dep.id, "failed", {
    ...errorMeta,
    errorMessage,
  });

  // Notify — dispatch to every subscribed channel (per-user prefs +
  // org defaults). Fire-and-forget: the dispatcher fans out across
  // email/webhook/in-app/slack based on each member's subscriptions.
  const lastLogs = collapsed.slice(-50).map((l) => l.message).join("\n");
  notification.emit({
    organizationId: dep.organizationId,
    eventType: "deployment.failed",
    resourceType: "deployment",
    resourceId: dep.id,
    payload: {
      projectName: project.name,
      branch: dep.branch,
      commitSha: dep.commitSha,
      errorMessage: errorMessage ?? "Unknown error",
      logsTail: lastLogs,
      durationMs,
    },
  });

  // Audit — async fire-and-forget; never blocks the failure path.
  // actorUserId is null here because the lifecycle runs in background;
  // the user who triggered the deploy is recorded on the original
  // `deployment.created` audit_event row.
  audit.recordAsync(
    { organizationId: dep.organizationId, actorUserId: null },
    {
      eventType: "deployment.failed",
      resourceType: "deployment",
      resourceId: dep.id,
      before: { status: dep.status },
      after: {
        status: "failed",
        projectId: project.id,
        branch: dep.branch,
        commitSha: dep.commitSha,
        errorMessage,
        durationMs,
      },
    },
  );
}

export async function onCancelled(
  ctx: LifecycleContext,
  durationMs?: number,
): Promise<void> {
  const { runtime, dep, buildSessionId, persistLogs, provisioned } = ctx;

  if (runtime && provisioned.imageRef) {
    try {
      await cleanupBuildArtifact(runtime, provisioned.imageRef);
    } catch (destroyErr) {
      console.error(
        `[DEPLOY] Failed to destroy ${provisioned.imageRef} on cancel:`,
        destroyErr,
      );
      await new Promise((r) => setTimeout(r, 2000));
      await cleanupBuildArtifact(runtime, provisioned.imageRef).catch(() => {});
    }
  }

  // Destroy service containers and broadcast failed status (mirrors onFailure)
  const serviceDeps = await repos.service.listByDeployment(dep.id).catch(() => []);
  const services = serviceDeps.length > 0
    ? await repos.service.listByProject(dep.projectId).catch(() => [])
    : [];
  const serviceNameMap = new Map(services.map((s) => [s.id, s.name]));

  for (const serviceDep of serviceDeps) {
    if (runtime && serviceDep.containerId) {
      await runtime.destroy(serviceDep.containerId).catch((err) => {
        console.error(`[DEPLOY] Failed to destroy service container ${serviceDep.containerId} on cancel:`, err);
      });
    }
    sessionManager.broadcastServiceStatus(dep.id, {
      serviceName: serviceNameMap.get(serviceDep.serviceId) ?? serviceDep.serviceId,
      serviceId: serviceDep.serviceId,
      status: "failed",
      error: "Deployment cancelled",
    });
  }

  // INVARIANT: cancel writes the DEPLOYMENT row only — NEVER the project row.
  // A cancelled redeploy leaves activeDeploymentId (the last successful release)
  // exactly as it was. Do not add a setActiveDeployment call here.
  await repos.deployment.updateStatus(dep.id, "cancelled");
  await repos.deployment.finishBuildSession(buildSessionId, "cancelled", durationMs ?? 0, persistLogs());
  sessionManager.updateStatus(dep.id, "cancelled");
}

export async function onSuccess(
  ctx: LifecycleContext,
  result: {
    containerId: string;
    url?: string;
    durationMs: number;
    warningMessage?: string;
    metaPatch?: Record<string, unknown>;
  },
): Promise<void> {
  const { project, dep, buildSessionId, persistLogs } = ctx;

  await repos.deployment.setContainerId(dep.id, result.containerId, result.url);
  const mergedMeta = result.metaPatch ? { ...((dep.meta as DeploymentMeta | null) ?? {}), ...result.metaPatch } : ((dep.meta as DeploymentMeta | null) ?? null);

  // Assign the human-friendly version NOW, on success — not at create. A version
  // is a shipped release: only successful deploys get one, and it's per-commit
  // (redeploying the same commit reuses its number rather than burning a new
  // one). The one-in-flight-per-project index serializes deploys, so the
  // MAX(ready)+1 fallback can't race.
  const version =
    (await repos.deployment.findReadyVersionByCommit(project.id, dep.commitSha)) ??
    (await repos.deployment.getNextReadyVersion(project.id));

  await repos.deployment.updateStatus(dep.id, "ready", {
    errorMessage: null,
    meta: mergedMeta,
    version,
  });

  await repos.project.setActiveDeployment(project.id, dep.id);

  // A newer release makes a prior held keep/reject decision moot — mark it
  // superseded so no stale deployment reads as "Action Required". Best-effort.
  await repos.deployment
    .supersedePendingDecisions(project.id, dep.id)
    .catch((err) =>
      console.warn(
        `[deployment-lifecycle] supersedePendingDecisions failed project=${project.id}: ${safeErrorMessage(err)}`,
      ),
    );

  // deployment.meta is the per-deploy historical snapshot; the
  // project column is the CURRENT cloud binding. Drift detection
  // reads the project column.
  //
  // EXCEPT for a local-orchestrated cloud deploy (self-hosted instance,
  // deployTarget=cloud + buildStrategy=local): the project MUST stay
  // local-canonical. `cloud_workspace_id` is the "this project lives on
  // the SaaS — proxy everything to it" primitive; setting it here would
  // flip the project to a SaaS proxy and break the next local build. The
  // workspace is still tracked per-deploy via `deployment.containerId`
  // (used for retirement of the previous workspace on redeploy), so
  // skipping the project column here loses nothing for this mode.
  const isLocalOrchestratedCloud =
    !env.CLOUD_MODE &&
    mergedMeta?.deployTarget === "cloud" &&
    mergedMeta?.buildStrategy === "local";
  if (mergedMeta?.workspaceId && !isLocalOrchestratedCloud) {
    await repos.project
      .setCloudWorkspaceId(project.id, mergedMeta.workspaceId)
      .catch((err) =>
        console.warn(
          `[deployment-lifecycle] setCloudWorkspaceId failed project=${project.id} workspace=${mergedMeta.workspaceId}: ${safeErrorMessage(err)}`,
        ),
      );
  }

  await repos.deployment.finishBuildSession(buildSessionId, "ready", result.durationMs, persistLogs());
  sessionManager.updateStatus(dep.id, "ready", {
    warningMessage: result.warningMessage,
  });

  notification.emit({
    organizationId: dep.organizationId,
    eventType: "deployment.succeeded",
    resourceType: "deployment",
    resourceId: dep.id,
    payload: {
      projectName: project.name,
      branch: dep.branch,
      commitSha: dep.commitSha,
      url: result.url,
      durationMs: result.durationMs,
    },
  });

  // Audit — async fire-and-forget. actorUserId null; the trigger
  // attribution lives on the original `deployment.created` row.
  // Records BOTH before and after for state transitions so an auditor
  // can see exactly what changed without joining the deployment table.
  audit.recordAsync(
    { organizationId: dep.organizationId, actorUserId: null },
    {
      eventType: "deployment.succeeded",
      resourceType: "deployment",
      resourceId: dep.id,
      before: { status: dep.status },
      after: {
        status: "ready",
        projectId: project.id,
        branch: dep.branch,
        commitSha: dep.commitSha,
        url: result.url,
        durationMs: result.durationMs,
      },
    },
  );

  // Async favicon detection - don't block the deploy response
  if (result.url) {
    void detectAndStoreFavicon(project.id, result.url);
  }

  // Webmail: flip mail-state `installed=true` so the /emails Open-webmail
  // CTA can finally surface. Slug is the only carrier of mailServerId
  // through the generic lifecycle - preserved by `ensureWebmailProject`.
  // For cloud deploys we also pass `result.url` so the success hook can
  // register an OpenResty proxy on the mail VPS pointing mail.<install>
  // → opsh.io (when that's the chosen hostname).
  if (project.framework === "webmail") {
    const mailServerId = mailServerIdFromWebmailSlug(project.slug);
    if (mailServerId) void markWebmailInstalled(mailServerId, project.organizationId, result.url);
  }
}
