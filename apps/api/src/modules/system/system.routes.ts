/**
 * System routes - mounted at /api/system in app.ts.
 *
 * Self-hosted only (gated by localOnly in app.ts).
 *
 * Auth strategies:
 *   - /setup routes use internalAuth (Electron → API, no user session)
 *     and pass `skipAuth: true` so secureRouter doesn't auto-inject
 *     the user-session authMiddleware on top of internalAuth.
 *   - all other routes get authMiddleware auto-injected by secureRouter.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { internalAuth, localOnly, requireRole } from "../../middleware";
import { rateLimiterFor } from "../../middleware/rate-limiter";
import { secureRouter } from "../../lib/secure-router";
import * as fs from "./filesystem.controller";
import * as setup from "./setup.controller";
import * as selfApp from "./self-app.controller";
import * as serverCheck from "./server-check.controller";
import * as serversCtrl from "./servers.controller";
import * as rateLimit from "./rate-limit.controller";
import * as tunnels from "./tunnels.controller";
import * as serverGithub from "../github/server-github.controller";
import * as serverModules from "./server-modules.controller";
import * as migration from "./migration/migration.controller";
import * as dataTransfer from "./data-transfer/data-transfer.controller";

const r = secureRouter(new Hono(), {
  module: "system",
  basePath: "/api/system",
});

r.use("*", localOnly);

/* ── Onboarding (first-run only, no auth) ───────────────────────── */
r.public("get", "/onboarding", { reason: "First-run onboarding status check - no user exists yet" }, setup.onboardingStatus);
r.public("post", "/onboarding", { reason: "First-run onboarding setup - creates initial admin user" }, setup.onboardingSetup);
r.public("post", "/onboarding/test-connection", { reason: "First-run SSH reachability test - no user exists yet; gated to no-servers instance" }, serverCheck.onboardingTestConnection);

/* ── Internal routes (Electron → API with shared token) ─────────── */
r.public("post", "/setup", { reason: "Electron desktop client setup - protected by internalAuth shared token" }, internalAuth, setup.setup);
r.public("get", "/setup", { reason: "Electron desktop client setup read - protected by internalAuth shared token" }, internalAuth, setup.getSetup);
r.public("post", "/bootstrap-admin", { reason: "CLI first-admin creation — internal-token gated, one-shot before any admin exists (openship setup)" }, internalAuth, setup.bootstrapAdmin);
r.public("post", "/reset-admin-password", { reason: "CLI password recovery — internal-token gated; resets the local admin login for a locked-out operator (openship reset-admin-password)" }, internalAuth, setup.resetAdminPassword);
r.public("post", "/invite-signup", { reason: "Self-host invited signup — authorized by the unguessable invitation id (token) in the emailed link, NOT a session; creates the account for the invitation's own email. Public + rate-limited because the invitee isn't logged in yet." }, rateLimiterFor("auth-tight"), setup.inviteSignup);

/* ── Control-plane self-registration (CLI setup wizard) ─────────────
 * After bootstrap-admin, the wizard registers Openship itself as an app
 * (shows under Apps) + attaches its domain — free (Oblien edge) or custom
 * (OpenResty + Let's Encrypt, streamed). All internal-token gated. */
r.public("get", "/cloud-status", { reason: "CLI setup — read Openship Cloud connection state; internal-token gated" }, internalAuth, selfApp.cloudStatus);
r.public("post", "/cloud-connect", { reason: "CLI setup — finalize Openship Cloud PKCE handshake for a free domain; internal-token gated" }, internalAuth, selfApp.cloudConnect);
r.public("post", "/self-register", { reason: "CLI setup — register the control plane as an app + attach its domain; internal-token gated" }, internalAuth, selfApp.selfRegister);
r.public("get", "/self-register/stream", { reason: "CLI setup — SSE progress for custom-domain edge provisioning; internal-token gated" }, internalAuth, selfApp.selfRegisterStream);
r.public("post", "/self-edge/preflight", { reason: "CLI setup — detect what owns ports 80/443 before installing OpenResty; internal-token gated" }, internalAuth, selfApp.selfEdgePreflight);

