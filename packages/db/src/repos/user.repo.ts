import { eq, and, asc, ilike, count, desc, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { user } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * User repository - all user-related database operations.
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

    /**
     * Batch-fetch users by id. Used to enrich list responses (e.g. audit
     * log rows) with actor name/email without an N+1 — one query per
     * request, regardless of row count. Empty input short-circuits.
     */
    async findManyByIds(ids: string[]): Promise<User[]> {
      if (ids.length === 0) return [];
      return db.query.user.findMany({
        where: inArray(user.id, ids),
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

    /**
     * The founding admin — the earliest REAL (non-auto-provisioned) account.
     *
     * One definition because it is an IDENTITY, not a convenience lookup: it decides which
     * org owns this box (and therefore who may run code on the host), where the
     * control-plane app is registered, and whose credentials the setup reset rewrites.
     * Five call sites spelled the same select/where/order by hand, so a change to what
     * "founding" means could have landed on some of them.
     *
     * Ordered by id after createdAt: `createdAt` alone is not a total order, and two
     * accounts created in the same millisecond — a scripted bootstrap does exactly that —
     * would otherwise let the database's row order pick the box owner.
     *
     * `undefined` before onboarding: an auto-provisioned local/desktop user is not an
     * admin, so a zero-auth box legitimately has no founder.
     */
    async findFoundingAdmin(): Promise<User | undefined> {
      return db.query.user.findFirst({
        where: eq(user.autoProvisioned, false),
        orderBy: [asc(user.createdAt), asc(user.id)],
      });
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
