import { and, asc, eq, gt } from "drizzle-orm";
import type { Database } from "../factory";
import { managementBilling } from "../schema/management-billing";

type State = typeof managementBilling.$inferInsert;
export function createManagementBillingRepo(db: Database) {
  return {
    async listReady(after?: string, limit = 50) {
      return db
        .select()
        .from(managementBilling)
        .where(
          and(
            eq(managementBilling.namespaceReady, true),
            after ? gt(managementBilling.organizationId, after) : undefined,
          ),
        )
        .orderBy(asc(managementBilling.organizationId))
        .limit(limit);
    },
    async get(organizationId: string) {
      return (
        await db
          .select()
          .from(managementBilling)
          .where(eq(managementBilling.organizationId, organizationId))
          .limit(1)
      )[0];
    },
    async byNamespace(namespace: string) {
      return (
        await db
          .select()
          .from(managementBilling)
          .where(eq(managementBilling.namespace, namespace))
          .limit(1)
      )[0];
    },
    async ensure(organizationId: string, namespace: string) {
      await db
        .insert(managementBilling)
        .values({ organizationId, namespace })
        .onConflictDoNothing();
    },
    async update(
      organizationId: string,
      patch: Partial<
        Pick<
          State,
          "checkout" | "change" | "verified" | "checkedAt" | "namespaceReady" | "cloudCoveredUntil"
        >
      >,
    ) {
      await db
        .update(managementBilling)
        .set(patch)
        .where(eq(managementBilling.organizationId, organizationId));
    },
  };
}
