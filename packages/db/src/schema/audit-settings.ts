import { pgTable, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organization";

/**
 * Per-organization audit recording settings.
 *
 * `enabled` is the kill switch: when false, repos.auditEvent.create() drops the
 * write. Existing rows stay, and the retention prune keeps running — the setting
 * governs new rows only.
 *
 * Per-org rather than instance-wide because a CLOUD_MODE instance holds many
 * orgs, and one tenant must not be able to switch off everybody's audit log.
 *
 * `retentionDays` supersedes organization.metadata.auditRetentionDays, which was
 * documented but had no writer (Better Auth owns organization writes).
 */
export const auditSettings = pgTable("audit_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** Default true — auditing is on unless an admin turns it off. */
  enabled: boolean("enabled").notNull().default(true),
  retentionDays: integer("retention_days").notNull().default(90),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
