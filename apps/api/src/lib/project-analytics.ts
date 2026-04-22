/**
 * Shared helpers for resolving a project's tracked domain, server,
 * and querying the OpenResty management API.
 *
 * The actual HTTP-over-SSH-tunnel logic lives in `./ssh-tunnel.ts`.
 * This file provides the OpenResty-specific convenience wrappers and
 * project → domain + server resolution.
 *
 * Used by:
 *   - analytics.service.ts  (summary, periods)
 *   - project.controller.ts (server log stream, recent logs)
 *   - analytics-scraper.ts  (periodic scrape via SSH)
 */

import { repos } from "@repo/db";
import { OPENRESTY_MGMT_PORT } from "@repo/adapters";
import { getRoutingBaseDomain } from "./routing-domains";
import { tunnelRequest, tunnelStream } from "./ssh-tunnel";

export type { TunnelStreamHandle } from "./ssh-tunnel";

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

export type ProjectTrafficSource =
  | {
      kind: "self-hosted";
      domain: string;
      serverId: string;
      deployTarget: string | null;
    }
  | {
      kind: "cloud";
      domain: string;
      deployTarget: "cloud";
    };

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
  const source = await resolveProjectTrafficSource(projectId);
  if (!source || source.kind !== "self-hosted") {
    return null;
  }

  return { domain: source.domain, serverId: source.serverId };
}

/**
 * Resolve where project request traffic is observed.
 *
 * Cloud deployments use Oblien edge analytics directly.
 * Self-hosted deployments use the OpenResty management API on the target server.
 */
export async function resolveProjectTrafficSource(
  projectId: string,
): Promise<ProjectTrafficSource | null> {
  const project = await repos.project.findById(projectId);
  if (!project) return null;

  // Domain: DB record first, then slug-based fallback
  const primaryDomain = await repos.domain.getPrimaryByProject(projectId);
  const baseDomain = getRoutingBaseDomain();
  const hostname =
    primaryDomain?.hostname ??
    (project.slug && baseDomain ? `${project.slug}.${baseDomain}` : null);
  if (!hostname) return null;

  const domain = normalizeTrackedDomain(hostname);

  let deployTarget: string | null = null;
  let serverId: string | null = null;
  if (project.activeDeploymentId) {
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    const meta = dep?.meta as { deployTarget?: string; serverId?: string } | null;
    deployTarget = meta?.deployTarget ?? null;
    if (meta?.serverId) serverId = meta.serverId;
  }

  if (deployTarget === "cloud") {
    return {
      kind: "cloud",
      domain,
      deployTarget: "cloud",
    };
  }

  // Server: deployment meta first, then first configured server
  if (!serverId) {
    const servers = await repos.server.list();
    serverId = servers[0]?.id ?? null;
  }
  if (!serverId) return null;

  return {
    kind: "self-hosted",
    domain,
    serverId,
    deployTarget,
  };
}

// ─── OpenResty management API wrappers ───────────────────────────────────────

/**
 * GET JSON from the OpenResty management API through SSH tunnel.
 */
export async function fetchMgmt<T>(
  serverId: string,
  path: string,
): Promise<T | null> {
  const res = await tunnelRequest(serverId, OPENRESTY_MGMT_PORT, path);
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return null;
  try { return JSON.parse(res.body) as T; } catch { return null; }
}

/**
 * POST to the OpenResty management API through SSH tunnel.
 */
export async function postMgmt<T>(
  serverId: string,
  path: string,
): Promise<T | null> {
  const res = await tunnelRequest(serverId, OPENRESTY_MGMT_PORT, path, {
    method: "POST",
  });
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return null;
  try { return JSON.parse(res.body) as T; } catch { return null; }
}

/**
 * Lightweight health probe for the OpenResty management port.
 */
export async function probeMgmt(serverId: string): Promise<boolean> {
  const res = await tunnelRequest(serverId, OPENRESTY_MGMT_PORT, "/health");
  return res?.body.trim() === "ok";
}

/**
 * Open a streaming SSE connection to the OpenResty management API.
 * Returns a tunnel stream handle — caller pipes `handle.stream.on("data", ...)`
 * to the SSE client.
 */
export async function mgmtStream(
  serverId: string,
  path: string,
) {
  return tunnelStream(serverId, OPENRESTY_MGMT_PORT, path);
}
