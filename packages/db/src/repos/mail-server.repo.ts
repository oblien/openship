import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { mailServers } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MailServer = typeof mailServers.$inferSelect;
export type NewMailServer = typeof mailServers.$inferInsert;

/**
 * The one shape a mail base domain is stored and looked up by. `findByDomain`
 * normalizes its argument, so the write side MUST apply the identical transform
 * or a `Mail.Example.com ` install would never be found by its own SSL resolver.
 */
function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

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
     * The mail server that owns a base domain — the reverse of the `mail.<domain>`
     * convention the wizard builds hostnames with.
     *
     * This is how a mail-owned `domain` row (ownerType='mail') finds its server: the
     * row carries no owner FK, because `mail.<base>` already determines the server
     * and this record is the canonical base-domain → server mapping. Used by the SSL
     * resolver so the renewal sweep can reach the right box.
     */
    async findByDomain(domain: string): Promise<MailServer | undefined> {
      return db.query.mailServers.findFirst({
        where: eq(mailServers.domain, normalizeDomain(domain)),
      });
    },

    /**
     * Insert-or-update - used both on install start (no `installedAt` yet)
     * and on `markInstalled`. Returning the row keeps callers from doing a
     * second lookup.
     */
    async upsert(data: NewMailServer): Promise<MailServer> {
      const domain = normalizeDomain(data.domain);
      const [row] = await db
        .insert(mailServers)
        .values({ ...data, domain })
        .onConflictDoUpdate({
          target: mailServers.serverId,
          set: {
            domain,
            installedAt: data.installedAt,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    /** Stamp `installed_at` once the wizard completes successfully. */
    async markInstalled(serverId: string, domain: string): Promise<MailServer> {
      const normalized = normalizeDomain(domain);
      const [row] = await db
        .insert(mailServers)
        .values({ serverId, domain: normalized, installedAt: new Date() })
        .onConflictDoUpdate({
          target: mailServers.serverId,
          set: {
            domain: normalized,
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
