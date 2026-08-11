/**
 * Notification category registry.
 *
 * Categories are the user-facing grouping for the Settings UI: a user
 * doesn't pick "deployment.failed" or "build.image_pull_error" — they
 * pick "Deploy failed". The dispatcher's job is to map low-level
 * eventTypes (the audit_event.event_type column) to these stable
 * category strings.
 *
 * To add a new category:
 *   1. Add a `CATEGORIES` entry with id + group + label + description
 *   2. Add the matching audit eventType(s) to `EVENT_TYPE_TO_CATEGORY`
 *   3. The Settings UI picks it up automatically
 *
 * Categories live in code (not the DB) so they're refactor-safe and
 * the Settings UI can render labels + descriptions without round-trips.
 */

/**
 * Category groups, in the order the Settings UI shows their tabs.
 *
 * These were section-divider comments in `CATEGORIES`, which meant the grouping
 * existed for whoever read this file and for nobody else: the API flattened it
 * away and the UI rendered one nineteen-row list. As data it drives the tab
 * strip, and a mistyped `group` on a category becomes a compile error rather
 * than a category that quietly belongs to no tab.
 */
export const CATEGORY_GROUPS = [
  { id: "deployment", label: "Deployment" },
  { id: "app_health", label: "App health" },
  { id: "backups", label: "Backups" },
  { id: "jobs", label: "Jobs" },
  { id: "domains", label: "Domains & SSL" },
  { id: "members", label: "Members" },
  { id: "billing", label: "Billing" },
] as const satisfies readonly { id: string; label: string }[];

export type NotificationCategoryGroup = (typeof CATEGORY_GROUPS)[number];
export type NotificationCategoryGroupId = NotificationCategoryGroup["id"];

export interface NotificationCategory {
  /** Stable id stored in subscription/default rows. snake_dot.case. */
  id: string;
  /** Which Settings tab this row lives under. */
  group: NotificationCategoryGroupId;
  /**
   * Display label for the Settings UI row — and the title of the delivered
   * alert, which `renderMessage` takes verbatim (notification-workers.ts).
   * Renaming one changes what lands in somebody's inbox; it is not a UI-only
   * edit. The id is what's stored, so a rename is safe for existing rows.
   */
  label: string;
  /** One-line explanation under the toggle. Also the alert's first body line. */
  description: string;
  /** Default enabled state when a brand-new user joins an org. */
  defaultEnabled: boolean;
}

export const CATEGORIES: readonly NotificationCategory[] = [
  {
    id: "deploy.failed",
    group: "deployment",
    label: "Deploy failed",
    description:
      "A build or deploy errored out. We send the error message + a snippet of the failing logs.",
    defaultEnabled: true,
  },
  {
    id: "deploy.succeeded",
    group: "deployment",
    label: "Deploy succeeded",
    description:
      "Every successful production deploy. Off by default — most teams find it noisy.",
    defaultEnabled: false,
  },
  {
    id: "deploy.cancelled",
    group: "deployment",
    label: "Deploy cancelled",
    description: "An in-flight deploy was cancelled by you or another member.",
    defaultEnabled: false,
  },

  // Fed by the `services:health-watch` job, which polls every server's Docker
  // daemon once a minute. All on by default: a container that is down is the one
  // thing nobody wants to find out about from a user. Each of these fires at most
  // twice per outage (open, then escalation) plus once on recovery — the incident
  // record is what stops a multi-hour crash loop from paging every minute.
  {
    id: "service.down",
    group: "app_health",
    label: "App down",
    description:
      "A container that should be running isn't — exited, dead, or OOM-killed. Includes the exit code and its last log lines. Never fires for a service you stopped yourself.",
    defaultEnabled: true,
  },
  {
    id: "service.crash_loop",
    group: "app_health",
    label: "App crash looping",
    description:
      "A container keeps restarting. Point-in-time status always reads healthy for these, so this is the only way you'd know.",
    defaultEnabled: true,
  },
  {
    id: "service.unhealthy",
    group: "app_health",
    label: "App unhealthy",
    description: "A container is up but its own healthcheck is failing.",
    defaultEnabled: true,
  },
  {
    id: "service.recovered",
    group: "app_health",
    label: "App recovered",
    description: "An outage ended, with how long it lasted. The other half of the alert above.",
    defaultEnabled: true,
  },
  {
    id: "server.unreachable",
    group: "app_health",
    // Named for the box, not the app: one unreachable host is one alert, however
    // many apps happen to sit on it.
    label: "Server unreachable",
    description:
      "We can't reach a server's Docker daemon. One alert per server — never one per service on it.",
    defaultEnabled: true,
  },

  {
    id: "backup.failed",
    group: "backups",
    label: "Backup failed",
    description:
      "A scheduled or manual backup run errored out. Includes the destination + policy that failed.",
    defaultEnabled: true,
  },
  {
    id: "backup.succeeded",
    group: "backups",
    label: "Backup succeeded",
    description: "Each successful backup. Off by default — high volume.",
    defaultEnabled: false,
  },
  {
    id: "backup.restore_completed",
    group: "backups",
    label: "Restore completed",
    description: "A restore finished (or failed). Always worth notifying on.",
    defaultEnabled: true,
  },

  {
    id: "job.run.failed",
    group: "jobs",
    label: "Job failed",
    description: "A scheduled or manual job run errored out. Includes the job + exit code.",
    defaultEnabled: true,
  },
  {
    id: "job.run.succeeded",
    group: "jobs",
    label: "Job succeeded",
    description: "Each successful job run. Off by default — can be high volume.",
    defaultEnabled: false,
  },
  {
    id: "job.run.started",
    group: "jobs",
    label: "Job started",
    description: "A job began running. Off by default — mostly useful per-job.",
    defaultEnabled: false,
  },

  {
    id: "domain.expiring",
    group: "domains",
    label: "SSL cert expiring",
    description:
      "Daily check — fires when any of your custom domain certs has under 7 days left and the renewer can't reach the host.",
    defaultEnabled: true,
  },
  {
    id: "domain.verification_failed",
    group: "domains",
    label: "Domain verification failed",
    description: "DNS check didn't pass during initial domain setup.",
    defaultEnabled: true,
  },

  {
    id: "member.added",
    group: "members",
    label: "New member joined",
    description: "Someone accepted an invite and joined this organization.",
    defaultEnabled: false,
  },
  {
    id: "member.removed",
    group: "members",
    label: "Member removed",
    description: "A member was removed from the organization.",
    defaultEnabled: false,
  },
  {
    id: "invitation.sent",
    group: "members",
    label: "Invitations sent",
    description:
      "An admin sent invite(s) to new members. Useful as a security signal.",
    defaultEnabled: false,
  },

  // Cloud-only: both are fed by Stripe/Oblien, so `listCategories` drops the whole
  // group outside CLOUD_MODE rather than showing toggles that can never fire. They
  // stay in the registry regardless — `findCategory` still has to render a message
  // for any row an org already has.
  {
    id: "billing.alert",
    group: "billing",
    label: "Billing alert",
    description:
      "Payment failed, plan limit reached, or invoice overdue. Always notifies billing-owners.",
    defaultEnabled: true,
  },
  {
    id: "quota.warning",
    group: "billing",
    label: "Quota warning",
    description:
      "You're approaching a plan limit (storage, deployments, members). Heads-up before things start failing.",
    defaultEnabled: true,
  },
] as const;

