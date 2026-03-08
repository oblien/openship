/**
 * Deployment service — orchestrates build → deploy pipeline via adapters.
 *
 * Flow:
 *   1. Create deployment record (queued)
 *   2. Create build session (for SSE streaming)
 *   3. Execute build via adapter (onLog → SSE + DB)
 *   4. Deploy built image via adapter
 *   5. Register route + SSL
 *   6. Promote to active deployment
 */

import { repos, type Project, type Deployment } from "@repo/db";
import { NotFoundError, ForbiddenError, BUILD_ENV_VARS, SYSTEM } from "@repo/core";
import {
  type BuildConfig,
  type DeployConfig,
  type LogEntry,
} from "@repo/adapters";
import { platform } from "../../lib/controller-helpers";
import { decrypt } from "../../lib/encryption";
import { notifyDeploySuccess, notifyBuildFailed } from "../../lib/notifications";
import { withDefaults } from "../../lib/resources";
import { env } from "../../config/env";
import type { ResourceConfig } from "@repo/adapters";
import * as sessionManager from "./session-manager";
import type { TTriggerDeployBody } from "./deployment.schema";

/** Truncate an error message to prevent storing huge strings in DB */
function truncateError(msg: string): string {
  const max = SYSTEM.DEPLOYMENTS.MAX_ERROR_MESSAGE_LENGTH;
  return msg.length > max ? msg.slice(0, max) + "…" : msg;
}

// ─── List deployments ────────────────────────────────────────────────────────

export async function listDeployments(
  userId: string,
  opts: { projectId?: string; environment?: string; page?: number; perPage?: number },
) {
  if (opts.projectId) {
    // Verify ownership
    const project = await repos.project.findById(opts.projectId);
    if (!project || project.userId !== userId) {
      throw new NotFoundError("Project", opts.projectId);
    }
  }
  if (!opts.projectId) {
    // If no projectId, we would need to filter by user's projects
    // For now, require projectId
    return { rows: [], total: 0, page: 1, perPage: 20 };
  }
  return repos.deployment.listByProject(opts.projectId, {
    page: opts.page,
    perPage: opts.perPage,
    environment: opts.environment,
  });
}

// ─── Get deployment ──────────────────────────────────────────────────────────

export async function getDeployment(deploymentId: string, userId: string) {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) throw new NotFoundError("Deployment", deploymentId);

  // Verify ownership through project
  const project = await repos.project.findById(dep.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Deployment", deploymentId);
  }

  return dep;
}

// ─── Trigger deployment ──────────────────────────────────────────────────────

export async function triggerDeployment(userId: string, data: TTriggerDeployBody) {
  const project = await repos.project.findById(data.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", data.projectId);
  }

  if (!project.gitUrl) {
    throw new ForbiddenError("Project has no git repository configured");
  }

  const branch = data.branch ?? project.gitBranch ?? "main";
  const environment = data.environment ?? "production";

  // Check for duplicate builds — prevent concurrent builds for same project
  const { rows: existing } = await repos.deployment.listByProject(project.id, {
    page: 1,
    perPage: SYSTEM.DEPLOYMENTS.MAX_CONCURRENT_PER_PROJECT + 1,
  });
  const activeBuild = existing.find((d) =>
    ["queued", "building", "deploying"].includes(d.status),
  );
  if (activeBuild) {
    throw new ForbiddenError(
      `A deployment is already in progress (${activeBuild.id}). Cancel it first or wait for it to complete.`,
    );
  }

  // 1. Create deployment record
  const dep = await repos.deployment.create({
    projectId: project.id,
    userId,
    branch,
    commitSha: data.commitSha,
    environment,
    framework: project.framework,
    status: "queued",
  });

  // 2. Create build session (for SSE logs)
  const buildSess = await repos.deployment.createBuildSession({
    deploymentId: dep.id,
    projectId: project.id,
    status: "queued",
  });

  // 3. Start the build asynchronously (fire and forget)
  void executeBuildAndDeploy(project, dep, buildSess.id).catch((err) => {
    console.error(`[DEPLOY] Fatal error for ${dep.id}:`, err);
  });

  return {
    deployment: dep,
    buildSessionId: buildSess.id,
  };
}

// ─── Build & Deploy pipeline ─────────────────────────────────────────────────

