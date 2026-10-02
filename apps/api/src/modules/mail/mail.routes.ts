/**
 * Mail setup routes - mounted at /api/mail in app.ts.
 *
 * Self-hosted only (dynamic import, gated by localOnly middleware).
 */

import { Hono } from "hono";
import { MailRequestSchemas } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as mail from "./mail.controller";
import * as admin from "./admin/admin.controller";
import * as webmail from "./webmail/webmail.controller";
import * as inbound from "./inbound/inbound.controller";
import * as certificate from "./admin/certificate.controller";

const r = secureRouter(new Hono(), {
  module: "mail",
  basePath: "/api/mail",
  ids: { mail_server: "serverId" },
  localOnly: true,
});

/* ── Setup wizard ─────────────────────────────────────────────────── */
r.get("/steps", { tag: "mail_server:read", mcp: { description: "Read the ordered mail installation steps. Installing a new mail stack uses the dashboard’s streaming setup wizard." } }, mail.getSteps);
r.get("/status", { tag: "mail_server:read", mcp: { description: "Read saved setup progress for query.serverId. A missing state after an SSH failure is not proof that mail is uninstalled; check the mail health tool for live reachability." }, query: MailRequestSchemas.status }, mail.getStatus);
// Cross-server mail-install summary - lets the /emails page auto-select
// the only mail server when there's exactly one.
r.get("/servers", { tag: "mail_server:list", mcp: { description: "List mail servers managed by this workspace, their installation state and linked webmail projects." } }, mail.listMailServers);
// Stop managing a mail server: drop the DB row only, leave the stack + state
// file intact so it can be re-adopted. Non-destructive; see forgetMailServer.
r.delete("/servers/:serverId", { tag: "mail_server:admin", mcp: { description: "Forget Openship’s mail-server registration without uninstalling daemons or deleting mail data. Scan and adopt can restore the registration." } }, mail.forgetMailServer);
// Re-adopt an existing mail install whose orchestrator state was lost (lost PC):
// scan a server for iRedMail + its on-server state, then adopt it back.
r.post("/scan", { tag: "mail_server:write", mcp: { description: "Inspect an existing mail installation on body.serverId without reinstalling it. Returns adoptable state; use adopt to register an existing stack." }, body: MailRequestSchemas.server, readOnly: true }, mail.scanMailInstall);
r.post("/adopt", { tag: "mail_server:write", mcp: { description: "Register an existing Openship mail installation found by scan. Restores control-plane ownership without reinstalling the stack." }, body: MailRequestSchemas.server }, mail.adoptMailServer);
r.post("/setup", { tag: "mail_server:write", mcpExcluded: "Mail installation is an interactive SSE wizard with DNS/PTR checkpoints. Open Emails → Set up mail; MCP can inspect status and administer or adopt existing installations." }, mail.startSetup);
r.post("/setup/cancel", { tag: "mail_server:write", mcpExcluded: "Controls the active browser mail-installation SSE session. Finish or cancel that setup in the Emails wizard." }, mail.cancelSetup);
r.post("/setup/dns-ack", { tag: "mail_server:write", mcpExcluded: "Acknowledges a checkpoint in the active mail-installation wizard. Use the Emails wizard; existing domain DNS has dedicated MCP tools." }, mail.acknowledgeDns);
r.post("/setup/ptr-ack", { tag: "mail_server:write", mcpExcluded: "Acknowledges provider PTR setup in the active mail-installation wizard. Use the Emails wizard to review the required reverse DNS." }, mail.acknowledgePtr);
r.post("/setup/reset", { tag: "mail_server:admin", mcpExcluded: "Resets the mail-installation wizard’s on-host state. Use the Emails recovery flow; forgetting registration is available separately." }, mail.resetSetup);

/* ── Post-install operations ──────────────────────────────────────── */
r.get("/admin/:serverId/certificate", { tag: "mail_server:read", mcp: { description: "Read the mail certificate, SMTP/IMAP TLS checks and automatic renewal settings." } }, certificate.getCertificate);
r.post("/admin/:serverId/certificate/check", { tag: "mail_server:write", readOnly: true, mcp: { description: "Recheck the mail certificate on disk and served by SMTP/IMAP. Does not issue a certificate or send email." } }, certificate.checkCertificate);
r.post("/admin/:serverId/certificate/renew", { tag: "mail_server:admin", mcp: { description: "Renew a due mail certificate through the Openship edge and reload Postfix/Dovecot. A still-valid certificate is reused and its service configuration repaired." } }, certificate.renewCertificate);
r.patch("/admin/:serverId/certificate", { tag: "mail_server:admin", body: MailRequestSchemas.certificate, mcp: { description: "Enable or disable automatic mail certificate renewal. Monitoring continues when renewal is disabled." } }, certificate.updateCertificate);
r.get("/health/:serverId", { tag: "mail_server:read", mcp: { description: "Check live mail components, delivery and network reachability. Set query.refreshReachability to bypass the reachability cache." }, query: MailRequestSchemas.health }, mail.getHealth);
r.post(
  "/credentials/postmaster",
  { tag: "mail_server:write", mcpExcluded: "Privileged mail administrator credentials are changed in the authenticated mail settings." },
  mail.setPostmasterPassword,
);

