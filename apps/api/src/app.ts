import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

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

/* ---------- Module routes ---------- */
app.route("/api/health", healthRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/deployments", deploymentRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api/webhooks", webhookRoutes);
