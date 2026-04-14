/**
 * Deployment lifecycle hooks — shared onSuccess / onFailure for the
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

import { repos, type Project, type Deployment } from "@repo/db";
import { DockerRuntime, type LogEntry } from "@repo/adapters";
import type { RuntimeAdapter } from "@repo/adapters";
import { SYSTEM } from "@repo/core";
import { notifyDeploySuccess, notifyBuildFailed } from "../../lib/notifications";
import * as sessionManager from "./session-manager";
import { detectAndStoreFavicon } from "../../lib/favicon-detector";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LifecycleContext {
  runtime: RuntimeAdapter;
  project: Project;
  dep: Deployment;
  buildSessionId: string;
  /** Returns collapsed logs for DB persistence. */
  persistLogs: () => LogEntry[];
  /** Provisioned resources — set by the orchestrator as phases progress. */
  provisioned: { imageRef?: string };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncateError(msg: string): string {
  const max = SYSTEM.DEPLOYMENTS.MAX_ERROR_MESSAGE_LENGTH;
  return msg.length > max ? msg.slice(0, max) + "…" : msg;
}

async function cleanupBuildArtifact(runtime: RuntimeAdapter, artifactRef: string): Promise<void> {
  if (runtime instanceof DockerRuntime) {
    await runtime.removeImage(artifactRef);
    return;
  }

  await runtime.destroy(artifactRef);
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export async function onFailure(
  ctx: LifecycleContext,
  error?: string,
  durationMs?: number,
  errorMeta?: { errorCode?: string; errorDetails?: Record<string, unknown>; errorMessage?: string },
): Promise<void> {
  const { runtime, project, dep, buildSessionId, persistLogs, provisioned } = ctx;

  // 1. Force destroy provisioned resources — always delete the workspace/container
  //    on failure so the user doesn't have to manually clean up.
  if (provisioned.imageRef) {
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

  // 2. Persist failure state
  const errorMessage = error ? truncateError(error) : undefined;
  const collapsed = persistLogs();
  await repos.deployment.updateStatus(dep.id, "failed", { errorMessage });
  await repos.deployment.finishBuildSession(buildSessionId, "failed", durationMs ?? 0, collapsed);
  sessionManager.updateStatus(dep.id, "failed", {
    ...errorMeta,
    errorMessage,
  });

  // 3. Notify
  const user = await repos.user.findById(dep.userId);
  if (user?.email) {
    const lastLogs = collapsed.slice(-50).map((l) => l.message).join("\n");
    void notifyBuildFailed(user.email, project, {
      branch: dep.branch,
      error: errorMessage ?? "Unknown error",
      logs: lastLogs,
    });
  }
}

export async function onCancelled(
  ctx: LifecycleContext,
  durationMs?: number,
): Promise<void> {
  const { runtime, dep, buildSessionId, persistLogs, provisioned } = ctx;

  // Force destroy provisioned resources
  if (provisioned.imageRef) {
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
    if (serviceDep.containerId) {
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
  await repos.deployment.updateStatus(dep.id, "ready", {
    errorMessage: null,
    meta: result.metaPatch
      ? { ...((dep.meta as Record<string, unknown> | null) ?? {}), ...result.metaPatch }
      : dep.meta,
  });
  await repos.project.setActiveDeployment(project.id, dep.id);
  await repos.deployment.finishBuildSession(buildSessionId, "ready", result.durationMs, persistLogs());
  sessionManager.updateStatus(dep.id, "ready", {
    warningMessage: result.warningMessage,
  });

  const user = await repos.user.findById(dep.userId);
  if (user?.email) {
    void notifyDeploySuccess(user.email, project, {
      branch: dep.branch,
      commitSha: dep.commitSha,
      url: result.url,
      durationMs: result.durationMs,
    });
  }

  // Async favicon detection — don't block the deploy response
  if (result.url) {
    void detectAndStoreFavicon(project.id, result.url);
  }
}
