import { actionRoutes } from "./modules/actions/action.routes";
import { actionRuntimeRoutes, actionTwirpRoutes } from "./modules/actions/action-runtime.routes";
import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env, trustedOrigins } from "@repo/platform/engine/config/env";
import { handleApiError } from "./middleware/error-handler";
import { observeRequestErrors } from "./middleware/error-observation";
import { authRouteLimiter, floodGuard } from "./middleware/rate-limiter";
import { clientIpMiddleware } from "./middleware/client-ip";
import { betterAuthShield } from "./middleware/better-auth-shield";
import { forceMcpConsent } from "./middleware/mcp-consent";
import { originGuard } from "./middleware/origin-guard";
import { migrationGuard } from "./middleware/migration-guard";
import {
  controllerIsActive,
  registerControllerLifecycle,
} from "./modules/system/instance/controller-state";
import { resumeControllerSockets } from "./lib/ws";
import { trackBackgroundWork } from "@repo/platform/engine/lib/background-work";
import { instanceAuthorityGuard } from "./modules/system/instance/authority-guard";
import { quiesceController } from "./modules/system/instance/quiescence";
import { initPlatform } from "@repo/adapters";
import { resolvePlatformConfig } from "@repo/platform/engine/lib/platform-config";
import { runWithRequestStore } from "@repo/platform/engine/lib/request-store";
import { runWithCallSource } from "./lib/call-source";
import { sanitizeRequestLogLine } from "./lib/request-log-redaction";

import { authRoutes } from "./modules/auth/auth.routes";
import { auth } from "@repo/platform/engine/lib/auth";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";
import {
  MCP_RESOURCE_PATHS,
  protectedResourceMetadata,
  publicOriginFor,
  rewriteMetadataOrigin,
} from "./lib/mcp-resource";
import { projectRoutes } from "./modules/projects/project.routes";
import { appRoutes } from "./modules/apps/app.routes";
import { appSettingsRoutes } from "./modules/apps/app-settings.routes";
import { appConnectionRoutes } from "./modules/apps/app-connection.routes";
import { projectConnectionRoutes } from "./modules/projects/project-connection.routes";
import { projectStorageRoutes } from "./modules/projects/project-storage.routes";
import { deploymentRoutes } from "./modules/deployments/deployment.routes";
import { domainRoutes } from "./modules/domains/domain.routes";
import { dnsRoutes } from "./modules/dns/dns.routes";
import { credentialRoutes } from "./modules/credentials/credential.routes";
import { issuesRoutes } from "./modules/issues/issues.routes";
import { jobRoutes } from "./modules/jobs/job.routes";
import { noticeRoutes } from "./modules/notices/notice.routes";
import { serviceRoutes } from "./modules/services/service.routes";
import { analyticsRoutes } from "./modules/analytics/analytics.routes";
import { billingPlansRoutes } from "./modules/billing/billing.routes";
import { webhookRoutes } from "./modules/webhooks/webhook.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { githubRoutes } from "./modules/github";
import * as githubAuth from "@repo/platform/engine/modules/github/github.auth";
import { settingsRoutes } from "./modules/settings/settings.routes";
import { tokenRoutes } from "./modules/tokens/token.routes";
import { mcpRoutes } from "./modules/mcp/mcp.routes";
import { notificationsRoutes } from "./modules/notifications/notifications.routes";
import { updatesRoutes } from "./modules/updates/updates.routes";
import { imageRoutes } from "./modules/images/images.routes";
import { backupRoutes } from "./modules/backups/backup.routes";
import { auditRoutes } from "./modules/audit/audit.routes";
import { permissionsRoutes } from "./modules/permissions/permissions.routes";
import { backupDestinationRoutes } from "./modules/backup-destinations/destination.routes";
import { reconcileAllSchedules } from "@repo/platform/engine/modules/backups/triggers/cron";
import { reconcileJobs, runScheduledJob } from "@repo/platform/engine/modules/jobs/job.service";
import { scheduleBillingAnniversary } from "@repo/platform/engine/modules/billing/billing-anniversary.cron";
import { ensureOblienWebhook } from "@repo/platform/engine/lib/openship-cloud";
import { ensureOblienDefaultQuota } from "@repo/platform/engine/modules/billing/billing-oblien-quota";
import { backfillWebhookSecrets } from "@repo/platform/engine/modules/github/github.service";
import { backupOrchestrator } from "@repo/platform/engine/modules/backups/backup.orchestrator";
import { getJobRunner } from "@repo/platform/engine/lib/job-runner/index";
import { repos } from "@repo/db";

