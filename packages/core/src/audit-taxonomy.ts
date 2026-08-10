/**
 * Audit event taxonomy — the one catalog both halves of the audit log read.
 *
 * It has to be shared because the two jobs are split across processes: the API
 * expands a category filter into the `event_type IN (...)` list (a category is
 * not a column), and the dashboard turns each row into a sentence. A copy in
 * either app would drift the moment someone added an event to only one of them,
 * which is exactly how the dashboard-only label file this replaces ended up
 * mapping `deployment.canceled` while the API emitted `deployment.cancelled`.
 *
 * Two kinds of event_type land in audit_event:
 *   1. Explicit `eventType: "..."` literals in apps/api (deploy lifecycle,
 *      Better Auth org hooks, billing crons, incident announcements).
 *   2. The secureRouter auto-emitter, which uses the route's permission tag
 *      verbatim — so `"project:write"` and `"server:admin"` are event types too.
 *      These are coarse by nature: one tag covers every write route under a
 *      resource, so their wording stays deliberately vague.
 *
 * `action` is a past-tense verb phrase, because the row is rendered as a
 * sentence — "Sarah deployed api-gateway", not "deployment.succeeded". `label`
 * is the same event stated without an actor, for the ~30% of rows written by
 * crons and webhooks where there is nobody to put in front of the verb.
 *
 * Labels stay in English here rather than in the dashboard's i18n bundles: the
 * API filters on these ids and the strings are operator-facing forensic terms,
 * the same call notification-categories.ts makes.
 */

export const AUDIT_CATEGORIES = [
  {
    id: "deployments",
    label: "Deployments",
    description: "Builds and releases — what shipped, what failed, what was cancelled.",
  },
  {
    id: "apps",
    label: "Apps & services",
    description: "Projects, the services inside them, and their runtime health.",
  },
  {
    id: "domains",
    label: "Domains & SSL",
    description: "Custom domains, DNS verification, and certificates.",
  },
  {
    id: "servers",
    label: "Servers",
    description: "Deployment targets, their configuration, and shell access.",
  },
  {
    id: "members",
    label: "Members & access",
    description: "Who is in this organization and what they are allowed to do.",
  },
  {
    id: "security",
    label: "Security",
    description: "Admin credentials, auth mode, data export, and audit recording itself.",
  },
  {
    id: "billing",
    label: "Billing",
    description: "Subscriptions, credits, spending caps, and quota thresholds.",
  },
  {
    id: "system",
    label: "System",
    description: "Settings, integrations, notifications, backups, and instance maintenance.",
  },
] as const satisfies readonly { id: string; label: string; description: string }[];

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export type AuditCategoryId = AuditCategory["id"];

/**
 * Row accent. Maps to the theme status tokens in the dashboard — never to a
 * literal colour, so a theme swap doesn't leave one green dot behind.
 */
export type AuditTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface AuditEventDef {
  category: AuditCategoryId;
  /** Past-tense verb phrase: "<actor> {action} <resource>". */
  action: string;
  /** The same event with no actor, e.g. for cron- and webhook-written rows. */
  label: string;
  /** Defaults to "neutral" when omitted. */
  tone?: AuditTone;
  /** Shown in the details panel, not in the feed row. */
  description?: string;
}

