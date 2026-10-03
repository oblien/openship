import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { AppError, generateId } from "@repo/core";
import type { Database, DatabaseTransaction } from "../client";
import {
  cloudDockerWorkspace,
  cloudWorkspace,
  cloudServerDeletion,
  project,
  servers,
  dockerMigrationRun,
  type CloudWorkspaceOperation,
  type CloudWorkspaceActivity,
} from "../schema";
import { activeMigration } from "./docker-migration.repo";

export type CloudWorkspace = typeof cloudWorkspace.$inferSelect;

/** Call in the same transaction as project insertion. The workspace row serializes placements. */
export async function assertCloudWorkspacePlacement(
  tx: DatabaseTransaction,
  input: {
    id?: string;
    workspaceId?: string | null;
    organizationId: string;
    serverId?: string | null;
    clusterId?: string | null;
  },
) {
  const [server] = input.serverId ? await tx.select().from(servers)
    .where(and(eq(servers.id, input.serverId), eq(servers.organizationId, input.organizationId))) : [];
  const workspaceId = server?.workspaceId ?? input.workspaceId;
  if (!workspaceId) return;
  if (!server?.workspaceId || (input.workspaceId && input.workspaceId !== server.workspaceId) || input.clusterId)
    throw new AppError(
      "Cloud workspace conflicts with the project's execution target",
      400,
      "CLOUD_WORKSPACE_TARGET_CONFLICT",
    );
  const [owner] = await tx
    .select()
    .from(cloudWorkspace)
    .where(
      and(
        eq(cloudWorkspace.id, workspaceId),
        eq(cloudWorkspace.organizationId, input.organizationId),
      ),
    )
    .for("update");
  if (!owner || owner.deletionInProgress)
    throw new AppError("Cloud workspace is unavailable", 409, "CLOUD_WORKSPACE_UNAVAILABLE");
  if (input.id && owner.linkedProjects.some(link => link.projects.some(project => project.id === input.id)))
    throw new AppError("A project identity is already controlled by another installation on this server", 409, "CLOUD_PROJECT_IDENTITY_CONFLICT");
  if (owner.operation?.kind === "resize" && owner.operation.status !== "succeeded")
    throw new AppError(
      "Wait for the workspace resize before adding a project",
      409,
      "CLOUD_WORKSPACE_BUSY",
    );

}

async function updatedLinkedProjects(
  tx: DatabaseTransaction,
  row: CloudWorkspace,
  controllerId: string,
  projects: Array<{ id: string; name: string }>,
) {
  const links = row.linkedProjects.filter(link => link.controllerId !== controllerId);
  const local = await tx.select({ id: project.id }).from(project).where(eq(project.workspaceId, row.id));
  const claimed = new Set([...local.map(row => row.id), ...links.flatMap(link => link.projects.map(project => project.id))]);
  if (new Set(projects.map(project => project.id)).size !== projects.length || projects.some(project => claimed.has(project.id)))
    throw new AppError("A project identity is already controlled by another installation on this server", 409, "CLOUD_PROJECT_IDENTITY_CONFLICT");
  if (projects.length) links.push({ controllerId, projects });
  return links;
}

