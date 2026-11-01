import { and, eq, lte, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database, DatabaseTransaction } from "../client";
import { updateStatus } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type UpdateStatus = typeof updateStatus.$inferSelect;
export type NewUpdateStatus = typeof updateStatus.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createUpdateStatusRepo(db: Database) {
  async function write<T>(run: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      // Cache maintenance must not occupy a pooled connection indefinitely on
      // a row lock. LOCAL keeps these limits out of unrelated transactions.
      await tx.execute(sql`SET LOCAL lock_timeout = '1500ms'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
      return run(tx);
    });
  }
  return {
    /** Upsert the polled upstream state for a project (unique on projectId). */
    async upsert(data: Omit<NewUpdateStatus, "id">): Promise<void> {
      const id = generateId("ups");
      const checkedAt = data.checkedAt ?? new Date();
      await write(async (tx) => {
        await tx
          .insert(updateStatus)
          .values({ id, ...data, checkedAt })
          .onConflictDoUpdate({
            target: updateStatus.projectId,
            set: {
              organizationId: data.organizationId,
              kind: data.kind,
              detail: data.detail ?? null,
              checkedAt,
              updatedAt: new Date(),
            },
            // An older poll may acquire its connection/lock after a newer one.
            setWhere: lte(updateStatus.checkedAt, sql`excluded.checked_at`),
          });
      });
    },

    /** All cached upstream rows for an org (newest poll first). */
    async listByOrg(organizationId: string): Promise<UpdateStatus[]> {
      const rows = await db.query.updateStatus.findMany({
        where: eq(updateStatus.organizationId, organizationId),
      });
      return rows.sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
    },

    // No listBehindByOrg: "behind" is not stored. It's a comparison against the
    // project's live deployment, computed in updates.service on read.

    async getByProject(projectId: string): Promise<UpdateStatus | undefined> {
      return db.query.updateStatus.findFirst({
        where: eq(updateStatus.projectId, projectId),
      });
    },

    async deleteByProject(projectId: string, checkedBefore?: Date): Promise<void> {
      await write(async (tx) => {
        await tx
          .delete(updateStatus)
          .where(
            and(
              eq(updateStatus.projectId, projectId),
              checkedBefore ? lte(updateStatus.checkedAt, checkedBefore) : undefined,
            ),
          );
      });
    },
  };
}
