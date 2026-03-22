import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env, trustedOrigins } from "./config/env";
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
import { settingsRoutes } from "./modules/settings/settings.routes";

/* ---------- Initialize platform (runtime + infra + system) ---------- */
await bootstrapPlatform();

export const app = new Hono();

/* ---------- Global middleware ---------- */
app.use(
  "*",
  cors({
    origin: trustedOrigins,
    credentials: true,
  }),
);
app.use("*", errorHandler);
app.use("*", logger());

app.use("/api/auth/*", rateLimiter);

/* ---------- Shared routes (self-hosted + cloud + desktop) ---------- */
app.route("/api/health", healthRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/deployments", deploymentRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/api/github", githubRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/settings", settingsRoutes);

/* ---------- Cloud-only routes (gated by CLOUD_MODE) ---------- */
if (env.CLOUD_MODE) {
  const { cloudSaasRoutes } = await import("./modules/cloud/cloud-saas.routes");
  app.route("/api/cloud", cloudSaasRoutes);
  app.route("/api/billing", billingRoutes);
} else {
  /**
   * System routes — filesystem browse, instance setup, user provisioning.
   *
   * Dynamic import: in cloud mode these modules are NEVER loaded into the
   * process. The filesystem controller (node:fs), setup controller
   * (admin user creation), and all their dependencies don't exist in
   * the cloud runtime — not just "protected", but fully absent.
   */
  const { systemRoutes } = await import("./modules/system");
  app.route("/api/system", systemRoutes);

  /** Mail server setup — self-hosted iRedMail wizard */
  const { mailRoutes } = await import("./modules/mail");
  app.route("/api/mail", mailRoutes);

  /** Cloud account management — connect/disconnect to Openship Cloud */
  const { cloudLocalRoutes } = await import("./modules/cloud/cloud-local.routes");
  app.route("/api/cloud", cloudLocalRoutes);
}
