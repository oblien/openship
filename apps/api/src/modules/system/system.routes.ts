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
import { internalAuth, requireInstanceAdmin } from "../../middleware";
import { AgentExecBody } from "../../lib/agent-exec.schema";
import { secureRouter } from "../../lib/secure-router";
import * as fs from "./filesystem.controller";
import * as setup from "./setup.controller";
import {
  invitationSignupBodyLimit,
  inviteSignup,
} from "../auth/invitation-signup.controller";
import * as selfApp from "./self-app.controller";
import * as serverCheck from "./server-check.controller";
import * as serversCtrl from "./servers.controller";
import * as rateLimit from "./rate-limit.controller";
import * as tunnels from "./tunnels.controller";
import * as serverGithub from "../github/server-github.controller";
import * as serverModules from "./server-modules.controller";
import * as serverContainers from "./server-containers.controller";
import * as migration from "./migration/migration.controller";
import * as dataTransfer from "./data-transfer/data-transfer.controller";
import * as systemHealth from "./system-health.controller";
import * as edgeOrphans from "./edge-orphans.controller";
import * as imageGc from "./image-gc.controller";

const r = secureRouter(new Hono(), {
  module: "system",
  basePath: "/api/system",
  localOnly: true,
});


/* ── Onboarding (first-run only, no auth) ───────────────────────── */
r.public("get", "/onboarding", { reason: "First-run onboarding status check - no user exists yet" }, setup.onboardingStatus);
r.public("post", "/onboarding", { reason: "First-run onboarding setup - creates initial admin user" }, setup.onboardingSetup);
r.public("post", "/onboarding/test-connection", { reason: "First-run SSH reachability test - no user exists yet; gated to no-servers instance" }, serverCheck.onboardingTestConnection);

/* ── Internal routes (Electron → API with shared token) ─────────── */
r.public("post", "/setup", { reason: "Electron desktop client setup - protected by internalAuth shared token" }, internalAuth, setup.setup);
r.public("get", "/setup", { reason: "Electron desktop client setup read - protected by internalAuth shared token" }, internalAuth, setup.getSetup);
r.public("get", "/health", { reason: "CLI `openship doctor` — internal-token gated deep health rollup (DB liveness/migrations + project/service counts); the public /api/health is only a liveness stub" }, internalAuth, systemHealth.systemHealth);
r.public("post", "/bootstrap-admin", { reason: "CLI first-admin creation — internal-token gated, one-shot before any admin exists (openship setup)" }, internalAuth, setup.bootstrapAdmin);
r.public("post", "/reset-admin-password", { reason: "CLI password recovery — internal-token gated; resets the local admin login for a locked-out operator (openship reset-admin-password)" }, internalAuth, setup.resetAdminPassword);
r.public(
  "post",
  "/invite-signup",
  {
    reason: "Self-host invited signup — authorized by the unguessable invitation id (token) in the emailed link, NOT a session; creates the account for the invitation's own email.",
    rateLimit: "auth-tight",
  },
  invitationSignupBodyLimit,
  inviteSignup,
);

/* ── Control-plane self-registration (CLI setup wizard) ─────────────
 * After bootstrap-admin, the wizard registers Openship itself as an app
 * (shows under Apps) + attaches its domain — free (Oblien edge) or custom
 * (OpenResty + Let's Encrypt, streamed). All internal-token gated. */
r.public("get", "/cloud-status", { reason: "CLI setup — read Openship Cloud connection state; internal-token gated" }, internalAuth, selfApp.cloudStatus);
r.public("post", "/cloud-connect", { reason: "CLI setup — finalize Openship Cloud PKCE handshake for a free domain; internal-token gated" }, internalAuth, selfApp.cloudConnect);
r.public("post", "/self-register", { reason: "CLI setup — register the control plane as an app + attach its domain; internal-token gated" }, internalAuth, selfApp.selfRegister);
r.public("get", "/self-register/stream", { reason: "CLI setup — SSE progress for custom-domain edge provisioning; internal-token gated" }, internalAuth, selfApp.selfRegisterStream);
r.public("post", "/self-edge/preflight", { reason: "CLI setup — detect what owns ports 80/443 before installing OpenResty; internal-token gated" }, internalAuth, selfApp.selfEdgePreflight);
r.public("post", "/edge/import-sites", { reason: "CLI `openship up` (compose) — register sites migrated from a foreign proxy into the container edge (host stops the proxy pre-up; api re-serves via DockerEdgeExecutor); internal-token gated" }, internalAuth, selfApp.edgeImportSites);

