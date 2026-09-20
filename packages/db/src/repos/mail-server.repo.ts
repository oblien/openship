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
 *
 * `webmail_project_id` is owned by the webmail install instead, so both
 * `upsert` and `markInstalled` deliberately leave it out of their conflict
 * `set` — a re-run of the mail wizard must not unlink a live webmail.
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
            // A completed install has no step to resume from. The halt(null) on
            // success already clears this; nulling it here too keeps the row
            // honest even if markInstalled is reached by another path.
            resumeStep: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    /**
     * Mirror the wizard's paused step onto the row (null once complete / not
     * halted). Update-only, like `setWebmailProject`: a missing row means the
     * install never started, so there's nothing to annotate — no-op, never an
     * upsert (that would fabricate a row with no `domain`).
     */
    async setResumeStep(serverId: string, step: number | null): Promise<void> {
      await db
        .update(mailServers)
        .set({ resumeStep: step, updatedAt: new Date() })
        .where(eq(mailServers.serverId, serverId));
    },

    /** The mail server whose webmail is this project — the reverse of the link
     *  below. Used by the deploy-success and teardown hooks, which only ever
     *  hold the project. */
    async findByWebmailProject(projectId: string): Promise<MailServer | undefined> {
      return db.query.mailServers.findFirst({
        where: eq(mailServers.webmailProjectId, projectId),
      });
    },

    /**
     * Point a mail server at the webmail project serving it (null unlinks).
     *
     * Never an upsert: the link is meaningless without an install record, and
     * inserting one here would fabricate a mail server with no `domain`. A
     * missing row is a no-op — the webmail project still deploys, it just isn't
     * offered from /emails.
     */
    async setWebmailProject(serverId: string, projectId: string | null): Promise<void> {
      await db
        .update(mailServers)
        .set({ webmailProjectId: projectId, updatedAt: new Date() })
        .where(eq(mailServers.serverId, serverId));
    },

    /** Drop the record on uninstall / reset. */
    async remove(serverId: string): Promise<void> {
      await db.delete(mailServers).where(eq(mailServers.serverId, serverId));
    },
  };
}
