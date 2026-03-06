import { eq, and, ilike, count, desc, sql } from "drizzle-orm";
import type { Database } from "../client";
import { user } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * User repository — all user-related database operations.
 *
 * Takes a `Database` instance so it works with any driver (pg or PGlite)
 * and can be tested with a transaction-wrapped DB.
 */
export function createUserRepo(db: Database) {
  return {
    /** Find user by ID */
    async findById(id: string): Promise<User | undefined> {
      return db.query.user.findFirst({
        where: eq(user.id, id),
      });
    },

    /** Find user by email (case-insensitive) */
    async findByEmail(email: string): Promise<User | undefined> {
      return db.query.user.findFirst({
        where: ilike(user.email, email),
      });
    },

    /** List users with pagination */
    async list(opts: { limit?: number; offset?: number; role?: string } = {}) {
      const { limit = 50, offset = 0, role } = opts;
      const where = role ? eq(user.role, role) : undefined;

      const [rows, [total]] = await Promise.all([
        db.query.user.findMany({
          where,
          limit,
          offset,
          orderBy: desc(user.createdAt),
        }),
        db.select({ count: count() }).from(user).where(where),
      ]);

      return { rows, total: total?.count ?? 0 };
    },

    /** Update user fields by ID */
    async update(id: string, data: Partial<Omit<NewUser, "id">>) {
      const [updated] = await db
        .update(user)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(user.id, id))
        .returning();
      return updated;
    },

    /** Delete user by ID (cascades sessions & accounts via FK) */
    async delete(id: string): Promise<boolean> {
      const result = await db.delete(user).where(eq(user.id, id)).returning();
      return result.length > 0;
    },

    /** Update user role */
    async setRole(id: string, role: string) {
      return db
        .update(user)
        .set({ role, updatedAt: new Date() })
        .where(eq(user.id, id))
        .returning();
    },

    /** Count users by role */
    async countByRole(role: string): Promise<number> {
      const [result] = await db
        .select({ count: count() })
        .from(user)
        .where(eq(user.role, role));
      return result?.count ?? 0;
    },

    /** Check if any user exists (useful for initial setup detection) */
    async hasAnyUser(): Promise<boolean> {
      const result = await db.query.user.findFirst({
        columns: { id: true },
      });
      return !!result;
    },
  };
}
