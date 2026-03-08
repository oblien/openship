/**
 * Project service — business logic for project CRUD, env vars, and resources.
 *
 * All database access goes through @repo/db repos.
 * All resource encoding/decoding goes through lib/resources.
 */

import { repos, type Project } from "@repo/db";
import { slugify, NotFoundError, ConflictError, ValidationError, SYSTEM } from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import { platform } from "../../lib/controller-helpers";
import { encrypt, decrypt } from "../../lib/encryption";
import { encodeResources, decodeResources, withDefaults } from "../../lib/resources";
import type { TCreateProjectBody, TUpdateProjectBody, TSetEnvVarsBody, TUpdateResourcesBody } from "./project.schema";

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

  const p = await repos.project.create({
    userId,
    name: data.name,
    slug,
    gitProvider: data.gitProvider ?? "github",
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

  // Destroy active container if any
  if (p.activeDeploymentId) {
    try {
      const dep = await repos.deployment.findById(p.activeDeploymentId);
      if (dep?.containerId) {
        const { runtime } = platform();
        await runtime.destroy(dep.containerId);
      }
    } catch (err) {
      console.error(`[PROJECT] Failed to destroy container for ${projectId}:`, err);
    }
  }

  // Remove domain routes
  try {
    const domains = await repos.domain.listByProject(projectId);
    const { routing } = platform();
    for (const d of domains) {
      await routing.removeRoute(d.hostname).catch(() => {});
    }
  } catch {
    // Best-effort cleanup
  }

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
