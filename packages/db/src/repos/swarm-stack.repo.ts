import { and, desc, eq, max, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { project, swarmManagedInput, swarmStack, swarmStackRevision } from "../schema";

export type SwarmStack = typeof swarmStack.$inferSelect;
export type NewSwarmStack = typeof swarmStack.$inferInsert;
export type SwarmStackRevision = typeof swarmStackRevision.$inferSelect;
export type NewSwarmStackRevision = typeof swarmStackRevision.$inferInsert;
export type SwarmManagedInput = typeof swarmManagedInput.$inferSelect;
export type NewSwarmManagedInput = typeof swarmManagedInput.$inferInsert;

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

    /** Metadata + encrypted payload remain organization-scoped through project ownership. */
    async listManagedInputsInOrganization(projectId: string, organizationId: string): Promise<SwarmManagedInput[]> {
      const rows = await db
        .select({ input: swarmManagedInput })
        .from(swarmManagedInput)
        .innerJoin(project, eq(project.id, swarmManagedInput.projectId))
        .where(and(eq(swarmManagedInput.projectId, projectId), eq(project.organizationId, organizationId)))
        .orderBy(swarmManagedInput.kind, swarmManagedInput.logicalName);
      return rows.map((row) => row.input);
    },

    async getManagedInputInOrganization(
      id: string,
      organizationId: string,
    ): Promise<SwarmManagedInput | undefined> {
      const rows = await db
        .select({ input: swarmManagedInput })
        .from(swarmManagedInput)
        .innerJoin(project, eq(project.id, swarmManagedInput.projectId))
        .where(and(eq(swarmManagedInput.id, id), eq(project.organizationId, organizationId)))
        .limit(1);
      return rows[0]?.input;
    },

    async upsertManagedInputInOrganization(
      projectId: string,
      organizationId: string,
      input: Pick<NewSwarmManagedInput, "kind" | "logicalName" | "valueEnc" | "createdByUserId" | "updatedByUserId">,
    ): Promise<SwarmManagedInput | undefined> {
      const owningProject = await db.query.project.findFirst({
        where: and(eq(project.id, projectId), eq(project.organizationId, organizationId)),
      });
      if (!owningProject) return undefined;
      const existing = await db.query.swarmManagedInput.findFirst({
        where: and(
          eq(swarmManagedInput.projectId, projectId),
          eq(swarmManagedInput.kind, input.kind),
          eq(swarmManagedInput.logicalName, input.logicalName),
        ),
      });
      if (existing) {
        const [updated] = await db
          .update(swarmManagedInput)
          .set({ valueEnc: input.valueEnc, updatedByUserId: input.updatedByUserId, updatedAt: new Date() })
          .where(eq(swarmManagedInput.id, existing.id))
          .returning();
        return updated;
      }
      const [created] = await db
        .insert(swarmManagedInput)
        .values({ id: generateId("swmi"), projectId, ...input })
        .returning();
      return created;
    },

    async removeManagedInputInOrganization(id: string, organizationId: string): Promise<boolean> {
      const input = await this.getManagedInputInOrganization(id, organizationId);
      if (!input) return false;
      const removed = await db.delete(swarmManagedInput).where(eq(swarmManagedInput.id, input.id)).returning();
      return removed.length === 1;
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

    /** Retention-only removal of an expired artifact; never removes the active revision. */
    async removeRevisionInOrganization(
      revisionId: string,
      organizationId: string,
    ): Promise<boolean> {
      const revision = await this.getRevisionInOrganization(revisionId, organizationId);
      if (!revision) return false;
      const stack = await this.getInOrganization(revision.stackId, organizationId);
      if (!stack || stack.lastAppliedRevisionId === revision.id) return false;
      const removed = await db
        .delete(swarmStackRevision)
        .where(eq(swarmStackRevision.id, revision.id))
        .returning();
      return removed.length === 1;
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
