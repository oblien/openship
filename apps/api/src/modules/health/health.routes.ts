/**
 * Health check module - used by load balancers and Docker health checks.
 */
import { Hono } from "hono";
import { hostname, userInfo } from "node:os";
import { cloudRuntimeTarget, env } from "../../config/env";
import apiPackage from "../../../package.json";

/** Running server version (from apps/api/package.json). Lets the dashboard tell
 *  a self-hosted operator their instance is outdated / has a security advisory.
 *  The desktop dashboard uses window.desktop.app.version() instead. */
const APP_VERSION = apiPackage.version;

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
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

/** GET /health/env - static deployment info (no auth, cached by callers). */
healthRoutes.get("/env", async (c) => {
  // authMode tells the dashboard which login flow to use:
  //   "none"   → zero-auth, auto-provisioned local user (desktop default)
  //   "cloud"  → external auth on Openship Cloud
  //   "local"  → local Better Auth (self-hosted server / SaaS)
  let authMode: string;
  // teamMode tells the dashboard whether this instance has been
  // migrated to a multi-user deployment. When non-default, the
  // dashboard renders a launcher pointing at migrationTargetUrl
  // instead of the normal UI.
  let teamMode: string = "single_user";
  let migrationTargetUrl: string | null = null;
  let migrationInProgress: boolean = false;

  if (env.DEPLOY_MODE === "desktop") {
    // Desktop: authMode is set during onboarding (none or cloud)
    try {
      const { repos } = await import("@repo/db");
      const settings = await repos.instanceSettings.get();
      authMode = settings?.authMode ?? "none";
      teamMode = settings?.teamMode ?? "single_user";
      migrationTargetUrl = settings?.migrationTargetUrl ?? null;
      migrationInProgress = settings?.migrationInProgress ?? false;
    } catch {
      authMode = "none";
    }
  } else {
    // Not desktop-only: zero-auth is valid for any DEPLOY_MODE (see
    // lib/auth-mode.ts). The operator opts in through the settings endpoint,
    // which gates it behind OPENSHIP_ALLOW_ZERO_AUTH plus an explicit
    // `confirm` string. Read the persisted value so this agrees with
    // getAuthMode() — hardcoding "local" told the dashboard to render a login
    // screen on an instance whose API requires no login.
    authMode = "local";
    try {
      const { repos } = await import("@repo/db");
      const settings = await repos.instanceSettings.get();
      authMode = settings?.authMode ?? "local";
      teamMode = settings?.teamMode ?? "single_user";
      migrationTargetUrl = settings?.migrationTargetUrl ?? null;
      migrationInProgress = settings?.migrationInProgress ?? false;
    } catch {
      // settings table may be unavailable mid-migration; defaults are safe.
    }
  }

  return c.json({
    selfHosted: !env.CLOUD_MODE,
    deployMode: env.DEPLOY_MODE,
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
