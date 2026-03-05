/**
 * Health check module — used by load balancers and Docker health checks.
 */
import { Hono } from "hono";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});
