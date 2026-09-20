import { systemManagementRoutes } from "./system-management.routes";
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
import { secureRouter } from "../../lib/secure-router";
import * as setup from "./setup.controller";
import {
  invitationSignupBodyLimit,
  inviteSignup,
} from "../auth/invitation-signup.controller";
import * as selfApp from "./self-app.controller";
import * as serverCheck from "./server-check.controller";
import { serverManagementRoutes } from "./server-management.routes";
import * as serverGithub from "../github/server-github.controller";
import * as migration from "./migration/migration.controller";
import * as dataTransfer from "./data-transfer/data-transfer.controller";
import {
  TRANSFER_CHUNK_BYTES,
  TRANSFER_CONTROL_BODY_BYTES,
} from "./data-transfer/chunk-store";
import * as systemHealth from "./system-health.controller";

const r = secureRouter(new Hono(), {
  module: "system",
  basePath: "/api/system",
  localOnly: true,
});

const transferControlBodyLimit = bodyLimit({
  maxSize: TRANSFER_CONTROL_BODY_BYTES,
  onError: (c) =>
    c.json(
      { error: "Transfer control request exceeds the size limit.", code: "PAYLOAD_TOO_LARGE" },
      413,
    ),
});


/* ── Onboarding (first-run only, no auth) ───────────────────────── */
r.public("get", "/onboarding", { reason: "First-run onboarding status check - no user exists yet" }, setup.onboardingStatus);
r.public("post", "/onboarding", { reason: "First-run onboarding setup - creates initial admin user" }, setup.onboardingSetup);
r.public("post", "/onboarding/test-connection", { reason: "First-run SSH reachability test - no user exists yet; gated to no-servers instance" }, serverCheck.onboardingTestConnection);

/* ── Internal routes (Electron → API with shared token) ─────────── */
r.public("post", "/setup", { reason: "Electron desktop client setup - protected by internalAuth shared token" }, internalAuth, setup.setup);
r.public("get", "/setup", { reason: "Electron desktop client setup read - protected by internalAuth shared token" }, internalAuth, setup.getInternalSetup);
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

r.hono.route("/", systemManagementRoutes);

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
r.hono.route("/", serverManagementRoutes);

