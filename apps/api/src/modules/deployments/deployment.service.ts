/**
 * Deployment service — deployment CRUD and runtime operations.
 *
 * Build pipeline logic lives in build.service.ts.
 * SSL operations live in ssl.service.ts.
 */

import { repos } from "@repo/db";
import { NotFoundError, ForbiddenError } from "@repo/core";
import type { LogEntry } from "@repo/adapters";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { isComposeProject } from "./compose";

async function listComposeContainerIds(deploymentId: string): Promise<string[]> {
  const rows = await repos.service.listByDeployment(deploymentId);
  return [...new Set(rows.map((row) => row.containerId).filter((id): id is string => !!id))];
}

// ─── List deployments ────────────────────────────────────────────────────────

export async function listDeployments(
  userId: string,
  opts: { projectId?: string; environment?: string; page?: number; perPage?: number },
) {
  if (opts.projectId) {
    const project = await repos.project.findById(opts.projectId);
    if (!project || project.userId !== userId) {
      throw new NotFoundError("Project", opts.projectId);
    }
    return repos.deployment.listByProject(opts.projectId, {
      page: opts.page,
      perPage: opts.perPage,
      environment: opts.environment,
    });
  }

  // No projectId — return all deployments for this user, enriched with project names
  const result = await repos.deployment.listByUser(userId, {
    page: opts.page,
    perPage: opts.perPage,
  });

  const projectIds = [...new Set(result.rows.map((d) => d.projectId))];
  const projectMap = new Map<string, string>();
  for (const pid of projectIds) {
    const p = await repos.project.findById(pid);
    if (p) projectMap.set(pid, p.name);
  }

  const enriched = result.rows.map((d) => ({
    ...d,
    projectName: projectMap.get(d.projectId) ?? "Unknown",
  }));

  return { ...result, rows: enriched };
}

// ─── Get deployment ──────────────────────────────────────────────────────────

export async function getDeployment(deploymentId: string, userId: string) {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) throw new NotFoundError("Deployment", deploymentId);

  const project = await repos.project.findById(dep.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Deployment", deploymentId);
  }

  return dep;
}

// ─── Delete deployment ───────────────────────────────────────────────────────

export async function deleteDeployment(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);

  if (["queued", "building", "deploying"].includes(dep.status)) {
    throw new ForbiddenError("Cannot delete a deployment that is in progress. Cancel it first.");
  }

  const project = await repos.project.findById(dep.projectId);
  const containerIds = project && isComposeProject(project)
    ? await listComposeContainerIds(dep.id)
    : dep.containerId
      ? [dep.containerId]
      : [];

  if (containerIds.length > 0) {
    const runtime = await resolveDeploymentRuntime(dep);
    for (const containerId of containerIds) {
      await runtime.stop(containerId).catch(() => {});
      await runtime.destroy(containerId).catch(() => {});
    }
  }

  // If this is the active deployment, clear it from the project
  if (project && project.activeDeploymentId === deploymentId) {
    await repos.project.setActiveDeployment(project.id, null);
  }

  await repos.deployment.deleteDeployment(deploymentId);
}

// ─── Rollback deployment ─────────────────────────────────────────────────────

export async function rollbackDeployment(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);

  if (dep.status !== "ready") {
    throw new ForbiddenError("Can only rollback to a successful deployment");
  }

  const project = await repos.project.findById(dep.projectId);
  if (!project) throw new NotFoundError("Project", dep.projectId);
  const targetContainerIds = isComposeProject(project)
    ? await listComposeContainerIds(dep.id)
    : dep.containerId
      ? [dep.containerId]
      : [];
  if (targetContainerIds.length === 0) {
    throw new ForbiddenError("Rollback artifact is no longer retained for this deployment");
  }

  if (project.activeDeploymentId && project.activeDeploymentId !== deploymentId) {
    const current = await repos.deployment.findById(project.activeDeploymentId);
    if (current) {
      const runtime = await resolveDeploymentRuntime(current);
      const currentContainerIds = isComposeProject(project)
        ? await listComposeContainerIds(current.id)
        : current.containerId
          ? [current.containerId]
          : [];
      for (const containerId of currentContainerIds) {
        await runtime.stop(containerId).catch(() => {});
      }
    }
  }

  await repos.project.setActiveDeployment(project.id, deploymentId);

  const runtime = await resolveDeploymentRuntime(dep);
  for (const containerId of targetContainerIds) {
    await runtime.start(containerId);
  }

  return dep;
}

// ─── Deployment logs ─────────────────────────────────────────────────────────

export async function getDeploymentLogs(deploymentId: string, userId: string, tail?: number) {
  const dep = await getDeployment(deploymentId, userId);

  const buildSessions = await repos.deployment.findBuildSession(deploymentId);
  if (buildSessions?.logs) {
    return buildSessions.logs as LogEntry[];
  }

  if (dep.containerId) {
    const runtime = await resolveDeploymentRuntime(dep);
    return runtime.getRuntimeLogs(dep.containerId, tail);
  }

  return [];
}

// ─── Restart deployment ──────────────────────────────────────────────────────

export async function restartDeployment(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);

  if (dep.status !== "ready") {
    throw new ForbiddenError("Can only restart a running deployment");
  }
  const project = await repos.project.findById(dep.projectId);
  const containerIds = project && isComposeProject(project)
    ? await listComposeContainerIds(dep.id)
    : dep.containerId
      ? [dep.containerId]
      : [];
  if (containerIds.length === 0) {
    throw new ForbiddenError("Deployment has no container");
  }

  const runtime = await resolveDeploymentRuntime(dep);
  for (const containerId of containerIds) {
    await runtime.restart(containerId);
  }

  return dep;
}

// ─── Container info ──────────────────────────────────────────────────────────

export async function getContainerInfo(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);
  if (!dep.containerId) {
    throw new ForbiddenError("Deployment has no container");
  }
  const runtime = await resolveDeploymentRuntime(dep);
  return runtime.getContainerInfo(dep.containerId);
}

// ─── Container usage ─────────────────────────────────────────────────────────

export async function getContainerUsage(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);
  if (!dep.containerId) {
    throw new ForbiddenError("Deployment has no container");
  }
  const runtime = await resolveDeploymentRuntime(dep);
  return runtime.getUsage(dep.containerId);
}

// ─── Build logs ──────────────────────────────────────────────────────────────

export async function getBuildLogs(deploymentId: string, userId: string) {
  await getDeployment(deploymentId, userId);

  const buildSession = await repos.deployment.findBuildSession(deploymentId);
  if (!buildSession?.logs) {
    return [];
  }
  return buildSession.logs as LogEntry[];
}


