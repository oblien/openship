import { and, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { updateStatus } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type UpdateStatus = typeof updateStatus.$inferSelect;
export type NewUpdateStatus = typeof updateStatus.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createUpdateStatusRepo(db: Database) {
  return {
    /** Upsert the scan result for a project (unique on projectId). */
    async upsert(data: Omit<NewUpdateStatus, "id">): Promise<void> {
      const id = generateId("ups");
      await db
        .insert(updateStatus)
        .values({ id, ...data })
        .onConflictDoUpdate({
          target: updateStatus.projectId,
          set: {
            organizationId: data.organizationId,
            kind: data.kind,
            behind: data.behind,
            latestInProgress: data.latestInProgress,
            currentLabel: data.currentLabel ?? null,
            latestLabel: data.latestLabel ?? null,
            detail: data.detail ?? null,
            checkedAt: data.checkedAt ?? new Date(),
            updatedAt: new Date(),
          },
        });
    },

    /** All cached statuses for an org (newest check first). */
    async listByOrg(organizationId: string): Promise<UpdateStatus[]> {
      const rows = await db.query.updateStatus.findMany({
        where: eq(updateStatus.organizationId, organizationId),
      });
      return rows.sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
    },

    /** Only the entities that currently have an update available. */
    async listBehindByOrg(organizationId: string): Promise<UpdateStatus[]> {
      const rows = await db.query.updateStatus.findMany({
        where: and(
          eq(updateStatus.organizationId, organizationId),
          eq(updateStatus.behind, true),
        ),
      });
      return rows.sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
    },

    async getByProject(projectId: string): Promise<UpdateStatus | undefined> {
      return db.query.updateStatus.findFirst({
        where: eq(updateStatus.projectId, projectId),
      });
    },

    async deleteByProject(projectId: string): Promise<void> {
      await db.delete(updateStatus).where(eq(updateStatus.projectId, projectId));
    },
  };
}
