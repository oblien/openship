/**
 * Project CRUD service — create, read, update, list, ensure.
 */

import { repos, type Project } from "@repo/db";
import { slugify, NotFoundError, ConflictError, ValidationError, SYSTEM } from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import { encodeResources } from "../../lib/resources";
import { normalizeRollbackWindow } from "../../lib/release-retention";
import { env } from "../../config";
import type { TCreateProjectBody, TUpdateProjectBody } from "./project.schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Enrich a project row with computed fields */
export async function enrichProject(p: Project) {
  const production = p.resources as ResourceConfig | null;
  const build = p.buildResources as ResourceConfig | null;

  // Resolve deploy target + server name from the active deployment's meta
  let deployTarget: string | null = null;
  let serverName: string | null = null;
  if (p.activeDeploymentId) {
    const dep = await repos.deployment.findById(p.activeDeploymentId);
    const meta = dep?.meta as { deployTarget?: string; serverId?: string } | null;
    deployTarget = meta?.deployTarget ?? null;
    if (meta?.serverId) {
      const server = await repos.server.get(meta.serverId);
      serverName = server?.name || server?.sshHost || null;
    }
  }

  return {
    ...p,
    deployTarget,
    serverName,
    resources: encodeResources(
      production,
      build,
      p.sleepMode ?? "auto_sleep",
      p.port ?? 3000,
    ),
  };
}

// ─── Ensure project (create or return existing) ─────────────────────────────

export async function ensureProject(userId: string, data: TCreateProjectBody) {
  const nameSlug = slugify(data.name);
  const desiredSlug = data.slug || nameSlug;

  let project = await repos.project.findBySlug(userId, nameSlug);
  if (!project && desiredSlug !== nameSlug) {
    project = await repos.project.findBySlug(userId, desiredSlug);
  }
  let created = false;

  if (!project) {
    const safeLocalPath = data.localPath && !env.CLOUD_MODE ? data.localPath : undefined;

    let gitUrl: string | undefined;
    if (!safeLocalPath && data.gitOwner && data.gitRepo) {
      gitUrl = `https://github.com/${data.gitOwner}/${data.gitRepo}.git`;
    }

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
      rollbackWindow: data.rollbackWindow !== undefined
        ? normalizeRollbackWindow(data.rollbackWindow)
        : null,
    });
    created = true;
  } else {
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
    if (data.localPath !== undefined) {
      const safePath = data.localPath && !env.CLOUD_MODE ? data.localPath : null;
      update.localPath = safePath;
      if (safePath) {
        update.gitProvider = "local";
        update.gitUrl = null;
      }
    }
    if (data.rollbackWindow !== undefined) {
      update.rollbackWindow = data.rollbackWindow === null
        ? null
        : normalizeRollbackWindow(data.rollbackWindow);
    }

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

  const { total } = await repos.project.listByUser(userId, { page: 1, perPage: 1 });
  if (total >= SYSTEM.PROJECTS.MAX_PER_USER) {
    throw new ValidationError(`Project limit reached (${SYSTEM.PROJECTS.MAX_PER_USER})`);
  }

  const existing = await repos.project.findBySlug(userId, slug);
  if (existing) throw new ConflictError(`Project "${data.name}" already exists`);

  const safeLocalPath = data.localPath && !env.CLOUD_MODE ? data.localPath : undefined;

  let gitUrl: string | undefined;
  if (!safeLocalPath && data.gitOwner && data.gitRepo) {
    gitUrl = `https://github.com/${data.gitOwner}/${data.gitRepo}.git`;
  }

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
    rollbackWindow: data.rollbackWindow !== undefined
      ? normalizeRollbackWindow(data.rollbackWindow)
      : null,
  });

  return enrichProject(p);
}

// ─── Update project ──────────────────────────────────────────────────────────

export async function updateProject(projectId: string, userId: string, data: TUpdateProjectBody) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const update: Record<string, unknown> = { ...data };
  if (data.name && data.name !== p.name) {
    const newSlug = slugify(data.name);
    const existing = await repos.project.findBySlug(userId, newSlug);
    if (existing && existing.id !== projectId) {
      throw new ConflictError(`Project "${data.name}" already exists`);
    }
    update.slug = newSlug;
  }

  if (data.gitOwner || data.gitRepo) {
    const owner = data.gitOwner ?? p.gitOwner;
    const repo = data.gitRepo ?? p.gitRepo;
    if (owner && repo) {
      update.gitUrl = `https://github.com/${owner}/${repo}.git`;
    }
  }

  if (data.rollbackWindow !== undefined) {
    update.rollbackWindow = data.rollbackWindow === null
      ? null
      : normalizeRollbackWindow(data.rollbackWindow);
  }

  await repos.project.update(projectId, update);
  const updated = await repos.project.findById(projectId);
  return enrichProject(updated!);
}

// ─── Git info ────────────────────────────────────────────────────────────────

export async function getGitInfo(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  // Resolve deploy target from active deployment meta
  let deployTarget: string | null = null;
  if (p.activeDeploymentId) {
    const dep = await repos.deployment.findById(p.activeDeploymentId);
    const meta = dep?.meta as { deployTarget?: string } | null;
    deployTarget = meta?.deployTarget ?? null;
  }

  return {
    gitProvider: p.gitProvider,
    gitOwner: p.gitOwner,
    gitRepo: p.gitRepo,
    gitBranch: p.gitBranch,
    gitUrl: p.gitUrl,
    installationId: p.installationId,
    webhookId: p.webhookId,
    webhookDomain: p.webhookDomain,
    autoDeploy: p.autoDeploy,
    deployTarget,
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
