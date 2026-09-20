/**
 * Mail setup routes - mounted at /api/mail in app.ts.
 *
 * Self-hosted only (dynamic import, gated by localOnly middleware).
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as mail from "./mail.controller";
import * as admin from "./admin/admin.controller";
import * as webmail from "./webmail/webmail.controller";
import * as inbound from "./inbound/inbound.controller";

const r = secureRouter(new Hono(), {
  module: "mail",
  basePath: "/api/mail",
  ids: { mail_server: "serverId" },
  localOnly: true,
});


/* ── Setup wizard ─────────────────────────────────────────────────── */
r.get("/steps", { tag: "mail_server:read" }, mail.getSteps);
r.get("/status", { tag: "mail_server:read" }, mail.getStatus);
// Cross-server mail-install summary - lets the /emails page auto-select
// the only mail server when there's exactly one.
r.get("/servers", { tag: "mail_server:list" }, mail.listMailServers);
// Stop managing a mail server: drop the DB row only, leave the stack + state
// file intact so it can be re-adopted. Non-destructive; see forgetMailServer.
r.delete("/servers/:serverId", { tag: "mail_server:admin" }, mail.forgetMailServer);
// Re-adopt an existing mail install whose orchestrator state was lost (lost PC):
// scan a server for iRedMail + its on-server state, then adopt it back.
r.post("/scan", { tag: "mail_server:write" }, mail.scanMailInstall);
r.post("/adopt", { tag: "mail_server:write" }, mail.adoptMailServer);
r.post("/setup", { tag: "mail_server:write" }, mail.startSetup);
r.post("/setup/cancel", { tag: "mail_server:write" }, mail.cancelSetup);
r.post("/setup/dns-ack", { tag: "mail_server:write" }, mail.acknowledgeDns);
r.post("/setup/ptr-ack", { tag: "mail_server:write" }, mail.acknowledgePtr);
r.post("/setup/reset", { tag: "mail_server:admin" }, mail.resetSetup);

/* ── Post-install operations ──────────────────────────────────────── */
r.get("/health/:serverId", { tag: "mail_server:read" }, mail.getHealth);
r.post(
  "/credentials/postmaster",
  { tag: "mail_server:write" },
  mail.setPostmasterPassword,
);

/* ── Admin panel - domains ────────────────────────────────────────── */
r.get(
  "/admin/:serverId/domains",
  { tag: "mail_server:list" },
  admin.listDomainsHandler,
);
r.post(
  "/admin/:serverId/domains",
  { tag: "mail_server:write" },
  admin.createDomainHandler,
);
r.get(
  "/admin/:serverId/domains/:domain",
  { tag: "mail_server:read" },
  admin.getDomainHandler,
);
r.patch(
  "/admin/:serverId/domains/:domain",
  { tag: "mail_server:write" },
  admin.updateDomainHandler,
);
r.delete(
  "/admin/:serverId/domains/:domain",
  { tag: "mail_server:admin" },
  admin.deleteDomainHandler,
);
r.get(
  "/admin/:serverId/domains/:domain/dependents",
  { tag: "mail_server:read" },
  admin.domainDependentsHandler,
);
r.get(
  "/admin/:serverId/domains/:domain/dns",
  { tag: "mail_server:read" },
  admin.getDomainDnsHandler,
);
r.post(
  "/admin/:serverId/domains/:domain/dns/acknowledge",
  { tag: "mail_server:write" },
  admin.acknowledgeDomainDnsHandler,
);
// On-demand DNS auto-configure via a connected provider (Settings→DNS). Plan is
// a read-only dry-run; apply writes the records on operator press (never on add).
r.get(
  "/admin/:serverId/domains/:domain/dns/plan",
  { tag: "mail_server:read" },
  admin.planDomainDnsHandler,
);
r.post(
  "/admin/:serverId/domains/:domain/dns/apply",
  { tag: "mail_server:write" },
  admin.applyDomainDnsHandler,
);
r.get(
  "/admin/:serverId/domains-dns/pending",
  { tag: "mail_server:read" },
  admin.pendingDomainDnsHandler,
);

/* ── Admin panel - mailboxes ──────────────────────────────────────── */
r.get(
  "/admin/:serverId/mailboxes",
  { tag: "mail_server:list" },
  admin.listMailboxesHandler,
);
r.post(
  "/admin/:serverId/mailboxes",
  { tag: "mail_server:write" },
  admin.createMailboxHandler,
);
r.get(
  "/admin/:serverId/mailboxes/:email",
  { tag: "mail_server:read" },
  admin.getMailboxHandler,
);
r.patch(
  "/admin/:serverId/mailboxes/:email",
  { tag: "mail_server:write" },
  admin.updateMailboxHandler,
);
r.delete(
  "/admin/:serverId/mailboxes/:email",
  { tag: "mail_server:admin" },
  admin.deleteMailboxHandler,
);
r.post(
  "/admin/:serverId/platform-mailbox/rotate",
  { tag: "mail_server:admin" },
  admin.rotatePlatformMailboxHandler,
);

