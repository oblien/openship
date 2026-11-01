import { and, asc, eq, ne, or, sql, isNull, isNotNull } from "drizzle-orm";
import { AppError, type ManagedCommandRef } from "@repo/core";
import type { Database, DatabaseTransaction } from "../client";
import {
  cloudBuildActivity,
  cloudDockerWorkspace,
  cloudWorkspace,
  project,
  deployment,
  buildSession,
} from "../schema";
import type { CloudWorkspaceActivity } from "../schema";

export interface CloudBuildActivityIdentity {
  workspaceId: string;
  organizationId: string;
  deploymentId: string;
  projectId: string;
}

/** Older controllers only inspect the singleton activity. Keep an exclusive
 * barrier there while shared executions exist; their commands stay per execution. */
function sharedBarrier(workspaceId: string): CloudWorkspaceActivity {
  return {
    id: `cloud-builds:${workspaceId}`,
    controllerId: "saas",
    scope: "cloud-builds",
    startedAt: new Date().toISOString(),
  };
}

function isSharedBarrier(activity: CloudWorkspaceActivity | null, workspaceId: string): boolean {
  return (
    activity?.id === `cloud-builds:${workspaceId}` &&
    activity.controllerId === "saas" &&
    activity.scope === "cloud-builds" &&
    !activity.settled &&
    !activity.commands?.length
  );
}

/** Must run under the workspace row lock shared by both admission protocols. */
export async function assertNoCloudBuildActivities(tx: DatabaseTransaction, workspaceId: string) {
  const [active] = await tx
    .select({ id: cloudBuildActivity.deploymentId })
    .from(cloudBuildActivity)
    .where(
      and(
        eq(cloudBuildActivity.workspaceId, workspaceId),
        isNull(cloudBuildActivity.finishedAt),
        isNotNull(cloudBuildActivity.ownerToken),
      ),
    )
    .limit(1);
  if (active)
    throw new AppError(
      "A Cloud build still owns this server. Finish or recover it before exclusive work.",
      409,
      "CLOUD_WORKSPACE_ACTIVITY_BUSY",
    );
}

export interface CloudBuildResources {
  cpuCores: number;
  memoryMb: number;
}

/** Compose with the deployment lease claim in its transaction for atomic admission.
 * Capacity policy is enforced by the caller under its shared admission lock.
 * A reservation has no host privileges and does not exclude lifecycle work. */
export async function reserveCloudBuildActivity(
  tx: DatabaseTransaction,
  input: CloudBuildActivityIdentity,
  resources: CloudBuildResources | null,
  buildSessionId?: string,
  exclusivePreparation = false,
) {
  if (
    resources &&
    (!Number.isFinite(resources.cpuCores) ||
      resources.cpuCores < 0 ||
      !Number.isFinite(resources.memoryMb) ||
      resources.memoryMb < 0)
  )
    throw new AppError(
      "Invalid Cloud build reservation resources",
      400,
      "CLOUD_BUILD_RESOURCES_INVALID",
    );
  const [workspace] = await tx
    .select()
    .from(cloudWorkspace)
    .where(
      and(
        eq(cloudWorkspace.id, input.workspaceId),
        eq(cloudWorkspace.organizationId, input.organizationId),
      ),
    )
    .for("update");
  if (!workspace || workspace.remote)
    throw new AppError(
      "Cloud build reservation requires an available local workspace",
      409,
      "CLOUD_BUILD_ACTIVITY_LOCAL_ONLY",
    );
  if (
    (workspace.activity && !isSharedBarrier(workspace.activity, input.workspaceId)) ||
    workspace.deletionInProgress ||
    (workspace.operation && workspace.operation.status !== "succeeded")
  )
    throw new AppError(
      "Finish the server operation before reserving a build",
      409,
      "CLOUD_WORKSPACE_ACTIVITY_BUSY",
    );
  await assertBuildIdentity(tx, input);
  const [row] = await tx
    .insert(cloudBuildActivity)
    .values({ ...input, resources, buildSessionId, exclusivePreparation })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await tx
    .select()
    .from(cloudBuildActivity)
    .where(eq(cloudBuildActivity.deploymentId, input.deploymentId));
  if (
    !existing ||
    existing.workspaceId !== input.workspaceId ||
    existing.organizationId !== input.organizationId ||
    existing.projectId !== input.projectId ||
    existing.finishedAt ||
    existing.resources?.cpuCores !== resources?.cpuCores ||
    existing.resources?.memoryMb !== resources?.memoryMb ||
    (buildSessionId && existing.buildSessionId !== buildSessionId) ||
    existing.exclusivePreparation !== exclusivePreparation
  )
    throw new AppError(
      "Cloud build reservation identity changed",
      409,
      "CLOUD_BUILD_ACTIVITY_CHANGED",
    );
  return existing;
}

