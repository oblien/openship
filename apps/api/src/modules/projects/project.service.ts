/**
 * Project service — business logic for project CRUD, env vars, and resources.
 *
 * All database access goes through @repo/db repos.
 * All resource encoding/decoding goes through lib/resources.
 */

import { repos, type Project } from "@repo/db";
import { slugify, NotFoundError, ConflictError, ValidationError, ForbiddenError, SYSTEM } from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import { platform } from "../../lib/controller-helpers";
import { encrypt, decrypt } from "../../lib/encryption";
import { encodeResources, decodeResources, withDefaults } from "../../lib/resources";
import { env } from "../../config";
import type { TCreateProjectBody, TUpdateProjectBody, TSetEnvVarsBody, TUpdateResourcesBody } from "./project.schema";

// ─── Ensure project (create or return existing) ─────────────────────────────

/**
 * Create a project if it doesn't exist, or update config if it does.
 * Uses TCreateProjectBody — same shape as createProject.
 * Mandatory first step before requesting build access.
 */
export async function ensureProject(userId: string, data: TCreateProjectBody) {
  const nameSlug = slugify(data.name);
  const desiredSlug = data.slug || nameSlug;

  // Look up by name-derived slug first (stable project identity),
  // then fall back to desired slug in case it was already created with it
  let project = await repos.project.findBySlug(userId, nameSlug);
  if (!project && desiredSlug !== nameSlug) {
    project = await repos.project.findBySlug(userId, desiredSlug);
  }
  let created = false;

  if (!project) {
    let gitUrl: string | undefined;
    if (data.gitOwner && data.gitRepo) {
      gitUrl = `https://github.com/${data.gitOwner}/${data.gitRepo}.git`;
    }

    const safeLocalPath = data.localPath && !env.CLOUD_MODE ? data.localPath : undefined;

    project = await repos.project.create({
      userId,
      name: data.name,
      slug: desiredSlug,
      localPath: safeLocalPath,
      gitProvider: safeLocalPath ? "local" : (data.gitProvider ?? "github"),
      gitOwner: data.gitOwner,
      gitRepo: data.gitRepo,
      gitBranch: data.gitBranch ?? "main",
      gitUrl,
      installationId: data.installationId,
      framework: data.framework ?? "unknown",
      packageManager: data.packageManager ?? "npm",
      installCommand: data.installCommand,
      buildCommand: data.buildCommand,
      outputDirectory: data.outputDirectory,
      productionPaths: data.productionPaths,
      rootDirectory: data.rootDirectory,
      startCommand: data.startCommand,
      buildImage: data.buildImage,
      productionMode: data.productionMode ?? "host",
      port: data.port ?? 3000,
      hasServer: data.hasServer ?? true,
      hasBuild: data.hasBuild ?? true,
    });
    created = true;
  } else {
    // Always overwrite config fields — ensure is called with the full
    // config every time, so "undefined" means "not provided by this caller"
    // while an explicit empty string means "user cleared this field".
    const update: Record<string, unknown> = {};
    if (data.framework !== undefined) update.framework = data.framework;
    if (data.packageManager !== undefined) update.packageManager = data.packageManager;
    if (data.installCommand !== undefined) update.installCommand = data.installCommand;
    if (data.buildCommand !== undefined) update.buildCommand = data.buildCommand;
    if (data.outputDirectory !== undefined) update.outputDirectory = data.outputDirectory;
    if (data.productionPaths !== undefined) update.productionPaths = data.productionPaths;
    if (data.rootDirectory !== undefined) update.rootDirectory = data.rootDirectory;
    if (data.startCommand !== undefined) update.startCommand = data.startCommand;
    if (data.buildImage !== undefined) update.buildImage = data.buildImage;
    if (data.port !== undefined) update.port = data.port;
    if (data.productionMode !== undefined) update.productionMode = data.productionMode;
    if (data.hasServer !== undefined) update.hasServer = data.hasServer;
    if (data.hasBuild !== undefined) update.hasBuild = data.hasBuild;
    if (data.slug !== undefined) update.slug = data.slug;

    if (Object.keys(update).length > 0) {
      await repos.project.update(project.id, update);
    }
  }

  return { success: true, project_id: project.id, created };
}

// ─── List projects ───────────────────────────────────────────────────────────

export async function listProjects(userId: string, opts?: { page?: number; perPage?: number }) {
  return repos.project.listByUser(userId, opts);
}

// ─── Get single project ──────────────────────────────────────────────────────

export async function getProject(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);
  return enrichProject(p);
}

// ─── Create project ──────────────────────────────────────────────────────────