export const AUDIT_EVENTS: Record<string, AuditEventDef> = {
  /* ---------------- Deployments ---------------- */
  "deployment.succeeded": {
    category: "deployments",
    action: "deployed",
    label: "Deploy succeeded",
    tone: "success",
    description: "A deployment finished successfully and is serving traffic.",
  },
  "deployment.failed": {
    category: "deployments",
    action: "failed to deploy",
    label: "Deploy failed",
    tone: "danger",
    description: "A deployment errored out before reaching a healthy state.",
  },
  "deployment.cancelled": {
    category: "deployments",
    action: "cancelled the deploy of",
    label: "Deploy cancelled",
    tone: "warning",
    description: "A deployment was stopped before it finished.",
  },
  "deployment:write": {
    category: "deployments",
    action: "started a deploy for",
    label: "Deploy action",
    description: "A deployment endpoint was invoked — start, retry, rollback, or promote.",
  },
  "deployment:admin": {
    category: "deployments",
    action: "ran an admin action on the deploy for",
    label: "Deploy admin action",
    tone: "warning",
    description: "A destructive deployment endpoint was invoked, such as cancel or destroy.",
  },

  /* ---------------- Apps & services ---------------- */
  "project.created": {
    category: "apps",
    action: "created",
    label: "App created",
    tone: "info",
  },
  "project.updated": {
    category: "apps",
    action: "updated",
    label: "App updated",
    description: "Settings, services, environment variables, or routing were changed.",
  },
  "project.deleted": {
    category: "apps",
    action: "deleted",
    label: "App deleted",
    tone: "danger",
  },
  "project.deletion.rejected": {
    category: "apps",
    action: "tried to delete",
    label: "App deletion refused",
    tone: "warning",
    description: "A delete was refused — something still depends on this app.",
  },
  "project:write": {
    category: "apps",
    action: "changed",
    label: "App changed",
    description: "One of the app's write endpoints was invoked.",
  },
  "project:admin": {
    category: "apps",
    action: "ran an admin action on",
    label: "App admin action",
    tone: "warning",
    description: "A destructive app endpoint was invoked, such as delete or transfer.",
  },
  "project:service:write": {
    category: "apps",
    action: "changed a service in",
    label: "Service changed",
    description: "A service was created, updated, started, stopped, or restarted.",
  },
  "project:service:admin": {
    category: "apps",
    action: "ran an admin action on a service in",
    label: "Service admin action",
    tone: "warning",
  },
  "job:write": {
    category: "apps",
    action: "changed the job",
    label: "Job changed",
    description: "A scheduled or custom job was created, edited, run, or removed.",
  },
  "job_run.started": {
    category: "apps",
    action: "started the job",
    label: "Job started",
  },
  "job_run.succeeded": {
    category: "apps",
    action: "ran the job",
    label: "Job succeeded",
    tone: "success",
  },
  "job_run.failed": {
    category: "apps",
    action: "ran the failing job",
    label: "Job failed",
    tone: "danger",
  },
  // Written by the health watcher, never by a person — these only ever render
  // through `label`.
  "service.down": {
    category: "apps",
    action: "reported down",
    label: "App went down",
    tone: "danger",
    description: "A container that should be running isn't — exited, dead, or OOM-killed.",
  },
  "service.crash_loop": {
    category: "apps",
    action: "reported crash looping",
    label: "App is crash looping",
    tone: "danger",
    description: "A container keeps restarting instead of staying up.",
  },
  "service.unhealthy": {
    category: "apps",
    action: "reported unhealthy",
    label: "App is unhealthy",
    tone: "warning",
    description: "A container is running but its own healthcheck is failing.",
  },
  "service.recovered": {
    category: "apps",
    action: "reported recovered",
    label: "App recovered",
    tone: "success",
    description: "An outage ended and the container is healthy again.",
  },

  /* ---------------- Domains & SSL ---------------- */
  "domain.added": {
    category: "domains",
    action: "added the domain",
    label: "Domain added",
    tone: "info",
  },
  "domain.removed": {
    category: "domains",
    action: "removed the domain",
    label: "Domain removed",
    tone: "danger",
  },
  "domain.verified": {
    category: "domains",
    action: "verified the domain",
    label: "Domain verified",
    tone: "success",
    description: "DNS verification succeeded, so the domain can be issued a certificate.",
  },
  "domain.verification_failed": {
    category: "domains",
    action: "failed to verify the domain",
    label: "Domain verification failed",
    tone: "warning",
    description: "DNS records for this domain don't point here yet.",
  },
  "domain.set_primary": {
    category: "domains",
    action: "made primary the domain",
    label: "Primary domain changed",
    description: "The domain other addresses now redirect to.",
  },
  "domain.cert_uploaded": {
    category: "domains",
    action: "uploaded a certificate for",
    label: "Certificate uploaded",
    description: "A certificate and key were supplied by hand instead of issued automatically.",
  },
  "ssl.renewal_failed": {
    category: "domains",
    action: "failed to renew SSL for",
    label: "SSL renewal failed",
    tone: "danger",
    description: "Automatic renewal failed — the certificate will expire unless this is fixed.",
  },
  "domain:write": {
    category: "domains",
    action: "changed the domain",
    label: "Domain action",
    description: "A domain endpoint was invoked — add, verify, or renew.",
  },
  "domain:admin": {
    category: "domains",
    action: "ran an admin action on the domain",
    label: "Domain admin action",
    tone: "warning",
  },

  /* ---------------- Servers ---------------- */
  "server.added": {
    category: "servers",
    action: "added the server",
    label: "Server added",
    tone: "info",
  },
  "server.updated": {
    category: "servers",
    action: "updated the server",
    label: "Server updated",
  },
  "server.removed": {
    category: "servers",
    action: "removed the server",
    label: "Server removed",
    tone: "danger",
  },
  "server.unreachable": {
    category: "servers",
    action: "reported unreachable",
    label: "Server unreachable",
    tone: "danger",
    description: "Openship could not open an SSH connection to this server.",
  },
  "server.reachable": {
    category: "servers",
    action: "reported reachable",
    label: "Server reachable again",
    tone: "success",
  },
  "server:write": {
    category: "servers",
    action: "changed the server",
    label: "Server changed",
  },
  "server:admin": {
    category: "servers",
    action: "ran an admin action on the server",
    label: "Server admin action",
    tone: "warning",
    description: "A destructive server endpoint was invoked, such as delete or component install.",
  },
  "terminal:write": {
    category: "servers",
    action: "opened a terminal on",
    label: "Terminal session opened",
    tone: "warning",
    description: "An interactive shell session was issued against a server.",
  },
  "mail_server:write": {
    category: "servers",
    action: "changed the mail server",
    label: "Mail server changed",
    description: "A mail server endpoint was invoked — setup, domain, DNS acknowledgement.",
  },
  "mail_server:admin": {
    category: "servers",
    action: "ran an admin action on the mail server",
    label: "Mail server admin action",
    tone: "warning",
  },

  /* ---------------- Members & access ---------------- */
  "organization.created": {
    category: "members",
    action: "created the organization",
    label: "Organization created",
    tone: "info",
  },
  "organization.deleted": {
    category: "members",
    action: "deleted the organization",
    label: "Organization deleted",
    tone: "danger",
  },
  "organization.deletion.blocked": {
    category: "members",
    action: "tried to delete the organization",
    label: "Organization deletion blocked",
    tone: "warning",
    description: "Deletion was refused — active resources or billing still attached.",
  },
  "member.added": {
    category: "members",
    action: "added",
    label: "Member added",
    tone: "info",
  },
  "member.removed": {
    category: "members",
    action: "removed",
    label: "Member removed",
    tone: "danger",
  },
  "member.role_changed": {
    category: "members",
    action: "changed the role of",
    label: "Member role changed",
    tone: "warning",
  },
  "member.joined": {
    category: "members",
    action: "joined",
    label: "Member joined",
    tone: "success",
    description: "An invitee accepted and now has access.",
  },
  "member.invited": {
    category: "members",
    action: "invited",
    label: "Member invited",
    tone: "info",
  },
  "member.removal.grant_cleanup_failed": {
    category: "members",
    action: "removed, with leftover permissions,",
    label: "Removed member's permissions not cleaned up",
    tone: "warning",
    description: "The member is gone but their permission grants remained — review by hand.",
  },
  "member.removal.subscription_cleanup_failed": {
    category: "members",
    action: "removed, with leftover billing,",
    label: "Removed member's billing not cleaned up",
    tone: "warning",
    description: "The member is gone but a linked subscription remained — review billing.",
  },
  "invitation.created": {
    category: "members",
    action: "invited",
    label: "Invitation sent",
    tone: "info",
  },
  "invitation.sent": {
    category: "members",
    action: "invited, with pending permissions,",
    label: "Invitation sent with pending permissions",
    tone: "info",
    description: "Grants were queued and will apply the moment the invitee joins.",
  },
  "invitation.accepted": {
    category: "members",
    action: "accepted the invitation of",
    label: "Invitation accepted",
    tone: "success",
  },
  "invitation.rejected": {
    category: "members",
    action: "declined the invitation of",
    label: "Invitation declined",
    tone: "warning",
  },
  "invitation.cancelled": {
    category: "members",
    action: "cancelled the invitation for",
    label: "Invitation cancelled",
    tone: "warning",
  },
  "team.created": {
    category: "members",
    action: "created the team",
    label: "Team created",
    tone: "info",
  },
  "grant.granted": {
    category: "members",
    action: "granted permissions to",
    label: "Permission granted",
    tone: "info",
  },
  "grant.revoked": {
    category: "members",
    action: "revoked permissions from",
    label: "Permission revoked",
    tone: "danger",
  },
  "grant.replaced": {
    category: "members",
    action: "replaced the permissions of",
    label: "Permission replaced",
    tone: "warning",
    description: "An existing grant was overwritten with a different scope.",
  },
  "grant.materialized": {
    category: "members",
    action: "received their pending permissions,",
    label: "Pending permission applied",
    description: "A grant attached to an invitation was applied once the invitee joined.",
  },
  "permissions:write": {
    category: "members",
    action: "changed permissions for",
    label: "Permissions changed",
    tone: "warning",
  },
  "permissions:admin": {
    category: "members",
    action: "ran an admin action on permissions for",
    label: "Permissions admin action",
    tone: "warning",
  },

  /* ---------------- Security ---------------- */
  "admin.bootstrapped": {
    category: "security",
    action: "bootstrapped the first admin account",
    label: "First admin account created",
    tone: "warning",
    description: "The instance's initial owner was created — this can only happen once.",
  },
  "admin.password_reset": {
    category: "security",
    action: "reset an admin password",
    label: "Admin password reset",
    tone: "danger",
  },
  "auth-mode-changed": {
    category: "security",
    action: "changed the sign-in mode",
    label: "Sign-in mode changed",
    tone: "danger",
    description: "The instance switched between single-user and full authentication.",
  },
  "instance.data.exported": {
    category: "security",
    action: "exported all instance data",
    label: "Instance data exported",
    tone: "warning",
    description: "A full database dump left this instance.",
  },
  "instance.data.imported": {
    category: "security",
    action: "imported instance data",
    label: "Instance data imported",
    tone: "warning",
    description: "A database dump from another instance was loaded in.",
  },
  // Written by the audit module itself. "disabled" is recorded before the switch
  // flips, so turning recording off always leaves this one row behind.
  "audit.disabled": {
    category: "security",
    action: "turned off activity recording",
    label: "Activity recording turned off",
    tone: "danger",
    description: "No further actions were recorded until recording was turned back on.",
  },
  "audit.enabled": {
    category: "security",
    action: "turned on activity recording",
    label: "Activity recording turned on",
    tone: "success",
  },
  "audit.retention_changed": {
    category: "security",
    action: "changed how long activity is kept",
    label: "Activity retention changed",
    tone: "warning",
  },
  "audit:write": {
    category: "security",
    action: "changed activity recording",
    label: "Activity settings changed",
    tone: "warning",
  },

  /* ---------------- Billing ---------------- */
  "billing.hard_cap_tripped": {
    category: "billing",
    action: "hit the spending cap for",
    label: "Spending cap reached",
    tone: "danger",
    description: "Cloud resources may have been paused — review billing.",
  },
  "billing.credit_exhausted": {
    category: "billing",
    action: "ran out of credits for",
    label: "Credits exhausted",
    tone: "warning",
    description: "Metered usage is paused until a top-up or the monthly reset.",
  },
  "billing.credit_restored": {
    category: "billing",
    action: "restored credits for",
    label: "Credits restored",
    tone: "success",
  },
  "billing.anniversary_reset": {
    category: "billing",
    action: "reset the monthly credits of",
    label: "Monthly credits reset",
  },
  "quota.threshold_fired": {
    category: "billing",
    action: "crossed a usage threshold on",
    label: "Usage threshold crossed",
    tone: "warning",
  },
  "billing:write": {
    category: "billing",
    action: "changed billing for",
    label: "Billing action",
    description: "A billing endpoint was invoked — subscribe, top up, or open the portal.",
  },
  "billing:admin": {
    category: "billing",
    action: "ran an admin action on billing for",
    label: "Billing admin action",
    tone: "warning",
    description: "A destructive billing endpoint was invoked, such as cancelling a subscription.",
  },

  /* ---------------- System ---------------- */
  "settings.updated": {
    category: "system",
    action: "updated settings",
    label: "Settings updated",
  },
  "settings:write": {
    category: "system",
    action: "changed settings",
    label: "Settings changed",
  },
  "settings:admin": {
    category: "system",
    action: "ran an admin action on settings",
    label: "Settings admin action",
    tone: "warning",
    description: "A destructive settings endpoint was invoked, such as a wipe or migration.",
  },
  "updates:write": {
    category: "system",
    action: "applied an update",
    label: "Update applied",
    description: "An Openship component was updated or an update scan was triggered.",
  },
  "cloud.disconnect": {
    category: "system",
    action: "disconnected from Openship Cloud",
    label: "Cloud disconnected",
    tone: "warning",
  },
  "cloud:write": {
    category: "system",
    action: "ran a cloud action",
    label: "Cloud action",
    description: "A cloud bridge endpoint was invoked — token, preflight, or edge proxy.",
  },
  "cloud:admin": {
    category: "system",
    action: "ran a cloud admin action",
    label: "Cloud admin action",
    tone: "warning",
  },
  "github.install": {
    category: "system",
    action: "installed the GitHub app on",
    label: "GitHub app installed",
    tone: "info",
  },
  "github.disconnect": {
    category: "system",
    action: "disconnected GitHub from",
    label: "GitHub disconnected",
    tone: "warning",
  },
  "github.repo.create": {
    category: "system",
    action: "created the repository",
    label: "Repository created",
    tone: "info",
  },
  "github.repo.delete": {
    category: "system",
    action: "deleted the repository",
    label: "Repository deleted",
    tone: "danger",
  },
  "github.webhook.register": {
    category: "system",
    action: "enabled deploy-on-push for",
    label: "Deploy-on-push enabled",
    tone: "info",
  },
  "github.webhook.delete": {
    category: "system",
    action: "disabled deploy-on-push for",
    label: "Deploy-on-push disabled",
    tone: "warning",
  },
  "github.instance_token.set": {
    category: "system",
    action: "set the instance GitHub token",
    label: "Instance GitHub token set",
    tone: "warning",
    description: "A GitHub token shared by every project on this instance was stored.",
  },
  "github:write": {
    category: "system",
    action: "changed a GitHub connection for",
    label: "GitHub action",
  },
  "github:admin": {
    category: "system",
    action: "ran a GitHub admin action on",
    label: "GitHub admin action",
    tone: "warning",
  },
  "notification_channel.created": {
    category: "system",
    action: "added the notification channel",
    label: "Notification channel added",
    tone: "info",
  },
  "notification_channel.updated": {
    category: "system",
    action: "updated the notification channel",
    label: "Notification channel updated",
  },
  "notification_channel.deleted": {
    category: "system",
    action: "removed the notification channel",
    label: "Notification channel removed",
    tone: "warning",
  },
  "notification_subscription.updated": {
    category: "system",
    action: "changed what is sent to",
    label: "Notification subscription changed",
  },
  "notification_subscription.deleted": {
    category: "system",
    action: "stopped notifications to",
    label: "Notification subscription removed",
    tone: "warning",
  },
  "notification_default.updated": {
    category: "system",
    action: "changed the notification defaults of",
    label: "Notification defaults changed",
  },
  "notifications:write": {
    category: "system",
    action: "changed notifications",
    label: "Notifications changed",
  },
  "notifications:admin": {
    category: "system",
    action: "ran a notifications admin action",
    label: "Notifications admin action",
    tone: "warning",
  },
  "backup_run.succeeded": {
    category: "system",
    action: "backed up",
    label: "Backup succeeded",
    tone: "success",
  },
  "backup_run.failed": {
    category: "system",
    action: "failed to back up",
    label: "Backup failed",
    tone: "danger",
  },
  "backup.webhook.fired": {
    category: "system",
    action: "triggered a backup of",
    label: "Backup triggered by webhook",
  },
  "backup.webhook.disabled": {
    category: "system",
    action: "disabled the backup webhook for",
    label: "Backup webhook disabled",
    tone: "warning",
    description: "The webhook failed too many times and was switched off.",
  },
  "backup_destination:write": {
    category: "system",
    action: "changed the backup destination",
    label: "Backup destination changed",
  },
  "backup_destination:admin": {
    category: "system",
    action: "ran an admin action on the backup destination",
    label: "Backup destination admin action",
    tone: "warning",
  },
  "backup_destination:backup_policy:write": {
    category: "system",
    action: "changed the backup schedule of",
    label: "Backup schedule changed",
  },
  "backup_destination:backup_run:write": {
    category: "system",
    action: "ran a backup of",
    label: "Backup run",
  },
  "backup_destination:backup_restore:write": {
    category: "system",
    action: "restored from a backup of",
    label: "Restore from backup",
    tone: "warning",
  },
};

