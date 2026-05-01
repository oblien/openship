/**
 * Project CRUD service — create, read, update, list, ensure.
 */

import { repos, type NewProject, type Project } from "@repo/db";
import { slugify, NotFoundError, ConflictError, ValidationError, SYSTEM } from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import { encodeResources } from "../../lib/resources";
import { normalizeRollbackWindow } from "../../lib/release-retention";
import { env } from "../../config";
import { getRepository, listBranches as listGitHubBranches } from "../github/github.service";
import type {
  TCreateProjectBody,
  TCreateProjectEnvironmentBody,
  TUpdateProjectBody,
} from "./project.schema";

type EnsureProjectBody = TCreateProjectBody & { projectId?: string };

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
    resources: encodeResources(production, build, p.sleepMode ?? "auto_sleep", p.port ?? 3000),
  };
}

function projectGitUrl(owner?: string | null, repo?: string | null) {
  return owner && repo ? `https://github.com/${owner}/${repo}.git` : undefined;
}

function resolveProjectSource(data: TCreateProjectBody) {
  const safeLocalPath = data.localPath && !env.CLOUD_MODE ? data.localPath : undefined;
  const gitOwner = safeLocalPath ? undefined : data.gitOwner;
  const gitRepo = safeLocalPath ? undefined : data.gitRepo;

  return {
    safeLocalPath,
    gitOwner,
    gitRepo,
    gitProvider: safeLocalPath ? "local" : (data.gitProvider ?? "github"),
    gitUrl: projectGitUrl(gitOwner, gitRepo),
  };
}

function normalizeEnvironmentSlug(input?: string | null, fallback = "production") {
  return slugify(input || fallback) || fallback;
}

function environmentNameFromSlug(slug: string) {
  return (
    slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Production"
  );
}

async function ensureProjectApp(userId: string, data: TCreateProjectBody, slug: string) {
  let app = await repos.projectApp.findBySlug(userId, slug);
  if (app) return { app, created: false };

  const source = resolveProjectSource(data);

  app = await repos.projectApp.create({
    userId,
    name: data.name,
    slug,
    gitProvider: source.gitProvider,
    gitOwner: source.gitOwner,
    gitRepo: source.gitRepo,
    gitUrl: source.gitUrl,
    installationId: data.installationId,
  });

  return { app, created: true };
}

function buildProductionProjectInput(
  userId: string,
  appId: string,
  data: TCreateProjectBody,
  slug: string,
): Omit<NewProject, "id"> {
  const source = resolveProjectSource(data);

  return {
    userId,
    appId,
    name: data.name,
    slug,
    environmentName: "Production",
    environmentSlug: "production",
    environmentType: "production",
    localPath: source.safeLocalPath,
    gitProvider: source.gitProvider,
    gitOwner: source.gitOwner,
    gitRepo: source.gitRepo,
    gitBranch: data.gitBranch ?? "main",
    gitUrl: source.gitUrl,
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
    productionMode: data.productionMode ?? (data.hasServer === false ? "static" : "host"),
    port: data.port ?? 3000,
    hasServer: data.hasServer ?? true,
    hasBuild: data.hasBuild ?? true,
    rollbackWindow:
      data.rollbackWindow !== undefined ? normalizeRollbackWindow(data.rollbackWindow) : null,
  };
}

async function createProductionProject(userId: string, data: TCreateProjectBody, slug: string) {
  const { app, created: appCreated } = await ensureProjectApp(userId, data, slug);

  try {
    return await repos.project.create(buildProductionProjectInput(userId, app.id, data, slug));
  } catch (err) {
    if (appCreated) {
      await repos.projectApp.softDelete(app.id).catch(() => {});
    }
    throw err;
  }
}