/* ── Untracked edge vhosts ──────────────────────────────────────────
 * Edge config lives on the host and outlives its DB rows by design (record-only
 * delete keeps the workload AND its route running). A leftover PROXY vhost 502s
 * and announces itself; a leftover STATIC one keeps serving the removed project's
 * files with a 200. This finds them, and removes them one named hostname at a
 * time — never as a sweep, which would break record-only's guarantee. */
// The scan diffs the host's live vhosts against EVERY org's domains
// (repos.domain.listAllHostnames + every mail server + OPENSHIP_PUBLIC_URL), so
// the READ is instance-wide too. `settings:read` alone admits a plain member
// (lib/permission.ts discards the action half of the tag), which made this a
// cross-tenant enumeration of every hostname the box serves. Gating the write
// half while leaving the read open is not a boundary.
r.get("/edge/untracked", { tag: "settings:read" }, requireInstanceAdmin(), edgeOrphans.listUntrackedEdgeSites);
// Stops serving a hostname → instance-admin only, same reason as the read
// (requireRole("owner") does not gate this; see middleware/instance-admin.ts).
r.post(
  "/edge/untracked/remove",
  { tag: "settings:admin" },
  requireInstanceAdmin(),
  edgeOrphans.removeUntrackedEdgeSite,
);

/* ── Built-image GC (the `images:gc` job, operator-facing) ──────────
 * `plan` is a read-only dry run naming what a sweep would remove and why the
 * rest stays; `run` is the sweep itself, recorded as a manual job run. Both
 * walk EVERY org's projects and hosts, so — like /edge/untracked above — the
 * org-singleton `job:*` tag alone is not a boundary; instance admin is. */
r.get("/image-gc/plan", { tag: "job:read" }, requireInstanceAdmin(), imageGc.plan);
r.post(
  "/image-gc/run",
  { tag: "job:write", body: imageGc.ImageGcRunBody },
  requireInstanceAdmin(),
  imageGc.run,
);

/* ── Authenticated routes (dashboard settings page) ─────────────── */
r.get("/settings", { tag: "settings:read" }, setup.getSetup);
// Instance-admin only (GHSA-43hf-p5j8-8vhx): this writes the single global
// instance_settings row — authMode, tunnelProvider/tunnelToken,
// defaultBuildMode, defaultRollbackWindow, invitationMailSource,
// autoUpdate/autoScanInfra — none of which is org-scoped. `settings:write`
// alone admits a plain member (lib/permission.ts allows every resource type
// but billing/audit to `member`), so a member could repoint the tunnel, shrink
// every org's rollback window, or flip auth mode on a zero-auth-enabled box.
// An org-scoped role check does NOT gate this; see middleware/instance-admin.ts.
r.patch("/settings", { tag: "settings:write" }, requireInstanceAdmin(), setup.updateSettings);
// Destructive reset — instance-admin only. The server cleanup IS org-scoped
// (see deleteSettings), but the handler also drops the global instance_settings
// row, so this is a whole-instance operation and an org-scoped role check would
// not gate it (see middleware/instance-admin.ts).
r.delete("/settings", { tag: "settings:admin" }, requireInstanceAdmin(), setup.deleteSettings);

