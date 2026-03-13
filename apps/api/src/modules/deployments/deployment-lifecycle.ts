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
import type { LogEntry } from "@repo/adapters";
import type { RuntimeAdapter } from "@repo/adapters";
import { SYSTEM } from "@repo/core";
import { notifyDeploySuccess, notifyBuildFailed } from "../../lib/notifications";
import * as sessionManager from "./session-manager";

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

// ─── Hooks ───────────────────────────────────────────────────────────────────

export async function onFailure(
  ctx: LifecycleContext,
  error?: string,
  durationMs?: number,
): Promise<void> {
  const { runtime, project, dep, buildSessionId, persistLogs, provisioned } = ctx;

  // 1. Force destroy provisioned resources — always delete the workspace/container
  //    on failure so the user doesn't have to manually clean up.
  if (provisioned.imageRef) {
    try {
      await runtime.destroy(provisioned.imageRef);
    } catch (destroyErr) {
      console.error(
        `[DEPLOY] Failed to destroy ${provisioned.imageRef} on failure:`,
        destroyErr,
      );
      // Retry once after a short delay
      await new Promise((r) => setTimeout(r, 2000));
      await runtime.destroy(provisioned.imageRef).catch((retryErr) => {
        console.error(
          `[DEPLOY] Retry destroy also failed for ${provisioned.imageRef}:`,
          retryErr,
        );
      });
    }
  }

  // 2. Persist failure state
  const errorMessage = error ? truncateError(error) : undefined;
  const collapsed = persistLogs();
  await repos.deployment.updateStatus(dep.id, "failed", { errorMessage });
  await repos.deployment.finishBuildSession(buildSessionId, "failed", durationMs ?? 0, collapsed);
  sessionManager.updateStatus(dep.id, "failed");

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
      await runtime.destroy(provisioned.imageRef);
    } catch (destroyErr) {
      console.error(
        `[DEPLOY] Failed to destroy ${provisioned.imageRef} on cancel:`,
        destroyErr,
      );
      await new Promise((r) => setTimeout(r, 2000));
      await runtime.destroy(provisioned.imageRef).catch(() => {});
    }
  }

  await repos.deployment.updateStatus(dep.id, "cancelled");
  await repos.deployment.finishBuildSession(buildSessionId, "cancelled", durationMs ?? 0, persistLogs());
  sessionManager.updateStatus(dep.id, "cancelled");
}

export async function onSuccess(
  ctx: LifecycleContext,
  result: { containerId: string; url?: string; durationMs: number },
): Promise<void> {
  const { project, dep, buildSessionId, persistLogs } = ctx;

  await repos.deployment.setContainerId(dep.id, result.containerId, result.url);
  await repos.deployment.updateStatus(dep.id, "ready");
  await repos.project.setActiveDeployment(project.id, dep.id);
  await repos.deployment.finishBuildSession(buildSessionId, "ready", result.durationMs, persistLogs());
  sessionManager.updateStatus(dep.id, "ready");

  const user = await repos.user.findById(dep.userId);
  if (user?.email) {
    void notifyDeploySuccess(user.email, project, {
      branch: dep.branch,
      commitSha: dep.commitSha,
      url: result.url,
      durationMs: result.durationMs,
    });
  }
}
