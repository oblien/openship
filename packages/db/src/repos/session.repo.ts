import { eq, and, lt, desc, count, sql } from "drizzle-orm";
import type { Database } from "../client";
import { session, user } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Session = typeof session.$inferSelect;

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * Session repository — query and manage auth sessions.
 *
 * Note: Better Auth handles session lifecycle (create, validate, refresh, revoke).
 * This repo is for admin operations: listing, bulk cleanup, analytics, etc.
 */
export function createSessionRepo(db: Database) {
  return {
    /** Find session by ID */
    async findById(id: string): Promise<Session | undefined> {
      return db.query.session.findFirst({
        where: eq(session.id, id),
      });
    },

    /** Find session by token */
    async findByToken(token: string): Promise<Session | undefined> {
      return db.query.session.findFirst({
        where: eq(session.token, token),
      });
    },

    /** List active sessions for a user */
    async listByUser(userId: string) {
      return db.query.session.findMany({
        where: eq(session.userId, userId),
        orderBy: desc(session.createdAt),
      });
    },

    /** Count active sessions for a user */
    async countByUser(userId: string): Promise<number> {
      const [result] = await db
        .select({ count: count() })
        .from(session)
        .where(eq(session.userId, userId));
      return result?.count ?? 0;
    },

    /** Delete all sessions for a user (force logout everywhere) */
    async revokeAllForUser(userId: string): Promise<number> {
      const result = await db
        .delete(session)
        .where(eq(session.userId, userId))
        .returning();
      return result.length;
    },

    /** Delete expired sessions (cleanup job) */
    async purgeExpired(): Promise<number> {
      const result = await db
        .delete(session)
        .where(lt(session.expiresAt, new Date()))
        .returning();
      return result.length;
    },

    /** Session with user info (join) */
    async findWithUser(sessionId: string) {
      const rows = await db
        .select({
          session: session,
          user: user,
        })
        .from(session)
        .innerJoin(user, eq(session.userId, user.id))
        .where(eq(session.id, sessionId))
        .limit(1);
      return rows[0];
    },
  };
}
