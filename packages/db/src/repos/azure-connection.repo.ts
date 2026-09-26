import { and, asc, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { azureConnection } from "../schema";

export type AzureConnection = typeof azureConnection.$inferSelect;
export type NewAzureConnection = typeof azureConnection.$inferInsert;

/**
 * Organization-scoped storage for Azure DevOps connections. Secret encryption
 * belongs to the API service; this repository treats the envelope as opaque.
 * Every read is scoped by panel organization — a connection is never visible
 * to, or resolvable for, any other tenant.
 */
export function createAzureConnectionRepo(db: Database) {
  return {
    async listByOrganization(organizationId: string): Promise<AzureConnection[]> {
      return db.query.azureConnection.findMany({
        where: eq(azureConnection.organizationId, organizationId),
        orderBy: [asc(azureConnection.adoOrg)],
      });
    },

    async listActiveByOrganization(organizationId: string): Promise<AzureConnection[]> {
      return db.query.azureConnection.findMany({
        where: and(
          eq(azureConnection.organizationId, organizationId),
          eq(azureConnection.status, "active"),
        ),
        orderBy: [asc(azureConnection.adoOrg)],
      });
    },

    async findByAdoOrg(
      organizationId: string,
      adoOrg: string,
    ): Promise<AzureConnection | undefined> {
      return db.query.azureConnection.findFirst({
        where: and(
          eq(azureConnection.organizationId, organizationId),
          eq(azureConnection.adoOrg, adoOrg),
        ),
      });
    },

    async upsert(data: {
      organizationId: string;
      adoOrg: string;
      patEncrypted: string;
    }): Promise<AzureConnection> {
      const [created] = await db
        .insert(azureConnection)
        .values({
          id: generateId("azc"),
          organizationId: data.organizationId,
          adoOrg: data.adoOrg,
          patEncrypted: data.patEncrypted,
          patSetAt: new Date(),
          status: "active",
          lastError: null,
          lastVerifiedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [azureConnection.organizationId, azureConnection.adoOrg],
          set: {
            patEncrypted: data.patEncrypted,
            patSetAt: new Date(),
            status: "active",
            lastError: null,
            lastVerifiedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!created) throw new Error("azure connection upsert did not persist");
      return created;
    },

    async setStatus(
      organizationId: string,
      adoOrg: string,
      status: "active" | "invalid",
      lastError?: string | null,
    ): Promise<void> {
      await db
        .update(azureConnection)
        .set({ status, lastError: lastError ?? null, updatedAt: new Date() })
        .where(
          and(
            eq(azureConnection.organizationId, organizationId),
            eq(azureConnection.adoOrg, adoOrg),
          ),
        );
    },

    async delete(organizationId: string, adoOrg: string): Promise<boolean> {
      const deleted = await db
        .delete(azureConnection)
        .where(
          and(
            eq(azureConnection.organizationId, organizationId),
            eq(azureConnection.adoOrg, adoOrg),
          ),
        )
        .returning();
      return deleted.length > 0;
    },
  };
}
