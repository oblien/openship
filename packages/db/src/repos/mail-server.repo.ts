import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { mailServers } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MailServer = typeof mailServers.$inferSelect;
export type NewMailServer = typeof mailServers.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * Mail-server install records.
 *
 * Owned by the mail-setup pipeline:
 *   - `upsert` on install start (so /emails can pre-select the in-progress
 *     server even while the wizard is mid-stream).
 *   - `markInstalled` flips `installed_at` when the wizard completes.
 *   - `remove` on uninstall / reset.
 *
 * Read by the /emails dashboard via `list()` to short-circuit the picker
 * when there's exactly one mail server.
 */
export function createMailServerRepo(db: Database) {
  return {
    /** Every mail-server record, ordered oldest-first for deterministic UI. */
    async list(): Promise<MailServer[]> {
      return db.query.mailServers.findMany({
        orderBy: (m, { asc }) => [asc(m.createdAt)],
      });
    },

    /** Single record by server id. */
    async get(serverId: string): Promise<MailServer | undefined> {
      return db.query.mailServers.findFirst({
        where: eq(mailServers.serverId, serverId),
      });
    },

    /**
     * Insert-or-update - used both on install start (no `installedAt` yet)
     * and on `markInstalled`. Returning the row keeps callers from doing a
     * second lookup.
     */
    async upsert(data: NewMailServer): Promise<MailServer> {
      const [row] = await db
        .insert(mailServers)
        .values(data)
        .onConflictDoUpdate({
          target: mailServers.serverId,
          set: {
            domain: data.domain,
            installedAt: data.installedAt,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    /** Stamp `installed_at` once the wizard completes successfully. */
    async markInstalled(serverId: string, domain: string): Promise<MailServer> {
      const [row] = await db
        .insert(mailServers)
        .values({ serverId, domain, installedAt: new Date() })
        .onConflictDoUpdate({
          target: mailServers.serverId,
          set: {
            domain,
            installedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    /** Drop the record on uninstall / reset. */
    async remove(serverId: string): Promise<void> {
      await db.delete(mailServers).where(eq(mailServers.serverId, serverId));
    },
  };
}
