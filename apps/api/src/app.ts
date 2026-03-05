import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./config/env";

import { authRoutes } from "./modules/auth/auth.routes";
import { projectRoutes } from "./modules/projects/project.routes";
import { deploymentRoutes } from "./modules/deployments/deployment.routes";
import { domainRoutes } from "./modules/domains/domain.routes";
import { billingRoutes } from "./modules/billing/billing.routes";
import { webhookRoutes } from "./modules/webhooks/webhook.routes";
import { healthRoutes } from "./modules/health/health.routes";

export const app = new Hono();

/* ---------- Global middleware ---------- */
app.use("*", logger());
app.use("*", cors());

/* ---------- Shared routes (self-hosted + cloud) ---------- */
app.route("/api/health", healthRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/deployments", deploymentRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/webhooks", webhookRoutes);

/* ---------- Cloud-only routes (gated by CLOUD_MODE) ---------- */
if (env.CLOUD_MODE) {
  app.route("/api/billing", billingRoutes);
  // Future cloud-only modules:
  // app.route("/api/teams", teamRoutes);
  // app.route("/api/analytics", analyticsRoutes);
}