/**
 * Resource type → the noun the feed uses when a row's resource has no
 * resolvable name (deleted rows, `resourceId: "*"` org-wide writes, resource
 * types with no name column at all).
 */
export const AUDIT_RESOURCE_LABELS: Record<string, string> = {
  project: "an app",
  service: "a service",
  container: "a container",
  deployment: "a deployment",
  domain: "a domain",
  server: "a server",
  mail_server: "the mail server",
  job: "a job",
  organization: "the organization",
  member: "a member",
  invitation: "an invitation",
  team: "a team",
  resource_grant: "a permission grant",
  env_var: "an environment variable",
  github: "GitHub",
  github_repository: "a repository",
  notifications: "notifications",
  notification_channel: "a notification channel",
  backup_destination: "a backup destination",
  backup_policy: "a backup schedule",
  backup_run: "a backup",
  backup_restore: "a restore",
  incoming_webhook: "a webhook",
  billing: "billing",
  cloud: "Openship Cloud",
  settings: "settings",
  "instance-settings": "instance settings",
  instance: "this instance",
  audit: "activity recording",
};

const CATEGORY_IDS = new Set<string>(AUDIT_CATEGORIES.map((c) => c.id));

/** Event types per category, precomputed — the API turns `category` into this. */
const EVENT_TYPES_BY_CATEGORY: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const id of CATEGORY_IDS) map[id] = [];
  for (const [eventType, def] of Object.entries(AUDIT_EVENTS)) {
    map[def.category]?.push(eventType);
  }
  return map;
})();

