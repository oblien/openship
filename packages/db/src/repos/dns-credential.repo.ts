import { and, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { dnsCredential } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type DnsCredential = typeof dnsCredential.$inferSelect;
export type NewDnsCredential = typeof dnsCredential.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createDnsCredentialRepo(db: Database) {
  return {
    /** List all DNS credentials for an organization. */
    async listByOrg(organizationId: string): Promise<DnsCredential[]> {
      return db.query.dnsCredential.findMany({
        where: eq(dnsCredential.organizationId, organizationId),
      });
    },

    /** Find a specific DNS credential by org and ID. */
    async findById(
      organizationId: string,
      id: string,
    ): Promise<DnsCredential | undefined> {
      return db.query.dnsCredential.findFirst({
        where: and(
          eq(dnsCredential.organizationId, organizationId),
          eq(dnsCredential.id, id),
        ),
      });
    },

    /** Find one credential by its operator-facing label (the unique key). */
    async findByName(
      organizationId: string,
      provider: string,
      name: string,
    ): Promise<DnsCredential | undefined> {
      return db.query.dnsCredential.findFirst({
        where: and(
          eq(dnsCredential.organizationId, organizationId),
          eq(dnsCredential.provider, provider),
          eq(dnsCredential.name, name),
        ),
      });
    },

    /** Find active DNS credentials for an org, optionally filtered by provider. */
    async findActiveByOrg(
      organizationId: string,
      provider?: string,
    ): Promise<DnsCredential[]> {
      const conditions = [
        eq(dnsCredential.organizationId, organizationId),
        eq(dnsCredential.status, "active"),
      ];
      if (provider) {
        conditions.push(eq(dnsCredential.provider, provider));
      }
      return db.query.dnsCredential.findMany({
        where: and(...conditions),
      });
    },

    /** Create a new DNS credential row. */
    async create(data: {
      id?: string;
      organizationId: string;
      provider: string;
      name: string;
      apiTokenEnc: string;
      status?: string;
      lastVerifiedAt?: Date | null;
    }): Promise<DnsCredential> {
      const [row] = await db
        .insert(dnsCredential)
        .values({
          id: data.id ?? generateId("dns"),
          organizationId: data.organizationId,
          provider: data.provider,
          name: data.name,
          apiTokenEnc: data.apiTokenEnc,
          status: data.status ?? "active",
          lastVerifiedAt: data.lastVerifiedAt ?? new Date(),
        })
        .returning();
      return row!;
    },

    /** Update an existing DNS credential row. */
    async update(
      organizationId: string,
      id: string,
      data: Partial<{
        name: string;
        apiTokenEnc: string;
        status: string;
        lastVerifiedAt: Date | null;
      }>,
    ): Promise<DnsCredential | undefined> {
      const [updated] = await db
        .update(dnsCredential)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dnsCredential.organizationId, organizationId),
            eq(dnsCredential.id, id),
          ),
        )
        .returning();
      return updated;
    },

    /** Delete a DNS credential by org and ID. */
    /**
     * Every legacy row, across all organizations — for the ONE-TIME boot backfill that
     * moves these into the generic `credential` store.
     *
     * Deliberately unscoped, unlike every other read here: the backfill runs once per
     * instance with no request context, so there is no organization to scope to. Nothing
     * else may use it — a request-path read that ignores the org boundary is how one
     * tenant's token reaches another.
     */
    async listAll(): Promise<DnsCredential[]> {
      return db.query.dnsCredential.findMany();
    },

    async delete(organizationId: string, id: string): Promise<void> {
      await db
        .delete(dnsCredential)
        .where(
          and(
            eq(dnsCredential.organizationId, organizationId),
            eq(dnsCredential.id, id),
          ),
        );
    },
  };
}
