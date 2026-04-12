/**
 * Shared helpers for resolving a project's tracked domain, server,
 * and querying the OpenResty management API.
 *
 * Used by:
 *   - analytics.service.ts  (summary, periods)
 *   - project.controller.ts (server log stream, recent logs)
 *   - analytics-scraper.ts  (periodic scrape via SSH)
 */

import { repos } from "@repo/db";
import { OPENRESTY_MGMT_PORT } from "@repo/adapters";
import { getRoutingBaseDomain } from "./routing-domains";
import { sshManager } from "./ssh-manager";

// ─── Domain normalisation ────────────────────────────────────────────────────

/**
 * Normalize a hostname to match OpenResty's tracking key format.
 * Lua `site_logger.lua` stores counters under lowercase, no-www keys.
 */
export function normalizeTrackedDomain(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, "");
}

// ─── Project → domain + server resolution ────────────────────────────────────

export interface ProjectTracking {
  domain: string;
  serverId: string;
}

/**
 * Resolve the tracked domain and server for a project.
 *
 * Domain resolution order:
 *   1. Primary domain from DB (`domain` table)
 *   2. Slug-based managed subdomain (`project.slug.baseDomain`)
 *
 * Server resolution order:
 *   1. Active deployment's `meta.serverId`
 *   2. First configured server (single-server setups)
 */
export async function resolveProjectTracking(
  projectId: string,
): Promise<ProjectTracking | null> {
  const project = await repos.project.findById(projectId);
  if (!project) return null;

  // Domain: DB record first, then slug-based fallback
  const primaryDomain = await repos.domain.getPrimaryByProject(projectId);
  const baseDomain = getRoutingBaseDomain();
  const hostname =
    primaryDomain?.hostname ??
    (project.slug && baseDomain ? `${project.slug}.${baseDomain}` : null);
  if (!hostname) return null;

  // Server: deployment meta first, then first configured server
  let serverId: string | null = null;
  if (project.activeDeploymentId) {
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    const meta = dep?.meta as { serverId?: string } | null;
    if (meta?.serverId) serverId = meta.serverId;
  }
  if (!serverId) {
    const servers = await repos.server.list();
    serverId = servers[0]?.id ?? null;
  }
  if (!serverId) return null;

  return { domain: normalizeTrackedDomain(hostname), serverId };
}

// ─── OpenResty management API client ─────────────────────────────────────────

const MGMT_BASE = `http://127.0.0.1:${OPENRESTY_MGMT_PORT}`;

async function execMgmtRequest(
  serverId: string,
  command: string,
): Promise<string | null> {
  try {
    return await sshManager.withExecutor(serverId, (executor) =>
      executor.exec(command, { timeout: 10_000 }),
    );
  } catch {
    return null;
  }
}

/**
 * Execute a curl request to an OpenResty management API endpoint via SSH.
 * Returns parsed JSON or null on any error (unreachable, timeout, bad JSON).
 */
export async function fetchMgmt<T>(
  serverId: string,
  path: string,
): Promise<T | null> {
  const raw = await execMgmtRequest(serverId, `curl -sf '${MGMT_BASE}${path}'`);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Lightweight health probe for the OpenResty management port.
 * `/health` returns plain text, so it must not go through JSON parsing.
 */
export async function probeMgmt(serverId: string): Promise<boolean> {
  const raw = await execMgmtRequest(serverId, `curl -sf '${MGMT_BASE}/health'`);
  return raw?.trim() === "ok";
}

/**
 * POST to an OpenResty management API endpoint via SSH.
 * Used by the scraper's flush operation (read + delete).
 */
export async function postMgmt<T>(
  serverId: string,
  path: string,
): Promise<T | null> {
  const raw = await execMgmtRequest(serverId, `curl -sf -X POST '${MGMT_BASE}${path}'`);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