async function assertBuildIdentity(tx: DatabaseTransaction, input: CloudBuildActivityIdentity) {
  const [row] = await tx
    .select({ id: deployment.id })
    .from(deployment)
    .innerJoin(project, eq(project.id, deployment.projectId))
    .where(
      and(
        eq(deployment.id, input.deploymentId),
        eq(deployment.projectId, input.projectId),
        eq(deployment.organizationId, input.organizationId),
        eq(project.organizationId, input.organizationId),
        eq(project.workspaceId, input.workspaceId),
        isNull(project.deletedAt),
        eq(project.deletionInProgress, false),
      ),
    );
  if (!row)
    throw new AppError(
      "The deployment does not belong to this live project and Cloud workspace",
      409,
      "BUILD_OWNERSHIP_MISMATCH",
    );
}

export function createCloudBuildActivityRepo(db: Database) {
  const match = (input: CloudBuildActivityIdentity) =>
    and(
      eq(cloudBuildActivity.deploymentId, input.deploymentId),
      eq(cloudBuildActivity.workspaceId, input.workspaceId),
      eq(cloudBuildActivity.organizationId, input.organizationId),
      eq(cloudBuildActivity.projectId, input.projectId),
    );
  const changed = () =>
    new AppError("Cloud build execution ownership changed", 409, "CLOUD_BUILD_ACTIVITY_CHANGED");
  async function owner(tx: DatabaseTransaction, input: CloudBuildActivityIdentity, token: string) {
    const [row] = await tx.select().from(cloudBuildActivity).where(match(input)).for("update");
    if (!row || row.finishedAt || row.ownerToken !== token) throw changed();
    return row;
  }
  return {
    reserve: (
      input: CloudBuildActivityIdentity & {
        buildSessionId?: string;
        resources: CloudBuildResources | null;
        exclusivePreparation?: boolean;
      },
    ) =>
      db.transaction((tx) =>
        reserveCloudBuildActivity(
          tx,
          input,
          input.resources,
          input.buildSessionId,
          input.exclusivePreparation,
        ),
      ),
    async cancelReservation(input: CloudBuildActivityIdentity) {
      const [row] = await db
        .update(cloudBuildActivity)
        .set({ finishedAt: new Date(), slotReleasedAt: new Date() })
        .where(
          and(
            match(input),
            isNull(cloudBuildActivity.ownerToken),
            isNull(cloudBuildActivity.finishedAt),
          ),
        )
        .returning();
      return !!row;
    },
    async listReservations(workspaceId: string, organizationId: string) {
      return db
        .select()
        .from(cloudBuildActivity)
        .where(
          and(
            eq(cloudBuildActivity.workspaceId, workspaceId),
            eq(cloudBuildActivity.organizationId, organizationId),
            isNull(cloudBuildActivity.finishedAt),
            isNull(cloudBuildActivity.slotReleasedAt),
          ),
        );
    },
    /** Admission coordination, including pending workers and deployment/cleanup
     * after build capacity was released. This does not relax exclusive fences. */
    async listActive(workspaceId: string, organizationId: string) {
      return db
        .select()
        .from(cloudBuildActivity)
        .where(
          and(
            eq(cloudBuildActivity.workspaceId, workspaceId),
            eq(cloudBuildActivity.organizationId, organizationId),
            isNull(cloudBuildActivity.finishedAt),
          ),
        )
        .orderBy(asc(cloudBuildActivity.reservedAt), asc(cloudBuildActivity.deploymentId));
    },
    /** Independent of deployment/session status and released build capacity.
     * Snapshot pages before closing rows: offset pagination across a shrinking
     * result set can skip work. A later sweep safely revisits anything deferred. */
    async listUnfinished({ limit = 200, offset = 0 }: { limit?: number; offset?: number } = {}) {
      return db
        .select()
        .from(cloudBuildActivity)
        .where(
          or(
            isNull(cloudBuildActivity.finishedAt),
            // A crash can happen after host ownership closes but before the outer
            // execution acknowledgement. Retain that receipt in recovery scans.
            sql`exists (select 1 from ${buildSession}
          where ${buildSession.deploymentId} = ${cloudBuildActivity.deploymentId}
            and ${buildSession.startedAt} is not null and ${buildSession.finishedAt} is null)`,
          ),
        )
        .orderBy(asc(cloudBuildActivity.reservedAt), asc(cloudBuildActivity.deploymentId))
        .limit(limit)
        .offset(offset);
    },
    async find(input: CloudBuildActivityIdentity) {
      const [row] = await db.select().from(cloudBuildActivity).where(match(input));
      return row;
    },
    /** Caller holds the execution advisory lock; duplicate IDs never restart work. */
    async claim(input: CloudBuildActivityIdentity, ownerToken: string) {
      return db.transaction(async (tx) => {
        const [workspace] = await tx
          .select()
          .from(cloudWorkspace)
          .where(
            and(
              eq(cloudWorkspace.id, input.workspaceId),
              eq(cloudWorkspace.organizationId, input.organizationId),
            ),
          )
          .for("update");
        if (!workspace)
          throw new AppError("Managed server not found", 404, "CLOUD_WORKSPACE_NOT_FOUND");
        if (workspace.remote)
          throw new AppError(
            "Shared builds require a local Cloud server",
            409,
            "CLOUD_BUILD_ACTIVITY_LOCAL_ONLY",
          );
        if (
          (workspace.activity && !isSharedBarrier(workspace.activity, input.workspaceId)) ||
          workspace.deletionInProgress ||
          (workspace.operation && workspace.operation.status !== "succeeded")
        )
          throw new AppError(
            "Finish the server operation before building",
            409,
            "CLOUD_WORKSPACE_ACTIVITY_BUSY",
          );
        const [binding] = await tx
          .select()
          .from(cloudDockerWorkspace)
          .where(eq(cloudDockerWorkspace.ownerWorkspaceId, input.workspaceId))
          .for("update");
        if (!binding?.workspaceId || binding.state !== "ready")
          throw new AppError(
            "Provision the Cloud server before shared build admission",
            409,
            "CLOUD_BUILD_HOST_NOT_READY",
          );
        await assertBuildIdentity(tx, input);
        // The process mutex can disappear while the old deployment's command
        // continues remotely. Do not let its successor mutate the same project.
        const [interrupted] = await tx
          .select({ id: cloudBuildActivity.deploymentId })
          .from(cloudBuildActivity)
          .where(
            and(
              eq(cloudBuildActivity.workspaceId, input.workspaceId),
              eq(cloudBuildActivity.projectId, input.projectId),
              ne(cloudBuildActivity.deploymentId, input.deploymentId),
              isNotNull(cloudBuildActivity.ownerToken),
              isNull(cloudBuildActivity.finishedAt),
            ),
          )
          .limit(1);
        if (interrupted)
          throw new AppError(
            "Recover the previous Cloud build before starting another for this project",
            409,
            "CLOUD_BUILD_PROJECT_BUSY",
          );
        const [existing] = await tx
          .select()
          .from(cloudBuildActivity)
          .where(eq(cloudBuildActivity.deploymentId, input.deploymentId))
          .for("update");
        if (existing) {
          if (
            existing.workspaceId !== input.workspaceId ||
            existing.organizationId !== input.organizationId ||
            existing.projectId !== input.projectId ||
            existing.ownerToken ||
            existing.finishedAt
          )
            throw changed();
          if (existing.resources) {
            // Unactivated reservations do not prevent resize. Revalidate against
            // the current binding, including siblings that activated after resize.
            const siblings = await tx
              .select({ resources: cloudBuildActivity.resources })
              .from(cloudBuildActivity)
              .where(
                and(
                  eq(cloudBuildActivity.workspaceId, input.workspaceId),
                  isNotNull(cloudBuildActivity.ownerToken),
                  isNull(cloudBuildActivity.finishedAt),
                  isNull(cloudBuildActivity.slotReleasedAt),
                ),
              );
            const allocations = [
              existing.resources,
              ...siblings.flatMap((row) => (row.resources ? [row.resources] : [])),
            ];
            const capacity = binding.resources;
            // Same structural headroom as platform cloud-build-resources.ts.
            const memoryBudget = Math.floor(
              capacity.memoryMb - Math.min(512, Math.max(128, capacity.memoryMb * 0.05)),
            );
            const cpu = allocations.reduce((sum, item) => sum + item.cpuCores, 0);
            const memory = allocations.reduce((sum, item) => sum + item.memoryMb, 0);
            const tolerance = Number.EPSILON * capacity.cpuCores * (allocations.length + 2);
            if (
              !Number.isFinite(capacity.cpuCores) ||
              capacity.cpuCores <= 0 ||
              !Number.isFinite(memoryBudget) ||
              allocations.some(
                (item) =>
                  !Number.isFinite(item.cpuCores) ||
                  item.cpuCores < 0 ||
                  !Number.isFinite(item.memoryMb) ||
                  item.memoryMb < 0,
              ) ||
              !Number.isFinite(cpu) ||
              !Number.isFinite(memory) ||
              cpu - capacity.cpuCores > tolerance ||
              memory > memoryBudget
            )
              throw new AppError(
                "The reserved build resources no longer fit the current server capacity. Retry after freeing resources or resizing the server.",
                409,
                "CLOUD_WORKSPACE_BUILD_CAPACITY",
              );
          }
          const [row] = await tx
            .update(cloudBuildActivity)
            .set({ ownerToken, providerWorkspaceId: binding.workspaceId, startedAt: new Date() })
            .where(match(input))
            .returning();
          if (!workspace.activity)
            await tx
              .update(cloudWorkspace)
              .set({ activity: sharedBarrier(input.workspaceId) })
              .where(eq(cloudWorkspace.id, input.workspaceId));
          return row!;
        }
        const [row] = await tx
          .insert(cloudBuildActivity)
          .values({
            ...input,
            ownerToken,
            providerWorkspaceId: binding.workspaceId,
            startedAt: new Date(),
          })
          .onConflictDoNothing()
          .returning();
        if (!row) throw changed();
        if (!workspace.activity)
          await tx
            .update(cloudWorkspace)
            .set({ activity: sharedBarrier(input.workspaceId) })
            .where(eq(cloudWorkspace.id, input.workspaceId));
        return row;
      });
    },
    /** Only after try-acquiring the exact execution's live-owner advisory lock.
     * Lifecycle intent may be pending: recovery must still be able to drain. */
    async takeRecoveryOwnership(input: CloudBuildActivityIdentity, ownerToken: string) {
      const [row] = await db
        .update(cloudBuildActivity)
        .set({ ownerToken })
        .where(
          and(
            match(input),
            isNull(cloudBuildActivity.finishedAt),
            isNotNull(cloudBuildActivity.ownerToken),
          ),
        )
        .returning();
      return row;
    },
    async recordCommand(
      input: CloudBuildActivityIdentity,
      token: string,
      command: ManagedCommandRef,
    ) {
      await db.transaction(async (tx) => {
        const row = await owner(tx, input, token);
        if (command.workspaceId !== row.providerWorkspaceId)
          throw new AppError(
            "The command belongs to another Cloud server",
            409,
            "CLOUD_SERVER_IDENTITY_MISMATCH",
          );
        await tx
          .update(cloudBuildActivity)
          .set({
            commands: [...row.commands.filter((item) => item.marker !== command.marker), command],
          })
          .where(match(input));
      });
    },
    async completeCommand(input: CloudBuildActivityIdentity, token: string, marker: string) {
      await db.transaction(async (tx) => {
        const row = await owner(tx, input, token);
        await tx
          .update(cloudBuildActivity)
          .set({ commands: row.commands.filter((item) => item.marker !== marker) })
          .where(match(input));
      });
    },
    /** Capacity only: the activity continues fencing lifecycle and tracking commands. */
    async releaseSlot(input: CloudBuildActivityIdentity, token: string) {
      await db.transaction(async (tx) => {
        const row = await owner(tx, input, token);
        if (row.commands.length)
          throw new AppError(
            "Build commands must finish before releasing capacity",
            503,
            "CLOUD_COMMAND_EXIT_UNCONFIRMED",
          );
        if (!row.slotReleasedAt)
          await tx
            .update(cloudBuildActivity)
            .set({ slotReleasedAt: new Date() })
            .where(match(input));
      });
    },
    async finish(input: CloudBuildActivityIdentity, token: string) {
      await db.transaction(async (tx) => {
        // Same order as claim: workspace before execution. The last completion
        // and a new activation cannot clear or cross each other's legacy barrier.
        const [workspace] = await tx
          .select()
          .from(cloudWorkspace)
          .where(
            and(
              eq(cloudWorkspace.id, input.workspaceId),
              eq(cloudWorkspace.organizationId, input.organizationId),
            ),
          )
          .for("update");
        if (!workspace) throw changed();
        const row = await owner(tx, input, token);
        if (row.commands.length)
          throw new AppError(
            "A Cloud build command has not confirmed its exit",
            503,
            "CLOUD_COMMAND_EXIT_UNCONFIRMED",
          );
        await tx.update(cloudBuildActivity).set({ finishedAt: new Date() }).where(match(input));
        const [remaining] = await tx
          .select({ id: cloudBuildActivity.deploymentId })
          .from(cloudBuildActivity)
          .where(
            and(
              eq(cloudBuildActivity.workspaceId, input.workspaceId),
              isNotNull(cloudBuildActivity.ownerToken),
              isNull(cloudBuildActivity.finishedAt),
            ),
          )
          .limit(1);
        if (!remaining && isSharedBarrier(workspace.activity, input.workspaceId))
          await tx
            .update(cloudWorkspace)
            .set({ activity: null })
            .where(eq(cloudWorkspace.id, input.workspaceId));
      });
    },
  };
}
