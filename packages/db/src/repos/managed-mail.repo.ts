import { and, eq, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  mailTenantAccess as access,
  managedMailService as services,
  managedMailHost as hosts,
  managedMailAccount as accounts,
} from "../schema";

class MailClaimConflict extends Error {}

export function createManagedMailRepo(db: Database) {
  return {
    async tenantAccess(tokenHash: string) {
      return (await db.select().from(access).where(eq(access.tokenHash, tokenHash)).limit(1))[0];
    },
    async bindTenantAccess(grant: typeof access.$inferInsert) {
      return db.transaction(async tx => {
        await tx.insert(access).values(grant).onConflictDoNothing();
        const [row] = await tx.update(access).set({ parentId: grant.parentId, tokenHash: grant.tokenHash })
          .where(and(eq(access.serverId, grant.serverId), eq(access.namespace, grant.namespace),
            eq(access.serviceId, grant.serviceId), eq(access.organizationId, grant.organizationId)))
          .returning();
        return !!row;
      });
    },
    async account(org: string) {
      return (await db.select().from(accounts).where(eq(accounts.organizationId, org)).limit(1))[0];
    },
    async billingOwner(namespace: string) {
      return (
        await db.select().from(accounts).where(eq(accounts.namespace, namespace)).limit(1)
      )[0];
    },
    async ensureAccount(org: string, namespace: string) {
      await db.insert(accounts).values({ organizationId: org, namespace }).onConflictDoNothing();
    },
    async updateAccount(
      org: string,
      data: Partial<
        Pick<
          typeof accounts.$inferInsert,
          "change" | "checkout" | "namespaceReady" | "sendingEnabled"
        >
      >,
    ) {
      await db.update(accounts).set(data).where(eq(accounts.organizationId, org));
    },
    async unfinishedChanges() {
      const pending = (column: typeof accounts.change | typeof services.change) =>
        sql`${column}->>'confirmationKey' IS NOT NULL AND ${column}->>'completed' IS DISTINCT FROM 'true'`;
      const [shared, dedicated] = await Promise.all([
        db
          .select({ organizationId: accounts.organizationId })
          .from(accounts)
          .where(pending(accounts.change)),
        db
          .select({ organizationId: services.organizationId, target: services.id })
          .from(services)
          .where(and(isNotNull(services.organizationId), pending(services.change))),
      ]);
      return [...shared.map((row) => ({ ...row, target: "account" })), ...dedicated];
    },
    async senders() {
      return db
        .select({ organizationId: accounts.organizationId })
        .from(accounts)
        .where(eq(accounts.sendingEnabled, true));
    },
    async forOrganization(organizationId: string) {
      const [row] = await db
        .select()
        .from(services)
        .where(and(eq(services.organizationId, organizationId), isNull(services.billingNamespace)))
        .limit(1);
      return row ?? null;
    },
    async discoverMailboxService(selector: { id: string } | { hostname: string }) {
      const [row] = await db.select().from(services).where(and(
        "id" in selector ? eq(services.id, selector.id) : eq(services.hostname, selector.hostname),
        isNotNull(services.organizationId),
        isNotNull(services.engine),
        eq(services.provisioning, false),
        or(isNull(services.orderState), eq(services.orderState, "funded")),
      )).limit(1);
      return row;
    },
    async service(org: string, id: string) {
      const [row] = await db
        .select()
        .from(services)
        .where(and(eq(services.organizationId, org), eq(services.id, id)));
      return row ?? null;
    },
    async orders(org: string) {
      return db
        .select()
        .from(services)
        .where(and(eq(services.organizationId, org), ne(services.orderState, "closed")))
        .orderBy(services.id);
    },
    async preparingOrders() {
      return db
        .select()
        .from(services)
        .where(
          and(
            eq(services.orderState, "funded"),
            eq(services.provisioning, true),
            isNotNull(services.cloudServerId),
            isNotNull(services.organizationId),
          ),
        );
    },
    async unprovisionedOrders() {
      return db
        .select()
        .from(services)
        .where(
          and(
            ne(services.orderState, "closed"),
            isNull(services.cloudServerId),
            isNotNull(services.organizationId),
          ),
        );
    },
    async orderByNamespace(namespace: string) {
      return (
        await db.select().from(services).where(eq(services.billingNamespace, namespace)).limit(1)
      )[0];
    },
    async createOrder(row: typeof services.$inferInsert) {
      return (await db.insert(services).values(row).returning())[0]!;
    },
    async updateOrder(
      org: string,
      id: string,
      data: Partial<
        Pick<
          typeof services.$inferInsert,
          "change" | "checkoutId" | "orderState" | "cloudServerId" | "order"
        >
      >,
    ) {
      await db
        .update(services)
        .set(data)
        .where(
          and(
            eq(services.organizationId, org),
            eq(services.id, id),
            isNotNull(services.billingNamespace),
          ),
        );
    },
    async cancelVmRequest(organizationId: string, id: string) {
      const [row] = await db
        .delete(services)
        .where(
          and(
            eq(services.id, id),
            eq(services.organizationId, organizationId),
            isNull(services.engine),
          ),
        )
        .returning();
      return !!row;
    },
    async pendingVm(cloudServerId: string) {
      const [row] = await db
        .select()
        .from(services)
        .where(and(eq(services.cloudServerId, cloudServerId), eq(services.provisioning, true)))
        .limit(1);
      return row;
    },
    async attachVm(id: string, organizationId: string, engine: string, hostname: string) {
      try {
        return await db.transaction(async (tx) => {
          const [host] = await tx
            .insert(hosts)
            .values({ engine, hostname, shared: false })
            .onConflictDoNothing()
            .returning();
          if (!host) return false;
          const [row] = await tx
            .update(services)
            .set({ engine, hostname })
            .where(
              and(
                eq(services.id, id),
                eq(services.organizationId, organizationId),
                isNull(services.engine),
              ),
            )
            .returning();
          if (!row) throw new MailClaimConflict();
          return true;
        });
      } catch (error) {
        if (error instanceof MailClaimConflict) return false;
        throw error;
      }
    },
    async finishProvisioning(id: string, organizationId: string) {
      await db
        .update(services)
        .set({ provisioning: false })
        .where(and(eq(services.id, id), eq(services.organizationId, organizationId)));
    },
    async owner(id: string) {
      const [row] = await db
        .select({ organizationId: services.organizationId })
        .from(services)
        .where(eq(services.id, id))
        .limit(1);
      return row?.organizationId ?? null;
    },
    async occupied(engine: string, hostname: string, shared = false) {
      const rows = await db
        .select()
        .from(hosts)
        .where(or(eq(hosts.engine, engine), eq(hosts.hostname, hostname)));
      return rows.some(
        (host) => !shared || !host.shared || host.engine !== engine || host.hostname !== hostname,
      );
    },
    async claim(row: typeof services.$inferInsert & { engine: string; hostname: string }) {
      try {
        return await db.transaction(async (tx) => {
          const shared = row.shared ?? false;
          await tx
            .insert(hosts)
            .values({ engine: row.engine, hostname: row.hostname, shared })
            .onConflictDoNothing();
          const [host] = await tx.select().from(hosts).where(eq(hosts.engine, row.engine));
          if (!host || host.hostname !== row.hostname || host.shared !== shared) return null;
          const [claimed] = await tx.insert(services).values(row).onConflictDoNothing().returning();
          if (!claimed) throw new MailClaimConflict();
          return claimed;
        });
      } catch (error) {
        if (error instanceof MailClaimConflict) return null;
        throw error;
      }
    },
  };
}
