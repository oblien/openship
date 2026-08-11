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
 *   1. Add a `CATEGORIES` entry with id + label + description
 *   2. Add the matching audit eventType(s) to `EVENT_TYPE_TO_CATEGORY`
 *   3. The Settings UI picks it up automatically
 *
 * Categories live in code (not the DB) so they're refactor-safe and
 * the Settings UI can render labels + descriptions without round-trips.
 */

export interface NotificationCategory {
  /** Stable id stored in subscription/default rows. snake_dot.case. */
  id: string;
  /** Display label for the Settings UI row. */
  label: string;
  /** One-line explanation under the toggle. */
  description: string;
  /** Default enabled state when a brand-new user joins an org. */
  defaultEnabled: boolean;
}

export const CATEGORIES: readonly NotificationCategory[] = [
  // ── Deployment ─────────────────────────────────────────────────────────────
  {
    id: "deploy.failed",
    label: "Deploy failed",
    description:
      "A build or deploy errored out. We send the error message + a snippet of the failing logs.",
    defaultEnabled: true,
  },
  {
    id: "deploy.succeeded",
    label: "Deploy succeeded",
    description:
      "Every successful production deploy. Off by default — most teams find it noisy.",
    defaultEnabled: false,
  },
  {
    id: "deploy.cancelled",
    label: "Deploy cancelled",
    description: "An in-flight deploy was cancelled by you or another member.",
    defaultEnabled: false,
  },

  // ── Backups ────────────────────────────────────────────────────────────────
  {
    id: "backup.failed",
    label: "Backup failed",
    description:
      "A scheduled or manual backup run errored out. Includes the destination + policy that failed.",
    defaultEnabled: true,
  },
  {
    id: "backup.succeeded",
    label: "Backup succeeded",
    description: "Each successful backup. Off by default — high volume.",
    defaultEnabled: false,
  },
  {
    id: "backup.restore_completed",
    label: "Restore completed",
    description: "A restore finished (or failed). Always worth notifying on.",
    defaultEnabled: true,
  },

  // ── Jobs ─────────────────────────────────────────────────────────────────
  {
    id: "job.run.failed",
    label: "Job failed",
    description: "A scheduled or manual job run errored out. Includes the job + exit code.",
    defaultEnabled: true,
  },
  {
    id: "job.run.succeeded",
    label: "Job succeeded",
    description: "Each successful job run. Off by default — can be high volume.",
    defaultEnabled: false,
  },
  {
    id: "job.run.started",
    label: "Job started",
    description: "A job began running. Off by default — mostly useful per-job.",
    defaultEnabled: false,
  },

  // ── Domains / SSL ──────────────────────────────────────────────────────────
  {
    id: "domain.expiring",
    label: "SSL cert expiring",
    description:
      "Daily check — fires when any of your custom domain certs has under 7 days left and the renewer can't reach the host.",
    defaultEnabled: true,
  },
  {
    id: "domain.verification_failed",
    label: "Domain verification failed",
    description: "DNS check didn't pass during initial domain setup.",
    defaultEnabled: true,
  },

  // ── Org membership ─────────────────────────────────────────────────────────
  {
    id: "member.added",
    label: "New member joined",
    description: "Someone accepted an invite and joined this organization.",
    defaultEnabled: false,
  },
  {
    id: "member.removed",
    label: "Member removed",
    description: "A member was removed from the organization.",
    defaultEnabled: false,
  },
  {
    id: "invitation.sent",
    label: "Invitations sent",
    description:
      "An admin sent invite(s) to new members. Useful as a security signal.",
    defaultEnabled: false,
  },

  // ── Billing (placeholder for future cloud) ─────────────────────────────────
  {
    id: "billing.alert",
    label: "Billing alert",
    description:
      "Payment failed, plan limit reached, or invoice overdue. Always notifies billing-owners.",
    defaultEnabled: true,
  },
  {
    id: "quota.warning",
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

export function findCategory(id: string): NotificationCategory | undefined {
  return CATEGORIES.find((c) => c.id === id);
}