export async function createProject(userId: string, data: TCreateProjectBody) {
  const slug = slugify(data.name);

  // Enforce project limit per user
  const { total } = await repos.project.listByUser(userId, { page: 1, perPage: 1 });
  if (total >= SYSTEM.PROJECTS.MAX_PER_USER) {
    throw new ValidationError(`Project limit reached (${SYSTEM.PROJECTS.MAX_PER_USER})`);
  }

  // Ensure unique slug for this user
  const existing = await repos.project.findBySlug(userId, slug);
  if (existing) throw new ConflictError(`Project "${data.name}" already exists`);

  // Build git clone URL if repo info provided
  let gitUrl: string | undefined;
  if (data.gitOwner && data.gitRepo) {
    gitUrl = `https://github.com/${data.gitOwner}/${data.gitRepo}.git`;
  }

  // Only allow localPath in non-cloud modes (enforced at route level too)
  const safeLocalPath = data.localPath && !env.CLOUD_MODE ? data.localPath : undefined;

  const p = await repos.project.create({
    userId,
    name: data.name,
    slug,
    localPath: safeLocalPath,
    gitProvider: safeLocalPath ? "local" : (data.gitProvider ?? "github"),
    gitOwner: data.gitOwner,
    gitRepo: data.gitRepo,
    gitBranch: data.gitBranch ?? "main",
    gitUrl,
    installationId: data.installationId,
    framework: data.framework ?? "unknown",
    packageManager: data.packageManager ?? "npm",
    installCommand: data.installCommand,
    buildCommand: data.buildCommand,
    outputDirectory: data.outputDirectory,
    productionPaths: data.productionPaths,
    rootDirectory: data.rootDirectory,
    productionMode: data.productionMode ?? "host",
    port: data.port ?? 3000,
  });

  return enrichProject(p);
}

// ─── Update project ──────────────────────────────────────────────────────────

export async function updateProject(projectId: string, userId: string, data: TUpdateProjectBody) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  // If renaming, regenerate slug and check uniqueness
  const update: Record<string, unknown> = { ...data };
  if (data.name && data.name !== p.name) {
    const newSlug = slugify(data.name);
    const existing = await repos.project.findBySlug(userId, newSlug);
    if (existing && existing.id !== projectId) {
      throw new ConflictError(`Project "${data.name}" already exists`);
    }
    update.slug = newSlug;
  }

  // Update git URL if source changed
  if (data.gitOwner || data.gitRepo) {
    const owner = data.gitOwner ?? p.gitOwner;
    const repo = data.gitRepo ?? p.gitRepo;
    if (owner && repo) {
      update.gitUrl = `https://github.com/${owner}/${repo}.git`;
    }
  }

  await repos.project.update(projectId, update);
  const updated = await repos.project.findById(projectId);
  return enrichProject(updated!);
}

// ─── Delete project ──────────────────────────────────────────────────────────

export async function deleteProject(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const { runtime, routing } = platform();

  // Destroy ALL deployment containers (not just active)
  try {
    const { rows: allDeps } = await repos.deployment.listByProject(projectId, { perPage: 1000 });
    for (const dep of allDeps) {
      if (dep.containerId) {
        await runtime.destroy(dep.containerId).catch((err) => {
          console.error(`[PROJECT] Failed to destroy container ${dep.containerId}:`, err);
        });
      }
    }
  } catch (err) {
    console.error(`[PROJECT] Failed to clean up deployments for ${projectId}:`, err);
  }

  // Remove domain routes
  try {
    const domains = await repos.domain.listByProject(projectId);
    for (const d of domains) {
      await routing.removeRoute(d.hostname).catch(() => {});
    }
  } catch {
    // Best-effort cleanup
  }

  // Delete all deployments + build sessions from DB
  await repos.deployment.deleteByProjectId(projectId);

  await repos.project.softDelete(projectId);
}

// ─── Environment variables ───────────────────────────────────────────────────

export async function listEnvVars(projectId: string, userId: string, environment?: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const vars = await repos.project.listEnvVars(projectId, environment);

  // Decrypt then mask secrets for API response
  return vars.map((v) => {
    let plainValue: string;
    try {
      plainValue = decrypt(v.value);
    } catch {
      // Legacy unencrypted value — return as-is
      plainValue = v.value;
    }
    return {
      id: v.id,
      key: v.key,
      value: v.isSecret ? "••••••••" : plainValue,
      environment: v.environment,
      isSecret: v.isSecret,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  });
}

export async function setEnvVars(projectId: string, userId: string, data: TSetEnvVarsBody) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  // Validate no duplicate keys
  const keys = data.vars.map((v) => v.key);
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    throw new ValidationError("Duplicate environment variable keys");
  }

  // Validate limits
  if (data.vars.length > SYSTEM.ENV_VARS.MAX_PER_PROJECT) {
    throw new ValidationError(
      `Maximum ${SYSTEM.ENV_VARS.MAX_PER_PROJECT} variables per project`,
    );
  }

  // Encrypt values before storage
  const encrypted = data.vars.map((v) => ({
    key: v.key,
    value: encrypt(v.value),
    isSecret: v.isSecret,
  }));

  await repos.project.bulkSetEnvVars(projectId, data.environment, encrypted);
  return { count: data.vars.length };
}

