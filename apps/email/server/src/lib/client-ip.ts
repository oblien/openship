import { isIP } from 'node:net';
import { getConnInfo } from '@hono/bun';
import type { Context } from 'hono';
import { env } from '../env';

export function clientIp(c: Context): string {
  // The OpenShip edge overwrites this header. Direct listeners use the socket peer.
  if (env.TRUST_PROXY) {
    const forwarded = c.req.header('x-real-ip')?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // Synthetic requests and disconnected sockets may have no peer information.
    return 'unknown';
  }
}
