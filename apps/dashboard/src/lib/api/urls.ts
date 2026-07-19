import { DASHBOARD_RUNTIME_TARGETS, DEFAULT_PORT } from "@repo/core";

// The runtime-target table, flattened to an array with the id inlined
// for browser-side lookup ("which row matches window.location?").
const TARGETS = Object.entries(DASHBOARD_RUNTIME_TARGETS).map(([id, t]) => ({ id, ...t }));
const DEFAULT_TARGET = TARGETS.find((t) => t.id === "local") ?? TARGETS[0]!;

type Target = (typeof TARGETS)[number];

/** Return the URL's origin (`scheme://host[:port]`), or undefined if not a valid http(s) URL. */
function originOf(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/** Find the runtime target whose dashboard or api origin matches the URL. */
function resolveTarget(rawUrl?: string): Target {
  const origin = rawUrl ? originOf(rawUrl) : undefined;
  if (!origin) return DEFAULT_TARGET;
  return (
    TARGETS.find(
      (t) => originOf(t.dashboard) === origin || originOf(t.api) === origin,
    ) ?? DEFAULT_TARGET
  );
}

/** The target this code is currently running under — from window.location in the browser. */
function currentTarget(rawUrl?: string): Target {
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : undefined;
  return resolveTarget(rawUrl ?? browserOrigin);
}

/** The cloud-side target that the given target pairs with (per its cloudTargetId). */
function cloudPartner(target: Target): Target {
  return TARGETS.find((t) => t.id === target.cloudTargetId) ?? target;
}

// ─── Same-host proxy mode ───────────────────────────────────────────────────
//
// When `NEXT_PUBLIC_API_PROXY=true`, the dashboard rewrites every API URL
// to land on its own origin under `/api/proxy/*`. The Next.js catch-all
// at app/api/proxy/[...path]/route.ts forwards those requests to the
// internal API process (configured via INTERNAL_API_URL on the server).
//
// Why: single-container self-hosted deploys want ONE public port. The
// dashboard is the only thing exposed; the internal API binds to loopback
// and is invisible to teammates. Same-origin requests also mean zero CORS
// config, which simplifies the deploy.
//
// Both env vars are intentionally string-literal `"true"` rather than
// runtime-bool. NEXT_PUBLIC_* values are inlined at build time, so we
// compare strings to stay deterministic across SSR + client bundles.

const API_PROXY_ENABLED =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_PROXY === "true";

/**
 * Resolve the same-origin URL when in proxy mode, or null when off.
 * `null` lets callers fall through to the direct-target behavior.
 */
function sameOriginProxyOrigin(): string | null {
  if (!API_PROXY_ENABLED) return null;
  if (typeof window !== "undefined") return window.location.origin;
  // SSR: read OPENSHIP_PUBLIC_URL or fall back to a reasonable default.
  // The proxy is dashboard-served, so we use the dashboard's public URL.
  const ssrOrigin = process.env.OPENSHIP_PUBLIC_URL ?? process.env.NEXT_PUBLIC_PUBLIC_URL;
  return ssrOrigin ?? null;
}

// ─── Dynamic local API origin (desktop) ─────────────────────────────────────
//
// The desktop app runs the API on a DYNAMIC free port that isn't in the static
// runtime-target table, so origin-based resolution can't find it. Electron sets
// `OPENSHIP_LOCAL_API_URL` on the dashboard server; the root layout mirrors it
// into `window.__OPENSHIP_API_ORIGIN__` for the browser bundle (whose base URL
// is a module-load constant — a build-time NEXT_PUBLIC var can't carry it).

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Align a loopback API origin with the loopback host the page is served from.
 *
 * `localhost` and `127.0.0.1` are the same machine but *different sites* to a
 * browser: a request between them is cross-site, so the session cookie
 * (host-only, SameSite=Lax) is never stored or sent back — sign-in returns 200
 * and the next get-session returns 401. The CLI advertises the dashboard on
 * `localhost` while injecting a `127.0.0.1` API origin, which trips exactly
 * this. Rewriting the host (port preserved) keeps the pair same-site either
 * way round. Non-loopback origins are left untouched.
 */
export function alignLoopbackOrigin(injected: string, pageOrigin: string): string {
  try {
    const api = new URL(injected);
    const page = new URL(pageOrigin);
    if (!LOOPBACK_HOSTNAMES.has(api.hostname) || !LOOPBACK_HOSTNAMES.has(page.hostname)) {
      return injected;
    }
    api.hostname = page.hostname;
    return `${api.protocol}//${api.host}`;
  } catch {
    // ponytail: a malformed override is passed through untouched — callers already
    // tolerate a bad origin, and repairing it here would hide the real config bug.
    return injected;
  }
}

function localApiOverride(): string | null {
  if (typeof window !== "undefined") {
    const injected = (window as { __OPENSHIP_API_ORIGIN__?: string })
      .__OPENSHIP_API_ORIGIN__;
    if (!injected) return null;
    return alignLoopbackOrigin(injected.replace(/\/+$/, ""), window.location.origin);
  }
  const env = process.env.OPENSHIP_LOCAL_API_URL;
  return env ? env.replace(/\/+$/, "") : null;
}

// ─── Public exports ─────────────────────────────────────────────────────────

export function getRequestOriginFromHeaders(headers: Pick<Headers, "get">) {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return undefined;
  const proto =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export function getApiOrigin(rawUrl?: string) {
  // In proxy mode every API call is same-origin — the "origin" of the
  // API IS the dashboard's origin. Caller-provided `rawUrl` still wins
  // (e.g. cloud-side lookups), but the default-no-arg case is rewritten.
  if (!rawUrl) {
    const proxied = sameOriginProxyOrigin();
    if (proxied) return proxied;
    const local = localApiOverride();
    if (local) return local;
  }
  return currentTarget(rawUrl).api;
}

export function getAuthBaseUrl() {
  if (API_PROXY_ENABLED) {
    const origin = sameOriginProxyOrigin();
    if (origin) return `${origin}/api/proxy/api/auth`;
  }
  return `${getApiOrigin()}/api/auth`;
}

export function getRestApiBaseUrl() {
  if (API_PROXY_ENABLED) {
    const origin = sameOriginProxyOrigin();
    if (origin) return `${origin}/api/proxy/api`;
  }
  return `${getApiOrigin()}/api`;
}

export function getCloudDashboardUrl(rawUrl?: string) {
  return originOf(rawUrl ?? "") ?? cloudPartner(currentTarget()).dashboard;
}

export function getCloudApiOrigin(rawUrl?: string) {
  return originOf(rawUrl ?? "") ?? cloudPartner(currentTarget()).api;
}

/**
 * Origin of the public marketing site (apps/web), where docs and setup
 * guides live. In production: app.openship.io → openship.io. In dev:
 * localhost:3001/3002 → localhost:3000. SSR falls back to production.
 */
export function getMarketingOrigin() {
  if (typeof window === "undefined") return "https://openship.io";
  const { protocol, hostname, port } = window.location;
  if (hostname.startsWith("app.")) return `${protocol}//${hostname.slice(4)}`;
  if (port === String(DEFAULT_PORT.dashboard) || port === String(DEFAULT_PORT.saasDashboard)) {
    return `${protocol}//${hostname}:${DEFAULT_PORT.web}`;
  }
  return "https://openship.io";
}

