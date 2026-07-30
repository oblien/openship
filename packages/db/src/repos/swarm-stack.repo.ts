import { and, desc, eq, max } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { swarmStack, swarmStackRevision } from "../schema";

export type SwarmStack = typeof swarmStack.$inferSelect;
export type NewSwarmStack = typeof swarmStack.$inferInsert;
export type SwarmStackRevision = typeof swarmStackRevision.$inferSelect;
export type NewSwarmStackRevision = typeof swarmStackRevision.$inferInsert;

/** All request-path reads are organization-scoped by construction. */
export function createSwarmStackRepo(db: Database) {
  return {
    async getInOrganization(id: string, organizationId: string): Promise<SwarmStack | undefined> {
      return db.query.swarmStack.findFirst({
        where: and(eq(swarmStack.id, id), eq(swarmStack.organizationId, organizationId)),
      });
    },

    async getForProjectInOrganization(projectId: string, organizationId: string): Promise<SwarmStack | undefined> {
      return db.query.swarmStack.findFirst({
        where: and(eq(swarmStack.projectId, projectId), eq(swarmStack.organizationId, organizationId)),
      });
    },

    async listByOrganization(organizationId: string): Promise<SwarmStack[]> {
      return db.query.swarmStack.findMany({
        where: eq(swarmStack.organizationId, organizationId),
        orderBy: [desc(swarmStack.updatedAt)],
      });
    },

    async create(data: Omit<NewSwarmStack, "id"> & { id?: string }): Promise<SwarmStack> {
      const id = data.id ?? generateId("swarm");
      const [row] = await db.insert(swarmStack).values({ ...data, id }).returning();
      return row;
    },

    async updateInOrganization(
      id: string,
      organizationId: string,
      patch: Partial<Omit<NewSwarmStack, "id" | "organizationId" | "projectId">>,
    ): Promise<SwarmStack | undefined> {
      const [row] = await db
        .update(swarmStack)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(swarmStack.id, id), eq(swarmStack.organizationId, organizationId)))
        .returning();
      return row;
    },

    async listRevisionsInOrganization(stackId: string, organizationId: string): Promise<SwarmStackRevision[]> {
      const rows = await db
        .select({ revision: swarmStackRevision })
        .from(swarmStackRevision)
        .innerJoin(swarmStack, eq(swarmStack.id, swarmStackRevision.stackId))
        .where(and(eq(swarmStackRevision.stackId, stackId), eq(swarmStack.organizationId, organizationId)))
        .orderBy(desc(swarmStackRevision.revision));
      return rows.map((row) => row.revision);
    },

    async createRevisionInOrganization(
      stackId: string,
      organizationId: string,
      data: Omit<NewSwarmStackRevision, "id" | "stackId" | "revision"> & { id?: string },
    ): Promise<SwarmStackRevision | undefined> {
      // Verify ownership before inserting. This records state only and never
      // touches Docker; callers apply separately after revision persistence.
      const stack = await this.getInOrganization(stackId, organizationId);
      if (!stack) return undefined;
      const [row] = await db
        .select({ latest: max(swarmStackRevision.revision) })
        .from(swarmStackRevision)
        .where(eq(swarmStackRevision.stackId, stackId));
      const revision = Number(row?.latest ?? 0) + 1;
      const id = data.id ?? generateId("swr");
      const [created] = await db
        .insert(swarmStackRevision)
        .values({ ...data, id, stackId, revision })
        .returning();
      return created;
    },
  };
}