/* ── Admin panel - aliases / forwards / catch-all ─────────────────── */
r.get(
  "/admin/:serverId/aliases",
  { tag: "mail_server:list" },
  admin.listAliasesHandler,
);
r.post(
  "/admin/:serverId/aliases",
  { tag: "mail_server:write" },
  admin.createAliasHandler,
);
r.patch(
  "/admin/:serverId/aliases/:id",
  { tag: "mail_server:write" },
  admin.updateAliasHandler,
);
r.delete(
  "/admin/:serverId/aliases/:id",
  { tag: "mail_server:admin" },
  admin.deleteAliasHandler,
);

/* ── Admin panel - aggregates ─────────────────────────────────────── */
r.get(
  "/admin/:serverId/stats",
  { tag: "mail_server:read" },
  admin.getStatsHandler,
);

/* ── Admin panel - backup (plugs into the general backup system) ──── */
r.get(
  "/admin/:serverId/backup-policy",
  { tag: "mail_server:read" },
  mail.getMailBackupPolicy,
);
r.post(
  "/admin/:serverId/backup-policy",
  { tag: "mail_server:admin" },
  mail.saveMailBackupPolicy,
);
r.get(
  "/admin/:serverId/backup-runs",
  { tag: "mail_server:read" },
  mail.listMailBackupRuns,
);

/* ── Admin panel - DNS scan ───────────────────────────────────────── */
r.get(
  "/admin/:serverId/dns-scan",
  { tag: "mail_server:read" },
  admin.getDnsScanHandler,
);

/* ── Admin panel - outbound relay (split delivery) ────────────────── */
r.get(
  "/admin/:serverId/relay",
  { tag: "mail_server:read" },
  admin.getOutboundRelayHandler,
);
r.post(
  "/admin/:serverId/relay",
  { tag: "mail_server:admin" },
  admin.putOutboundRelayHandler,
);
r.delete(
  "/admin/:serverId/relay",
  { tag: "mail_server:admin" },
  admin.deleteOutboundRelayHandler,
);

/* ── Admin panel - welcome test email ─────────────────────────────── */
r.post(
  "/admin/:serverId/test-email",
  { tag: "mail_server:write" },
  admin.sendTestEmailHandler,
);

/* ── Admin panel - component actions (Health / Advanced) ──────────── */
r.post(
  "/admin/:serverId/components/restart-all",
  { tag: "mail_server:admin" },
  admin.restartAllComponentsHandler,
);
r.post(
  "/admin/:serverId/components/:key/:action",
  { tag: "mail_server:admin" },
  admin.runComponentActionHandler,
);
r.get(
  "/admin/:serverId/components/:key/logs",
  { tag: "mail_server:read" },
  admin.getComponentLogsHandler,
);

/* ── Webmail deploy (creates a standard project + deployment) ─────── */
r.get(
  "/webmail/targets",
  { tag: "mail_server:read" },
  webmail.getTargetsHandler,
);
r.post(
  "/webmail/deploy-project",
  { tag: "mail_server:write" },
  webmail.startDeployAsProjectHandler,
);
// External-backend webmail (BYO IMAP/SMTP — SES / custom). No mail server.
r.post(
  "/webmail/deploy-external",
  { tag: "mail_server:write" },
  webmail.startExternalDeployAsProjectHandler,
);

/* ── Inbound rules (mail arrives → notification channel) ──────────── */
// `:serverId` is a PATH param on every one of these, and that is deliberate:
// `mail_server` is a CONDITIONAL_SINGLETON, so a route that took the id from the body
// would degrade to resourceId "*" — a pure role×type check that names no server and
// therefore establishes no tenant boundary.
r.get(
  "/admin/:serverId/inbound-rules",
  { tag: "mail_server:read" },
  inbound.listRulesHandler,
);
r.post(
  "/admin/:serverId/inbound-rules",
  { tag: "mail_server:write" },
  inbound.createRuleHandler,
);
r.patch(
  "/admin/:serverId/inbound-rules/:ruleId",
  { tag: "mail_server:write" },
  inbound.updateRuleHandler,
);
r.delete(
  "/admin/:serverId/inbound-rules/:ruleId",
  { tag: "mail_server:write" },
  inbound.deleteRuleHandler,
);
// Dry run — reads and reports what WOULD notify, dispatching and deleting nothing.
// Tagged `write` because the boot scanner treats a POST on a read-tagged route as a
// CRITICAL error and exits the process.
r.post(
  "/admin/:serverId/inbound-rules/test",
  { tag: "mail_server:write" },
  inbound.testRulesHandler,
);

export const mailRoutes = r.hono;
