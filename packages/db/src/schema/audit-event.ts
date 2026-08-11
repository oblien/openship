import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

/**
 * Audit events — append-only log of who-did-what within an organization.
 *
 * Captures three classes of events:
 *   - auth.*       login, logout, failed-login, password reset
 *   - member.*     invited, joined, role-changed, removed, left
 *   - deployment.* started, succeeded, failed, canceled, rolled-back
 *   - settings.*   updated (with before/after diff)
 *   - project.*    created, updated, deleted
 *   - server.*     added, removed, ssh-failed
 *   - domain.*     added, removed, ssl-renewed
 *   - backup.*     policy-created, run-succeeded, restore-initiated
 *
 * Retention is org-configurable via organization.metadata.auditRetentionDays
 * (default 90). A daily prune job deletes rows older than the per-org TTL.
 *
 * `before`/`after` carry a small JSON snapshot of relevant fields for
 * mutation events. Both are nullable — auth/lifecycle events don't have
 * a diff shape.
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Who performed the action. Null for system-emitted events
     *  (cron-triggered prunes, webhook-triggered deploys). */
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Dot-namespaced event taxonomy: "deployment.succeeded",
     *  "member.invited", "settings.updated", etc. */
    eventType: text("event_type").notNull(),
    /** Resource kind: "project", "deployment", "server", "settings",
     *  "member", "organization", etc. Null for org-level events with
     *  no specific resource. */
    resourceType: text("resource_type"),
    /** Resource primary key (matches resourceType's id column). */
    resourceId: text("resource_id"),
    /** Pre-mutation snapshot (mutation events only). */
    before: jsonb("before"),
    /** Post-mutation snapshot (mutation events only). */
    after: jsonb("after"),
    /** Source IP + UA for forensic queries. */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Primary access pattern: feed for an org, newest first.
    index("audit_event_org_created_idx").on(t.organizationId, t.createdAt),
    // Filter by event type within an org.
    index("audit_event_org_type_idx").on(t.organizationId, t.eventType),
    // Filter by actor within an org (per-user activity).
    index("audit_event_org_actor_idx").on(t.organizationId, t.actorUserId),
    // Filter by specific resource (per-resource activity tab).
    index("audit_event_resource_idx").on(t.resourceType, t.resourceId),
  ],
);