/* ── Admin panel - domains ────────────────────────────────────────── */
r.get(
  "/admin/:serverId/domains",
  { tag: "mail_server:list", mcp: { description: "List mail domains configured on this mail server." } },
  admin.listDomainsHandler,
);
r.post(
  "/admin/:serverId/domains",
  { tag: "mail_server:write", mcp: { description: "Create a mail domain with mailbox, alias and quota limits. Then inspect its DNS plan and apply or configure the required records." }, body: MailRequestSchemas.createDomain },
  admin.createDomainHandler,
);
r.get(
  "/admin/:serverId/domains/:domain",
  { tag: "mail_server:read", mcp: { description: "Read a mail domain’s configuration and status." } },
  admin.getDomainHandler,
);
r.patch(
  "/admin/:serverId/domains/:domain",
  { tag: "mail_server:write", mcp: { description: "Update a mail domain’s description, capacity limits, default quota or enabled state." }, body: MailRequestSchemas.updateDomain },
  admin.updateDomainHandler,
);
r.delete(
  "/admin/:serverId/domains/:domain",
  { tag: "mail_server:admin", mcp: { description: "Delete a mail domain. Inspect dependents first; query.cascade=true also removes dependent mailboxes and aliases." }, query: MailRequestSchemas.deleteDomain },
  admin.deleteDomainHandler,
);
r.get(
  "/admin/:serverId/domains/:domain/dependents",
  { tag: "mail_server:read", mcp: { description: "Inspect mailboxes and aliases affected by deleting this mail domain." } },
  admin.domainDependentsHandler,
);
r.get(
  "/admin/:serverId/domains/:domain/dns",
  { tag: "mail_server:read", mcp: { description: "Read required DNS records and the current DNS acknowledgment state for this mail domain." } },
  admin.getDomainDnsHandler,
);
r.post(
  "/admin/:serverId/domains/:domain/dns/acknowledge",
  { tag: "mail_server:write", mcp: { description: "Recheck and acknowledge a mail domain’s DNS configuration. Only use after the required records have been configured." } },
  admin.acknowledgeDomainDnsHandler,
);
// On-demand DNS auto-configure via a connected provider (Settings→DNS). Plan is
// a read-only dry-run; apply writes the records on operator press (never on add).
r.get(
  "/admin/:serverId/domains/:domain/dns/plan",
  { tag: "mail_server:read", mcp: { description: "Preview DNS changes for this mail domain through a connected DNS provider. Does not apply records." } },
  admin.planDomainDnsHandler,
);
r.post(
  "/admin/:serverId/domains/:domain/dns/apply",
  { tag: "mail_server:write", mcp: { description: "Apply this mail domain’s required DNS records through a connected provider. Inspect the DNS plan first." } },
  admin.applyDomainDnsHandler,
);
r.get(
  "/admin/:serverId/domains-dns/pending",
  { tag: "mail_server:read", mcp: { description: "List mail domains still requiring DNS configuration or acknowledgment." } },
  admin.pendingDomainDnsHandler,
);

