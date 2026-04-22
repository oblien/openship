/**
 * Rate limit controller — manage OpenResty-level rate limiting per server.
 *
 * GET  /system/servers/:id/rate-limit — read current config for a server
 * PATCH /system/servers/:id/rate-limit — update rate limit settings for a server
 *
 * Self-hosted only. OpenResty is the sole source of truth via the parsed
 * `ratelimit.conf` snippet on the target server.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import {
  type RateLimitConfig,
} from "@repo/adapters";
import { env } from "../../config";
import { withOpenRestyRouting } from "@/lib/openresty-paths";

function assertNotCloud(c: Context): boolean {
  if (env.CLOUD_MODE) {
    c.status(404);
    c.body(null);
    return false;
  }
  return true;
}

function getServerId(c: Context): string {
  return c.req.param("id") ?? "";
}

function isValidCidr(cidr: string): boolean {
  return /^[\da-fA-F.:]+\/\d{1,3}$/.test(cidr) && cidr.length <= 50;
}

export async function getRateLimit(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const server = await repos.server.get(getServerId(c));
  if (!server) return c.json({ error: "Server not found" }, 404);

  try {
    const config = await withOpenRestyRouting(server.id, (routing) =>
      routing.getRateLimitConfig(),
    );

    if (!config) {
      return c.json({ error: "Failed to parse OpenResty rate limit config" }, 500);
    }

    return c.json({ config });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to read OpenResty rate limit config: ${msg}` }, 500);
  }
}

export async function updateRateLimit(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const serverId = getServerId(c);
  const server = await repos.server.get(serverId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const body = await c.req.json<{
    rps?: number;
    burst?: number;
    whitelist?: string[];
  }>();

  let isRemoving = false;

  try {
    const current = await withOpenRestyRouting(serverId, (routing) =>
      routing.getRateLimitConfig(),
    );

    if (!current) {
      return c.json({ success: false, error: "Failed to parse current OpenResty rate limit config" }, 500);
    }

    const nextConfig: RateLimitConfig = {
      rps: typeof body.rps === "number" ? Math.max(0, Math.floor(body.rps)) : current.rps,
      burst: typeof body.burst === "number" ? Math.max(0, Math.floor(body.burst)) : current.burst,
      whitelist: Array.isArray(body.whitelist)
        ? body.whitelist.filter(isValidCidr)
        : current.whitelist,
    };
    isRemoving = nextConfig.rps <= 0;

    await withOpenRestyRouting(serverId, (routing) =>
      routing.applyRateLimit(nextConfig),
    );

    const config = await withOpenRestyRouting(serverId, (routing) =>
      routing.getRateLimitConfig(),
    );
    if (!config) {
      return c.json({
        success: false,
        error: "OpenResty updated, but the live rate limit config could not be verified afterward.",
      }, 500);
    }

    return c.json({ success: true, config });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({
      success: false,
      error: isRemoving
        ? `Failed to remove rate limit from OpenResty: ${msg}`
        : `Failed to apply rate limit to OpenResty: ${msg}`,
    }, 500);
  }
}
