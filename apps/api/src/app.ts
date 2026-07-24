import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env, trustedOrigins } from "./config/env";
import { handleApiError } from "./middleware/error-handler";
import { rateLimiterFor } from "./middleware/rate-limiter";
import { clientIpMiddleware } from "./middleware/client-ip";
import { betterAuthShield } from "./middleware/better-auth-shield";
import { forceMcpConsent } from "./middleware/mcp-consent";
import { originGuard } from "./middleware/origin-guard";
import { migrationGuard } from "./middleware/migration-guard";
import { initPlatform } from "@repo/adapters";
import { resolvePlatformConfig } from "./lib/controller-helpers";
import { runWithRequestStore } from "./lib/request-store";

import { authRoutes } from "./modules/auth/auth.routes";
import { auth } from "./lib/auth";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { projectRoutes } from "./modules/projects/project.routes";
import { appRoutes } from "./modules/apps/app.routes";
import { appSettingsRoutes } from "./modules/apps/app-settings.routes";
import { appConnectionRoutes } from "./modules/apps/app-connection.routes";
import { projectConnectionRoutes } from "./modules/projects/project-connection.routes";
import { deploymentRoutes } from "./modules/deployments/deployment.routes";
import { domainRoutes } from "./modules/domains/domain.routes";
import { jobRoutes } from "./modules/jobs/job.routes";
import { noticeRoutes } from "./modules/notices/notice.routes";
import { serviceRoutes } from "./modules/services/service.routes";
import { analyticsRoutes } from "./modules/analytics/analytics.routes";
import { billingPlansRoutes } from "./modules/billing/billing.routes";
import { webhookRoutes } from "./modules/webhooks/webhook.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { githubRoutes } from "./modules/github";
import * as githubAuth from "./modules/github/github.auth";
import { settingsRoutes } from "./modules/settings/settings.routes";
import { tokenRoutes } from "./modules/tokens/token.routes";
import { mcpRoutes } from "./modules/mcp/mcp.routes";
import { notificationsRoutes } from "./modules/notifications/notifications.routes";
import { updatesRoutes } from "./modules/updates/updates.routes";
import { imageRoutes } from "./modules/images/images.routes";
import { backupRoutes } from "./modules/backups/backup.routes";
import { auditRoutes } from "./modules/audit/audit.routes";
import { permissionsRoutes } from "./modules/permissions/permissions.routes";
import { backupWebhookRoutes } from "./modules/backups/webhook.routes";
import { backupDestinationRoutes } from "./modules/backup-destinations/destination.routes";
import { reconcileAllSchedules } from "./modules/backups/triggers/cron";
import { reconcileJobs } from "./modules/jobs/job.service";
import { scheduleBillingAnniversary } from "./modules/billing/billing-anniversary.cron";
import { ensureOblienWebhook } from "./lib/openship-cloud";
import { backfillWebhookSecrets } from "./modules/github/github.service";
import { backupOrchestrator } from "./modules/backups/backup.orchestrator";
import { getJobRunner } from "./lib/job-runner";
import { repos } from "@repo/db";

/* ---------- Initialize platform (runtime + infra + system) ---------- */
await initPlatform(resolvePlatformConfig());

export const app = new Hono();

const oauthAuthServerMetadata = oAuthDiscoveryMetadata(auth);
const oauthProtectedResourceMetadata = oAuthProtectedResourceMetadata(auth);

/* ---------- Global middleware ---------- */
app.use(
  "*",
  cors({
    origin: trustedOrigins,
    credentials: true,
  }),
);
app.use("*", logger());
// Seed a per-request memo store FIRST so every downstream handler shares it.
// Collapses idempotent-per-request reads (cloud session validation, GitHub
// auth-mode, installations) to one call each — a single /github/status was
// fanning out into ~6 /cloud/account + 3 installations round-trips otherwise.
app.use("*", (_c, next) => runWithRequestStore(() => next()));
app.use("*", clientIpMiddleware);
// CSRF defence: reject mutating requests from untrusted origins BEFORE
// the auth chain touches the session. Webhooks (Stripe, Oblien) don't
// send an Origin header so they pass through; CLI/server-to-server
// callers using Bearer also have no Origin and pass through.
app.use("*", originGuard);
app.use("*", migrationGuard);

// Primary error path: Hono's compose() catches thrown errors at each
// dispatch level and routes them to `this.errorHandler`, NOT up through
// middleware. So try/catch-around-next middleware never sees downstream
// throws — only an explicit `app.onError(...)` does. Register one here so
// AppError / ZodError get serialized with their statusCode and code.
app.onError(handleApiError);