/* ---------- Initialize platform (runtime + infra + system) ---------- */
await initPlatform(resolvePlatformConfig());
if (await controllerIsActive()) await repos.configurationSecrets.backfillLegacy();

export const app = new Hono();

const oauthAuthServerMetadata = oAuthDiscoveryMetadata(auth);
const oauthProtectedResourceMetadata = oAuthProtectedResourceMetadata(auth);

/**
 * Serve one of the plugin's discovery documents re-pointed at the origin THIS
 * request arrived on, instead of the static baseURL it was built from (#543 —
 * see `rewriteMetadataOrigin` for why that origin is unreachable).
 *
 * `no-store` because the document now varies by request origin on a box with no
 * OPENSHIP_PUBLIC_URL: the plugin sets `Access-Control-Allow-Origin: *` and no
 * cache directives, so a shared cache keyed on path alone could otherwise hand
 * one client's resolved origin to another.
 */
function requestScopedMetadata(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const res = await handler(req);
    const body = await res.text();
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-store");
    headers.delete("content-length");
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(body) as Record<string, unknown>;
    } catch {
      // Non-JSON (an upstream error page): pass the plugin's own body through.
      return new Response(body, { status: res.status, headers });
    }
    return new Response(JSON.stringify(rewriteMetadataOrigin(metadata, publicOriginFor(req))), {
      status: res.status,
      headers,
    });
  };
}

const serveAuthServerMetadata = requestScopedMetadata(oauthAuthServerMetadata);
const serveProtectedResourceMetadata = requestScopedMetadata(oauthProtectedResourceMetadata);

/* ---------- Global middleware ---------- */
app.use("*", observeRequestErrors);
app.use(
  "*",
  cors({
    origin: trustedOrigins,
    credentials: true,
    exposeHeaders: ["X-Request-ID"],
  }),
);
// Hono's default logger includes the raw query string and path. Invitation ids
// are bearer credentials embedded in a path, while OAuth/signed credentials
// commonly live in queries, so sanitize both before anything reaches stdout.
// Bypass logging for periodic healthcheck probes to prevent log flooding.
const requestLogger = logger((line) => console.log(sanitizeRequestLogLine(line)));
app.use("*", (c, next) => {
  if (c.req.path === "/api/health" || c.req.path === "/health") {
    return next();
  }
  return requestLogger(c, next);
});
// Seed a per-request memo store FIRST so every downstream handler shares it.
// Collapses idempotent-per-request reads (cloud session validation, GitHub
// auth-mode, installations) to one call each — a single /github/status was
// fanning out into ~6 /cloud/account + 3 installations round-trips otherwise.
app.use("*", (_c, next) => runWithRequestStore(() => next()));
// Ambient call source (dashboard / mcp / cli / api). Seeded here so the audit
// emitters that run outside the handler chain — Better Auth's organization hooks
// — can still record WHERE a member/invitation change came from.
app.use("*", (c, next) => runWithCallSource(c, () => next()));
app.use("*", clientIpMiddleware);
// CSRF defence: reject mutating requests from untrusted origins BEFORE
// the auth chain touches the session. Webhooks (Stripe, Oblien) don't
// send an Origin header so they pass through; CLI/server-to-server
// callers using Bearer also have no Origin and pass through.
app.use("*", originGuard);
app.use("*", instanceAuthorityGuard);
app.use("*", migrationGuard);