/* ── Authenticated routes (dashboard settings page) ─────────────── */
r.get("/settings", { tag: "settings:read" }, setup.getSetup);
r.patch("/settings", { tag: "settings:write" }, setup.updateSettings);
// Destructive reset — owner-only (like the other destructive settings routes),
// and the handler is org-scoped (it only clears the CALLER's-org servers, never
// every org's — see deleteSettings).
r.delete("/settings", { tag: "settings:admin" }, requireRole("owner"), setup.deleteSettings);

// Instance SMTP (Settings → Email) — self-hosted operator transport for all
// system mail (password reset, verification, invites, notifications).
//
// WRITE + TEST are owner-only via requireRole("owner"): the `settings:*` tag
// alone also admits admins/members (see lib/permission.ts), and this row is
// the transport for every password-reset/verification email — a member who
// could repoint it to their own SMTP relay could harvest reset tokens and take
// over the owner's account (same reasoning as the data-transfer routes below).
// GET returns only a MASKED config (no password) so it stays settings:read —
// that keeps the "no email transport → set up SMTP" hint readable everywhere.
r.get("/settings/email", { tag: "settings:read" }, setup.getEmailSettings);
r.put("/settings/email", { tag: "settings:write" }, requireRole("owner"), setup.updateEmailSettings);
r.post("/settings/email/test", { tag: "settings:write" }, requireRole("owner"), setup.sendTestEmail);

/* ── Zero-auth → local-auth upgrade (no session yet) ────────────── */
r.public(
  "post",
  "/upgrade-to-auth",
  {
    reason:
      "Zero-auth upgrade flow — no session cookie exists for the synthetic local user. Handler enforces authMode === 'none' before mutating.",
  },
  setup.upgradeToAuth,
);

/* ── Servers CRUD ───────────────────────────────────────────────── */
r.get("/servers", { tag: "server:list" }, serversCtrl.listServers);
r.get("/servers/:id", { tag: "server:read" }, serversCtrl.getServer);
r.get("/servers/:id/reachability", { tag: "server:read" }, serversCtrl.probeReachability);
// Create has no :id in the URL — org scope comes from the request and the
// row is created in the active org. collection:true keeps the permission
// middleware from demanding a (nonexistent) :id param.
r.post("/servers", { tag: "server:write", collection: true }, serversCtrl.createServer);
r.patch("/servers/:id", { tag: "server:write" }, serversCtrl.updateServer);
r.delete("/servers/:id", { tag: "server:admin" }, serversCtrl.deleteServer);

/* ── Per-server rate limiting (OpenResty level) ─────────────────── */
r.get("/servers/:id/rate-limit", { tag: "server:read" }, rateLimit.getRateLimit);
r.patch("/servers/:id/rate-limit", { tag: "server:write" }, rateLimit.updateRateLimit);
r.post("/servers/:id/ports/scan", { tag: "server:read", readOnly: true }, serverCheck.scanExposedPorts);

// ── Native-module versioning + migration (OpenResty, …). The `:id` server is
//    the permission resource; handlers hard-guard cloud + org-scope. ──
r.get("/servers/:id/modules", { tag: "server:read" }, serverModules.listServerModules);
r.post("/servers/:id/modules/scan", { tag: "server:write" }, serverModules.scanServerModules);
r.post("/servers/:id/modules/:module/apply", { tag: "server:write" }, serverModules.applyServerModuleUpdate);

// ── Per-server GitHub auth (self-hosted): device-login token / PAT / SSH
//    server-key / per-repo deploy-key. The `:id` server is the permission
//    resource; handlers hard-guard cloud + org-scope the server. ──
r.get("/servers/:id/github", { tag: "server:read" }, serverGithub.getStatus);
r.post("/servers/:id/github/connect", { tag: "server:write" }, serverGithub.startConnect);
r.get("/servers/:id/github/connect/poll", { tag: "server:read" }, serverGithub.pollConnect);
r.put("/servers/:id/github/token", { tag: "server:write" }, serverGithub.putToken);
r.post("/servers/:id/github/ssh-key", { tag: "server:write" }, serverGithub.generateSshKey);
r.put("/servers/:id/github/deploy-key-mode", { tag: "server:write" }, serverGithub.useDeployKeyMode);
r.delete("/servers/:id/github", { tag: "server:write" }, serverGithub.disconnect);