async function executeBuildAndDeploy(
  project: Project,
  dep: Deployment,
  buildSessionId: string,
) {
  const { runtime, routing } = platform();
  const logs: LogEntry[] = [];

  // Create in-memory session for SSE
  sessionManager.createSession(buildSessionId, dep.id, project.id);

  const logCallback = (entry: LogEntry) => {
    logs.push(entry);
    sessionManager.appendLog(buildSessionId, entry);
  };

  try {
    // ── Build phase ────────────────────────────────────────────────────
    await repos.deployment.updateStatus(dep.id, "building");
    await repos.deployment.updateBuildSession(buildSessionId, {
      status: "building",
      startedAt: new Date(),
    });
    sessionManager.updateStatus(buildSessionId, "building");

    // Resolve resource configs
    const prodResources = withDefaults(project.resources as ResourceConfig | null);
    const buildResources = withDefaults(
      project.buildResources as ResourceConfig | null,
      { cpus: 2, cpuConfig: { quotaUs: 200_000, periodUs: 100_000 }, memoryMb: 4096 },
    );

    // Get env vars for this environment (decrypt values stored at rest)
    const rawEnvMap = await repos.project.getEnvMap(project.id, dep.environment);
    const envMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnvMap)) {
      try { envMap[k] = decrypt(v); } catch { envMap[k] = v; }
    }

    const buildConfig: BuildConfig = {
      sessionId: buildSessionId,
      projectId: project.id,
      repoUrl: project.gitUrl!,
      branch: dep.branch,
      commitSha: dep.commitSha ?? undefined,
      stack: project.framework ?? "unknown",
      packageManager: project.packageManager ?? "npm",
      installCommand: project.installCommand ?? "npm ci",
      buildCommand: project.buildCommand ?? "npm run build",
      outputDirectory: project.outputDirectory ?? "dist",
      envVars: { ...BUILD_ENV_VARS, ...envMap },
      resources: buildResources,
    };

    const buildResult = await runtime.build(buildConfig, logCallback);

    if (buildResult.status === "failed" || buildResult.status === "cancelled") {
      await repos.deployment.updateStatus(dep.id, buildResult.status as string);
      await repos.deployment.finishBuildSession(
        buildSessionId,
        buildResult.status as string,
        buildResult.durationMs ?? 0,
        logs,
      );
      sessionManager.updateStatus(buildSessionId, buildResult.status);
      return;
    }

    // ── Deploy phase ───────────────────────────────────────────────────
    await repos.deployment.updateStatus(dep.id, "deploying", {
      imageRef: buildResult.imageRef,
      buildDurationMs: buildResult.durationMs,
    });
    sessionManager.updateStatus(buildSessionId, "deploying");

    const deployConfig: DeployConfig = {
      deploymentId: dep.id,
      projectId: project.id,
      buildSessionId,
      environment: dep.environment,
      port: project.port ?? 3000,
      envVars: envMap,
      resources: prodResources,
      restartPolicy: "always",
    };

    const deployResult = await runtime.deploy(deployConfig);

    // Update deployment with container info
    await repos.deployment.setContainerId(dep.id, deployResult.containerId ?? "", deployResult.url);

    // ── Post-deploy: route registration ────────────────────────────────
    // Stop the previous active container (if this is a redeploy)
    if (project.activeDeploymentId) {
      const prev = await repos.deployment.findById(project.activeDeploymentId);
      if (prev?.containerId && prev.containerId !== deployResult.containerId) {
        await runtime.stop(prev.containerId).catch(() => {});
      }
    }

    // Register routes for all verified domains pointing at the new container
    if (deployResult.containerId) {
      const ip = await runtime.getContainerIp(deployResult.containerId);
      if (ip) {
        const targetUrl = `http://${ip}:${project.port ?? 3000}`;
        const domains = await repos.domain.listByProject(project.id);
        for (const d of domains) {
          if (d.verified) {
            await routing.registerRoute({
              domain: d.hostname,
              targetUrl,
              tls: d.sslStatus === "active",
            }).catch((err) => {
              console.error(`[DEPLOY] Failed to register route for ${d.hostname}:`, err);
            });
          }
        }
      }
    }

    await repos.deployment.updateStatus(dep.id, "ready");

    // Promote as active deployment
    await repos.project.setActiveDeployment(project.id, dep.id);

    // Finish build session
    await repos.deployment.finishBuildSession(buildSessionId, "ready", buildResult.durationMs ?? 0, logs);
    sessionManager.updateStatus(buildSessionId, "ready");

    // ── Notify on success (best-effort, never throws) ──────────────────
    const user = await repos.user.findById(dep.userId);
    if (user?.email) {
      void notifyDeploySuccess(user.email, project, {
        branch: dep.branch,
        commitSha: dep.commitSha,
        url: deployResult.url,
        durationMs: buildResult.durationMs,
      });
    }
  } catch (err) {
    const message = truncateError(err instanceof Error ? err.message : "Unknown error");
    logCallback({ timestamp: new Date().toISOString(), message: `Error: ${message}`, level: "error" });

    await repos.deployment.updateStatus(dep.id, "failed", { errorMessage: message });
    await repos.deployment.finishBuildSession(buildSessionId, "failed", 0, logs);
    sessionManager.updateStatus(buildSessionId, "failed");

    // ── Notify on failure (best-effort) ────────────────────────────────────────
    const user = await repos.user.findById(dep.userId);
    if (user?.email) {
      const lastLogs = logs.slice(-50).map((l) => l.message).join("\n");
      void notifyBuildFailed(user.email, project, {
        branch: dep.branch,
        error: message,
        logs: lastLogs,
      });
    }
  }
}