// ── Per-server GitHub auth (self-hosted): device-login token / PAT / SSH
//    server-key / per-repo deploy-key. The `:id` server is the permission
//    resource; handlers hard-guard cloud + org-scope the server. ──
r.get("/servers/:id/github", { tag: "server:read", authorizationHandledByOperation: true, auditHandledByOperation: true }, serverGithub.getStatus);
r.post("/servers/:id/github/connect", { tag: "server:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, serverGithub.startConnect);
r.get("/servers/:id/github/connect/poll", { tag: "server:read", authorizationHandledByOperation: true, auditHandledByOperation: true }, serverGithub.pollConnect);
r.put("/servers/:id/github/token", { tag: "server:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, serverGithub.putToken);
r.post("/servers/:id/github/ssh-key", { tag: "server:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, serverGithub.generateSshKey);
r.put("/servers/:id/github/deploy-key-mode", { tag: "server:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, serverGithub.useDeployKeyMode);
r.delete("/servers/:id/github", { tag: "server:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, serverGithub.disconnect);

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

/* ── Server monitoring (live stats via SSE) ─────────────────────── */

/* ── Filesystem browse ──────────────────────────────────────────── */

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

/* ── Instance and project data export / import (instance-admin only) ─────
 * This moves the entire database including every org's data, and export
 * returns every secret DECRYPTED in the response body under a passphrase the
 * CALLER chooses. requireInstanceAdmin() is mandatory.
 *
 * This previously used requireRole("owner"), which did not gate it at all:
 * that check resolves a caller-selected org and every user is owner of their
 * own personal org (GHSA-rwq6-r63g-3c8h). Do not "restore" it here.
 */
r.get("/data-transfer/preview", { tag: "settings:admin" }, requireInstanceAdmin(), dataTransfer.previewInstanceExportHandler);
r.post("/data-transfer/preview", { tag: "settings:admin" }, requireInstanceAdmin(), transferControlBodyLimit, dataTransfer.previewInstanceExportHandler);
r.post("/data-transfer/direct/session", { tag: "settings:admin" }, requireInstanceAdmin(), transferControlBodyLimit, dataTransfer.createDirectReceiveSessionHandler);
r.post("/data-transfer/direct/send", { tag: "settings:admin" }, requireInstanceAdmin(), transferControlBodyLimit, dataTransfer.sendDirectTransferHandler);
r.post("/data-transfer/direct/send/stream", { tag: "settings:admin" }, requireInstanceAdmin(), transferControlBodyLimit, dataTransfer.sendDirectTransferStreamHandler);
r.public(
  "post",
  "/data-transfer/direct/chunk/init",
  {
    reason: "Initializes an encrypted upload using the one-time receive capability.",
    rateLimit: "auth-tight",
  },
  transferControlBodyLimit,
  dataTransfer.initializeDirectChunkUploadHandler,
);
r.public(
  "post",
  "/data-transfer/direct/chunk/:sessionId/heartbeat",
  {
    reason: "Extends an authenticated in-progress direct-transfer lease.",
    rateLimit: "transfer-chunk",
  },
  transferControlBodyLimit,
  dataTransfer.heartbeatDirectChunkUploadHandler,
);
r.public(
  "put",
  "/data-transfer/direct/chunk/:sessionId/:index",
  {
    reason: "Accepts one bounded, encrypted, signed direct-transfer chunk.",
    rateLimit: "transfer-chunk",
  },
  bodyLimit({
    maxSize: TRANSFER_CHUNK_BYTES + 64,
    onError: (c) =>
      c.json({ error: "Transfer chunk exceeds the size limit.", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
  dataTransfer.receiveDirectChunkHandler,
);
r.public(
  "post",
  "/data-transfer/direct/chunk/:sessionId/finalize/stream",
  {
    reason: "Keeps an authenticated direct-transfer restore alive through proxy timeouts.",
    rateLimit: "auth-tight",
  },
  transferControlBodyLimit,
  dataTransfer.finalizeDirectChunkUploadStreamHandler,
);
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
r.post("/data-transfer/export", { tag: "settings:admin" }, requireInstanceAdmin(), transferControlBodyLimit, dataTransfer.exportInstanceHandler);
r.post("/data-transfer/import/session", { tag: "settings:admin" }, requireInstanceAdmin(), transferControlBodyLimit, dataTransfer.createFileUploadHandler);
r.post("/data-transfer/import/session/:sessionId/preview", { tag: "settings:admin" }, requireInstanceAdmin(), transferControlBodyLimit, dataTransfer.previewFileUploadHandler);
r.put(
  "/data-transfer/import/session/:sessionId/chunk/:index",
  { tag: "settings:admin" },
  requireInstanceAdmin(),
  bodyLimit({
    maxSize: TRANSFER_CHUNK_BYTES,
    onError: (c) =>
      c.json({ error: "Import chunk exceeds the size limit.", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
  dataTransfer.uploadFileChunkHandler,
);
r.post(
  "/data-transfer/import/session/:sessionId/finalize/stream",
  { tag: "settings:admin" },
  requireInstanceAdmin(),
  transferControlBodyLimit,
  dataTransfer.finalizeFileUploadStreamHandler,
);
r.use(
  "/data-transfer/import",
  bodyLimit({
    maxSize: 500_000_000,
    onError: (c) => c.json({ error: "Import file exceeds the 500MB limit.", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
);
r.post("/data-transfer/import", { tag: "settings:admin" }, requireInstanceAdmin(), dataTransfer.importInstanceHandler);

export const systemRoutes = r.hono;
