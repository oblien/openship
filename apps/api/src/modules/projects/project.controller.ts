/**
 * Project controller — Hono request handlers.
 *
 * Every handler:
 *   1. Extracts user from context (set by authMiddleware)
 *   2. Delegates to project.service
 *   3. Returns consistent JSON
 */

import type { Context } from "hono";
import { streamSSE } from "../../lib/sse";
import { getUserId, param } from "../../lib/controller-helpers";
import * as projectService from "./project.service";
import type { TCreateProjectBody, TUpdateProjectBody, TSetEnvVarsBody, TUpdateResourcesBody } from "./project.schema";
import { detectStack, MANIFEST_FILES, type RepoFile } from "../../lib/stack-detector";
import { readdir, readFile, stat } from "node:fs/promises";
import { repos } from "@repo/db";
import { deployLuaScripts, detectOpenRestyPaths } from "@repo/adapters";
import * as domainService from "../domains/domain.service";
import { sshManager } from "../../lib/ssh-manager";
import { env } from "../../config";
import { resolveProjectTracking, fetchMgmt, mgmtStream } from "../../lib/project-analytics";

// Track which servers have had Lua scripts deployed this session
const luaDeployedServers = new Set<string>();

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

    // Enrich each project with computed fields + latest deployment info
    const projects = await Promise.all(
      result.rows.map(async (p) => {
        const [enriched, latest, primary] = await Promise.all([
          projectService.enrichProject(p),
          repos.deployment.findLatestByProject(p.id),
          repos.domain.getPrimaryByProject(p.id),
        ]);
        return {
          ...enriched,
          latestDeploymentId: latest?.id ?? null,
          latestDeploymentStatus: latest?.status ?? null,
          primaryDomain: primary?.hostname ?? null,
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
  if (env.CLOUD_MODE) return c.notFound();

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

  // Read manifest files for deep stack detection
  const manifests: Record<string, string> = {};
  await Promise.all(
    MANIFEST_FILES.map(async (name) => {
      try {
        manifests[name] = await readFile(`${dirPath}/${name}`, "utf-8");
      } catch { /* skip */ }
    }),
  );

  const result = detectStack(files, packageJson, manifests);
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
  if (env.CLOUD_MODE) return c.notFound();

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
  if (env.CLOUD_MODE) return c.notFound();

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
    let serverId: string | null = null;

    try {
      const result = await projectService.streamRuntimeLogs(id, userId, (entry) => {
        void sseStream.writeSSE({
          event: "log",
          data: JSON.stringify({
            type: "log",
            data: entry.rawData,
            message: entry.message,
            timestamp: entry.timestamp,
            level: entry.level,
          }),
        });
      }, { tail });

      cleanup = result.cleanup;
      serverId = result.serverId;
      if (serverId) sshManager.retain(serverId);

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
    } finally {
      if (serverId) sshManager.release(serverId);
    }
  });
}

// ─── Server HTTP request logs (OpenResty live pipe) ──────────────────────────

/**
 * GET /projects/:id/server-logs/stream — SSE stream of HTTP request logs
 * from the OpenResty pipe_stream on the managed server.
 *
 * Uses rawExec to run curl on the remote server, piping the raw SSE
 * bytes directly to the browser.  No parsing, no transformation.
 * Auto-deploys Lua scripts once per API session per server.
 */
export async function serverLogStream(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");

  const project = await repos.project.findById(id);
  if (!project || project.userId !== userId) {
    return c.json({ error: "Project not found" }, 404);
  }

  const tracking = await resolveProjectTracking(id);
  if (!tracking) {
    return c.json({ error: "No domain configured for this project" }, 400);
  }
  const { domain, serverId } = tracking;

  return streamSSE(c, async (sseStream) => {
    // Retain the connection so idle timer doesn't drop it mid-stream
    sshManager.retain(serverId);
    try {
      // Deploy Lua scripts once per server per API session
      if (!luaDeployedServers.has(serverId!)) {
        try {
          const executor = await sshManager.acquire(serverId);
          const paths = await detectOpenRestyPaths(executor);
          await deployLuaScripts(executor, paths);
          luaDeployedServers.add(serverId!);
        } catch {
          // Non-fatal — scripts may already be up to date
        }
      }

      const reqPath = `/logs/stream?domain=${encodeURIComponent(domain)}`;
      const conn = await mgmtStream(serverId, reqPath);
      if (!conn) {
        await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: "Failed to connect to log service — ensure OpenResty is running" }) }).catch(() => {});
        return;
      }

      sseStream.onAbort(() => conn.destroy());

      await new Promise<void>((resolve) => {
        conn.stream.on("data", (chunk: Buffer) => {
          sseStream.write(chunk.toString()).catch(() => conn.destroy());
        });
        conn.stream.on("close", () => resolve());
        conn.stream.on("end", () => resolve());
        conn.stream.on("error", () => resolve());
      });
    } finally {
      sshManager.release(serverId);
    }
  });
}

// ─── Recent server logs (ring buffer) ────────────────────────────────────────

export async function recentServerLogs(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");

  const project = await repos.project.findById(id);
  if (!project || project.userId !== userId) {
    return c.json({ error: "Project not found" }, 404);
  }

  const tracking = await resolveProjectTracking(id);
  if (!tracking) {
    return c.json({ logs: [] });
  }
  const { domain, serverId } = tracking;

  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);

  const entries = await fetchMgmt<unknown[]>(
    serverId,
    `/logs/recent?domain=${encodeURIComponent(domain)}&limit=${limit}`,
  );
  return c.json({ logs: entries ?? [] });
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
    productionPaths: project.productionPaths ?? '',
    installCommand: project.installCommand ?? '',
    startCommand: '',
    productionPort: String(project.port ?? 3000),
    hasServer: project.productionMode === 'host',
    isLoading: false,
    error: null,
  };

  // Fetch domains for this project
  const rawDomains = await repos.domain.listByProject(id);
  const domains = rawDomains.map((d) => ({
    ...d,
    domain: d.hostname,
    primary: d.isPrimary,
  }));

  return c.json({
    success: true,
    data: {
      project: { ...project, options, domains },
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

// ─── Connect custom domain ─────────────────────────────────────────────────────

export async function connectDomain(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<{ domain: string; includeWww?: boolean }>();

  if (!body.domain?.trim()) {
    return c.json({ success: false, error: "Domain is required" }, 400);
  }

  try {
    const result = await domainService.addDomain(userId, {
      projectId: id,
      hostname: body.domain.trim(),
      isPrimary: true,
    });

    return c.json({
      success: true,
      domain: result.domain,
      records: result.records,
    });
  } catch (err) {
    if (err instanceof Error) {
      return c.json({ success: false, error: err.message, message: err.message }, 400);
    }
    throw err;
  }
}
