import { and, desc, eq, max, sql } from "drizzle-orm";
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

    async getForProjectInOrganization(
      projectId: string,
      organizationId: string,
    ): Promise<SwarmStack | undefined> {
      return db.query.swarmStack.findFirst({
        where: and(
          eq(swarmStack.projectId, projectId),
          eq(swarmStack.organizationId, organizationId),
        ),
      });
    },

    /** Internal conflict guard: never return this row directly to a caller from another org. */
    async findByClusterName(clusterId: string, stackName: string): Promise<SwarmStack | undefined> {
      return db.query.swarmStack.findFirst({
        where: and(eq(swarmStack.clusterId, clusterId), eq(swarmStack.stackName, stackName)),
      });
    },

    async listByOrganization(organizationId: string): Promise<SwarmStack[]> {
      return db.query.swarmStack.findMany({
        where: eq(swarmStack.organizationId, organizationId),
        orderBy: [desc(swarmStack.updatedAt)],
      });
    },

    /** Internal scheduler read. No request handler may expose these rows cross-org. */
    async listManaged(limit = 200): Promise<SwarmStack[]> {
      return db.query.swarmStack.findMany({
        where: eq(swarmStack.managementMode, "managed"),
        orderBy: [desc(swarmStack.updatedAt)],
        limit,
      });
    },

    async create(data: Omit<NewSwarmStack, "id"> & { id?: string }): Promise<SwarmStack> {
      const id = data.id ?? generateId("swarm");
      const [row] = await db
        .insert(swarmStack)
        .values({ ...data, id })
        .returning();
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

    /**
     * Atomically update authoritative source material. SourceVersion is an
     * optimistic lock: concurrent editors must refresh rather than silently
     * replacing each other's compose paths or encrypted inline document.
     */
    async updateSourceInOrganization(
      id: string,
      organizationId: string,
      expectedVersion: number,
      patch: Pick<
        NewSwarmStack,
        | "sourceKind"
        | "sourceStatus"
        | "sourcePaths"
        | "sourcePath"
        | "sourceBranch"
        | "sourceCommitSha"
        | "sourceYamlEnc"
        | "sourceDigest"
      >,
    ): Promise<SwarmStack | undefined> {
      const [row] = await db
        .update(swarmStack)
        .set({
          ...patch,
          sourceVersion: sql`${swarmStack.sourceVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(swarmStack.id, id),
            eq(swarmStack.organizationId, organizationId),
            eq(swarmStack.sourceVersion, expectedVersion),
          ),
        )
        .returning();
      return row;
    },

    async listRevisionsInOrganization(
      stackId: string,
      organizationId: string,
    ): Promise<SwarmStackRevision[]> {
      const rows = await db
        .select({ revision: swarmStackRevision })
        .from(swarmStackRevision)
        .innerJoin(swarmStack, eq(swarmStack.id, swarmStackRevision.stackId))
        .where(
          and(
            eq(swarmStackRevision.stackId, stackId),
            eq(swarmStack.organizationId, organizationId),
          ),
        )
        .orderBy(desc(swarmStackRevision.revision));
      return rows.map((row) => row.revision);
    },

    /** Read one immutable revision through its owning stack's organization. */
    async getRevisionInOrganization(
      revisionId: string,
      organizationId: string,
    ): Promise<SwarmStackRevision | undefined> {
      const row = await db
        .select({ revision: swarmStackRevision })
        .from(swarmStackRevision)
        .innerJoin(swarmStack, eq(swarmStack.id, swarmStackRevision.stackId))
        .where(
          and(eq(swarmStackRevision.id, revisionId), eq(swarmStack.organizationId, organizationId)),
        )
        .limit(1);
      return row[0]?.revision;
    },

    /**
     * Finalize an already-persisted revision without ever accepting a stack ID
     * from an unscoped request. The source/rendered document stays immutable;
     * only apply and convergence facts may change.
     */
    async updateRevisionInOrganization(
      revisionId: string,
      organizationId: string,
      patch: Partial<
        Pick<
          NewSwarmStackRevision,
          "applyStatus" | "applyOutput" | "serviceRefs" | "appliedAt" | "convergedAt"
        >
      >,
    ): Promise<SwarmStackRevision | undefined> {
      const revision = await this.getRevisionInOrganization(revisionId, organizationId);
      if (!revision) return undefined;
      const [updated] = await db
        .update(swarmStackRevision)
        .set(patch)
        .where(eq(swarmStackRevision.id, revisionId))
        .returning();
      return updated;
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
