/**
 * Project controller — Hono request handlers.
 *
 * Every handler:
 *   1. Extracts user from context (set by authMiddleware)
 *   2. Delegates to project.service
 *   3. Returns consistent JSON
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getUserId, param } from "../../lib/controller-helpers";
import * as projectService from "./project.service";
import type { TCreateProjectBody, TUpdateProjectBody, TSetEnvVarsBody, TUpdateResourcesBody } from "./project.schema";
import { detectStack, type RepoFile } from "../../lib/stack-detector";
import { readdir, readFile, stat } from "node:fs/promises";
import { repos } from "@repo/db";

// ─── Ensure project ──────────────────────────────────────────────────────────

export async function ensure(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<TCreateProjectBody>();

  if (!body.name) {
    return c.json({ success: false, error: "name is required" }, 400);
  }

  try {
    const result = await projectService.ensureProject(userId, body);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to ensure project";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Projects CRUD ───────────────────────────────────────────────────────────

export async function getHome(c: Context) {
  const userId = getUserId(c);
  try {
    const result = await projectService.listProjects(userId, { page: 1, perPage: 100 });

    // Enrich each project with latest deployment info
    const projects = await Promise.all(
      result.rows.map(async (p) => {
        const latest = await repos.deployment.findLatestByProject(p.id);
        return {
          ...p,
          latestDeploymentId: latest?.id ?? null,
          latestDeploymentStatus: latest?.status ?? null,
        };
      }),
    );

    return c.json({
      success: true,
      projects,
      numbers: {
        total_projects: result.total,
        total_deployments: 0,
        total_success_deployments: 0,
      },
    });
  } catch {
    // Table may not exist yet (e.g. PGlite before migrations)
    return c.json({
      success: true,
      projects: [],
      numbers: { total_projects: 0, total_deployments: 0, total_success_deployments: 0 },
    });
  }
}

export async function list(c: Context) {
  const userId = getUserId(c);
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  const result = await projectService.listProjects(userId, { page, perPage });
  return c.json({
    data: result.rows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

export async function create(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<TCreateProjectBody>();
  const project = await projectService.createProject(userId, body);
  return c.json({ data: project }, 201);
}

export async function getById(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const project = await projectService.getProject(id, userId);
  return c.json({ data: project });
}

export async function update(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<TUpdateProjectBody>();
  const project = await projectService.updateProject(id, userId, body);
  return c.json({ data: project });
}

export async function remove(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  await projectService.deleteProject(id, userId);
  return c.json({ message: "deleted" });
}

// ─── Environment variables ───────────────────────────────────────────────────

export async function listEnvVars(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const environment = c.req.query("environment");
  const vars = await projectService.listEnvVars(id, userId, environment);
  return c.json({ data: vars });
}

export async function setEnvVars(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<TSetEnvVarsBody>();
  const result = await projectService.setEnvVars(id, userId, body);
  return c.json(result);
}

// ─── Resources ───────────────────────────────────────────────────────────────

export async function getResources(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const resources = await projectService.getResources(id, userId);
  return c.json({ data: resources });
}

export async function updateResources(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<TUpdateResourcesBody>();
  const resources = await projectService.updateResources(id, userId, body);
  return c.json({ data: resources });
}

// ─── Local projects ──────────────────────────────────────────────────────────

/** Scan a local directory and detect framework/stack */
export async function scanLocal(c: Context) {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  if (!dirPath) return c.json({ error: "path is required" }, 400);

  // Validate the path exists and is a directory
  try {
    const st = await stat(dirPath);
    if (!st.isDirectory()) return c.json({ error: "Path is not a directory" }, 400);
  } catch {
    return c.json({ error: "Directory not found" }, 404);
  }

  // Read top-level files for stack detection
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: RepoFile[] = entries.map((e) => ({
    name: e.name,
    type: e.isDirectory() ? "dir" : "file",
  }));

  // Try reading package.json if exists
  let packageJson: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(`${dirPath}/package.json`, "utf-8");
    packageJson = JSON.parse(raw);
  } catch {
    // No package.json or invalid — that's fine
  }

  const result = detectStack(files, packageJson);
  const dirName = dirPath.split("/").filter(Boolean).pop() ?? "project";

  return c.json({
    success: true,
    name: (packageJson?.name as string) ?? dirName,
    path: dirPath,
    ...result,
  });
}

/** Import a local folder as a project */
export async function importLocal(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<TCreateProjectBody & { localPath: string }>();

  if (!body.localPath) return c.json({ error: "localPath is required" }, 400);

  // Verify directory exists
  try {
    const st = await stat(body.localPath);
    if (!st.isDirectory()) return c.json({ error: "Path is not a directory" }, 400);
  } catch {
    return c.json({ error: "Directory not found" }, 404);
  }

  const project = await projectService.createProject(userId, {
    ...body,
    gitProvider: "local",
  });

  return c.json({ data: project }, 201);
}