export function isAuditCategoryId(value: unknown): value is AuditCategoryId {
  return typeof value === "string" && CATEGORY_IDS.has(value);
}

export function categoryForAuditEvent(eventType: string): AuditCategoryId | null {
  return AUDIT_EVENTS[eventType]?.category ?? null;
}

/**
 * The `event_type IN (...)` list for a category filter.
 *
 * An unknown event type belongs to no category, so it is reachable only from
 * the "All" view. That is the intended failure mode: a new event type shows up
 * unfiltered rather than being silently hidden behind a tab that never lists it.
 */
export function eventTypesForCategory(category: string): string[] {
  return EVENT_TYPES_BY_CATEGORY[category] ?? [];
}

/**
 * Pretty-print a raw event type for events with no catalog entry.
 *
 * "foo.bar_baz"   → "Foo bar baz"
 * "foo:bar:write" → "Foo: bar: write"
 */
export function prettifyEventType(type: string): string {
  if (!type) return "Unknown event";
  if (type.includes(":")) {
    const parts = type
      .split(":")
      .map((p) => p.replace(/[._]/g, " ").trim())
      .filter(Boolean);
    if (parts.length === 0) return type;
    const [first, ...rest] = parts;
    const head = first.charAt(0).toUpperCase() + first.slice(1);
    return rest.length === 0 ? head : `${head}: ${rest.join(": ")}`;
  }
  const flat = type.replace(/[._]/g, " ").trim();
  return flat.charAt(0).toUpperCase() + flat.slice(1);
}

export interface AuditEventDescription extends AuditEventDef {
  /** False when this came from the prettifier, so the UI can hedge its wording. */
  known: boolean;
}

/**
 * Resolve an event type to something renderable. Never throws and never returns
 * undefined — an uncatalogued event still has to produce a readable row.
 */
export function describeAuditEvent(eventType: string): AuditEventDescription {
  const hit = AUDIT_EVENTS[eventType];
  if (hit) return { ...hit, tone: hit.tone ?? "neutral", known: true };
  const label = prettifyEventType(eventType);
  return { category: "system", action: label.toLowerCase(), label, tone: "neutral", known: false };
}

/** Noun for a row whose resource could not be named. */
export function auditResourceLabel(resourceType: string | null | undefined): string {
  if (!resourceType) return "";
  return AUDIT_RESOURCE_LABELS[resourceType] ?? resourceType.replace(/[._-]/g, " ");
}