// ─── Resources ───────────────────────────────────────────────────────────────

export async function getResources(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const production = p.resources as ResourceConfig | null;
  const build = p.buildResources as ResourceConfig | null;
  return encodeResources(production, build, p.sleepMode ?? "auto_sleep", p.port ?? 3000);
}

export async function updateResources(projectId: string, userId: string, data: TUpdateResourcesBody) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const update: Record<string, unknown> = {};

  if (data.production) {
    update.resources = decodeResources(data.production);
  }
  if (data.build) {
    update.buildResources = decodeResources(data.build);
  }
  if (data.sleepMode) {
    update.sleepMode = data.sleepMode;
  }
  if (data.port) {
    update.port = data.port;
  }

  await repos.project.update(projectId, update);
  return getResources(projectId, userId);
}

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

  const { runtime } = platform();
  return runtime.getRuntimeLogs(dep.containerId, tail);
}

export async function streamRuntimeLogs(
  projectId: string,
  userId: string,
  onLog: (entry: import("@repo/adapters").LogEntry) => void,
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

  const { runtime } = platform();
  return runtime.streamRuntimeLogs(dep.containerId, onLog, opts);
}

// ─── Git info ────────────────────────────────────────────────────────────────

export async function getGitInfo(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  return {
    gitProvider: p.gitProvider,
    gitOwner: p.gitOwner,
    gitRepo: p.gitRepo,
    gitBranch: p.gitBranch,
    gitUrl: p.gitUrl,
    installationId: p.installationId,
  };
}

export async function setBranch(projectId: string, userId: string, branch: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  await repos.project.update(projectId, { gitBranch: branch });
  return { success: true, branch };
}

// ─── Build options ───────────────────────────────────────────────────────────

export async function updateOptions(projectId: string, userId: string, options: Record<string, unknown>) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const update: Record<string, unknown> = {};
  if (options.buildCommand !== undefined) update.buildCommand = options.buildCommand;
  if (options.installCommand !== undefined) update.installCommand = options.installCommand;
  if (options.outputDirectory !== undefined) update.outputDirectory = options.outputDirectory;
  if (options.productionPaths !== undefined) update.productionPaths = options.productionPaths;
  if (options.rootDirectory !== undefined) update.rootDirectory = options.rootDirectory;
  if (options.startCommand !== undefined) update.startCommand = options.startCommand;
  if (options.productionPort !== undefined) update.port = options.productionPort;
  if (options.packageManager !== undefined) update.packageManager = options.packageManager;
  if (options.framework !== undefined) update.framework = options.framework;
  if (options.productionMode !== undefined) update.productionMode = options.productionMode;

  if (Object.keys(update).length > 0) {
    await repos.project.update(projectId, update);
  }

  const updated = await repos.project.findById(projectId);
  return enrichProject(updated!);
}

// ─── Sleep mode ──────────────────────────────────────────────────────────────

export async function setSleepMode(projectId: string, userId: string, sleepMode: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  if (!["auto_sleep", "always_on"].includes(sleepMode)) {
    throw new ValidationError("Invalid sleep mode. Must be 'auto_sleep' or 'always_on'");
  }

  await repos.project.update(projectId, { sleepMode });
  return { success: true, sleepMode };
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

  const { runtime } = platform();
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

  const { runtime } = platform();
  await runtime.stop(dep.containerId);
  return { success: true, message: "Project disabled" };
}

// ─── Project deployments ─────────────────────────────────────────────────────

export async function listProjectDeployments(
  projectId: string,
  userId: string,
  opts?: { page?: number; perPage?: number; environment?: string },
) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  return repos.deployment.listByProject(projectId, opts);
}

// ─── Deployment session ──────────────────────────────────────────────────────

export async function getLatestDeploymentSession(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  if (!p.activeDeploymentId) {
    return { session: null };
  }

  const session = await repos.deployment.findBuildSessionByDeploymentId(p.activeDeploymentId);
  return {
    session: session ? {
      id: session.id,
      deploymentId: session.deploymentId,
      status: session.status,
      durationMs: session.durationMs,
    } : null,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Enrich a project row with computed fields */
function enrichProject(p: Project) {
  const production = p.resources as ResourceConfig | null;
  const build = p.buildResources as ResourceConfig | null;
  return {
    ...p,
    resources: encodeResources(
      production,
      build,
      p.sleepMode ?? "auto_sleep",
      p.port ?? 3000,
    ),
  };
}
