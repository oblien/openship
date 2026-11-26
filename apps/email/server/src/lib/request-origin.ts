import type { Context } from 'hono';
import { env } from '../env';

export function permitsBrowserOrigin(c: Context): boolean {
  const origin = c.req.header('Origin');
  return !origin || origin === new URL(c.req.url).origin || env.TRUSTED_ORIGINS.includes(origin);
}
