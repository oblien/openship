/**
 * Health check module — used by load balancers and Docker health checks.
 */
import { Hono } from "hono";
import { hostname } from "node:os";
import { env } from "../../config/env";

/** Computed once — hostname never changes at runtime. */
const machineName = env.DEPLOY_MODE === "desktop" ? hostname() : undefined;

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

/** GET /health/env — static deployment info (no auth, cached by callers). */
healthRoutes.get("/env", async (c) => {
  // authMode tells the dashboard which login flow to use:
  //   "none"   → zero-auth, auto-provisioned local user (desktop default)
  //   "cloud"  → external auth on Openship Cloud
  //   "local"  → local Better Auth (self-hosted server / SaaS)
  let authMode: string;

  if (env.DEPLOY_MODE === "desktop") {
    // Desktop: authMode is set during onboarding (none or cloud)
    try {
      const { repos } = await import("@repo/db");
      const settings = await repos.instanceSettings.get();
      authMode = settings?.authMode ?? "none";
    } catch {
      authMode = "none";
    }
  } else {
    authMode = "local";
  }

  return c.json({
    selfHosted: !env.CLOUD_MODE,
    deployMode: env.DEPLOY_MODE,
    authMode,
    cloudAuthUrl: env.OPENSHIP_CLOUD_DASHBOARD_URL,
    ...(machineName && { machineName }),
    ...(env.HOST_DOMAIN && { hostDomain: env.HOST_DOMAIN }),
  });
});