// Primary error path: Hono's compose() catches thrown errors at each
// dispatch level and routes them to `this.errorHandler`, NOT up through
// middleware. So try/catch-around-next middleware never sees downstream
// throws — only an explicit `app.onError(...)` does. Register one here so
// AppError / ZodError get serialized with their statusCode and code.
app.onError(handleApiError);

// Per-route rate limiting lives after authentication (fixes #123).
// secureRouter injects a per-route limiter AFTER
// authMiddleware — `default-authed` (per user) for permission-tagged routes,
// `default-anon` (per IP) for public ones, or the route's explicit `rateLimit`
// policy. A global limiter ran upstream of auth, so it could never see `ctx`
// (always default-anon) and double-charged routes with their own policy.
//
// An independent pre-auth ceiling protects the session lookup on standalone
// installations. Its flood-ip bucket does not charge the per-route policies.
// Cloud mode and OPENSHIP_TRUST_EDGE delegate this ceiling to the trusted edge.
app.use("/api/*", floodGuard);

// Better Auth is a RAW catch-all (not secureRouter), so it carries one central
// limiter: POSTs and invitation bearer-token previews use `auth-tight`; ordinary
// session/OAuth GETs use `default-anon`. A route must not add a second limiter.
app.use("/api/auth/*", authRouteLimiter);

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
app.route("/api/projects/:id/storage", projectStorageRoutes);
app.route("/api/deployments", deploymentRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/dns", dnsRoutes);
app.route("/api/credentials", credentialRoutes);
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
app.route("/api/audit", auditRoutes);
app.route("/api/permissions", permissionsRoutes);
app.route("/api/notifications", notificationsRoutes);
app.route("/api/updates", updatesRoutes);
// Org-wide issue feed — reads the caches the jobs above write; no detection of its own.
app.route("/api/issues", issuesRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/actions", actionRoutes);
app.route("/api/actions/runtime", actionRuntimeRoutes);
app.route("/twirp", actionTwirpRoutes);
// Platform status notices — banner feed (public read) + operator push (internal).
// Both modes; primarily consumed on the SaaS.
app.route("/api/notices", noticeRoutes);

/* ---------- OAuth 2.1 discovery (MCP) ---------- */
// The mcp() plugin serves these under /api/auth, but MCP/OAuth 2.1 clients look
// for them at the ORIGIN ROOT. Re-serve the plugin's documents here — through the
// request-scoped rewrite — so `Authorization`-less requests to /api/mcp can be
// discovered end-to-end.
//
// The protected-resource one needs the rewrite as much as the authorization-server
// one: the plugin builds its `resource` + `authorization_servers` from the same
// static baseURL, so a client that probes here instead of following our 401 hint
// would echo the INTERNAL origin back as `resource=` on the token request — which
// mcp-token.handler rejects as `invalid_target`, validating against the PUBLIC
// origin's resources.
app.get("/.well-known/oauth-authorization-server", (c) => serveAuthServerMetadata(c.req.raw));
app.get("/.well-known/oauth-protected-resource", (c) => serveProtectedResourceMetadata(c.req.raw));

// RFC 9728 §3.1: metadata for a resource whose identifier has a PATH lives at
// the well-known prefix FOLLOWED BY that path. A client configured with
// `https://host/api/mcp` looks there, not at the root — and the root document's
// `resource` (the bare origin) doesn't match the URL it connected to, so a
// strict client (Claude.ai) rejects the authorization it just completed.
// Serve one document per URL that addresses this instance's MCP endpoint.
const OAUTH_DISCOVERY_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // Origin-dependent when no OPENSHIP_PUBLIC_URL is set — never let a shared
  // cache serve one client's resolved origin to another.
  "Cache-Control": "no-store",
} as const;

for (const path of MCP_RESOURCE_PATHS) {
  app.get(`/.well-known/oauth-protected-resource${path}`, (c) => {
    const origin = publicOriginFor(c.req.raw);
    const body = protectedResourceMetadata(origin, `${origin}${path}`);
    return new Response(JSON.stringify(body), { status: 200, headers: OAUTH_DISCOVERY_HEADERS });
  });
  // RFC 8414 path-aware authorization-server metadata. Same document as the
  // root one — served here so a client that only probes the path-aware location
  // finds it instead of falling back.
  app.get(`/.well-known/oauth-authorization-server${path}`, (c) =>
    serveAuthServerMetadata(c.req.raw),
  );
}

/* ---------- OAuth callback landing pages ---------- */
const authCallbackHtml = `<!DOCTYPE html><html><head><title>Success</title></head><body><script>window.close();</script><p>Authentication successful. You can close this window.</p></body></html>`;

app.get("/auth/callback/install", (c) => {
  if (githubAuth.getGitHubAuthMode() === "app") {
    // The setup URL's installation_id is attacker-controlled. A local App
    // install is usable only when it carries the one-shot user/workspace state
    // minted before OAuth. Never retain the old stateless fallback here.
    const state = c.req.query("state")?.trim();
    if (!state) {
      return c.text("Missing GitHub installation state. Start again from Settings.", 400);
    }
    return c.redirect(`${githubAuth.getInstallUrl()}?state=${encodeURIComponent(state)}`);
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
  const { serviceTerminalRoutes } =
    await import("./modules/service-terminal/service-terminal.routes");
  app.route("/api/services/terminal", serviceTerminalRoutes);
}

// Host resources resolve their own connection; machine-local setup remains self-hosted.
{
  const { serverResourceRoutes } = await import("./modules/system/server-resource.routes");
  app.route("/api/system", serverResourceRoutes);
  const { terminalRoutes } = await import("./modules/terminal/terminal.routes");
  app.route("/api/terminal", terminalRoutes);
  const { migrationRoutes } = await import("./modules/migration/migration.routes");
  app.route("/api/migration", migrationRoutes);
}

/* ---------- Cloud-only routes (gated by CLOUD_MODE) ---------- */
if (env.CLOUD_MODE) {
  const { diagnosticsRoutes } = await import("./modules/diagnostics/diagnostics.routes");
  app.route("/api/diagnostics", diagnosticsRoutes);
  const { cloudSupportRoutes } = await import("./modules/cloud-support/cloud-support.routes");
  app.route("/api/cloud/support", cloudSupportRoutes);
  const { cloudAnalyticsRoutes } = await import("./modules/cloud-analytics/cloud-analytics.routes");
  app.route("/api/cloud/telemetry", cloudAnalyticsRoutes);
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
  const { instanceRoutes } = await import("./modules/system/instance/instance.routes");
  app.route("/api/system/instance", instanceRoutes);
  if (process.env.OPENSHIP_API_ONLY === "true") {
    const { instanceAccessPages } = await import("./modules/system/instance/access-page");
    app.route("/", instanceAccessPages);
  }
  const { systemRoutes } = await import("./modules/system/system.routes");
  app.route("/api/system", systemRoutes);

  /** Mail server setup - self-hosted iRedMail wizard */
  const { mailRoutes } = await import("./modules/mail/mail.routes");
  app.route("/api/mail", mailRoutes);

  /** Cloud account management - connect/disconnect to Openship Cloud */
  const { cloudLocalRoutes } = await import("./modules/cloud/cloud-local.routes");
  app.route("/api/cloud", cloudLocalRoutes);

  /** Private support uses the caller's personal Cloud connection. */
  const { cloudSupportLocalRoutes } =
    await import("./modules/cloud-support/cloud-support-local.routes");
  app.route("/api/cloud/support", cloudSupportLocalRoutes);

  /** Billing proxy - cloud-connected local instances proxy to SaaS */
  const { billingLocalRoutes } = await import("./modules/billing/billing-local.routes");
  app.route("/api/billing", billingLocalRoutes);

  // Analytics is scraped on two triggers, neither wired here: the
  // `analytics:scrape` system job owns durability (the edge holds counters in RAM
  // under a TTL, so an unswept server loses them), and the read handlers scrape
  // on view for freshness. Both go through scrapeServerIfStale, which throttles
  // and dedups, so they collapse rather than compete.
}

let backgroundStarted = false;
let startupRegistered = false;
async function startControllerBackground(): Promise<void> {
  if (backgroundStarted) return;
  backgroundStarted = true;
  try {
    resumeControllerSockets();
    // ─── Backup job runner + boot reconcile ─────────────────────────────
    //
    // One JobRunner powers all backup work — BullMQ when Redis is
    // reachable, in-process otherwise. Same code path for SaaS and
    // desktop installs. The runner is module-singleton; first access
    // here triggers Redis detection.
    {
      // These rows represent process-owned work. A self-hosted instance has one API
      // process, so its boot proves the previous owner died. CLOUD_MODE has several
      // replicas sharing the same DB: one replica starting proves nothing about a
      // worker or teardown on another, and sweeping it would manufacture false
      // quiescence while that other process can still mutate runtime resources.
      if (!env.CLOUD_MODE) {
        await Promise.all([
          repos.terminalSession.closeAllActive("server_error"),
          repos.serviceTerminalSession.closeAllActive("server_error"),
        ]);
        // A self-hosted process restart proves every in-process worker from the old
        // process is gone. Complete reconciliation BEFORE starting the runner: a
        // fire-and-forget sweep can otherwise terminalize a backup/deploy/restore
        // that the new process has already claimed.
        const [runs, restores, deployments] = await Promise.all([
          repos.backupRun.sweepStaleRuns("API restart while backup in flight"),
          repos.backupRestore.sweepStaleRestores("API restart while restore in flight"),
          repos.deployment.sweepStaleInFlight(
            "Interrupted by a server restart — redeploy to try again.",
          ),
        ]);
        if (runs > 0 || restores > 0) {
          console.log(`[boot] swept ${runs} stale backup runs + ${restores} stale restores`);
        }
        if (deployments > 0) {
          console.log(`[boot] cancelled ${deployments} stale in-flight deployment(s)`);
        }

        // Stale project deletion flags are reclaimed under the project advisory
        // lock by the next teardown attempt. A blanket boot sweep can overlap work
        // started by this process and clear a fresh fence, so it is deliberately
        // not used here.
      }
      // A Docker migration is an in-memory FSM that quiesces (stops) the source
      // containers before the target deploy — a restart mid-migration would strand
      // a stopped production stack forever. Restart the originals + roll back any
      // interrupted run. Per-run advisory leases leave workers on other Cloud
      // replicas untouched; the same recovery is used by self-hosted installations.
      {
        const { migrationOrchestrator } =
          await import("@repo/platform/engine/modules/migration/migration.orchestrator");
        await migrationOrchestrator.recoverInterruptedMigrations();
      }

      const runner = await getJobRunner();
      await runner.start({
        processRun: (runId) => backupOrchestrator.execute(runId),
        processRecurring: runScheduledJob,
      });
      console.log(`[boot] backup runner: ${runner.describe()}`);
      (await import("@repo/platform/engine/modules/actions/lifecycle")).startActionController();

      // Generic job schedule: seed built-in system jobs (SSL renewal, orphan GC,
      // prunes, deployment reconcile) into the `job` table and register every
      // enabled row on the runner. Operator cron/enabled overrides survive restarts.
      void trackBackgroundWork(
        reconcileJobs()
          .then((stats) => console.log(`[boot] jobs: ${stats.registered}/${stats.total} scheduled`))
          .catch((err) => errorDiagnostics.warn("api/app", "[boot] reconcileJobs failed:", err)),
      );

      // Self-hosted (single box): any job_run still "running" at boot was orphaned
      // by a crash/restart mid-run — close it out so the Jobs UI doesn't show a
      // perpetual "Running" spinner. Not run in CLOUD_MODE, where a shared queue +
      // multiple replicas mean a "running" row may be live on another replica.
      if (!env.CLOUD_MODE) {
        void trackBackgroundWork(
          repos.jobRun
            .failStaleRunning()
            .then((n) => n > 0 && console.log(`[boot] reconciled ${n} orphaned job run(s)`))
            .catch((err) => errorDiagnostics.warn("api/app", "[boot] failStaleRunning failed:", err)),
        );
      }

      // Refresh entitlement mirrors every five minutes; Oblien owns renewals.
      void trackBackgroundWork(
        scheduleBillingAnniversary().catch((err) =>
          errorDiagnostics.warn("api/app", "[boot] scheduleBillingAnniversary failed:", err),
        ),
      );

      // Register signed payment, entitlement, and credit notifications.
      void trackBackgroundWork(
        ensureOblienWebhook().catch((err) =>
          errorDiagnostics.warn("api/app", "[boot] ensureOblienWebhook failed:", err),
        ),
      );

      // Validate onboarding policy without modifying provider quotas or grants.
      void trackBackgroundWork(
        ensureOblienDefaultQuota().catch((err) =>
          errorDiagnostics.warn("api/app", "[boot] ensureOblienDefaultQuota failed:", err),
        ),
      );

      if (env.CLOUD_MODE) {
        void import("@repo/platform/engine/modules/cloud-support/index")
          .then(({ startCloudSupport }) => startCloudSupport())
          .catch(() =>
            errorDiagnostics.warn("api/app",
              "[cloud-support] Background delivery could not start; requests remain saved.",
            ),
          );
        void import("@repo/platform/engine/modules/cloud-analytics/index")
          .then(({ startCloudAnalytics }) => startCloudAnalytics())
          .catch(() => errorDiagnostics.warn("api/app", "[cloud-analytics] Background delivery could not start."));
        void import("@repo/platform/engine/lib/oblien-client")
          .then(({ getOblienBillingApi }) => getOblienBillingApi().assertResellerSupport())
          .catch((error) =>
            errorDiagnostics.error("api/app", "[boot] Oblien reseller billing contract unavailable:", error),
          );
      }

      // Self-hosted only: backfill per-project GitHub webhook secrets for
      // auto-deploy projects registered before per-project secrets were wired
      // (self-gates on !CLOUD_MODE). Fixes silently-broken auto-deploy on installs
      // that followed the "GITHUB_WEBHOOK_SECRET is ignored" guidance.
      void trackBackgroundWork(
        backfillWebhookSecrets().catch((err) =>
          errorDiagnostics.warn("api/app", "[boot] backfillWebhookSecrets failed:", err),
        ),
      );

      // Re-register every enabled cron policy with the runner.
      void trackBackgroundWork(
        reconcileAllSchedules().then((stats) =>
          console.log(
            `[boot] backup schedules: ${stats.registered} registered, ${stats.skipped} skipped`,
          ),
        ),
      );
    }

    // ─── Notification delivery runner ───────────────────────────────────
    //
    // Polls notification_delivery for queued rows every few seconds and
    // dispatches them to per-channel workers (email/webhook/in_app/slack).
    // Lightweight in-process timer — fine for the cluster sizes we target.
    {
      const { startNotificationRunner } =
        await import("@repo/platform/engine/lib/notification-workers");
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
      const { runStartupHooks } = await import("@repo/platform/engine/lib/startup/index");
      if (!startupRegistered) {
        registerStartupHooks();
        startupRegistered = true;
      }
      await runStartupHooks();
    }
  } catch (error) {
    backgroundStarted = false;
    throw error;
  }
}
registerControllerLifecycle({
  start: startControllerBackground,
  stop: async () => {
    try { await quiesceController(); }
    finally {
      // A late Actions dispatch can refuse the handoff after its reconciler
      // has stopped. Cancelling that move must be able to start it again.
      backgroundStarted = false;
    }
  },
});
if (await controllerIsActive()) await startControllerBackground();
