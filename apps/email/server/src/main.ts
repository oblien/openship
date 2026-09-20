/**
 * Zero server entrypoint.
 *
 * Hono + Bun. Mounts:
 *   /auth/*       sign-in / sign-out / session
 *   /mail/idle    SSE bridge to IMAP IDLE
 *   /admin/*      branding writes (token-gated)
 *   /branding.*   branding read API + uploaded assets
 *   /trpc/*       tRPC over HTTP (all the things)
 *   /api/trpc/*   same - what the Zero client posts to
 *   /*            client SPA (served from CLIENT_BUILD_DIR) with index.html
 *                 fallback so client-side routes resolve.
 *
 * Bootstraps an SSE-friendly CORS policy so the dashboard (on a different
 * origin) can hold the IDLE connection open with credentials. Same-origin
 * traffic from the SPA bypasses CORS entirely.
 */

import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { getCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { trpcServer } from '@hono/trpc-server';
import { serveStatic } from 'hono/bun';
import { env } from './env';
import { authRoutes } from './routes/auth';
import { idleRoute } from './routes/idle';
import { appRouter } from './trpc';
import { buildContext } from './ctx';
import { getSession } from './lib/session';
import { getBranding, assetsDir } from './lib/branding';
import { renderIndexHtml } from './lib/index-html';
import { brandingAdminRoute } from './routes/branding-admin';

const app = new Hono();

app.use('*', logger());

// Defense-in-depth HTTP response headers. We're primarily an API server,
// so we deliberately leave CSP unset (the only HTML we ever return is
// the branding JSON / 404 pages, never a UI). Everything else hardens
// against clickjacking, MIME sniffing, and referrer leaks. HSTS is only
// meaningful behind HTTPS - hono's middleware no-ops it on plain HTTP.
app.use(
  '*',
  secureHeaders({
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    xPermittedCrossDomainPolicies: 'none',
    crossOriginOpenerPolicy: 'same-origin',
    crossOriginResourcePolicy: 'same-site',
  }),
);

// 25 MB cap on request bodies. Covers the largest plausible email
// attachment payload (most SMTP servers reject anything bigger anyway)
// and prevents a single client from OOM'ing the process by streaming
// a multi-gigabyte JSON.
app.use(
  '*',
  bodyLimit({
    maxSize: 25 * 1024 * 1024,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
);

app.use(
  '*',
  cors({
    origin: env.TRUSTED_ORIGINS,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.get('/health', (c) => c.json({ ok: true, version: '0.2.0' }));

// Plain JSON branding config - no tRPC envelope, no auth. Reads
// from ${BRANDING_PATH}/config.json via the filesystem-backed store.
// Consumers (Zero client, openship dashboard) can fetch this without
// going through tRPC; useful for static HTML/SSR and curl.
app.get('/branding.json', (c) => c.json(getBranding()));

// Logo / favicon / future uploads - served from ${BRANDING_PATH}/assets/.
// hono/bun's serveStatic resolves the file from `${root}/${path-after-rewrite}`.
app.use(
  '/branding/assets/*',
  serveStatic({
    root: assetsDir(),
    rewriteRequestPath: (p) => p.replace(/^\/branding\/assets\//, '/'),
  }),
);

app.route('/auth', authRoutes);
app.route('/mail', idleRoute);
// Token-gated write API for branding. Openship's dashboard PATCHes
// here using the shared BRANDING_ADMIN_TOKEN. Reads (`/branding.json`)
// stay unauthenticated for the login page.
app.route('/admin', brandingAdminRoute);

// The upstream Zero client posts to /api/trpc; we keep /trpc as a
// convenience for curl + the openship dashboard. `endpoint` MUST match
// the mount point - the hono adapter uses it to strip the prefix
// before resolving the procedure name.
const createTrpcContext = async (_opts: unknown, c: any) => {
  const sid = getCookie(c, env.SESSION_COOKIE_NAME);
  const session = sid ? await getSession(sid) : null;
  return { ...buildContext(session, c) };
};
// allowMethodOverride: the client uses `methodOverride: 'POST'` so EVERY
// procedure call goes out as POST (queries and mutations alike). Without
// this flag, @trpc/server rejects POST-to-query with
// `METHOD_NOT_SUPPORTED` (HTTP 405), which is what every load-time
// dashboard request hit.
app.use(
  '/trpc/*',
  trpcServer({
    router: appRouter,
    endpoint: '/trpc',
    createContext: createTrpcContext,
    allowMethodOverride: true,
  }),
);
app.use(
  '/api/trpc/*',
  trpcServer({
    router: appRouter,
    endpoint: '/api/trpc',
    createContext: createTrpcContext,
    allowMethodOverride: true,
  }),
);

// ─── Client SPA ──────────────────────────────────────────────────────────────
//
// In production we serve the React Router build from the same bun process
// that handles the API - same origin, no CORS dance, no separate static
// server. The vite/react-router build emits to `client/build/client/` of
// the workspace; resolve that from this file's location so the path works
// whether bun is invoked as `bun run server/src/main.ts` (from workspace
// root) or `bun run src/main.ts` (from server/). CLIENT_BUILD_DIR overrides
// for packaging layouts that put the assets elsewhere.
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientBuildDir =
  process.env.CLIENT_BUILD_DIR ?? resolvePath(__dirname, '../../client/build/client');

// The HTML document, branded (GH-568). Registered BEFORE serveStatic because
// serveStatic resolves `/` and `/index.html` to the file on disk and would
// answer with the build-time <title>/<meta> - the very thing that made
// siteTitle look write-only. Assets are untouched below and keep their
// immutable caching; only the document is dynamic, so it must not be cached by
// intermediaries or a rebrand would appear stuck.
const sendIndexHtml = (c: Context) =>
  c.html(renderIndexHtml(clientBuildDir), 200, {
    'Cache-Control': 'no-cache, must-revalidate',
  });

app.get('/', sendIndexHtml);
app.get('/index.html', sendIndexHtml);

// Static files: assets, fonts, manifest, etc. serveStatic falls through to
// the next handler when a path doesn't resolve to a file on disk, which is
// what lets the SPA fallback below handle client-side routes.
app.use('/*', serveStatic({ root: clientBuildDir }));

// SPA fallback - any unmatched GET serves index.html so React Router can
// take over routing on the client. Registered last so it never shadows API
// routes (those returned a response above and never fell through). Deep links
// are documents too, so they get the same branded shell - a link preview of
// https://mail.example.com/mail/inbox must not say "OpenShip Mail" either.
app.get('*', sendIndexHtml);

const port = env.PORT;
console.log(`[zero] listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
