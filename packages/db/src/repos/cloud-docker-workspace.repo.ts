import { and, eq, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database, DatabaseTransaction } from "../client";
import { cloudDockerWorkspace, cloudWorkspace, project } from "../schema";

export type CloudDockerWorkspace = typeof cloudDockerWorkspace.$inferSelect;
export type CloudDockerOwner = string | { ownerWorkspaceId: string };

/** Resolve ownership once. Project membership never creates a second host binding. */
async function resolveOwner(db: Database | DatabaseTransaction, target: CloudDockerOwner, organizationId: string, lock = false) {
  const projectQuery = typeof target === "string" ? db.select().from(project).where(and(
    eq(project.id, target), eq(project.organizationId, organizationId),
  )) : null;
  const [member] = projectQuery ? await (lock ? projectQuery.for("update") : projectQuery) : [];
  if (typeof target === "string" && !member) return null;
  const ownerWorkspaceId = typeof target === "string" ? member?.workspaceId : target.ownerWorkspaceId;
  if (!ownerWorkspaceId) return null;
  {
    const query = db.select().from(cloudWorkspace).where(and(eq(cloudWorkspace.id, ownerWorkspaceId), eq(cloudWorkspace.organizationId, organizationId)));
    const [workspace] = await (lock ? query.for("update") : query);
    if (!workspace) return null;
    return { member, workspace, ownerWorkspaceId, condition: eq(cloudDockerWorkspace.ownerWorkspaceId, ownerWorkspaceId) };
  }

}

function assertAvailable(owner: Awaited<ReturnType<typeof resolveOwner>>, forCleanup = false) {
  if (!owner || owner.workspace?.deletionInProgress || (owner.member && (
    forCleanup ? !owner.member.deletionInProgress : owner.member.deletedAt || owner.member.deletionInProgress
  ))) throw new Error("Cloud Docker host owner is unavailable");
  return owner;
}

export function createCloudDockerWorkspaceRepo(db: Database) {
  const find = async (target: CloudDockerOwner, organizationId: string) => {
    const owner = await resolveOwner(db, target, organizationId);
    if (!owner) return undefined;
    return db.query.cloudDockerWorkspace.findFirst({ where: owner.condition });
  };
  return {
    find,
    async updateResources(target: CloudDockerOwner, organizationId: string, workspaceId: string, resources: CloudDockerWorkspace["resources"]) {
      const owner = await resolveOwner(db, target, organizationId);
      if (!owner) throw new Error("Cloud workspace ownership changed");
      const [row] = await db.update(cloudDockerWorkspace).set({ resources, updatedAt: new Date() })
        .where(and(owner.condition, eq(cloudDockerWorkspace.workspaceId, workspaceId))).returning();
      if (!row) throw new Error("Cloud workspace ownership changed");
    },
    async discardUncreated(target: CloudDockerOwner, organizationId: string, provisionKey: string): Promise<void> {
      const owner = await resolveOwner(db, target, organizationId);
      if (!owner) return;
      await db.delete(cloudDockerWorkspace).where(and(owner.condition,
        eq(cloudDockerWorkspace.provisionKey, provisionKey), isNull(cloudDockerWorkspace.workspaceId)));
    },
    async reserve(input: Pick<CloudDockerWorkspace, "namespace" | "image" | "resources"> &
      { ownerWorkspaceId: string }, organizationId: string): Promise<CloudDockerWorkspace> {
      return db.transaction(async tx => {
        const target = { ownerWorkspaceId: input.ownerWorkspaceId };
        const owner = assertAvailable(await resolveOwner(tx, target, organizationId, true));
        if (owner.workspace && owner.workspace.namespace !== input.namespace) throw new Error("Cloud workspace namespace does not match its owner");
        await tx.insert(cloudDockerWorkspace).values({
          ownerWorkspaceId: owner.ownerWorkspaceId,
          namespace: input.namespace, image: input.image, resources: input.resources, provisionKey: randomUUID(),
        }).onConflictDoNothing();
        const row = await tx.query.cloudDockerWorkspace.findFirst({ where: owner.condition });
        if (!row || row.namespace !== input.namespace) throw new Error("Cloud workspace namespace binding does not match this owner");
        return row;
      });
    },
    async attach(target: CloudDockerOwner, organizationId: string, namespace: string, workspaceId: string, forCleanup = false): Promise<void> {
      await db.transaction(async tx => {
        const owner = assertAvailable(await resolveOwner(tx, target, organizationId, true), forCleanup);
        const [row] = await tx.update(cloudDockerWorkspace).set({ workspaceId, updatedAt: new Date() })
          .where(and(owner.condition, eq(cloudDockerWorkspace.namespace, namespace),
            or(isNull(cloudDockerWorkspace.workspaceId), eq(cloudDockerWorkspace.workspaceId, workspaceId))))
          .returning();
        if (!row) throw new Error("Cloud workspace binding cannot be reassigned");

      });
    },
    async markReady(target: CloudDockerOwner, organizationId: string, workspaceId: string): Promise<void> {
      const owner = await resolveOwner(db, target, organizationId);
      if (!owner) throw new Error("Cloud workspace ownership changed");
      const [row] = await db.update(cloudDockerWorkspace).set({ state: "ready", updatedAt: new Date() })
        .where(and(owner.condition, eq(cloudDockerWorkspace.workspaceId, workspaceId))).returning();
      if (!row) throw new Error("Cloud workspace ownership changed");
    },
  };
}
