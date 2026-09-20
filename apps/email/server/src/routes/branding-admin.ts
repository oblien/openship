/**
 * Branding admin endpoint - token-authenticated write API.
 *
 * The Zero server fully owns branding storage: openship's dashboard
 * never touches our filesystem. It hits this endpoint with the shared
 * `BRANDING_ADMIN_TOKEN` to PATCH `config.json`. Reads (`/branding.json`)
 * stay public because the login page renders pre-auth.
 *
 * Why a token here, not a session cookie:
 *   - openship's API is a different origin and a different auth realm.
 *     It has no Zero session, and bolting on a service-to-service login
 *     just to write a few strings is overkill.
 *   - The token is a single shared secret operators provision once at
 *     install time (same approach as Postfix/Dovecot's vmail DB binds).
 *   - One trust boundary: whoever has the token has full branding
 *     control, same as whoever has SSH to the Zero VPS.
 *
 * Wire format:
 *   PATCH /admin/branding
 *   X-Branding-Admin-Token: <token>
 *   { siteTitle?, siteDescription?, loginHeading?, loginSubtext?, loginFooter?,
 *     homeHtml?, showPoweredBy? }
 *   →  200 { branding: Branding }   or   401 { error }   or   400 { error }
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../env';
import { getBranding, updateBranding } from '../lib/branding';

const patchSchema = z.object({
  siteTitle: z.string().min(1).max(120).optional(),
  siteDescription: z.string().max(400).optional(),
  loginHeading: z.string().min(1).max(120).optional(),
  loginSubtext: z.string().max(240).optional(),
  loginFooter: z.string().max(240).optional(),
  homeHtml: z.string().max(50_000).nullable().optional(),
  showPoweredBy: z.boolean().optional(),
});

/**
 * Constant-time compare so a network-observable timing attack can't
 * leak the token byte-by-byte. Standard practice for any shared secret
 * compared on the request path.
 */
function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const brandingAdminRoute = new Hono();

brandingAdminRoute.patch('/branding', async (c) => {
  const token = c.req.header('x-branding-admin-token');
  if (!token || !tokenEquals(token, env.BRANDING_ADMIN_TOKEN)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid patch', details: parsed.error.flatten() }, 400);
  }
  const next = updateBranding(parsed.data);
  return c.json({ branding: next });
});

// GET mirror for symmetry with the public /branding.json - same data,
// but accessed via the same token-gated route family. The dashboard
// uses this so it never has to think about two different URLs.
brandingAdminRoute.get('/branding', (c) => {
  const token = c.req.header('x-branding-admin-token');
  if (!token || !tokenEquals(token, env.BRANDING_ADMIN_TOKEN)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return c.json({ branding: getBranding() });
});