/** List only local projects for the current user */
export async function listLocal(c: Context) {
  const userId = getUserId(c);
  try {
    const result = await projectService.listProjects(userId, { page: 1, perPage: 100 });
    const localProjects = result.rows.filter((p) => p.gitProvider === "local");
    return c.json({ success: true, projects: localProjects });
  } catch {
    return c.json({ success: true, projects: [] });
  }
}

// ─── Runtime logs ────────────────────────────────────────────────────────────

/**
 * GET /projects/:id/logs — one-shot fetch of recent runtime logs.
 */
export async function runtimeLogs(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;

  try {
    const entries = await projectService.getRuntimeLogs(id, userId, tail);
    return c.json({ data: entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get logs";
    return c.json({ error: message }, 400);
  }
}

/**
 * GET /projects/:id/logs/stream — SSE stream of runtime logs.
 */
export async function runtimeLogStream(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;

  return streamSSE(c, async (sseStream) => {
    let cleanup: (() => void) | null = null;

    try {
      cleanup = await projectService.streamRuntimeLogs(id, userId, (entry) => {
        void sseStream.writeSSE({
          event: "log",
          data: JSON.stringify(entry),
        });
      }, { tail });

      // Keep the stream open until client disconnects
      await new Promise<void>((resolve) => {
        sseStream.onAbort(() => {
          cleanup?.();
          resolve();
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stream logs";
      await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: message }) });
      cleanup?.();
    }
  });
}

// ─── Git info ────────────────────────────────────────────────────────────────

export async function getGitInfo(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const info = await projectService.getGitInfo(id, userId);
  return c.json({ data: info });
}

export async function setBranch(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const { branch } = await c.req.json<{ branch: string }>();
  if (!branch) return c.json({ error: "branch is required" }, 400);
  const result = await projectService.setBranch(id, userId, branch);
  return c.json(result);
}

// ─── Build options ───────────────────────────────────────────────────────────

export async function setOptions(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<Record<string, unknown>>();
  const result = await projectService.updateOptions(id, userId, body);
  return c.json({ data: result });
}

// ─── Sleep mode ──────────────────────────────────────────────────────────────

export async function setSleepMode(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const { sleep_mode } = await c.req.json<{ sleep_mode: string }>();
  if (!sleep_mode) return c.json({ error: "sleep_mode is required" }, 400);
  const result = await projectService.setSleepMode(id, userId, sleep_mode);
  return c.json(result);
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

export async function enable(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  try {
    const result = await projectService.enableProject(id, userId);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to enable project";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function disable(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  try {
    const result = await projectService.disableProject(id, userId);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to disable project";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Project deployments ─────────────────────────────────────────────────────

export async function listDeployments(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  const environment = c.req.query("environment") ?? undefined;
  const result = await projectService.listProjectDeployments(id, userId, { page, perPage, environment });
  return c.json({ data: result.rows, total: result.total, page: result.page, perPage: result.perPage });
}

// ─── Deployment session ──────────────────────────────────────────────────────

export async function deploymentSession(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const result = await projectService.getLatestDeploymentSession(id, userId);
  return c.json(result);
}

// ─── Env var aliases (old API paths) ─────────────────────────────────────────

export async function envGet(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const environment = c.req.query("environment");
  const vars = await projectService.listEnvVars(id, userId, environment);
  return c.json({ data: vars });
}

export async function envSet(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<{ envVars?: TSetEnvVarsBody } & TSetEnvVarsBody>();

  // Support both { envVars: { environment, vars } } and flat { environment, vars }
  const payload = body.envVars || body;
  if (!payload.environment || !payload.vars) {
    return c.json({ error: "environment and vars are required" }, 400);
  }

  const result = await projectService.setEnvVars(id, userId, payload);
  return c.json(result);
}

// ─── Project info (enriched) ─────────────────────────────────────────────────

export async function getInfo(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const project = await projectService.getProject(id, userId);

  // Build the "options" object the dashboard expects for build settings
  const options = {
    buildCommand: project.buildCommand ?? '',
    outputDirectory: project.outputDirectory ?? '',
    installCommand: project.installCommand ?? '',
    startCommand: '',
    productionPort: String(project.port ?? 3000),
    hasServer: project.productionMode === 'host',
    isLoading: false,
    error: null,
  };

  // Fetch domains for this project
  const domains = await repos.domain.listByProject(id);

  return c.json({
    success: true,
    data: {
      project: { ...project, options, domains },
      analytics: null,
    },
  });
}

// ─── Delete via POST (old API compat) ────────────────────────────────────────

export async function deletePost(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  await projectService.deleteProject(id, userId);
  return c.json({ success: true, message: "deleted" });
}

// ─── Update via POST (old API compat) ────────────────────────────────────────

export async function updatePost(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<TUpdateProjectBody>();
  const project = await projectService.updateProject(id, userId, body);
  return c.json({ data: project });
}