// Instance SMTP (Settings → Email) — self-hosted operator transport for all
// system mail (password reset, verification, invites, notifications).
//
// WRITE + TEST are instance-admin only: the `settings:*` tag alone also admits
// plain members (lib/permission.ts discards the action half of the tag), and
// this row is the transport for every password-reset/verification email — a
// member who could repoint it to their own SMTP relay could harvest reset
// tokens and take over the owner's account.
//
// This is the threat the previous requireRole("owner") was meant to stop and
// did not: that check resolves a caller-selected org and every user owns their
// personal org (GHSA-rwq6-r63g-3c8h). Instance SMTP is instance-wide state, so
// it needs an instance-level gate.
// GET returns only a MASKED config (no password) so it stays settings:read —
// that keeps the "no email transport → set up SMTP" hint readable everywhere.
r.get("/settings/email", { tag: "settings:read" }, setup.getEmailSettings);
r.put("/settings/email", { tag: "settings:write" }, requireInstanceAdmin(), setup.updateEmailSettings);
r.post("/settings/email/test", { tag: "settings:write" }, requireInstanceAdmin(), setup.sendTestEmail);

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
// Read-only blast-radius snapshot for the removal confirm: which projects and apps
// this box currently runs, and which server-scoped records go with it.
r.get("/servers/:id/deletion-preview", { tag: "server:read" }, serversCtrl.serverDeletionPreview);
// Create has no :id in the URL — org scope comes from the request and the
// row is created in the active org. collection:true keeps the permission
// middleware from demanding a (nonexistent) :id param.
r.post("/servers", { tag: "server:write", collection: true }, serversCtrl.createServer);
r.patch("/servers/:id", { tag: "server:write" }, serversCtrl.updateServer);
r.delete("/servers/:id", { tag: "server:admin" }, serversCtrl.deleteServer);
// Host exec. `server:admin` on the id, so a {server,<id>,[admin]} grant confines an
// agent to this one box — the per-resource scope the jobs-based workaround could not
// express. MCP-exposed deliberately: this is the sanctioned agent execution point.
r.post(
  "/servers/:id/exec",
  {
    tag: "server:admin",
    // Tighter than the default-authed 3000/min: each call opens a pooled SSH
    // connection and runs an arbitrary command, so the generic read budget is the
    // wrong shape for it.
    rateLimit: "write-authed",
    body: AgentExecBody,
    mcp: {
      description:
        "Run a shell command on this server's host and return its exit code and combined output. Interpreted by `sh -c`, so pipes and redirects work; stderr is merged in. Times out (default 30s, max 120s) and truncates large output. Use this to inspect or repair a server; prefer the read-only endpoints when they answer the question.",
    },
  },
  serversCtrl.execOnServer,
);

/* ── Per-server rate limiting (OpenResty level) ─────────────────── */
r.get("/servers/:id/rate-limit", { tag: "server:read" }, rateLimit.getRateLimit);
r.patch("/servers/:id/rate-limit", { tag: "server:write" }, rateLimit.updateRateLimit);
r.post("/servers/:id/ports/scan", { tag: "server:read", readOnly: true }, serverCheck.scanExposedPorts);

// ── Native-module versioning + migration (OpenResty, …). The `:id` server is
//    the permission resource; handlers hard-guard cloud + org-scope. ──
r.get("/servers/:id/modules", { tag: "server:read" }, serverModules.listServerModules);
r.post("/servers/:id/modules/scan", { tag: "server:write" }, serverModules.scanServerModules);
r.post("/servers/:id/modules/:module/apply", { tag: "server:write" }, serverModules.applyServerModuleUpdate);

