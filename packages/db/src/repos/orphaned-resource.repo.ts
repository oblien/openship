/**
 * Orphaned-resource repo — records leaked remote resources from a force-orphan
 * delete and feeds the GC sweep. Append on orphan, delete on successful GC,
 * bumpAttempt when a sweep can't yet reach the server.
 */

import { eq, asc, inArray, sql, and, isNull, or, notExists } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { orphanedResource } from "../schema/orphaned-resource";
import { project } from "../schema/project";
import { hostPortClaim } from "../schema/host-port-claim";

export type OrphanedResource = typeof orphanedResource.$inferSelect;
export type NewOrphanedResource = typeof orphanedResource.$inferInsert;

export function createOrphanedResourceRepo(db: Database) {
  return {
    async create(
      data: Omit<NewOrphanedResource, "id" | "createdAt" | "attempts">,
    ): Promise<OrphanedResource> {
      const id = generateId("orph");
      const row: NewOrphanedResource = { id, ...data };
      await db.insert(orphanedResource).values(row);
      return { ...row, attempts: 0, createdAt: new Date() } as OrphanedResource;
    },

    /** All orphans, oldest first (GC processes them fairly). */
    async listAll(): Promise<OrphanedResource[]> {
      return db.select().from(orphanedResource).orderBy(asc(orphanedResource.createdAt));
    },

    async listByServer(serverId: string): Promise<OrphanedResource[]> {
      return db.select().from(orphanedResource).where(eq(orphanedResource.serverId, serverId));
    },

    async listByProject(projectId: string): Promise<OrphanedResource[]> {
      return db
        .select()
        .from(orphanedResource)
        .where(eq(orphanedResource.projectId, projectId))
        .orderBy(asc(orphanedResource.createdAt));
    },

    async delete(id: string): Promise<void> {
      await db.delete(orphanedResource).where(eq(orphanedResource.id, id));
    },

    /** Complete absence reconciliation atomically; never retire a changed target,
     * a restored owner, or intent still protecting a physical host-port claim. */
    async retireUnboundRoute(expected: OrphanedResource): Promise<boolean> {
      if (!expected.projectId) return false;
      const rows = await db
        .delete(orphanedResource)
        .where(
          and(
            eq(orphanedResource.id, expected.id),
            eq(orphanedResource.organizationId, expected.organizationId),
            eq(orphanedResource.projectId, expected.projectId),
            eq(orphanedResource.ref, expected.ref),
            eq(orphanedResource.resourceType, "route"),
            isNull(orphanedResource.serverId),
            isNull(orphanedResource.targetKey),
            isNull(orphanedResource.payload),
            or(isNull(orphanedResource.runtimeMode), eq(orphanedResource.runtimeMode, "docker")),
            notExists(
              db.select({ id: project.id }).from(project).where(eq(project.id, expected.projectId)),
            ),
            notExists(
              db
                .select({ projectId: hostPortClaim.projectId })
                .from(hostPortClaim)
                .where(eq(hostPortClaim.projectId, expected.projectId)),
            ),
          ),
        )
        .returning();
      return rows.length === 1;
    },

    /** Retire a proven ownership handoff in one statement, under the GC lock. */
    async deleteMany(ids: string[]): Promise<void> {
      if (ids.length) await db.delete(orphanedResource).where(inArray(orphanedResource.id, ids));
    },

    /** Record a failed/deferred GC attempt so the sweep can back off / observe. */
    async bumpAttempt(id: string): Promise<void> {
      await db
        .update(orphanedResource)
        .set({ attempts: sql`${orphanedResource.attempts} + 1`, lastAttemptAt: new Date() })
        .where(eq(orphanedResource.id, id));
    },

    /** Persist recovery metadata before a GC operation destroys the source that
     *  metadata was discovered from (for example container volume mounts). */
    async updatePayload(id: string, payload: unknown): Promise<void> {
      await db.update(orphanedResource).set({ payload }).where(eq(orphanedResource.id, id));
    },
  };
}
