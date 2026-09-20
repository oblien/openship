import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../client";
import { cloudDockerWorkspace, project } from "../schema";

export type CloudDockerWorkspace = typeof cloudDockerWorkspace.$inferSelect;

export function createCloudDockerWorkspaceRepo(db: Database) {
  const find = async (projectId: string, organizationId: string) => {
    const [row] = await db.select({ binding: cloudDockerWorkspace }).from(cloudDockerWorkspace)
      .innerJoin(project, eq(project.id, cloudDockerWorkspace.projectId))
      .where(and(eq(project.id, projectId), eq(project.organizationId, organizationId)));
    return row?.binding;
  };
  return {
    find,
    /** A definitive provider rejection created nothing. Keep ambiguous network
     * failures reserved so a retry cannot create a second workspace. */
    async discardUncreated(projectId: string, organizationId: string, provisionKey: string): Promise<void> {
      await db.delete(cloudDockerWorkspace).where(and(eq(cloudDockerWorkspace.projectId, projectId),
        inArray(cloudDockerWorkspace.projectId, db.select({ id: project.id }).from(project).where(eq(project.organizationId, organizationId))),
        eq(cloudDockerWorkspace.provisionKey, provisionKey), isNull(cloudDockerWorkspace.workspaceId)));
    },
    async reserve(input: Pick<CloudDockerWorkspace, "projectId" | "namespace" | "image" | "resources">, organizationId: string): Promise<CloudDockerWorkspace> {
      return db.transaction(async tx => {
        const [owner] = await tx.select().from(project).where(and(
          eq(project.id, input.projectId), eq(project.organizationId, organizationId), isNull(project.deletedAt),
        )).for("update");
        if (!owner || owner.deletionInProgress) throw new Error("Project is unavailable for cloud provisioning");
        await tx.insert(cloudDockerWorkspace).values({ ...input, provisionKey: randomUUID() }).onConflictDoNothing();
        const row = await tx.query.cloudDockerWorkspace.findFirst({ where: eq(cloudDockerWorkspace.projectId, input.projectId) });
        if (!row || row.namespace !== input.namespace) throw new Error("Cloud workspace namespace binding does not match this project");
        return row;
      });
    },
    async attach(projectId: string, organizationId: string, namespace: string, workspaceId: string, forCleanup = false): Promise<void> {
      await db.transaction(async tx => {
        const [owner] = await tx.select().from(project).where(and(eq(project.id, projectId), eq(project.organizationId, organizationId))).for("update");
        if (!owner || (forCleanup ? !owner.deletionInProgress : owner.deletedAt || owner.deletionInProgress)) throw new Error("Project is unavailable for cloud provisioning");
        const [row] = await tx.update(cloudDockerWorkspace).set({ workspaceId, updatedAt: new Date() })
          .where(and(eq(cloudDockerWorkspace.projectId, projectId), eq(cloudDockerWorkspace.namespace, namespace),
            or(isNull(cloudDockerWorkspace.workspaceId), eq(cloudDockerWorkspace.workspaceId, workspaceId))))
          .returning();
        if (!row) throw new Error("Cloud workspace binding cannot be reassigned");
        if (owner.cloudWorkspaceId && owner.cloudWorkspaceId !== workspaceId) throw new Error("Project already owns a different cloud workspace");
        await tx.update(project).set({ cloudWorkspaceId: workspaceId, updatedAt: new Date() })
          .where(and(eq(project.id, projectId), eq(project.organizationId, organizationId)));
      });
    },
    async markReady(projectId: string, organizationId: string, workspaceId: string): Promise<void> {
      const [row] = await db.update(cloudDockerWorkspace).set({ state: "ready", updatedAt: new Date() })
        .where(and(eq(cloudDockerWorkspace.projectId, projectId), eq(cloudDockerWorkspace.workspaceId, workspaceId),
          inArray(cloudDockerWorkspace.projectId, db.select({ id: project.id }).from(project).where(eq(project.organizationId, organizationId)))))
        .returning();
      if (!row) throw new Error("Cloud workspace ownership changed");
    },
  };
}
