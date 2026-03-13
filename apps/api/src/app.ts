import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./config/env";
import { errorHandler } from "./middleware/error-handler";
import { rateLimiter } from "./middleware/rate-limiter";
import { bootstrapPlatform } from "./lib/controller-helpers";

import { authRoutes } from "./modules/auth/auth.routes";
import { projectRoutes } from "./modules/projects/project.routes";
import { deploymentRoutes } from "./modules/deployments/deployment.routes";
import { domainRoutes } from "./modules/domains/domain.routes";
import { analyticsRoutes } from "./modules/analytics/analytics.routes";
import { billingRoutes } from "./modules/billing/billing.routes";
import { webhookRoutes } from "./modules/webhooks/webhook.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { githubRoutes } from "./modules/github";

/* ---------- Initialize platform (runtime + infra + system) ---------- */
await bootstrapPlatform();

export const app = new Hono();

/* ---------- Global middleware ---------- */
app.use(
  "*",
  cors({
    origin: env.TRUSTED_ORIGINS
      ? env.TRUSTED_ORIGINS.split(",")
      : ["http://localhost:3000", "http://localhost:3001"],
    credentials: true,
  }),
);
app.use("*", errorHandler);
app.use("*", logger());

app.use("/api/auth/*", rateLimiter);

/* ---------- Shared routes (self-hosted + cloud) ---------- */
app.route("/api/health", healthRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/deployments", deploymentRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/api/github", githubRoutes);
app.route("/api/analytics", analyticsRoutes);

/* ---------- Cloud-only routes (gated by CLOUD_MODE) ---------- */
if (env.CLOUD_MODE) {
  app.route("/api/billing", billingRoutes);
  // Future cloud-only modules:
  // app.route("/api/teams", teamRoutes);
}
