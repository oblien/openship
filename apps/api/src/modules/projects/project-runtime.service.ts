/**
 * Project runtime service — logs, enable/disable (start/stop).
 */

import { repos } from "@repo/db";
import { NotFoundError, ValidationError } from "@repo/core";
import type { LogEntry } from "@repo/adapters";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";

// ─── Runtime logs ────────────────────────────────────────────────────────────

export async function getRuntimeLogs(projectId: string, userId: string, tail?: number) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  if (!p.activeDeploymentId) {
    throw new NotFoundError("No active deployment for project", projectId);
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep?.containerId) {
    throw new NotFoundError("No running container for project", projectId);
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  return runtime.getRuntimeLogs(dep.containerId, tail);
}

export async function streamRuntimeLogs(
  projectId: string,
  userId: string,
  onLog: (entry: LogEntry) => void,
  opts?: { tail?: number },
) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  if (!p.activeDeploymentId) {
    throw new NotFoundError("No active deployment for project", projectId);
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep?.containerId) {
    throw new NotFoundError("No running container for project", projectId);
  }

  const { runtime, serverId } = await resolveDeploymentRuntime(dep);
  const cleanup = await runtime.streamRuntimeLogs(dep.containerId, onLog, opts);
  return { cleanup, serverId };
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

export async function enableProject(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  if (!p.activeDeploymentId) {
    throw new ValidationError("No deployment to enable — deploy first");
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep?.containerId) {
    throw new ValidationError("No container found for active deployment");
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  await runtime.start(dep.containerId);
  return { success: true, message: "Project enabled" };
}

export async function disableProject(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  if (!p.activeDeploymentId) {
    return { success: true, message: "No active deployment" };
  }

  const dep = await repos.deployment.findById(p.activeDeploymentId);
  if (!dep?.containerId) {
    return { success: true, message: "No container to stop" };
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  await runtime.stop(dep.containerId);
  return { success: true, message: "Project disabled" };
}
