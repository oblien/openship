/**
 * Audit event label catalog.
 *
 * Maps every server-emitted `eventType` to a human-readable
 * `{ label, description? }` so the AuditTab can render rows
 * without exposing raw `foo.bar_baz` tokens to operators.
 *
 * Two sources feed this:
 *   1. Explicit `eventType: "..."` literals in `apps/api/src/**`
 *      (deployment lifecycle, org/membership hooks, billing, etc.).
 *   2. The secureRouter auto-emitter, which fires one row per
 *      successful write/admin route using the route's `tag` as
 *      the eventType (e.g. `"project:write"`, `"github:admin"`).
 *
 * When a new eventType lands without a mapping here, the fallback
 * in `getAuditLabel` prettifies the raw string ("foo.bar_baz" →
 * "Foo bar baz") so the UI never shows `undefined`.
 */

export interface AuditLabel {
  label: string;
  description?: string;
}

export const AUDIT_EVENT_LABELS: Record<string, AuditLabel> = {
  /* ---------- Organization / membership (Better Auth hooks) ---------- */
  "organization.created": {
    label: "Organization created",
    description: "A new organization workspace was created.",
  },
  "organization.deleted": {
    label: "Organization deleted",
    description: "An organization workspace was permanently removed.",
  },
  "member.added": {
    label: "Member added",
    description: "A user was added to the organization.",
  },
  "member.removed": {
    label: "Member removed",
    description: "A user was removed from the organization.",
  },
  "member.role_changed": {
    label: "Member role changed",
    description: "A member's role inside the organization was changed.",
  },
  "member.removal.grant_cleanup_failed": {
    label: "Member removal cleanup failed",
    description:
      "A member was removed but their permission grants could not be fully cleaned up — review manually.",
  },
  "member.invited": {
    label: "Member invited",
    description: "An invitation to join the organization was sent.",
  },
  "member.joined": {
    label: "Member joined",
    description: "An invitee accepted their invitation and joined the organization.",
  },

  /* ---------- Invitations ---------- */
  "invitation.created": {
    label: "Invitation sent",
    description: "An invitation was issued to a prospective member.",
  },
  "invitation.accepted": {
    label: "Invitation accepted",
    description: "An invitee accepted their invitation to join.",
  },
  "invitation.rejected": {
    label: "Invitation declined",
    description: "An invitee declined their invitation.",
  },
  "invitation.cancelled": {
    label: "Invitation cancelled",
    description: "A pending invitation was revoked by an admin.",
  },
  "invitation.sent": {
    label: "Invitation sent (with pending grants)",
    description:
      "An invitation was issued, queuing permission grants that will materialize on acceptance.",
  },

  /* ---------- Permissions / teams / grants ---------- */
  "team.created": {
    label: "Team created",
    description: "A new team was created inside the organization.",
  },
  "grant.granted": {
    label: "Permission granted",
    description: "A new permission grant was issued to a member or team.",
  },
  "grant.revoked": {
    label: "Permission revoked",
    description: "An existing permission grant was removed.",
  },
  "grant.materialized": {
    label: "Permission grant materialized",
    description:
      "A pending grant attached to an invitation was applied after the invitee joined.",
  },

  /* ---------- Projects ---------- */
  "project.created": {
    label: "Project created",
    description: "A new project was created.",
  },
  "project.updated": {
    label: "Project updated",
    description: "Project settings, services, env vars, or domain config were modified.",
  },
  "project.deleted": {
    label: "Project deleted",
    description: "A project was permanently removed.",
  },

  /* ---------- Deployments ---------- */
  "deployment.succeeded": {
    label: "Deploy succeeded",
    description: "A deployment finished successfully.",
  },
  "deployment.failed": {
    label: "Deploy failed",
    description: "A deployment failed before reaching healthy state.",
  },
  "deployment.canceled": {
    label: "Deploy canceled",
    description: "A deployment was canceled before completion.",
  },

  /* ---------- Servers ---------- */
  "server.added": {
    label: "Server added",
    description: "A new server was registered as a deployment target.",
  },
  "server.updated": {
    label: "Server updated",
    description: "A registered server's configuration was changed.",
  },
  "server.removed": {
    label: "Server removed",
    description: "A server was unregistered from the organization.",
  },

  /* ---------- Domains / SSL ---------- */
  "domain.added": {
    label: "Domain added",
    description: "A custom domain was attached to a project.",
  },
  "domain.removed": {
    label: "Domain removed",
    description: "A custom domain was detached from a project.",
  },
  "domain.verified": {
    label: "Domain verified",
    description: "DNS verification for a custom domain succeeded.",
  },
  "domain.verify_failed": {
    label: "Domain verification failed",
    description: "DNS verification for a custom domain did not succeed.",
  },
  "ssl.renewal_failed": {
    label: "SSL renewal failed",
    description:
      "Automatic SSL certificate renewal failed for one or more domains — manual intervention may be required.",
  },

  /* ---------- Settings ---------- */
  "settings.updated": {
    label: "Settings updated",
    description: "Organization or instance settings were changed.",
  },
  "auth-mode-changed": {
    label: "Auth mode changed",
    description:
      "Instance authentication mode was switched (e.g. local single-user → cloud auth).",
  },

  /* ---------- Cloud connection ---------- */
  "cloud.disconnect": {
    label: "Cloud disconnected",
    description: "This instance was disconnected from Openship Cloud.",
  },

  /* ---------- GitHub ---------- */
  "github.install": {
    label: "GitHub app installed",
    description: "The Openship GitHub app was installed on an account or organization.",
  },
  "github.disconnect": {
    label: "GitHub disconnected",
    description: "GitHub integration was disconnected.",
  },
  "github.repo.create": {
    label: "GitHub repository created",
    description: "A new repository was created via the GitHub integration.",
  },
  "github.repo.delete": {
    label: "GitHub repository deleted",
    description: "A repository was deleted via the GitHub integration.",
  },
  "github.webhook.register": {
    label: "GitHub webhook registered",
    description: "A repository webhook was registered for deploy-on-push.",
  },
  "github.webhook.delete": {
    label: "GitHub webhook removed",
    description: "A repository webhook was removed.",
  },

  /* ---------- Notifications ---------- */
  "notification_channel.created": {
    label: "Notification channel created",
    description: "A new notification destination (Slack, email, webhook, etc.) was added.",
  },
  "notification_channel.updated": {
    label: "Notification channel updated",
    description: "An existing notification channel's configuration was changed.",
  },
  "notification_channel.deleted": {
    label: "Notification channel deleted",
    description: "A notification channel was removed.",
  },
  "notification_subscription.updated": {
    label: "Notification subscription updated",
    description: "An event-to-channel subscription was changed.",
  },
  "notification_subscription.deleted": {
    label: "Notification subscription deleted",
    description: "An event-to-channel subscription was removed.",
  },
  "notification_default.updated": {
    label: "Notification defaults updated",
    description: "The organization-wide notification defaults were changed.",
  },

  /* ---------- Backups ---------- */
  "backup_run.succeeded": {
    label: "Backup succeeded",
    description: "A scheduled or manual backup finished successfully.",
  },
  "backup_run.failed": {
    label: "Backup failed",
    description: "A backup run did not complete — review the orchestrator logs.",
  },
  "backup.webhook.fired": {
    label: "Backup webhook fired",
    description: "A backup was triggered by an inbound webhook.",
  },
  "backup.webhook.disabled": {
    label: "Backup webhook disabled",
    description: "A backup webhook was disabled (e.g. exceeded failure threshold).",
  },

  /* ---------- Billing ---------- */
  "billing.hard_cap_tripped": {
    label: "Billing hard cap tripped",
    description:
      "The organization hit a spending hard cap. Cloud resources may have been paused — review billing.",
  },
  "billing.credit_exhausted": {
    label: "Billing credits exhausted",
    description: "Monthly credits ran out; metered usage paused until top-up or reset.",
  },
  "billing.credit_restored": {
    label: "Billing credits restored",
    description: "Credit balance was restored (top-up or anniversary reset).",
  },
  "billing.anniversary_reset": {
    label: "Billing anniversary reset",
    description: "Monthly credit allocation was reset on the billing anniversary.",
  },

  /* ---------- Auto-emitted permission-tag eventTypes (write/admin routes) ---------- */
  "project:write": {
    label: "Project changed",
    description: "A project-scoped write endpoint was invoked.",
  },
  "project:admin": {
    label: "Project: admin action",
    description: "A destructive project endpoint (e.g. delete, transfer) was invoked.",
  },
  "project:env_var:write": {
    label: "Project env vars updated",
    description: "Environment variables on a project were modified.",
  },
  "project:deployment:write": {
    label: "Project deployment session",
    description: "A deployment session was started for the project.",
  },
  "project:domain:write": {
    label: "Project domain connected",
    description: "A domain was connected to (or disconnected from) the project.",
  },
  "project:service:write": {
    label: "Project service changed",
    description: "A service inside the project was created, updated, or container-managed.",
  },
  "project:service:admin": {
    label: "Project service: admin action",
    description: "A destructive action on a project service (e.g. delete) was performed.",
  },
  "deployment:write": {
    label: "Deployment action",
    description: "A deployment write endpoint was invoked.",
  },
  "deployment:admin": {
    label: "Deployment: admin action",
    description: "A destructive deployment endpoint (e.g. cancel/destroy) was invoked.",
  },
  "server:write": {
    label: "Server: configuration changed",
    description: "A server's configuration was modified.",
  },
  "server:admin": {
    label: "Server: admin action",
    description: "A destructive server endpoint (e.g. delete, install/remove component) was invoked.",
  },
  "domain:write": {
    label: "Domain action",
    description: "A domain endpoint was invoked (add, verify, renew).",
  },
  "domain:admin": {
    label: "Domain: admin action",
    description: "A destructive domain endpoint (e.g. delete) was invoked.",
  },
  "settings:write": {
    label: "Settings changed",
    description: "Instance or organization settings were modified.",
  },
  "settings:admin": {
    label: "Settings: admin action",
    description: "A destructive settings endpoint (e.g. wipe, migrate) was invoked.",
  },
  "permissions:write": {
    label: "Permissions changed",
    description: "Permission grants or teams were modified.",
  },
  "permissions:admin": {
    label: "Permissions: admin action",
    description: "A destructive permission endpoint (e.g. delete grant) was invoked.",
  },
  "github:write": {
    label: "GitHub permission: write",
    description:
      "A GitHub integration write endpoint was invoked (connect, create repo, register webhook).",
  },
  "github:admin": {
    label: "GitHub permission: admin",
    description:
      "A destructive GitHub integration endpoint (disconnect, delete repo, delete webhook) was invoked.",
  },
  "cloud:write": {
    label: "Cloud action",
    description: "A cloud bridge endpoint (token, preflight, edge-proxy, etc.) was invoked.",
  },
  "cloud:admin": {
    label: "Cloud: admin action",
    description:
      "A destructive cloud endpoint (e.g. disconnect, subgraph ingest/export) was invoked.",
  },
  "billing:write": {
    label: "Billing action",
    description:
      "A billing write endpoint was invoked (subscribe, top-up, open portal).",
  },
  "billing:admin": {
    label: "Billing: admin action",
    description: "A destructive billing endpoint (e.g. cancel subscription) was invoked.",
  },
  "notifications:write": {
    label: "Notifications changed",
    description: "Notification channels or subscriptions were modified.",
  },
  "notifications:admin": {
    label: "Notifications: admin action",
    description: "A destructive notifications endpoint (e.g. delete default) was invoked.",
  },
  "terminal:write": {
    label: "Terminal session opened",
    description: "An interactive terminal session ticket was issued.",
  },
  "mail_server:write": {
    label: "Mail server action",
    description: "A mail server write endpoint was invoked (setup, domain, DNS ack, etc.).",
  },
  "mail_server:admin": {
    label: "Mail server: admin action",
    description: "A destructive mail server endpoint (e.g. reset setup, remove) was invoked.",
  },
  "backup_destination:write": {
    label: "Backup destination changed",
    description: "A backup destination was created or updated.",
  },
  "backup_destination:admin": {
    label: "Backup destination: admin action",
    description: "A destructive backup destination endpoint was invoked.",
  },
  "backup_destination:backup_policy:write": {
    label: "Backup policy changed",
    description: "A backup policy was created, updated, or manually run.",
  },
  "backup_destination:backup_run:write": {
    label: "Backup run action",
    description: "A backup run was triggered or modified.",
  },
  "backup_destination:backup_restore:write": {
    label: "Backup restore",
    description: "A restore from backup was initiated.",
  },
};

