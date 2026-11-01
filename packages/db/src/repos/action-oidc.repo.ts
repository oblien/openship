import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { actionOidcKey } from "../schema/action-oidc";

export function createActionOidcRepo(db: Database) {
  return {
    async key(issuer: string) {
      return (
        await db.select().from(actionOidcKey).where(eq(actionOidcKey.id, issuer)).limit(1)
      )[0];
    },
    async ensureKey(value: typeof actionOidcKey.$inferInsert) {
      await db.insert(actionOidcKey).values(value).onConflictDoNothing();
      return (
        await db.select().from(actionOidcKey).where(eq(actionOidcKey.id, value.id)).limit(1)
      )[0]!;
    },
  };
}
