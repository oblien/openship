import { eq, and, count } from "drizzle-orm";
import type { Database } from "../client";
import { account, user } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Account = typeof account.$inferSelect;

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * Account repository — OAuth account links.
 *
 * Better Auth manages account CRUD during OAuth flows.
 * This repo is for admin queries: listing linked providers, unlinking, etc.
 */
export function createAccountRepo(db: Database) {
  return {
    /** List all linked accounts for a user */
    async listByUser(userId: string) {
      return db.query.account.findMany({
        where: eq(account.userId, userId),
      });
    },

    /** Find a specific provider link for a user */
    async findByProvider(userId: string, providerId: string) {
      return db.query.account.findFirst({
        where: and(
          eq(account.userId, userId),
          eq(account.providerId, providerId)
        ),
      });
    },

    /** Check if user has a password (email+password account) */
    async hasPassword(userId: string): Promise<boolean> {
      const cred = await db.query.account.findFirst({
        where: and(
          eq(account.userId, userId),
          eq(account.providerId, "credential")
        ),
        columns: { id: true },
      });
      return !!cred;
    },

    /** Count linked providers for a user */
    async countProviders(userId: string): Promise<number> {
      const [result] = await db
        .select({ count: count() })
        .from(account)
        .where(eq(account.userId, userId));
      return result?.count ?? 0;
    },

    /** Unlink an OAuth provider (admin action) */
    async unlinkProvider(userId: string, providerId: string): Promise<boolean> {
      const result = await db
        .delete(account)
        .where(
          and(
            eq(account.userId, userId),
            eq(account.providerId, providerId)
          )
        )
        .returning();
      return result.length > 0;
    },

    /** Account with user info (join) */
    async findWithUser(accountId: string) {
      const rows = await db
        .select({ account: account, user: user })
        .from(account)
        .innerJoin(user, eq(account.userId, user.id))
        .where(eq(account.id, accountId))
        .limit(1);
      return rows[0];
    },

    /** Find account by provider + provider account ID (e.g. GitHub user id) */
    async findByProviderAccountId(providerId: string, providerAccountId: string) {
      return db.query.account.findFirst({
        where: and(
          eq(account.providerId, providerId),
          eq(account.accountId, providerAccountId),
        ),
      });
    },
  };
}