/* ── Port-forward tunnels (DESKTOP-only; handlers add assertDesktop) ─
 * VS Code-style forwarding of a remote server port to localhost. Config
 * persists in server_tunnels; live sockets live in ssh-tunnel-manager.
 * `:id` is the server resource the permission middleware resolves on.
 */
r.get("/servers/:id/tunnels", { tag: "server:read" }, tunnels.listTunnels);
r.post("/servers/:id/tunnels", { tag: "server:write" }, tunnels.saveTunnel);
r.post("/servers/:id/tunnels/:tunnelId/start", { tag: "server:write" }, tunnels.startTunnelHandler);
r.post("/servers/:id/tunnels/:tunnelId/stop", { tag: "server:write" }, tunnels.stopTunnelHandler);
r.delete("/servers/:id/tunnels/:tunnelId", { tag: "server:write" }, tunnels.deleteTunnel);

/* ── Server check & install (dashboard setup wizard) ─────────────
 * These endpoints target a server identified by `serverId` in the
 * request BODY (POST) or QUERY string (GET), not a URL :id param. The
 * route-permission middleware only resolves ids from path params, so
 * each is marked `collection: true` to org-scope the route-level check;
 * every handler then runs its own
 * `permission.assert({ resourceType: "server", resourceId: <body/query id> })`
 * for the precise per-server authorization. Without this flag the
 * middleware 400s with "Missing route param :id" before the handler runs.
 */
r.post("/test-connection", { tag: "server:write", collection: true }, serverCheck.testConnection);
r.post("/check", { tag: "server:write", collection: true }, serverCheck.checkServer);
r.post("/install", { tag: "server:admin", collection: true }, serverCheck.installComponent);
r.post("/remove", { tag: "server:admin", collection: true }, serverCheck.removeComponent);
r.post("/install/stream", { tag: "server:admin", collection: true }, serverCheck.installStream);
r.post("/install/respond", { tag: "server:admin", collection: true }, serverCheck.installRespond);
r.get("/install/stream", { tag: "server:read", collection: true }, serverCheck.attachInstallStream);
r.get("/install/session", { tag: "server:read", collection: true }, serverCheck.getInstallSession);

/* ── Server monitoring (live stats via SSE) ─────────────────────── */
r.get("/monitor/stream", { tag: "server:read", collection: true }, serverCheck.monitorStream);

/* ── Filesystem browse ──────────────────────────────────────────── */
r.get("/browse", { tag: "settings:read" }, fs.browse);

/* ── Team-mode migration ─────────────────────────────────────────
 * Path A (single_user → self_hosted_remote): preflight + start
 * Path B (single_user → cloud_hosted):       start-cloud
 * Path C (single_user → tunneled):           start-tunnel
 */
r.post("/migration/preflight", { tag: "settings:admin" }, migration.preflight);
r.post("/migration/start", { tag: "settings:admin" }, migration.start);
r.post("/migration/start-cloud", { tag: "settings:admin" }, migration.startCloud);
r.post("/migration/start-tunnel", { tag: "settings:admin" }, migration.startTunnel);
r.post("/migration/switch-back", { tag: "settings:admin" }, migration.switchBack);

/* ── Whole-instance data export / import (owner-only) ─────────────
 * requireRole("owner") is mandatory — the `settings:*` tag alone also
 * admits admins/members (see lib/permission.ts), and this moves the
 * entire database including every org's data.
 */
r.post("/data-transfer/export", { tag: "settings:admin" }, requireRole("owner"), dataTransfer.exportInstanceHandler);
r.use(
  "/data-transfer/import",
  bodyLimit({
    maxSize: 500_000_000,
    onError: (c) => c.json({ error: "Import file exceeds the 500MB limit.", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
);
r.post("/data-transfer/import", { tag: "settings:admin" }, requireRole("owner"), dataTransfer.importInstanceHandler);

export const systemRoutes = r.hono;