// Rate limiting now lives in the route chain, NOT in a global `/api/*`
// middleware (fixes #123). secureRouter injects a per-route limiter AFTER
// authMiddleware — `default-authed` (per user) for permission-tagged routes,
// `default-anon` (per IP) for public ones, or the route's explicit `rateLimit`
// policy. A global limiter ran upstream of auth, so it could never see `ctx`
// (always default-anon) and double-charged routes with their own policy.
//
// Better Auth is a RAW catch-all (not secureRouter), so it carries its own:
// POST → `auth-tight` (credential-stuffing), GET (get-session, OAuth
// callbacks) → `default-anon` (hot). See lib/rate-limit/policies.ts.
app.on("POST", "/api/auth/*", rateLimiterFor("auth-tight"));
app.on("GET", "/api/auth/*", rateLimiterFor("default-anon"));

// Shield Better Auth's organization-plugin reads (list-members,
// list-invitations, get-active-member-role) — they leak admin-tier
// data to restricted/member roles otherwise. Must register BEFORE the
// /api/auth catch-all route mount so Hono runs it first.
app.use("/api/auth/organization/*", betterAuthShield);

// Force MCP OAuth clients through our consent page (which writes the org/scope
// binding) — better-auth otherwise skips consent unless prompt==="consent"
// exactly, minting a bindingless token that's denied everything. Must run
// BEFORE the /api/auth catch-all so it can redirect first.
app.use("/api/auth/mcp/authorize", forceMcpConsent);