/* ── Admin panel - mailboxes ──────────────────────────────────────── */
r.get(
  "/admin/:serverId/mailboxes",
  { tag: "mail_server:list", mcp: { description: "List mailboxes, optionally filtered by query.domain. Passwords are not returned." }, query: MailRequestSchemas.domainFilter },
  admin.listMailboxesHandler,
);
r.post(
  "/admin/:serverId/mailboxes",
  { tag: "mail_server:write", mcp: { description: "Create a mailbox with a supplied password and optional quota. This changes the mail server’s account database." }, body: MailRequestSchemas.createMailbox },
  admin.createMailboxHandler,
);
r.get(
  "/admin/:serverId/mailboxes/:email",
  { tag: "mail_server:read", mcp: { description: "Read a mailbox’s profile, quota and enabled state without its password." } },
  admin.getMailboxHandler,
);
r.patch(
  "/admin/:serverId/mailboxes/:email",
  { tag: "mail_server:write", mcp: { description: "Update a mailbox’s name, quota, password or enabled state. Omit password to preserve it." }, body: MailRequestSchemas.updateMailbox },
  admin.updateMailboxHandler,
);
r.delete(
  "/admin/:serverId/mailboxes/:email",
  { tag: "mail_server:admin", mcp: { description: "Remove a mailbox account. query.hard=true also deletes its stored mail; read its details before requesting permanent removal." }, query: MailRequestSchemas.deleteMailbox },
  admin.deleteMailboxHandler,
);
r.post(
  "/admin/:serverId/platform-mailbox/rotate",
  { tag: "mail_server:admin", mcpExcluded: "Rotates the platform’s private mail-delivery credential. Use the mail-server settings; this is not a user mailbox." },
  admin.rotatePlatformMailboxHandler,
);

/* ── Admin panel - aliases / forwards / catch-all ─────────────────── */
r.get(
  "/admin/:serverId/aliases",
  { tag: "mail_server:list", mcp: { description: "List mail aliases and forwards, optionally filtered by query.domain." }, query: MailRequestSchemas.domainFilter },
  admin.listAliasesHandler,
);
r.post(
  "/admin/:serverId/aliases",
  { tag: "mail_server:write", mcp: { description: "Create a mail alias, forward or catch-all and its destination. A catch-all applies to unmatched recipients in the domain." }, body: MailRequestSchemas.createAlias },
  admin.createAliasHandler,
);
r.patch(
  "/admin/:serverId/aliases/:id",
  { tag: "mail_server:write", mcp: { description: "Enable or disable this mail alias using body.active." }, body: MailRequestSchemas.updateAlias },
  admin.updateAliasHandler,
);
r.delete(
  "/admin/:serverId/aliases/:id",
  { tag: "mail_server:admin", mcp: { description: "Delete a mail alias or forward. Messages addressed through it will no longer use that mapping." } },
  admin.deleteAliasHandler,
);

/* ── Admin panel - aggregates ─────────────────────────────────────── */
r.get(
  "/admin/:serverId/stats",
  { tag: "mail_server:read", mcp: { description: "Read mail-server domain, mailbox, alias and storage totals." } },
  admin.getStatsHandler,
);

/* ── Admin panel - backup (plugs into the general backup system) ──── */
r.get(
  "/admin/:serverId/backup-policy",
  { tag: "mail_server:read", mcp: { description: "Read this mail server’s saved backup policy, or null when no policy exists." } },
  mail.getMailBackupPolicy,
);
r.post(
  "/admin/:serverId/backup-policy",
  { tag: "mail_server:admin", mcp: { description: "Create or update the mail-server backup policy. Set messageData=true to include stored messages; keys default to included. Omitted retention preserves an existing policy or uses creation defaults; null removes that retention limit. Use the general backup policy run tool for an immediate backup." }, body: MailRequestSchemas.saveBackupPolicy },
  mail.saveMailBackupPolicy,
);
r.get(
  "/admin/:serverId/backup-runs",
  { tag: "mail_server:read", mcp: { description: "Read this mail server’s recent backup runs. Follow run IDs with the general backup status and restore tools." } },
  mail.listMailBackupRuns,
);

/* ── Admin panel - DNS scan ───────────────────────────────────────── */
r.get(
  "/admin/:serverId/dns-scan",
  { tag: "mail_server:read", mcp: { description: "Check current mail DNS records, optionally for query.domain. Does not apply changes." }, query: MailRequestSchemas.domainFilter },
  admin.getDnsScanHandler,
);

/* ── Admin panel - outbound relay (split delivery) ────────────────── */
r.get(
  "/admin/:serverId/relay",
  { tag: "mail_server:read", mcp: { description: "Read outbound relay configuration with its password hidden. Relay credentials are managed in the mail server’s settings." } },
  admin.getOutboundRelayHandler,
);
r.post(
  "/admin/:serverId/relay",
  { tag: "mail_server:admin", mcpExcluded: "Configures outbound delivery credentials and provider identity in the mail-server settings; MCP can inspect the resulting relay state." },
  admin.putOutboundRelayHandler,
);
r.delete(
  "/admin/:serverId/relay",
  { tag: "mail_server:admin", mcpExcluded: "Changes server-wide delivery from relay to direct SMTP. Manage relay identity and removal together in the mail-server settings." },
  admin.deleteOutboundRelayHandler,
);

