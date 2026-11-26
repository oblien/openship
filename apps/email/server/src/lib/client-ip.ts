/**
 * Resolve the calling client's IP address for rate-limiting / audit logging.
 *
 * Openship's deploy topology always fronts this Bun process with
 * openresty/nginx inside the orchestrator stack. The reverse proxy
 * populates `X-Real-IP` with the originating client address and
 * strips/rewrites anything inbound. We trust that header at face
 * value and ignore `X-Forwarded-For` entirely.
 *
 * If we ever lose the proxy (direct exposure) the function returns
 * the socket-level remote (or "unknown"), so rate limiters still
 * have a bucket — but that path should never happen in production.
 */

import { isIP } from 'node:net';
import { getConnInfo } from 'hono/bun';
import type { Context } from 'hono';

export function clientIp(c: Context): string {
  const realIp = c.req.header('x-real-ip')?.trim();
  if (realIp && isIP(realIp)) return realIp;
  try {
    const info = getConnInfo(c);
    return info.remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
