/**
 * Health check module — used by load balancers and Docker health checks.
 */
import { Hono } from "hono";
import { env } from "../../config/env";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

/** GET /health/env — static deployment info (no auth, cached by callers). */
healthRoutes.get("/env", (c) => {
  return c.json({
    selfHosted: !env.CLOUD_MODE,
    deployMode: env.DEPLOY_MODE,
  });
});