/* ---------- Shared routes (self-hosted + cloud + desktop) ---------- */
app.route("/api/health", healthRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/apps", appRoutes);
app.route("/api/projects/:id/services", serviceRoutes);
app.route("/api/projects/:id/app-settings", appSettingsRoutes);
app.route("/api/projects/:id/app-connection", appConnectionRoutes);
app.route("/api/projects/:id/connections", projectConnectionRoutes);
app.route("/api/deployments", deploymentRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/api/github", githubRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/tokens", tokenRoutes);
app.route("/api/mcp", mcpRoutes);
app.route("/api/billing", billingPlansRoutes);
app.route("/api/images", imageRoutes);
app.route("/api", backupRoutes);
app.route("/api/backup-destinations", backupDestinationRoutes);
app.route("/api/webhooks/backup", backupWebhookRoutes);
app.route("/api/audit", auditRoutes);
app.route("/api/permissions", permissionsRoutes);
app.route("/api/notifications", notificationsRoutes);
app.route("/api/updates", updatesRoutes);
app.route("/api/jobs", jobRoutes);
// Platform status notices — banner feed (public read) + operator push (internal).
// Both modes; primarily consumed on the SaaS.
app.route("/api/notices", noticeRoutes);

/* ---------- OAuth 2.1 discovery (MCP) ---------- */
// The mcp() plugin serves these under /api/auth, but MCP/OAuth 2.1 clients look
// for them at the ORIGIN ROOT. Re-serve the plugin's own metadata handlers here
// so `Authorization`-less requests to /api/mcp can be discovered end-to-end.
app.get("/.well-known/oauth-authorization-server", (c) => oauthAuthServerMetadata(c.req.raw));
app.get("/.well-known/oauth-protected-resource", (c) => oauthProtectedResourceMetadata(c.req.raw));

/* ---------- OAuth callback landing pages ---------- */
const authCallbackHtml = `<!DOCTYPE html><html><head><title>Success</title></head><body><script>window.close();</script><p>Authentication successful. You can close this window.</p></body></html>`;

app.get("/auth/callback/install", (c) => {
  if (githubAuth.getGitHubAuthMode() === "app") {
    return c.redirect(githubAuth.getInstallUrl());
  }
  return c.html(authCallbackHtml);
});
app.get("/auth/callback/close", (c) => c.html(authCallbackHtml));

/* ---------- WebSocket subsystem ---------- */
//
// Needed for both interactive terminal endpoints:
//   - server terminal (self-hosted only — mounted inside the `else`)
//   - service terminal (mounted unconditionally below; runtime adapter
//     decides Docker vs Cloud per-service)
//
// setupWebSocket(app) MUST run before any route module that calls
// upgradeWebSocket() at module load.
const { setupWebSocket } = await import("./lib/ws");
setupWebSocket(app);

/* ---------- Service terminal (both modes) ---------- */
//
// Cloud mode routes terminal traffic to the user's Oblien workspace
// via the Cloud runtime adapter; self-hosted mode routes to Docker
// exec via the Docker runtime adapter. The controller picks via
// resolveDeploymentRuntime() from the service's active deployment.
{
  const { serviceTerminalRoutes } = await import(
    "./modules/service-terminal/service-terminal.routes"
  );
  app.route("/api/services/terminal", serviceTerminalRoutes);
}

/* ---------- Cloud-only routes (gated by CLOUD_MODE) ---------- */
if (env.CLOUD_MODE) {
  const { cloudSaasRoutes } = await import("./modules/cloud/cloud-saas.routes");
  app.route("/api/cloud", cloudSaasRoutes);

  const { billingSaasRoutes } = await import("./modules/billing/billing.routes");
  app.route("/api/billing", billingSaasRoutes);
} else {
  /**
   * System routes - filesystem browse, instance setup, user provisioning.
   *
   * Dynamic import: in cloud mode these modules are NEVER loaded into the
   * process. The filesystem controller (node:fs), setup controller
   * (admin user creation), and all their dependencies don't exist in
   * the cloud runtime - not just "protected", but fully absent.
   */
  const { systemRoutes } = await import("./modules/system/system.routes");
  app.route("/api/system", systemRoutes);

  /** Mail server setup - self-hosted iRedMail wizard */
  const { mailRoutes } = await import("./modules/mail/mail.routes");
  app.route("/api/mail", mailRoutes);

  /** Docker migration - inspect a server's Docker and adopt it as a project */
  const { migrationRoutes } = await import("./modules/migration/migration.routes");
  app.route("/api/migration", migrationRoutes);

  /**
   * Interactive SERVER terminal (xterm.js ↔ WebSocket ↔ ssh2 PTY).
   * Self-hosted only — exposes the host's SSH-managed servers.
   * setupWebSocket(app) already ran unconditionally above; this
   * branch only mounts the SSH-flavored routes.
   */
  const { terminalRoutes } = await import("./modules/terminal/terminal.routes");
  app.route("/api/terminal", terminalRoutes);

  /** Cloud account management - connect/disconnect to Openship Cloud */
  const { cloudLocalRoutes } = await import("./modules/cloud/cloud-local.routes");
  app.route("/api/cloud", cloudLocalRoutes);

  /** Billing proxy - cloud-connected local instances proxy to SaaS */
  const { billingLocalRoutes } = await import("./modules/billing/billing-local.routes");
  app.route("/api/billing", billingLocalRoutes);

  // Analytics is scraped ON-DEMAND when a server's analytics is viewed
  // (analytics.controller → scrapeServerIfStale) — no background interval.
}

// ─── Backup job runner + boot reconcile ─────────────────────────────
//
// One JobRunner powers all backup work — BullMQ when Redis is
// reachable, in-process otherwise. Same code path for SaaS and
// desktop installs. The runner is module-singleton; first access
// here triggers Redis detection.
{
  const sweepStale = repos.backupRun.sweepStaleRuns(
    "API restart while backup in flight",
  );
  const sweepStaleRestores = repos.backupRestore.sweepStaleRestores(
    "API restart while restore in flight",
  );
  // A deploy is an in-process task driven by an in-memory build session, so a
  // restart orphans any deployment still building/deploying/queued — the UI
  // would otherwise hang on "Building" forever. Flip those to cancelled at boot
  // (reconciling is left for the reconcile scheduler). Fire-and-forget.
  void repos.deployment
    .sweepStaleInFlight("Interrupted by a server restart — redeploy to try again.")
    .then((n) => {
      if (n > 0) console.log(`[boot] cancelled ${n} stale in-flight deployment(s)`);
    })
    .catch((err) => console.warn("[boot] sweepStaleInFlight failed:", err));
  // A project's deletionInProgress flag can only survive from a teardown that
  // died mid-flight (no teardown outlives a restart), so clear stuck locks at
  // boot — otherwise the project refuses all deletes forever ("Another delete
  // is already running"). Fire-and-forget; logs the count if any were stuck.
  void repos.project.clearStaleDeletions().then((n) => {
    if (n > 0) console.log(`[boot] cleared ${n} stale project deletion lock(s)`);
  }).catch((err) => console.warn("[boot] clearStaleDeletions failed:", err));
  // A Docker migration is an in-memory FSM that quiesces (stops) the source
  // containers before the target deploy — a restart mid-migration would strand
  // a stopped production stack forever. Restart the originals + roll back any
  // interrupted run. Self-hosted only (migrations don't run on the SaaS); the
  // dynamic import keeps the SSH/runtime chain out of the cloud boot path.
  if (!env.CLOUD_MODE) {
    void import("./modules/migration/migration.orchestrator")
      .then(({ migrationOrchestrator }) => migrationOrchestrator.recoverInterruptedMigrations())
      .catch((err) => console.warn("[boot] migration recovery failed:", err));
  }

  const runner = await getJobRunner();
  await runner.start({
    processRun: (runId) => backupOrchestrator.execute(runId),
  });
  console.log(`[boot] backup runner: ${runner.describe()}`);

  // Generic job schedule: seed built-in system jobs (SSL renewal, orphan GC,
  // prunes, deployment reconcile) into the `job` table and register every
  // enabled row on the runner. Operator cron/enabled overrides survive restarts.
  void reconcileJobs()
    .then((stats) =>
      console.log(`[boot] jobs: ${stats.registered}/${stats.total} scheduled`),
    )
    .catch((err) => console.warn("[boot] reconcileJobs failed:", err));

  // Self-hosted (single box): any job_run still "running" at boot was orphaned
  // by a crash/restart mid-run — close it out so the Jobs UI doesn't show a
  // perpetual "Running" spinner. Not run in CLOUD_MODE, where a shared queue +
  // multiple replicas mean a "running" row may be live on another replica.
  if (!env.CLOUD_MODE) {
    void repos.jobRun
      .failStaleRunning()
      .then((n) => n > 0 && console.log(`[boot] reconciled ${n} orphaned job run(s)`))
      .catch((err) => console.warn("[boot] failStaleRunning failed:", err));
  }

  // Hourly billing-period rollover — re-arms Oblien quota for orgs
  // whose current_period_end has passed (safety net for paid orgs
  // whose Stripe webhook lagged, and the primary mechanism for
  // free-tier orgs).
  void scheduleBillingAnniversary().catch((err) =>
    console.warn("[boot] scheduleBillingAnniversary failed:", err),
  );

  // Register the Oblien billing webhook (credits usage/low/depleted + quota
  // threshold). Idempotent + self-gating on CLOUD_MODE; without it Oblien
  // never calls our receiver.
  void ensureOblienWebhook().catch((err) =>
    console.warn("[boot] ensureOblienWebhook failed:", err),
  );

  // Self-hosted only: backfill per-project GitHub webhook secrets for
  // auto-deploy projects registered before per-project secrets were wired
  // (self-gates on !CLOUD_MODE). Fixes silently-broken auto-deploy on installs
  // that followed the "GITHUB_WEBHOOK_SECRET is ignored" guidance.
  void backfillWebhookSecrets().catch((err) =>
    console.warn("[boot] backfillWebhookSecrets failed:", err),
  );

  // Re-register every enabled cron policy with the runner.
  void reconcileAllSchedules().then((stats) =>
    console.log(
      `[boot] backup schedules: ${stats.registered} registered, ${stats.skipped} skipped`,
    ),
  );

  void Promise.all([sweepStale, sweepStaleRestores]).then(([runs, restores]) => {
    if (runs > 0 || restores > 0) {
      console.log(
        `[boot] swept ${runs} stale backup runs + ${restores} stale restores`,
      );
    }
  });
}

// ─── Notification delivery runner ───────────────────────────────────
//
// Polls notification_delivery for queued rows every few seconds and
// dispatches them to per-channel workers (email/webhook/in_app/slack).
// Lightweight in-process timer — fine for the cluster sizes we target.
{
  const { startNotificationRunner } = await import("./lib/notification-workers");
  startNotificationRunner();
  console.log("[boot] notification runner started");
}

// ─── Feature startup hooks (self-hosted only) ───────────────────────
//
// Registry-based home for boot behavior that individual features opt
// into via `registerStartupHook` — e.g. desktop re-establishing its
// saved port-forward tunnels. No-op under CLOUD_MODE; each hook is
// further gated by its declared modes. The ad-hoc boot blocks above
// stay as-is (some are cloud); new self-hosted boot work belongs here.
{
  const { registerStartupHooks } = await import("./lib/startup/register");
  const { runStartupHooks } = await import("./lib/startup");
  registerStartupHooks();
  await runStartupHooks();
}