export function createCloudWorkspaceRepo(db: Database) {
  return {
    async findById(id: string) {
      return db.query.cloudWorkspace.findFirst({ where: eq(cloudWorkspace.id, id) });
    },
    async findByIdInOrganization(id: string, organizationId: string) {
      return db.query.cloudWorkspace.findFirst({
        where: and(eq(cloudWorkspace.id, id), eq(cloudWorkspace.organizationId, organizationId)),
      });
    },
    async findByNamespace(namespace: string) {
      return db.query.cloudWorkspace.findFirst({ where: eq(cloudWorkspace.namespace, namespace) });
    },
    async listByOrganization(organizationId: string) {
      return db
        .select()
        .from(cloudWorkspace)
        .where(eq(cloudWorkspace.organizationId, organizationId))
        .orderBy(asc(cloudWorkspace.createdAt), asc(cloudWorkspace.id));
    },
    async create(input: Pick<CloudWorkspace, "organizationId" | "name">) {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(cloudWorkspace)
          .values({ ...input, id: generateId("cws") }).returning();
        await tx.insert(servers).values({
          organizationId: input.organizationId, workspaceId: row!.id,
          name: input.name, sshHost: null, sshPort: null, sshUser: null,
        });
        return row!;
      });
    },
    /** Linking is idempotent and never copies a subscription or creates a VM. */
    async link(input: Pick<CloudWorkspace, "organizationId" | "name"> & { remote: NonNullable<CloudWorkspace["remote"]> }) {
      return db.transaction(async (tx) => {
        await tx.insert(cloudWorkspace).values({ ...input, id: generateId("cws") })
          .onConflictDoNothing();
        const [row] = await tx.select().from(cloudWorkspace).where(and(
          eq(cloudWorkspace.organizationId, input.organizationId), eq(cloudWorkspace.remote, input.remote),
        )).for("update");
        if (!row) throw new AppError("This managed server is already connected to another organization or Cloud account on this installation", 409, "CLOUD_SERVER_ALREADY_LINKED");
        await tx.insert(servers).values({
          organizationId: input.organizationId, workspaceId: row.id,
          name: input.name, sshHost: null, sshPort: null, sshUser: null,
        }).onConflictDoNothing({ target: servers.workspaceId });
        return row;
      });
    },
    async setNamespace(id: string, organizationId: string, namespace: string) {
      const [row] = await db
        .update(cloudWorkspace)
        .set({ namespace, updatedAt: new Date() })
        .where(
          and(
            eq(cloudWorkspace.id, id),
            eq(cloudWorkspace.organizationId, organizationId),
            isNull(cloudWorkspace.deletionInProgress),
            or(isNull(cloudWorkspace.namespace), eq(cloudWorkspace.namespace, namespace)),
          ),
        )
        .returning();
      if (!row) throw new Error("Cloud workspace namespace cannot be reassigned");
      return row;
    },
    async setBillingEntitlement(
      id: string,
      organizationId: string,
      namespace: string,
      data: Pick<
        CloudWorkspace,
        "planTierId" | "subscriptionStatus" | "currentPeriodStart" | "currentPeriodEnd"
      >,
    ) {
      const [row] = await db
        .update(cloudWorkspace)
        .set({ ...data, updatedAt: new Date() })
        .where(
          and(
            eq(cloudWorkspace.id, id),
            eq(cloudWorkspace.organizationId, organizationId),
            eq(cloudWorkspace.namespace, namespace),
          ),
        )
        .returning();
      if (!row) throw new Error("Cloud workspace billing owner changed");
      return row;
    },
    async rename(id: string, organizationId: string, name: string) {
      return db.transaction(async (tx) => {
        const updatedAt = new Date();
        const [row] = await tx
          .update(cloudWorkspace)
          .set({ name, updatedAt })
          .where(
            and(
              eq(cloudWorkspace.id, id),
              eq(cloudWorkspace.organizationId, organizationId),
              isNull(cloudWorkspace.deletionInProgress),
            ),
          )
          .returning();
        if (row) await tx.update(servers).set({ name, updatedAt })
          .where(and(eq(servers.workspaceId, id), eq(servers.organizationId, organizationId)));
        return row;
      });
    },
    /** Caller holds the workspace billing lock across provider reconciliation. */
    async setPendingCheckouts(
      id: string,
      organizationId: string,
      pendingCheckouts: CloudWorkspace["pendingCheckouts"],
    ) {
      const [row] = await db
        .update(cloudWorkspace)
        .set({ pendingCheckouts, updatedAt: new Date() })
        .where(and(eq(cloudWorkspace.id, id), eq(cloudWorkspace.organizationId, organizationId)))
        .returning();
      if (!row) throw new Error("Cloud workspace not found");
      return row;
    },
    async requestOperation(id: string, organizationId: string, operation: CloudWorkspaceOperation) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(cloudWorkspace)
          .where(and(eq(cloudWorkspace.id, id), eq(cloudWorkspace.organizationId, organizationId)))
          .for("update");
        if (!row) throw new Error("Cloud workspace not found");
        const previous = row.operation;
        if (previous?.id === operation.id) {
          if (
            previous.kind !== operation.kind ||
            previous.revision !== operation.revision ||
            JSON.stringify(previous.resources) !== JSON.stringify(operation.resources)
          ) {
            throw new AppError(
              "This request key belongs to a different workspace operation",
              409,
              "IDEMPOTENCY_KEY_CONFLICT",
            );
          }
          if (previous.status !== "failed") return row;
        } else if (previous && previous.status !== "succeeded") {
          if (
            previous.kind === "ensure" &&
            operation.kind === "ensure" &&
            previous.status !== "failed"
          )
            return row;
          if (previous.status !== "failed" || previous.restartWorkloads !== undefined) {
            throw new AppError(
              "Finish or retry the current workspace operation first",
              409,
              "CLOUD_WORKSPACE_BUSY",
            );
          }
        }
        if (row.deletionInProgress && operation.kind !== "delete")
          throw new Error("Cloud workspace is being deleted");
        if (operation.kind === "resize" || operation.kind === "delete") {
          const [migration] = await tx.select({ id: dockerMigrationRun.id }).from(dockerMigrationRun)
            .innerJoin(servers, or(eq(servers.id, dockerMigrationRun.sourceServerId), eq(servers.id, dockerMigrationRun.targetServerId)))
            .where(and(eq(servers.workspaceId, id), activeMigration)).limit(1);
          if (migration) throw new AppError("Finish or cancel this server's migration before changing the server", 409, "CLOUD_WORKSPACE_MIGRATION_ACTIVE");
        }
        if (operation.kind === "resize") {
          const members = await tx
            .select({ id: project.id })
            .from(project)
            .where(eq(project.workspaceId, id));
          if (members.some((member) => !operation.restartProjectIds?.includes(member.id))) {
            throw new AppError(
              "Workspace membership changed. Review the resize again.",
              409,
              "CLOUD_WORKSPACE_CHANGED",
            );
          }
        }
        if (operation.kind === "delete") {
          if (row.linkedProjects.some(link => link.projects.length))
            throw new AppError("This server still has projects on a connected installation. Remove or move them before deleting the server.", 409, "CLOUD_WORKSPACE_NOT_EMPTY");
          const [member] = await tx
            .select({ id: project.id })
            .from(project)
            .where(eq(project.workspaceId, id))
            .limit(1);
          if (member)
            throw new AppError(
              "Delete or migrate this workspace's projects before deleting the workspace",
              409,
              "CLOUD_WORKSPACE_NOT_EMPTY",
            );
        }
        const [updated] = await tx
          .update(cloudWorkspace)
          .set({
            operation,
            updatedAt: new Date(),
            ...(operation.kind === "delete" ? { deletionInProgress: new Date() } : {}),
          })
          .where(eq(cloudWorkspace.id, id))
          .returning();
        return updated!;
      });
    },
    async updateOperation(
      id: string,
      operation: CloudWorkspaceOperation,
      expectedOperationId: string,
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(cloudWorkspace)
          .where(eq(cloudWorkspace.id, id))
          .for("update");
        if (!row || row.operation?.id !== expectedOperationId)
          throw new Error("Workspace operation changed");
        const [updated] = await tx
          .update(cloudWorkspace)
          .set({ operation, updatedAt: new Date() })
          .where(eq(cloudWorkspace.id, id))
          .returning();
        return updated!;
      });
    },
    /** A definitive remote refusal has no provider side effect. Undo only the
     * matching local intent; a timeout stays pending until it is reconciled. */
    async rejectLinkedOperation(id: string, organizationId: string, operationId: string, error: string) {
      await db.update(cloudWorkspace).set({
        deletionInProgress: null,
        operation: sql`jsonb_set(jsonb_set(${cloudWorkspace.operation}, '{status}', '"failed"'), '{error}', ${JSON.stringify(error)}::jsonb)`,
        updatedAt: new Date(),
      }).where(and(eq(cloudWorkspace.id, id), eq(cloudWorkspace.organizationId, organizationId),
        isNotNull(cloudWorkspace.remote), sql`${cloudWorkspace.operation}->>'id' = ${operationId}`));
    },
    async listPendingOperations(limit = 50) {
      return db
        .select()
        .from(cloudWorkspace)
        .where(
          and(
            isNotNull(cloudWorkspace.operation),
            sql`${cloudWorkspace.operation}->>'status' IN ('queued', 'running')`,
          ),
        )
        .orderBy(asc(cloudWorkspace.updatedAt))
        .limit(limit);
    },
    /** Serialized with lifecycle intent on the same workspace row. The caller
     * also holds its controller's advisory lock for the entire critical section. */
    async claimActivity(id: string, organizationId: string, activity: CloudWorkspaceActivity, lifecycle = false,
      linkedProjects?: Array<{ id: string; name: string }>) {
      return db.transaction(async tx => {
        const [row] = await tx.select().from(cloudWorkspace).where(and(
          eq(cloudWorkspace.id, id), eq(cloudWorkspace.organizationId, organizationId),
        )).for("update");
        if (!row) throw new AppError("Managed server not found", 404, "CLOUD_WORKSPACE_NOT_FOUND");
        if (row.activity) {
          if (row.activity.id !== activity.id || row.activity.controllerId !== activity.controllerId || row.activity.scope !== activity.scope)
            throw new AppError("This server has an operation in progress. Let it finish on the installation that started it before changing the server.", 409, "CLOUD_WORKSPACE_ACTIVITY_BUSY");
        }
        if (!lifecycle && (row.deletionInProgress || (row.operation?.kind === "resize" && row.operation.status !== "succeeded")))
          throw new AppError("Finish the server's current operation before starting work", 409, "CLOUD_WORKSPACE_BUSY");
        const links = linkedProjects ? await updatedLinkedProjects(tx, row, activity.controllerId, linkedProjects) : undefined;
        const claim = row.activity ?? activity;
        await tx.update(cloudWorkspace).set({ activity: claim,
          ...(links ? { linkedProjects: links } : {}),
        }).where(eq(cloudWorkspace.id, id));
        return claim;
      });
    },
    async recordActivityCommand(id: string, activityId: string, command: import("@repo/core").ManagedCommandRef) {
      await db.transaction(async tx => {
        const [row] = await tx.select().from(cloudWorkspace).where(eq(cloudWorkspace.id, id)).for("update");
        if (!row?.activity || row.activity.id !== activityId || row.activity.settled)
          throw new AppError("The server operation no longer owns command execution", 409, "CLOUD_WORKSPACE_ACTIVITY_CHANGED");
        await tx.update(cloudWorkspace).set({ activity: { ...row.activity, commands: [
          ...(row.activity.commands ?? []).filter(item => item.marker !== command.marker), command,
        ] } }).where(eq(cloudWorkspace.id, id));
      });
    },
    async completeActivityCommand(id: string, activityId: string, marker: string) {
      await db.transaction(async tx => {
        const [row] = await tx.select().from(cloudWorkspace).where(eq(cloudWorkspace.id, id)).for("update");
        if (row?.activity?.id !== activityId) return;
        await tx.update(cloudWorkspace).set({ activity: { ...row.activity,
          commands: (row.activity.commands ?? []).filter(item => item.marker !== marker),
        } }).where(eq(cloudWorkspace.id, id));
      });
    },
    async settleActivity(id: string, activityId: string) {
      await db.update(cloudWorkspace).set({ activity: sql`jsonb_set(${cloudWorkspace.activity}, '{settled}', 'true')` })
        .where(and(eq(cloudWorkspace.id, id), sql`${cloudWorkspace.activity}->>'id' = ${activityId}`,
          sql`jsonb_array_length(coalesce(${cloudWorkspace.activity}->'commands', '[]'::jsonb)) = 0`));
    },
    async releaseActivity(id: string, organizationId: string, activityId: string, controllerId: string,
      linkedProjects?: Array<{ id: string; name: string }>) {
      await db.transaction(async tx => {
        const [row] = await tx.select().from(cloudWorkspace).where(and(
          eq(cloudWorkspace.id, id), eq(cloudWorkspace.organizationId, organizationId),
        )).for("update");
        if (row?.activity?.id !== activityId || row.activity.controllerId !== controllerId) return;
        if (row.activity.commands?.length)
          throw new AppError("A command on this server has not confirmed its exit. Retry the interrupted operation to recover it.", 409, "CLOUD_COMMAND_EXIT_UNCONFIRMED");
        const links = linkedProjects ? await updatedLinkedProjects(tx, row, controllerId, linkedProjects) : undefined;
        await tx.update(cloudWorkspace).set({ activity: null,
          ...(links ? { linkedProjects: links } : {}),
        }).where(eq(cloudWorkspace.id, id));
      });
    },
    async listSettledLinkedActivities(limit = 50) {
      return db.select().from(cloudWorkspace).where(and(isNotNull(cloudWorkspace.remote),
        sql`${cloudWorkspace.activity}->>'settled' = 'true'`)).limit(limit);
    },
    async findDeletion(serverId: string, organizationId: string, operationId: string) {
      return db.query.cloudServerDeletion.findFirst({ where: and(
        eq(cloudServerDeletion.serverId, serverId), eq(cloudServerDeletion.organizationId, organizationId),
        eq(cloudServerDeletion.operationId, operationId),
      ) });
    },
    /** Only called after provider deletion is confirmed. Membership is blocked
     * by deletionInProgress and independently protected by its RESTRICT FK. */
    async finishDeletion(id: string, organizationId: string) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(cloudWorkspace)
          .where(and(eq(cloudWorkspace.id, id), eq(cloudWorkspace.organizationId, organizationId)))
          .for("update");
        if (!row?.deletionInProgress) throw new Error("Workspace deletion was not requested");
        const [member] = await tx
          .select({ id: project.id })
          .from(project)
          .where(eq(project.workspaceId, id))
          .limit(1);
        if (member) throw new Error("Cloud workspace still contains projects");
        if (row.linkedProjects.some(link => link.projects.length)) throw new Error("Cloud workspace still contains linked projects");
        const [server] = await tx.select({ id: servers.id }).from(servers)
          .where(and(eq(servers.workspaceId, id), eq(servers.organizationId, organizationId)));
        if (!server || row.operation?.kind !== "delete") throw new Error("Server deletion identity is missing");
        await tx.insert(cloudServerDeletion).values({
          serverId: server.id, workspaceId: id, organizationId, operationId: row.operation.id,
        });
        await tx.delete(cloudDockerWorkspace).where(eq(cloudDockerWorkspace.ownerWorkspaceId, id));
        await tx.delete(servers).where(and(eq(servers.workspaceId, id), eq(servers.organizationId, organizationId)));
        await tx.delete(cloudWorkspace).where(eq(cloudWorkspace.id, id));
      });
    },
  };
}
