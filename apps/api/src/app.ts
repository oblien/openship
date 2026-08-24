import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env, trustedOrigins } from "./config/env";
import { handleApiError } from "./middleware/error-handler";
import { rateLimiterFor, floodGuard } from "./middleware/rate-limiter";
import { clientIpMiddleware } from "./middleware/client-ip";
import { betterAuthShield } from "./middleware/better-auth-shield";
import { forceMcpConsent } from "./middleware/mcp-consent";
import { originGuard } from "./middleware/origin-guard";
import { migrationGuard } from "./middleware/migration-guard";
import { initPlatform } from "@repo/adapters";
import { validatePlanPriceIds } from "@repo/core";
import { resolvePlatformConfig } from "./lib/controller-helpers";
import { runWithRequestStore } from "./lib/request-store";
import { runWithCallSource } from "./lib/call-source";

import { authRoutes } from "./modules/auth/auth.routes";
import { auth } from "./lib/auth";
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
import { backupDestinationRoutes } from "./modules/backup-destinations/destination.routes";
import { reconcileAllSchedules } from "./modules/backups/triggers/cron";
import { reconcileJobs } from "./modules/jobs/job.service";
import { scheduleBillingAnniversary } from "./modules/billing/billing-anniversary.cron";
import { ensureOblienWebhook } from "./lib/openship-cloud";
import { ensureOblienDefaultQuota } from "./modules/billing/billing-oblien-quota";
import { backfillWebhookSecrets } from "./modules/github/github.service";
import { backupOrchestrator } from "./modules/backups/backup.orchestrator";
import { getJobRunner } from "./lib/job-runner";
import { repos } from "@repo/db";

/* ---------- Initialize platform (runtime + infra + system) ---------- */
await initPlatform(resolvePlatformConfig());

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
    return new Response(
      JSON.stringify(rewriteMetadataOrigin(metadata, publicOriginFor(req))),
      { status: res.status, headers },
    );
  };
}

const serveAuthServerMetadata = requestScopedMetadata(oauthAuthServerMetadata);
const serveProtectedResourceMetadata = requestScopedMetadata(oauthProtectedResourceMetadata);

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
//
// Pre-auth flood guard: a coarse per-IP ceiling on the whole /api tree, ahead
// of every route chain (and of authMiddleware, injected downstream by
// secureRouter). Bounds abusive volume so an unauthenticated flood can't drive
// the session lookup unthrottled. A separate bucket from the per-route policies,
// so it doesn't double-charge them. No-op behind an edge that already rate-limits
// (CLOUD_MODE / OPENSHIP_TRUST_EDGE). See middleware/rate-limiter.ts + #123.
app.use("/api/*", floodGuard);

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

  // Analytics is scraped on two triggers, neither wired here: the
  // `analytics:scrape` system job owns durability (the edge holds counters in RAM
  // under a TTL, so an unswept server loses them), and the read handlers scrape
  // on view for freshness. Both go through scrapeServerIfStale, which throttles
  // and dedups, so they collapse rather than compete.
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

  // Account-wide default credit ceiling, auto-applied by Oblien to any namespace
  // created without an explicit setQuota. Backstop only — the spend path asserts
  // the real ceiling — but it makes the free tier, not "unlimited", the failure
  // mode of a forgotten quota push. Self-gating on CLOUD_MODE.
  void ensureOblienDefaultQuota().catch((err) =>
    console.warn("[boot] ensureOblienDefaultQuota failed:", err),
  );

  // Drain orgs that have no Oblien namespace recorded. Every org predates
  // namespace persistence (the column was read in eleven places and written in
  // none), so until this sweep finishes their credit quotas and resource
  // ceilings do not exist on Oblien's side. Bounded per boot.
  void import("./modules/billing/billing-namespace.provision")
    .then(({ backfillOrgNamespaces }) => backfillOrgNamespaces())
    .then((stats) => {
      if (stats.done > 0 || stats.failed > 0) {
        console.log(
          `[boot] Oblien namespaces backfilled: ${stats.done} provisioned, ${stats.failed} failed`,
        );
      }
    })
    .catch((err) => console.warn("[boot] backfillOrgNamespaces failed:", err));

  // Every PUBLISHED price must have a real Stripe price id in the environment.
  // Now that the pricing catalog states actual prices, a missing id is a
  // customer-visible failure: the plan card shows $39 and checkout 503s. This
  // check already existed but had NO caller in either mode — wired here.
  //
  // Loud, not fatal: refusing to boot the whole SaaS over an unset price id
  // would trade a broken checkout button for a total outage, and checkout
  // already fails closed on its own (503 BILLING_NOT_CONFIGURED at the point of
  // use, plus BILLING_ENABLED defaults off). Self-hosted logs it as information
  // — it never sells anything.
  // A live campaign must match its Stripe coupon, or the page advertises a
  // discount the customer won't get. Only reaches Stripe when a campaign is
  // actually running, so the common case costs nothing.
  void import("./modules/billing/billing.service")
    .then(({ verifyCampaigns }) => verifyCampaigns())
    .then((problems) => {
      for (const p of problems) console.error(`[boot] pricing campaign: ${p}`);
    })
    .catch((err) => console.warn("[boot] verifyCampaigns failed:", err));

  {
    const { missing } = validatePlanPriceIds();
    if (missing.length > 0) {
      const detail = missing.join(", ");
      if (env.CLOUD_MODE) {
        console.error(
          `[boot] FATAL: published prices with no Stripe price id configured: ${detail}. Set those env vars or unpublish the price in packages/core/src/pricing/pricing.json.`,
        );
      } else {
        console.log(`[boot] billing not configured (self-hosted, expected): ${detail}`);
      }
    }
  }

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
