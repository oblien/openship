import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../connection";
import { billingPlanGrant } from "../schema/billing-plan-grant";
import { organization, member } from "../schema/organization";
import { user } from "../schema/auth";
import { billingSubscription } from "../schema/billing";

export type BillingPlanGrant = typeof billingPlanGrant.$inferSelect;
export type NewBillingPlanGrant = typeof billingPlanGrant.$inferInsert;

export function createBillingPlanGrantRepo(db: Database) {
  return {
    async ownedOrganizations(email: string) {
      return db.select({
        userId: user.id, email: user.email,
        organizationId: organization.id, name: organization.name,
        namespace: organization.oblienNamespace, isTeam: organization.isTeam,
        tier: organization.planTierId,
      }).from(user)
        .innerJoin(member, and(eq(member.userId, user.id), eq(member.role, "owner")))
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(sql`lower(${user.email}) = lower(${email})`);
    },
    async current(organizationId: string): Promise<BillingPlanGrant | null> {
      const [row] = await db.select().from(billingPlanGrant)
        .where(and(eq(billingPlanGrant.organizationId, organizationId), isNull(billingPlanGrant.releasedAt))).limit(1);
      return row ?? null;
    },
    async latest(organizationId: string): Promise<BillingPlanGrant | null> {
      const [row] = await db.select().from(billingPlanGrant).where(eq(billingPlanGrant.organizationId, organizationId))
        .orderBy(desc(billingPlanGrant.createdAt)).limit(1);
      return row ?? null;
    },
    async hasLegacySubscription(organizationId: string): Promise<boolean> {
      const [row] = await db.select({ id: billingSubscription.id }).from(billingSubscription)
        .where(and(eq(billingSubscription.organizationId, organizationId),
          sql`${billingSubscription.status} IN ('active', 'trialing', 'past_due', 'unpaid', 'paused')`)).limit(1);
      return Boolean(row);
    },
    async create(input: NewBillingPlanGrant): Promise<BillingPlanGrant> {
      const [row] = await db.insert(billingPlanGrant).values(input).returning();
      return row!;
    },
    async markApplied(id: string, periodEnd: Date): Promise<void> {
      await db.update(billingPlanGrant).set({ appliedPeriodEnd: periodEnd }).where(eq(billingPlanGrant.id, id));
    },
    async revoke(id: string, operator: string, now: Date): Promise<void> {
      await db.update(billingPlanGrant).set({ revokedAt: now, revokedBy: operator, releaseReason: "revoked" })
        .where(and(eq(billingPlanGrant.id, id), isNull(billingPlanGrant.revokedAt)));
    },
    async release(id: string, reason: string, now: Date): Promise<void> {
      await db.update(billingPlanGrant).set({ releasedAt: now, releaseReason: reason }).where(eq(billingPlanGrant.id, id));
    },
    async mirror(organizationId: string, namespace: string, state: {
      planTierId: string; subscriptionStatus: string; currentPeriodStart: Date | null; currentPeriodEnd: Date | null;
    }): Promise<void> {
      const rows = await db.update(organization).set(state)
        .where(and(eq(organization.id, organizationId), eq(organization.oblienNamespace, namespace)))
        .returning();
      if (rows.length !== 1) throw new Error("Organization namespace changed while applying the plan grant");
    },
  };
}

export type BillingPlanGrantRepo = ReturnType<typeof createBillingPlanGrantRepo>;
