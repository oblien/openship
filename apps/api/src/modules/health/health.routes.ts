/**
 * Health check module - used by load balancers and Docker health checks.
 */
import { Hono } from "hono";
import { hostname, userInfo } from "node:os";
import { cloudRuntimeTarget, env } from "../../config/env";
import { rateLimiterFor } from "../../middleware/rate-limiter";
import { APP_VERSION } from "../../lib/app-version";
import { getAuthMode } from "../../lib/auth-mode";

/** Running server version (apps/api/package.json, via lib/app-version — the same
 *  value sent to the cloud on every call). Lets the dashboard tell a self-hosted
 *  operator their instance is outdated / has a security advisory. The desktop
 *  dashboard uses window.desktop.app.version() instead. */

/**
 * Best-effort friendly name for the local machine. On macOS with Bonjour
 * misconfigured, `os.hostname()` can return the LAN IP literal (e.g.
 * "192.168.1.8") instead of a name - useless in the sidebar. Treat any
 * IPv4/IPv6 literal as bogus and fall back to the unix username, which
 * the OS always has and renders nicely as a personal-machine identity.
 */
function resolveMachineName(): string | undefined {
  if (env.DEPLOY_MODE !== "desktop") return undefined;

  const raw = (() => {
    try {
      return hostname();
    } catch {
      return "";
    }
  })().trim();

  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw);
  const isIpv6 = raw.includes(":") && /^[0-9a-fA-F:]+$/.test(raw);
  if (raw && !isIpv4 && !isIpv6) return raw;

  try {
    const u = userInfo().username?.trim();
    if (u) return `${u[0].toUpperCase()}${u.slice(1)}`;
  } catch {
    /* fall through */
  }
  return undefined;
}

const machineName = resolveMachineName();

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  // `cloudMode` lets a migrate-control-plane flow cheaply refuse a multi-tenant
  // SaaS as a transfer TARGET before sending anything (GATE 3 probe) — an
  // instance import --wipe against the SaaS would truncate every tenant.
  return c.json({ status: "ok", cloudMode: env.CLOUD_MODE === true, timestamp: new Date().toISOString() });
});

/** GET /health/env - static deployment info (no auth, cached by callers). Rate-
 *  limited per-IP because it reads the DB (instanceSettings) while unauthenticated;
 *  the bare `/` liveness check stays unthrottled for load balancers. */
healthRoutes.get("/env", rateLimiterFor("default-anon"), async (c) => {
  // authMode tells the dashboard which login flow to use:
  //   "none"   → zero-auth, auto-provisioned local user (desktop default)
  //   "cloud"  → external auth on Openship Cloud
  //   "local"  → local Better Auth (self-hosted server / SaaS)
  // authMode comes from getAuthMode() — the ONE canonical resolver — never from a
  // local re-derivation. This endpoint used to compute it itself off
  // `settings?.authMode ?? default`, which is a third independent copy of the
  // rules (authMiddleware and zeroAuthAllowed being the other two, and
  // zero-auth-guard.ts documents what happened last time two of them drifted).
  // It went stale immediately: it ignored OPENSHIP_REQUIRE_AUTH /
  // OPENSHIP_PUBLIC_URL, and it kept handing the dashboard a stale desktop
  // "cloud" — so the app rendered the Openship Cloud sign-in screen while the API
  // itself required no login at all. This is the value that decides which login
  // flow the dashboard draws, so it has to agree with the API's real behaviour.
  const authMode = await getAuthMode();

  // teamMode tells the dashboard whether this instance has been
  // migrated to a multi-user deployment. When non-default, the
  // dashboard renders a launcher pointing at migrationTargetUrl
  // instead of the normal UI.
  let teamMode: string = "single_user";
  let migrationTargetUrl: string | null = null;
  let migrationInProgress: boolean = false;

  try {
    const { repos } = await import("@repo/db");
    const settings = await repos.instanceSettings.get();
    teamMode = settings?.teamMode ?? "single_user";
    migrationTargetUrl = settings?.migrationTargetUrl ?? null;
    migrationInProgress = settings?.migrationInProgress ?? false;
  } catch {
    // settings table may be unavailable mid-migration; defaults are safe.
  }

  return c.json({
    selfHosted: !env.CLOUD_MODE,
    deployMode: env.DEPLOY_MODE,
    // Server-host ("VPS") mode: OpenShip is installed ON a server (docker/bare
    // self-host, not the desktop app, not cloud SaaS). In this mode the host is
    // itself a deployable target and is auto-registered as an isLocal server.
    isServerHost: !env.CLOUD_MODE && env.DEPLOY_MODE !== "desktop",
    version: APP_VERSION,
    authMode,
    teamMode,
    migrationTargetUrl,
    migrationInProgress,
    // Both respect OPENSHIP_CLOUD_TARGET (cloudRuntimeTarget). The dashboard
    // must use these, not its static table, to reach the right cloud.
    cloudAuthUrl: cloudRuntimeTarget.dashboard,
    cloudApiUrl: cloudRuntimeTarget.api,
    ...(machineName && { machineName }),
    ...(env.HOST_DOMAIN && { hostDomain: env.HOST_DOMAIN }),
  });
});
