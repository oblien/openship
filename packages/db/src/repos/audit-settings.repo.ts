/**
 * Audit settings repo — per-org recording switch + retention.
 *
 * `isEnabled` is on the hot path: every audited mutation calls it before the
 * insert, so it's memoized behind a short TTL. Stale-by-up-to-30s is fine for a
 * preference (a just-disabled org may record a few more rows), and `upsert`
 * invalidates the entry so a toggle in the UI reads back immediately.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { auditSettings } from "../schema/audit-settings";

export type AuditSettings = typeof auditSettings.$inferSelect;
export type NewAuditSettings = typeof auditSettings.$inferInsert;

/** Shape returned when an org has no row yet — recording on, 90-day retention. */
export interface AuditSettingsView {
  enabled: boolean;
  retentionDays: number;
}

export const AUDIT_SETTINGS_DEFAULTS: AuditSettingsView = { enabled: true, retentionDays: 90 };

const ENABLED_TTL_MS = 30_000;

export function createAuditSettingsRepo(db: Database) {
  const enabledCache = new Map<string, { value: boolean; expires: number }>();

  return {
    /**
     * The stored row, or undefined when the org has never touched these
     * settings. `get` can't answer that — it folds "no row" into the defaults —
     * and the retention prune needs the distinction to know whether the legacy
     * organization.metadata.auditRetentionDays still applies.
     */
    async find(organizationId: string): Promise<AuditSettings | undefined> {
      return db.query.auditSettings.findFirst({
        where: eq(auditSettings.organizationId, organizationId),
      });
    },

    async get(organizationId: string): Promise<AuditSettingsView> {
      const row = await db.query.auditSettings.findFirst({
        where: eq(auditSettings.organizationId, organizationId),
      });
      if (!row) return { ...AUDIT_SETTINGS_DEFAULTS };
      return { enabled: row.enabled, retentionDays: row.retentionDays };
    },

    async upsert(
      organizationId: string,
      patch: Partial<Pick<AuditSettings, "enabled" | "retentionDays">>,
    ): Promise<AuditSettingsView> {
      const [row] = await db
        .insert(auditSettings)
        .values({ organizationId, ...patch })
        .onConflictDoUpdate({
          target: auditSettings.organizationId,
          set: { ...patch, updatedAt: new Date() },
        })
        .returning();
      enabledCache.delete(organizationId);
      return { enabled: row.enabled, retentionDays: row.retentionDays };
    },

    /**
     * Is recording on for this org? Defaults to true (including when the lookup
     * itself fails): losing the audit trail because a settings read errored is
     * the worse failure of the two.
     */
    async isEnabled(organizationId: string): Promise<boolean> {
      const hit = enabledCache.get(organizationId);
      const now = Date.now();
      if (hit && hit.expires > now) return hit.value;
      let value = true;
      try {
        const row = await db.query.auditSettings.findFirst({
          where: eq(auditSettings.organizationId, organizationId),
          columns: { enabled: true },
        });
        value = row?.enabled ?? true;
      } catch {
        return true; // don't cache a failure
      }
      enabledCache.set(organizationId, { value, expires: now + ENABLED_TTL_MS });
      return value;
    },

    /** Drop the memo for an org (called after a write from another process/path). */
    invalidate(organizationId: string): void {
      enabledCache.delete(organizationId);
    },
  };
}