/* ── Admin panel - welcome test email ─────────────────────────────── */
r.post(
  "/admin/:serverId/test-email",
  { tag: "mail_server:write", mcp: { description: "Send a mail-delivery test to body.to, optionally from body.fromDomain. This sends a real email; use the recipient requested by the user." }, body: MailRequestSchemas.testEmail },
  admin.sendTestEmailHandler,
);

/* ── Admin panel - component actions (Health / Advanced) ──────────── */
r.post(
  "/admin/:serverId/components/restart-all",
  { tag: "mail_server:admin", mcp: { description: "Restart managed mail components on this server. Mail delivery can be briefly interrupted; inspect health afterward." } },
  admin.restartAllComponentsHandler,
);
r.post(
  "/admin/:serverId/migrate-to-container",
  { tag: "mail_server:admin" },
  admin.migrateToContainerHandler,
);
r.post(
  "/admin/:serverId/components/:key/:action",
  { tag: "mail_server:admin", mcp: { description: "Run a supported action on a managed mail component. Read health for component keys and supported actions; inspect health again to confirm recovery." } },
  admin.runComponentActionHandler,
);
r.get(
  "/admin/:serverId/components/:key/logs",
  { tag: "mail_server:read", mcp: { description: "Read recent logs for one managed mail component, with optional query.lines. Logs can contain recipient addresses; redact before sharing." }, query: MailRequestSchemas.logs },
  admin.getComponentLogsHandler,
);

/* ── Webmail deploy (creates a standard project + deployment) ─────── */
r.get(
  "/webmail/targets",
  { tag: "mail_server:read", mcp: { description: "List permitted deployment targets for the mail server named by query.serverId." }, query: MailRequestSchemas.server },
  webmail.getTargetsHandler,
);
r.post(
  "/webmail/deploy-project",
  { tag: "mail_server:write", mcp: { description: "Deploy webmail for an existing mail server to a permitted target. Returns projectId and deploymentId for normal deployment monitoring. replaceLegacy=true explicitly replaces an older unmanaged webmail installation." }, body: MailRequestSchemas.deployWebmail },
  webmail.startDeployAsProjectHandler,
);
// External-backend webmail (BYO IMAP/SMTP — SES / custom). No mail server.
r.post(
  "/webmail/deploy-external",
  { tag: "mail_server:write", mcpExcluded: "External mail-provider setup is a catalog/browser configuration flow. Use the catalog webmail app with its template inputs; managed mail-server webmail has a dedicated deploy tool." },
  webmail.startExternalDeployAsProjectHandler,
);

/* ── Inbound rules (mail arrives → notification channel) ──────────── */
// `:serverId` is a PATH param on every one of these, and that is deliberate:
// `mail_server` is a CONDITIONAL_SINGLETON, so a route that took the id from the body
// would degrade to resourceId "*" — a pure role×type check that names no server and
// therefore establishes no tenant boundary.
r.get(
  "/admin/:serverId/inbound-rules",
  { tag: "mail_server:read", mcp: { description: "List inbound-mail notification rules and their enabled or paused state." } },
  inbound.listRulesHandler,
);
r.post(
  "/admin/:serverId/inbound-rules",
  { tag: "mail_server:write", mcp: { description: "Create an inbound-mail notification rule for a mailbox, domain or all domains, targeting existing notification channels. Inspect its resulting enabled/paused state if engine capture cannot be armed." }, body: MailRequestSchemas.createInboundRule },
  inbound.createRuleHandler,
);
r.patch(
  "/admin/:serverId/inbound-rules/:ruleId",
  { tag: "mail_server:write", mcp: { description: "Update an inbound-mail notification rule and reconcile capture on affected domains. pausedReason=null clears the saved pause reason." }, body: MailRequestSchemas.updateInboundRule },
  inbound.updateRuleHandler,
);
r.delete(
  "/admin/:serverId/inbound-rules/:ruleId",
  { tag: "mail_server:write", mcp: { description: "Delete an inbound-mail notification rule and release capture that no remaining rule needs." } },
  inbound.deleteRuleHandler,
);
// Dry run — reads and reports what WOULD notify, dispatching and deleting nothing.
// Tagged `write` because the boot scanner treats a POST on a read-tagged route as a
// CRITICAL error and exits the process.
r.post(
  "/admin/:serverId/inbound-rules/test",
  { tag: "mail_server:write", mcp: { description: "Preview matches for this server’s inbound notification rules without sending notifications or deleting captured messages." }, readOnly: true },
  inbound.testRulesHandler,
);

export const mailRoutes = r.hono;