// ─── Deployment actions ──────────────────────────────────────────────────────

export async function cancelDeployment(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);

  if (!["queued", "building", "deploying"].includes(dep.status)) {
    throw new ForbiddenError("Cannot cancel a deployment that is not in progress");
  }

  const { runtime } = platform();

  // If there's a build session, cancel it
  if (dep.status === "building") {
    await runtime.cancelBuild(deploymentId);
  }

  // If there's a container, destroy it
  if (dep.containerId) {
    await runtime.destroy(dep.containerId);
  }

  await repos.deployment.updateStatus(deploymentId, "cancelled");
}

export async function rollbackDeployment(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);

  if (dep.status !== "ready") {
    throw new ForbiddenError("Can only rollback to a successful deployment");
  }

  // Re-deploy this deployment's image
  const project = await repos.project.findById(dep.projectId);
  if (!project) throw new NotFoundError("Project", dep.projectId);

  // Stop current active container if any
  if (project.activeDeploymentId && project.activeDeploymentId !== deploymentId) {
    const current = await repos.deployment.findById(project.activeDeploymentId);
    if (current?.containerId) {
      const { runtime } = platform();
      await runtime.stop(current.containerId).catch(() => {});
    }
  }

  // Promote this deployment as active
  await repos.project.setActiveDeployment(project.id, deploymentId);

  // Restart the target container
  if (dep.containerId) {
    const { runtime } = platform();
    await runtime.start(dep.containerId);
  }

  return dep;
}

export async function getDeploymentLogs(deploymentId: string, userId: string, tail?: number) {
  const dep = await getDeployment(deploymentId, userId);

  // Try in-memory session first
  const buildSessions = await repos.deployment.findBuildSession(deploymentId);
  if (buildSessions?.logs) {
    return buildSessions.logs as LogEntry[];
  }

  // Fall back to runtime
  if (dep.containerId) {
    const { runtime } = platform();
    return runtime.getRuntimeLogs(dep.containerId, tail);
  }

  return [];
}

// ─── Restart a deployment container ──────────────────────────────────────────

export async function restartDeployment(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);

  if (dep.status !== "ready") {
    throw new ForbiddenError("Can only restart a running deployment");
  }
  if (!dep.containerId) {
    throw new ForbiddenError("Deployment has no container");
  }

  const { runtime } = platform();
  await runtime.stop(dep.containerId);
  await runtime.start(dep.containerId);

  return dep;
}

// ─── Container info ──────────────────────────────────────────────────────────

export async function getContainerInfo(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);
  if (!dep.containerId) {
    throw new ForbiddenError("Deployment has no container");
  }
  const { runtime: rt } = platform();
  return rt.getContainerInfo(dep.containerId);
}

// ─── Container usage ─────────────────────────────────────────────────────────

export async function getContainerUsage(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);
  if (!dep.containerId) {
    throw new ForbiddenError("Deployment has no container");
  }
  const { runtime: rt } = platform();
  return rt.getUsage(dep.containerId);
}

// ─── Build logs (separate from runtime logs) ─────────────────────────────────

export async function getBuildLogs(deploymentId: string, userId: string) {
  const dep = await getDeployment(deploymentId, userId);

  const buildSession = await repos.deployment.findBuildSession(deploymentId);
  if (!buildSession?.logs) {
    return [];
  }
  return buildSession.logs as LogEntry[];
}

// ─── SSE streaming ───────────────────────────────────────────────────────────

export { subscribe as subscribeToBuildSession } from "./session-manager";
