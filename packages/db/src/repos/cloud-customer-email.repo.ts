import { and, eq, lte, asc, sql } from "drizzle-orm";
import type { Database } from "../connection";
import { cloudCustomerEmail as mail } from "../schema/cloud-customer-email";
import { user } from "../schema/auth";
import { member } from "../schema/organization";

export type CustomerEmail = typeof mail.$inferSelect;
export type CustomerEmailInput = Pick<CustomerEmail, "id" | "kind" | "userId" | "organizationId"> &
  Partial<Pick<CustomerEmail, "payment">>;
export type { CustomerPaymentEmail } from "../schema/cloud-customer-email";

export function createCloudCustomerEmailRepo(db: Database) {
  return {
    async enqueue(input: CustomerEmailInput) {
      await db.insert(mail).values(input).onConflictDoNothing();
    },
    async recipient(userId: string, organizationId: string) {
      return (
        await db
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            verified: user.emailVerified,
            autoProvisioned: user.autoProvisioned,
            role: member.role,
          })
          .from(user)
          .innerJoin(
            member,
            and(eq(member.userId, user.id), eq(member.organizationId, organizationId)),
          )
          .where(eq(user.id, userId))
          .limit(1)
      )[0];
    },
    /** Claim one at a time so a batch waiting on SMTP never outlives its lease.
     * Unverified signups stay queued without spending delivery attempts. */
    async claim(leaseId: string, now: Date) {
      return db.transaction(async (tx) => {
        const [due] = await tx
          .select({ id: mail.id })
          .from(mail)
          .where(
            and(
              eq(mail.status, "pending"),
              lte(mail.nextAttemptAt, now),
              sql`EXISTS (SELECT 1 FROM "user" WHERE "user".id = ${mail.userId} AND "user".email_verified = true)`,
            ),
          )
          .orderBy(
            asc(mail.nextAttemptAt),
            sql`CASE ${mail.kind} WHEN 'signup' THEN 0 WHEN 'purchase' THEN 1 ELSE 2 END`,
            asc(mail.id),
          )
          .limit(1)
          .for("update", { skipLocked: true });
        if (!due) return null;
        return (
          await tx
            .update(mail)
            .set({
              leaseId,
              attempts: sql`${mail.attempts} + 1`,
              nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
            })
            .where(eq(mail.id, due.id))
            .returning()
        )[0]!;
      });
    },
    async finish(id: string, leaseId: string, status: "sent" | "canceled", now: Date) {
      await db
        .update(mail)
        .set({
          status,
          leaseId: null,
          nextAttemptAt: null,
          lastError: null,
          deliveredAt: status === "sent" ? now : null,
        })
        .where(and(eq(mail.id, id), eq(mail.leaseId, leaseId)));
    },
    async deferVerification(id: string, leaseId: string, now: Date) {
      await db
        .update(mail)
        .set({
          leaseId: null,
          nextAttemptAt: new Date(now.getTime() + 60_000),
          attempts: sql`GREATEST(${mail.attempts} - 1, 0)`,
          lastError: null,
        })
        .where(and(eq(mail.id, id), eq(mail.leaseId, leaseId)));
    },
    async failed(id: string, leaseId: string, nextAttemptAt: Date | null) {
      await db
        .update(mail)
        .set({
          status: nextAttemptAt ? "pending" : "failed",
          leaseId: null,
          nextAttemptAt,
          lastError: "Customer email delivery failed",
        })
        .where(and(eq(mail.id, id), eq(mail.leaseId, leaseId)));
    },
  };
}
export type CloudCustomerEmailRepo = ReturnType<typeof createCloudCustomerEmailRepo>;