/**
 * Map low-level audit eventType strings to a notification category id.
 *
 * Many event types share a category — both "deployment.failed" and
 * "build.fatal_error" route to "deploy.failed".
 *
 * Returns undefined for event types that aren't notifiable (most of
 * them — audit_event has a lot of internal/debug entries that no human
 * cares about).
 */
const EVENT_TYPE_TO_CATEGORY: Record<string, string> = {
  // Deploy
  "deployment.failed": "deploy.failed",
  "deployment.succeeded": "deploy.succeeded",
  "deployment.cancelled": "deploy.cancelled",
  "build.failed": "deploy.failed",
  "build.fatal_error": "deploy.failed",

  // Service health
  "service.down": "service.down",
  "service.crash_loop": "service.crash_loop",
  "service.unhealthy": "service.unhealthy",
  "service.recovered": "service.recovered",
  // Both directions share one toggle, same as backup restores below: an operator
  // who wants to know a box went away wants to know it came back, and splitting
  // them lets someone subscribe to the bad news only and never see the all-clear.
  "server.unreachable": "server.unreachable",
  "server.reachable": "server.unreachable",

  // Backup
  "backup.failed": "backup.failed",
  "backup.succeeded": "backup.succeeded",
  "backup_run.failed": "backup.failed",
  "backup_run.succeeded": "backup.succeeded",
  "backup_restore.completed": "backup.restore_completed",
  "backup_restore.failed": "backup.restore_completed",

  // Jobs
  "job_run.failed": "job.run.failed",
  "job_run.succeeded": "job.run.succeeded",
  "job_run.started": "job.run.started",

  // Domains / SSL
  "domain.expiring": "domain.expiring",
  "ssl.renewal_failed": "domain.expiring",
  "domain.verification_failed": "domain.verification_failed",

  // Membership
  "member.added": "member.added",
  "member.removed": "member.removed",
  "invitation.sent": "invitation.sent",
  "invitation.created": "invitation.sent",

  // Billing
  "billing.payment_failed": "billing.alert",
  "billing.invoice_overdue": "billing.alert",
  "billing.credit_exhausted": "billing.alert",
  "billing.credit_restored": "billing.alert",
  "billing.credit_low": "quota.warning",
  "quota.threshold_reached": "quota.warning",
  "quota.threshold_fired": "quota.warning",
};

export function categoryForEventType(eventType: string): string | undefined {
  return EVENT_TYPE_TO_CATEGORY[eventType];
}

/**
 * Headline for the few event types that share a category with their own opposite.
 *
 * A category is a SUBSCRIPTION — one toggle deliberately covering "the box went away"
 * and "the box came back", so nobody can subscribe to the bad news only. A delivered
 * message describes an EVENT, and rendering one from the other's category is how
 * `server.reachable` arrived titled "Server unreachable", over a body whose first line
 * insisted we couldn't reach the daemon, directly above "is answering again after 4m".
 *
 * The override is what lets the outage keep the blunt title it needs — on a phone the
 * subject line IS the alert — without the all-clear inheriting it. Only for genuine
 * two-direction categories: anything else belongs in `CATEGORIES` as its own row.
 */
export const EVENT_HEADLINES: Record<string, { title: string; description: string }> = {
  "server.reachable": {
    title: "Server reachable",
    description: "A server's Docker daemon is answering again, with how long it was gone.",
  },
};

export function headlineForEventType(
  eventType: string,
): { title: string; description: string } | undefined {
  return EVENT_HEADLINES[eventType];
}

export function findCategory(id: string): NotificationCategory | undefined {
  return CATEGORIES.find((c) => c.id === id);
}
