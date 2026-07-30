import { and, desc, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { containerRegistry } from "../schema";

export type ContainerRegistry = typeof containerRegistry.$inferSelect;
export type NewContainerRegistry = typeof containerRegistry.$inferInsert;

/** Registry credentials are stored encrypted by callers and never decrypted here. */
export function createContainerRegistryRepo(db: Database) {
  return {
    async getInOrganization(id: string, organizationId: string): Promise<ContainerRegistry | undefined> {
      return db.query.containerRegistry.findFirst({
        where: and(eq(containerRegistry.id, id), eq(containerRegistry.organizationId, organizationId)),
      });
    },

    async listByOrganization(organizationId: string): Promise<ContainerRegistry[]> {
      return db.query.containerRegistry.findMany({
        where: eq(containerRegistry.organizationId, organizationId),
        orderBy: [desc(containerRegistry.updatedAt)],
      });
    },

    async create(data: Omit<NewContainerRegistry, "id"> & { id?: string }): Promise<ContainerRegistry> {
      const id = data.id ?? generateId("reg");
      const [row] = await db.insert(containerRegistry).values({ ...data, id }).returning();
      return row;
    },

    async updateInOrganization(
      id: string,
      organizationId: string,
      patch: Partial<Omit<NewContainerRegistry, "id" | "organizationId">>,
    ): Promise<ContainerRegistry | undefined> {
      const [row] = await db
        .update(containerRegistry)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(containerRegistry.id, id), eq(containerRegistry.organizationId, organizationId)))
        .returning();
      return row;
    },
  };
}
