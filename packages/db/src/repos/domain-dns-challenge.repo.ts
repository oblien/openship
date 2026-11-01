import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { acmeAccount, domain, domainDnsChallenge as challenge } from "../schema";

export type DomainDnsChallenge = typeof challenge.$inferSelect;
type Patch = Partial<
  Pick<
    DomainDnsChallenge,
    "status" | "recordName" | "recordValue" | "accountId" | "orderEnc" | "expiresAt" | "error"
  >
>;
const running = ["preparing", "checking", "installing", "cancelling"] as const;
const terminal = ["completed", "failed", "cancelled", "expired"] as const;
const leaseUntil = () => new Date(Date.now() + 120_000);

export function createDomainDnsChallengeRepo(db: Database) {
  const find = (domainId: string) =>
    db.query.domainDnsChallenge.findFirst({ where: eq(challenge.domainId, domainId) });
  return {
    find,
    async account(organizationId: string, directoryUrl: string, keyEnc: string) {
      await db
        .insert(acmeAccount)
        .values({ id: generateId("acme"), organizationId, directoryUrl, keyEnc })
        .onConflictDoNothing({ target: [acmeAccount.organizationId, acmeAccount.directoryUrl] });
      return (await db.query.acmeAccount.findFirst({
        where: and(
          eq(acmeAccount.organizationId, organizationId),
          eq(acmeAccount.directoryUrl, directoryUrl),
        ),
      }))!;
    },
    accountById(organizationId: string, id: string) {
      return db.query.acmeAccount.findFirst({
        where: and(eq(acmeAccount.organizationId, organizationId), eq(acmeAccount.id, id)),
      });
    },
    async expire(domainId: string) {
      const now = new Date();
      // A stopped controller may have finished ACME issuance before installing
      // the certificate. Keep that order/key so a new worker can resume it.
      const resumable = sql`${challenge.mode} = 'manual' and ${challenge.orderEnc} is not null and ${challenge.expiresAt} > ${now} and ${challenge.status} != 'cancelling'`;
      await db
        .update(challenge)
        .set({
          status: sql`case when ${challenge.status} = 'cancelling' then 'cancelled' when ${challenge.expiresAt} <= ${now} then 'expired' when ${resumable} then 'waiting' else 'failed' end`,
          error: sql`case when ${challenge.status} = 'cancelling' then null when ${challenge.expiresAt} <= ${now} then 'The TXT challenge expired. Start again to get a new record.' when ${resumable} then 'The certificate operation was interrupted. Check the same TXT record again to resume.' else 'The certificate operation was interrupted. Start again to resume setup.' end`,
          orderEnc: sql`case when ${resumable} then ${challenge.orderEnc} else null end`,
          leaseId: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(challenge.domainId, domainId),
            or(
              and(eq(challenge.status, "waiting"), lt(challenge.expiresAt, now)),
              and(inArray(challenge.status, [...running]), lt(challenge.leaseExpiresAt, now)),
            ),
          ),
        );
    },
    async begin(domainId: string, mode: "automatic" | "manual") {
      return db.transaction(async (tx) => {
        const now = new Date();
        const input = {
          domainId,
          id: generateId("dns"),
          mode,
          status: "preparing" as const,
          leaseId: generateId("lease"),
          leaseExpiresAt: leaseUntil(),
          expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
          createdAt: now,
          updatedAt: now,
          recordName: null,
          recordValue: null,
          accountId: null,
          orderEnc: null,
          error: null,
          logs: "",
        };
        const [claimed] = await tx
          .insert(challenge)
          .values(input)
          .onConflictDoUpdate({
            target: challenge.domainId,
            set: input,
            setWhere: inArray(challenge.status, [...terminal]),
          })
          .returning();
        if (claimed) {
          await tx
            .update(domain)
            .set({ sslChallenge: "dns-01", sslDnsMode: mode, updatedAt: now })
            .where(eq(domain.id, domainId));
        }
        const row =
          claimed ??
          (await tx.query.domainDnsChallenge.findFirst({
            where: eq(challenge.domainId, domainId),
          }));
        return { row: row!, claimed: !!claimed };
      });
    },
    async claimCheck(domainId: string, id: string) {
      const [row] = await db
        .update(challenge)
        .set({
          status: "checking",
          leaseId: generateId("lease"),
          leaseExpiresAt: leaseUntil(),
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(challenge.domainId, domainId),
            eq(challenge.id, id),
            eq(challenge.status, "waiting"),
            sql`${challenge.expiresAt} > now()`,
          ),
        )
        .returning();
      return row;
    },
    async heartbeat(domainId: string, leaseId: string) {
      const [row] = await db
        .update(challenge)
        .set({ leaseExpiresAt: leaseUntil() })
        .where(
          and(
            eq(challenge.domainId, domainId),
            eq(challenge.leaseId, leaseId),
            sql`${challenge.leaseExpiresAt} > now()`,
            inArray(challenge.status, [...running]),
          ),
        )
        .returning();
      return row;
    },
    async updateOwned(domainId: string, leaseId: string, patch: Patch, release = false) {
      const [row] = await db
        .update(challenge)
        .set({
          ...patch,
          updatedAt: new Date(),
          ...(release ? { leaseId: null, leaseExpiresAt: null } : {}),
          ...(patch.status && terminal.includes(patch.status as (typeof terminal)[number])
            ? { orderEnc: null }
            : {}),
        })
        .where(
          and(
            eq(challenge.domainId, domainId),
            eq(challenge.leaseId, leaseId),
            sql`${challenge.leaseExpiresAt} > now()`,
            // A late preparation cannot revive an order the operator cancelled.
            patch.status === "cancelled" ? undefined : sql`${challenge.status} != 'cancelling'`,
          ),
        )
        .returning();
      return row;
    },
    async log(domainId: string, leaseId: string, message: string) {
      await db
        .update(challenge)
        .set({
          logs: sql`right(${challenge.logs} || ${message.slice(-4000) + "\n"}, 16000)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(challenge.domainId, domainId),
            eq(challenge.leaseId, leaseId),
            sql`${challenge.leaseExpiresAt} > now()`,
          ),
        );
    },
    async cancel(domainId: string, id: string) {
      const [row] = await db
        .update(challenge)
        .set({
          status: sql`case when ${challenge.status} = 'waiting' then 'cancelled' else 'cancelling' end`,
          orderEnc: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(challenge.domainId, domainId),
            eq(challenge.id, id),
            inArray(challenge.status, ["preparing", "waiting", "checking"]),
          ),
        )
        .returning();
      return row;
    },
  };
}