/**
 * Pretty-print a raw event type as a fallback.
 *
 * "foo.bar_baz"        → "Foo bar baz"
 * "foo:write"          → "Foo: write"
 * "foo:bar:write"      → "Foo: bar: write"
 */
function prettifyEventType(type: string): string {
  if (!type) return "Unknown event";
  // Colon-delimited (permission tag) — promote to "X: y" so it reads naturally.
  if (type.includes(":")) {
    const parts = type.split(":").map((p) => p.replace(/[._]/g, " ").trim()).filter(Boolean);
    if (parts.length === 0) return type;
    const [first, ...rest] = parts;
    const head = first.charAt(0).toUpperCase() + first.slice(1);
    return rest.length === 0 ? head : `${head}: ${rest.join(": ")}`;
  }
  // Dot/underscore tokens — flatten and Sentence-case the first word.
  const flat = type.replace(/[._]/g, " ").trim();
  return flat.charAt(0).toUpperCase() + flat.slice(1);
}

/**
 * Resolve an audit row's eventType to a UI label.
 * Falls back to a prettified raw string when no mapping exists, so
 * a forgotten event still renders cleanly without crashing the row.
 */
export function getAuditLabel(eventType: string): AuditLabel {
  const hit = AUDIT_EVENT_LABELS[eventType];
  if (hit) return hit;
  return { label: prettifyEventType(eventType) };
}