async function uniqueProjectSlug(userId: string, baseSlug: string) {
  let slug = baseSlug;
  let suffix = 2;

  while (await repos.project.findBySlug(userId, slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

function environmentSummary(
  p: Project,
  latestStatus?: string | null,
  primaryDomain?: string | null,
) {
  return {
    id: p.id,
    name: p.environmentName,
    slug: p.environmentSlug,
    type: p.environmentType,
    gitBranch: p.gitBranch ?? "main",
    projectSlug: p.slug,
    activeDeploymentId: p.activeDeploymentId,
    latestDeploymentStatus: latestStatus ?? null,
    primaryDomain,
  };
}

function selectDisplayProject(rows: Project[]): Project | null {
  if (rows.length === 0) return null;
  return rows.find((row) => row.environmentSlug === "production") ?? rows[0]!;
}

function selectProjectForBranch(rows: Project[], branch?: string | null): Project | null {
  if (rows.length === 0) return null;

  const normalizedBranch = branch?.trim();
  if (normalizedBranch) {
    const byBranch = rows.find((row) => row.gitBranch === normalizedBranch);
    if (byBranch) return byBranch;
  }

  return selectDisplayProject(rows);
}

async function findProjectByAppSlug(
  userId: string,
  slug: string,
  branch?: string | null,
): Promise<Project | null> {
  const app = await repos.projectApp.findBySlug(userId, slug);
  if (app) {
    return selectProjectForBranch(await repos.project.listByApp(app.id), branch);
  }

  return (await repos.project.findBySlug(userId, slug)) ?? null;
}

// ─── Ensure project (create or return existing) ─────────────────────────────

export async function ensureProject(userId: string, data: EnsureProjectBody) {
  const nameSlug = slugify(data.name);
  const desiredSlug = data.slug || nameSlug;

  let project: Project | null = null;
  if (data.projectId) {
    project = (await repos.project.findById(data.projectId)) ?? null;
    if (!project || project.userId !== userId) throw new NotFoundError("Project", data.projectId);
  }

  if (!project) {
    project = await findProjectByAppSlug(userId, nameSlug, data.gitBranch);
  }
  if (!project && desiredSlug !== nameSlug) {
    project = await findProjectByAppSlug(userId, desiredSlug, data.gitBranch);
  }
  let created = false;

  if (!project) {
    project = await createProductionProject(userId, data, desiredSlug);
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
    if (data.hasServer !== undefined) {
      update.hasServer = data.hasServer;
      if (data.productionMode === undefined && data.hasServer === false) {
        update.productionMode = "static";
      }
    }
    if (data.hasBuild !== undefined) update.hasBuild = data.hasBuild;
    if (data.slug !== undefined) update.slug = data.slug;
    if (data.gitBranch !== undefined && (data.projectId || !project.gitBranch)) {
      update.gitBranch = data.gitBranch;
    }
    if (data.localPath !== undefined) {
      const safePath = data.localPath && !env.CLOUD_MODE ? data.localPath : null;
      update.localPath = safePath;
      if (safePath) {
        update.gitProvider = "local";
        update.gitUrl = null;
      }
    }
    if (data.rollbackWindow !== undefined) {
      update.rollbackWindow =
        data.rollbackWindow === null ? null : normalizeRollbackWindow(data.rollbackWindow);
    }

    if (Object.keys(update).length > 0) {
      await repos.project.update(project.id, update);
    }
  }

  return { success: true, project_id: project.id, created };
}

// ─── List projects ───────────────────────────────────────────────────────────

export async function listProjects(userId: string, opts?: { page?: number; perPage?: number }) {
  const apps = await repos.projectApp.listByUser(userId, opts);
  const rows = (
    await Promise.all(
      apps.rows.map(async (app) => selectDisplayProject(await repos.project.listByApp(app.id))),
    )
  ).filter((project): project is Project => !!project);

  return { ...apps, rows };
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

  const { total } = await repos.projectApp.listByUser(userId, { page: 1, perPage: 1 });
  if (total >= SYSTEM.PROJECTS.MAX_PER_USER) {
    throw new ValidationError(`Project limit reached (${SYSTEM.PROJECTS.MAX_PER_USER})`);
  }

  const existing = await findProjectByAppSlug(userId, slug);
  if (existing) throw new ConflictError(`Project "${data.name}" already exists`);

  const p = await createProductionProject(userId, data, slug);

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
    update.rollbackWindow =
      data.rollbackWindow === null ? null : normalizeRollbackWindow(data.rollbackWindow);
  }

  await repos.project.update(projectId, update);
  if (p.appId) {
    const appUpdate: Record<string, unknown> = {};
    if (typeof update.name === "string") appUpdate.name = update.name;
    if (typeof update.slug === "string" && p.environmentSlug === "production")
      appUpdate.slug = update.slug;
    if (typeof update.gitProvider === "string") appUpdate.gitProvider = update.gitProvider;
    if (typeof update.gitOwner === "string" || update.gitOwner === null)
      appUpdate.gitOwner = update.gitOwner;
    if (typeof update.gitRepo === "string" || update.gitRepo === null)
      appUpdate.gitRepo = update.gitRepo;
    if (typeof update.gitUrl === "string" || update.gitUrl === null)
      appUpdate.gitUrl = update.gitUrl;
    if (typeof update.installationId === "number" || update.installationId === null)
      appUpdate.installationId = update.installationId;
    if (Object.keys(appUpdate).length > 0) {
      await repos.projectApp.update(p.appId, appUpdate);
    }
  }
  const updated = await repos.project.findById(projectId);
  return enrichProject(updated!);
}

// ─── Project environments ───────────────────────────────────────────────────

export async function listProjectEnvironments(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const rows = await repos.project.listByApp(p.appId);
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const [latest, primary] = await Promise.all([
        repos.deployment.findLatestByProject(row.id),
        repos.domain.getPrimaryByProject(row.id),
      ]);
      return environmentSummary(row, latest?.status ?? null, primary?.hostname ?? null);
    }),
  );

  return enriched.sort((a, b) => {
    if (a.slug === "production") return -1;
    if (b.slug === "production") return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function createProjectEnvironment(
  projectId: string,
  userId: string,
  data: TCreateProjectEnvironmentBody,
) {
  const base = await repos.project.findById(projectId);
  if (!base || base.userId !== userId) throw new NotFoundError("Project", projectId);

  const environmentSlug = normalizeEnvironmentSlug(
    data.environmentSlug ?? data.environmentName,
    "development",
  );
  const environmentName = data.environmentName?.trim() || environmentNameFromSlug(environmentSlug);
  const environmentType =
    data.environmentType ?? (environmentSlug === "production" ? "production" : "development");

  const existing = (await repos.project.listByApp(base.appId)).find(
    (row) => row.environmentSlug === environmentSlug,
  );
  if (existing) {
    throw new ConflictError(`Environment "${environmentName}" already exists`);
  }

  const app = await repos.projectApp.findById(base.appId);
  const projectSlug = await uniqueProjectSlug(
    userId,
    environmentSlug === "production" ? base.slug : `${app?.slug ?? base.slug}-${environmentSlug}`,
  );

  let productionBranch = base.gitBranch ?? undefined;
  if (!productionBranch && environmentType === "production" && base.gitOwner && base.gitRepo) {
    const repository = await getRepository(userId, base.gitOwner, base.gitRepo);
    productionBranch = repository.default_branch;
  }

  const gitBranch =
    data.gitBranch?.trim() ||
    (environmentType === "production" ? (productionBranch ?? "main") : environmentSlug);

  if ((data.sourceMode ?? "branch") === "branch" && base.gitOwner && base.gitRepo && gitBranch) {
    const branches = await listGitHubBranches(userId, base.gitOwner, base.gitRepo);
    const exists = branches.some((branch) => branch.name === gitBranch);
    if (!exists) {
      throw new ValidationError(`Branch "${gitBranch}" was not found for ${base.gitOwner}/${base.gitRepo}`);
    }
  }

  const created = await repos.project.create({
    userId,
    appId: base.appId,
    name: app?.name ?? base.name,
    slug: projectSlug,
    environmentName,
    environmentSlug,
    environmentType,
    localPath: base.localPath,
    gitProvider: app?.gitProvider ?? base.gitProvider,
    gitOwner: app?.gitOwner ?? base.gitOwner,
    gitRepo: app?.gitRepo ?? base.gitRepo,
    gitBranch,
    gitUrl: app?.gitUrl ?? base.gitUrl,
    installationId: app?.installationId ?? base.installationId,
    framework: base.framework,
    packageManager: base.packageManager,
    installCommand: base.installCommand,
    buildCommand: base.buildCommand,
    outputDirectory: base.outputDirectory,
    productionPaths: base.productionPaths,
    rootDirectory: base.rootDirectory,
    startCommand: base.startCommand,
    buildImage: base.buildImage,
    productionMode: base.productionMode,
    port: base.port,
    hasServer: base.hasServer,
    hasBuild: base.hasBuild,
    resources: base.resources,
    buildResources: base.buildResources,
    sleepMode: base.sleepMode,
    rollbackWindow: base.rollbackWindow,
    webhookId: null,
    webhookDomain: null,
    autoDeploy: base.autoDeploy,
  });

  return environmentSummary(created);
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

export async function updateOptions(
  projectId: string,
  userId: string,
  options: Record<string, unknown>,
) {
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
  if (options.hasServer !== undefined) {
    update.hasServer = options.hasServer;
    if (options.productionMode === undefined && options.hasServer === false) {
      update.productionMode = "static";
    }
  }
  if (options.hasBuild !== undefined) update.hasBuild = options.hasBuild;

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
    session: session
      ? {
          id: session.id,
          deploymentId: session.deploymentId,
          status: session.status,
          durationMs: session.durationMs,
        }
      : null,
  };
}
