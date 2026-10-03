import { and, count, desc, eq, isNull, lt } from "drizzle-orm";
import type { Database } from "../client";
import { terminalSessions } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TerminalSession = typeof terminalSessions.$inferSelect;
export type NewTerminalSession = typeof terminalSessions.$inferInsert;

export type TerminalExitReason =
  | "client_close"
  | "remote_exit"
  | "idle_timeout"
  | "session_cap"
  | "max_sessions"
  | "server_error";

// ─── Repository ──────────────────────────────────────────────────────────────

export function createTerminalSessionRepo(db: Database) {
  return {
    /**
     * Open a new audit row at session handshake. Returns the new row's id
     * so the caller can finalize it on close.
     */
    async open(data: {
      userId: string;
      serverId: string;
      clientIp?: string | null;
      userAgent?: string | null;
    }): Promise<{ id: string }> {
      const [row] = await db
        .insert(terminalSessions)
        .values({
          userId: data.userId,
          serverId: data.serverId,
          clientIp: data.clientIp ?? null,
          userAgent: data.userAgent ?? null,
        })
        .returning();
      return { id: row.id };
    },

    /**
     * Finalize a session row. Idempotent at the DB level (we just stamp
     * endedAt + exitReason); the session manager guards against double
     * close so this is only ever called once in practice.
     */
    async close(
      id: string,
      data: { exitCode?: number | null; exitReason: TerminalExitReason },
    ): Promise<void> {
      await db
        .update(terminalSessions)
        .set({
          endedAt: new Date(),
          exitCode: data.exitCode ?? null,
          exitReason: data.exitReason,
        })
        .where(and(eq(terminalSessions.id, id), isNull(terminalSessions.endedAt)));
    },

    /**
     * How many sessions does this user currently have open across all
     * servers? Used by the handshake to enforce the per-user concurrent
     * cap (default 3) before we burn an SSH channel.
     */
    async countActiveByUser(userId: string): Promise<number> {
      const [row] = await db
        .select({ count: count() })
        .from(terminalSessions)
        .where(
          and(eq(terminalSessions.userId, userId), isNull(terminalSessions.endedAt)),
        );
      return Number(row?.count ?? 0);
    },

    /** A Cloud replica may restart while another still owns live sessions.
     * Only expire rows older than the enforced maximum session lifetime. */
    async closeExpiredForUser(userId: string, startedBefore: Date): Promise<void> {
      await db.update(terminalSessions)
        .set({ endedAt: new Date(), exitReason: "session_cap" })
        .where(and(eq(terminalSessions.userId, userId), isNull(terminalSessions.endedAt), lt(terminalSessions.startedAt, startedBefore)));
    },

    /**
     * Boot-time sweep: any session row that was open when the API
     * crashed/restarted is finalized with reason='server_error'. The
     * underlying ssh2 channels died with the process anyway, so the rows
     * are accurate after this.
     */
    async closeAllActive(reason: TerminalExitReason = "server_error"): Promise<number> {
      const updated = await db
        .update(terminalSessions)
        .set({ endedAt: new Date(), exitReason: reason })
        .where(isNull(terminalSessions.endedAt))
        .returning();
      return updated.length;
    },

    /**
     * Recent sessions for a user / server (for an admin viewer that
     * doesn't exist yet but is the obvious next consumer).
     */
    async listRecent(opts: {
      userId?: string;
      serverId?: string;
      limit?: number;
    }): Promise<TerminalSession[]> {
      const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
      const where = [
        opts.userId ? eq(terminalSessions.userId, opts.userId) : undefined,
        opts.serverId ? eq(terminalSessions.serverId, opts.serverId) : undefined,
      ].filter(Boolean);
      return db.query.terminalSessions.findMany({
        where: where.length ? and(...(where as any[])) : undefined,
        orderBy: [desc(terminalSessions.startedAt)],
        limit,
      });
    },
  };
}
