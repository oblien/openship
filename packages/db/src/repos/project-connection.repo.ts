import { and, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { projectConnection } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProjectConnection = typeof projectConnection.$inferSelect;
export type NewProjectConnection = typeof projectConnection.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createProjectConnectionRepo(db: Database) {
  return {
    /** Links a consumer (target) project depends on. */
    async listByTarget(targetProjectId: string): Promise<ProjectConnection[]> {
      return db.query.projectConnection.findMany({
        where: eq(projectConnection.targetProjectId, targetProjectId),
      });
    },

    /** Links that consume a given source DB app (e.g. to block its deletion). */
    async listBySource(sourceProjectId: string): Promise<ProjectConnection[]> {
      return db.query.projectConnection.findMany({
        where: eq(projectConnection.sourceProjectId, sourceProjectId),
      });
    },

    async findById(id: string): Promise<ProjectConnection | undefined> {
      return db.query.projectConnection.findFirst({
        where: eq(projectConnection.id, id),
      });
    },

    /** Create or update the link for (target, envKey) — one env var, one source. */
    async upsert(
      data: Omit<NewProjectConnection, "id" | "createdAt" | "updatedAt"> & { id?: string },
    ): Promise<ProjectConnection> {
      const [row] = await db
        .insert(projectConnection)
        .values({ id: data.id ?? generateId("conn"), ...data })
        .onConflictDoUpdate({
          target: [projectConnection.targetProjectId, projectConnection.envKey],
          set: {
            organizationId: data.organizationId,
            sourceProjectId: data.sourceProjectId,
            outputId: data.outputId,
            mode: data.mode,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    async delete(id: string): Promise<void> {
      await db.delete(projectConnection).where(eq(projectConnection.id, id));
    },

    /** Guard for a scoped delete: only within the given target project. */
    async findInTarget(
      id: string,
      targetProjectId: string,
    ): Promise<ProjectConnection | undefined> {
      return db.query.projectConnection.findFirst({
        where: and(
          eq(projectConnection.id, id),
          eq(projectConnection.targetProjectId, targetProjectId),
        ),
      });
    },
  };
}