// ── Managed CONTAINER versioning (edge / mail images pinned to APP_VERSION).
//    Same `:id`-server permission resource + cloud/org guards as modules; apply
//    STREAMS the rollback-guarded image swap. ──
// Org-wide drift count for the home nudge — no :id, so collection:true scopes
// the permission check to the active org (like /install/stream, /monitor/stream)
// instead of demanding a server param.
r.get("/containers/behind", { tag: "server:read", collection: true }, serverContainers.containersBehind);
r.get("/containers/issues", { tag: "server:read", collection: true }, serverContainers.containerIssues);
// Global infra view — every server × component. No :id, so collection:true scopes
// the check to the active org (same as /containers/behind). Scan is detect-only.
r.get("/containers", { tag: "server:read", collection: true }, serverContainers.listAllContainers);
// Live progress for the fleet view: what's queued/running right now (cached rows ×
// in-memory sessions) plus what just settled, which is the only place an outcome
// lives — a finished row clears its drift and its in-progress flag together.
r.get("/containers/applying", { tag: "server:read", collection: true }, serverContainers.listApplyingContainers);
r.post("/containers/scan", { tag: "server:write", collection: true }, serverContainers.scanAllContainers);
// Fleet bulk apply — targets are derived from the cache server-side, so the body
// only carries which intents to run ("update" swaps, "repair" restarts).
r.post("/containers/apply-all", { tag: "server:write", collection: true }, serverContainers.applyAllContainers);
r.get("/servers/:id/containers", { tag: "server:read" }, serverContainers.listServerContainers);
r.post("/servers/:id/containers/scan", { tag: "server:write" }, serverContainers.scanServerContainers);
r.post("/servers/:id/containers/:component/apply/stream", { tag: "server:write" }, serverContainers.applyServerContainerStream);
// Read-only siblings of the POST apply stream, for page reloads: /session hands
// back a running swap's id, /stream (GET) re-attaches to it. Neither can start a
// run, so they stay on server:read while the POST keeps server:write.
r.get("/servers/:id/containers/:component/apply/session", { tag: "server:read" }, serverContainers.getServerContainerApplySession);
r.get("/servers/:id/containers/:component/apply/stream", { tag: "server:read" }, serverContainers.attachServerContainerStream);

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
// requireInstanceAdmin() is mandatory: migrating the instance exports every
// org's data with all secrets DECRYPTED and ships it to a caller-named server.
// The `settings:*` tag admits plain members (lib/permission.ts discards the
// action half), and requireRole("owner") would NOT help — see the middleware's
// header for why an org-scoped role can't gate a whole-instance operation.
r.post("/migration/preflight", { tag: "settings:admin" }, requireInstanceAdmin(), migration.preflight);
r.post("/migration/start", { tag: "settings:admin" }, requireInstanceAdmin(), migration.start);
r.post("/migration/start-cloud", { tag: "settings:admin" }, requireInstanceAdmin(), migration.startCloud);
r.post("/migration/start-tunnel", { tag: "settings:admin" }, requireInstanceAdmin(), migration.startTunnel);
r.post("/migration/switch-back", { tag: "settings:admin" }, requireInstanceAdmin(), migration.switchBack);

/* ── Whole-instance data export / import (instance-admin only) ─────
 * This moves the entire database including every org's data, and export
 * returns every secret DECRYPTED in the response body under a passphrase the
 * CALLER chooses. requireInstanceAdmin() is mandatory.
 *
 * This previously used requireRole("owner"), which did not gate it at all:
 * that check resolves a caller-selected org and every user is owner of their
 * own personal org (GHSA-rwq6-r63g-3c8h). Do not "restore" it here.
 */
r.get("/data-transfer/preview", { tag: "settings:admin" }, requireInstanceAdmin(), dataTransfer.previewInstanceExportHandler);
r.post("/data-transfer/direct/session", { tag: "settings:admin" }, requireInstanceAdmin(), dataTransfer.createDirectReceiveSessionHandler);
r.post("/data-transfer/direct/send", { tag: "settings:admin" }, requireInstanceAdmin(), dataTransfer.sendDirectTransferHandler);
r.public(
  "post",
  "/data-transfer/direct/receive",
  {
    reason: "One-time instance receive capability — payload is ECDH-encrypted and authorized by the expiring token inside it.",
    rateLimit: "auth-tight",
  },
  bodyLimit({
    maxSize: 700_000_000,
    onError: (c) => c.json({ error: "Direct transfer exceeds the 700MB limit.", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
  dataTransfer.receiveDirectTransferHandler,
);
r.post("/data-transfer/export", { tag: "settings:admin" }, requireInstanceAdmin(), dataTransfer.exportInstanceHandler);
r.use(
  "/data-transfer/import",
  bodyLimit({
    maxSize: 500_000_000,
    onError: (c) => c.json({ error: "Import file exceeds the 500MB limit.", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
);
r.post("/data-transfer/import", { tag: "settings:admin" }, requireInstanceAdmin(), dataTransfer.importInstanceHandler);

export const systemRoutes = r.hono;
