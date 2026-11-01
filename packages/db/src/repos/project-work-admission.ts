import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { AppError } from "@repo/core";
import type { Database } from "../client";
import { project } from "../schema";

type RepoTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Configuration writes and promotion's deletion claim lock the same project
 * rows. Call inside the write transaction: a write that wins is included in the
 * final source check; a claim that wins rejects the write before it changes data.
 * Ordinary teardown keeps its existing worker/cancellation semantics. */
export async function assertProjectConfigurationWritable(
  tx: RepoTransaction,
  predicate: SQL,
): Promise<void> {
  const owners = await tx
    .select({
      deletionInProgress: project.deletionInProgress,
      lifecycleOperation: project.lifecycleOperation,
      cloudPromotion: project.cloudPromotion,
    })
    .from(project)
    .where(predicate)
    .orderBy(asc(project.id))
    .for("update");
  if (owners.some((owner) => owner.deletionInProgress && owner.cloudPromotion?.cleanupInProgress))
    throw new AppError(
      "This project is being transferred to Cloud. Configuration changes are temporarily blocked until cleanup finishes.",
      409,
      "PROJECT_TRANSFER_IN_PROGRESS",
    );
  if (owners.some((owner) => owner.deletionInProgress && owner.lifecycleOperation?.kind === "delete"))
    throw new AppError(
      "Project cleanup is pending. Finish deletion before changing its configuration.",
      409,
      "PROJECT_DELETION_PENDING",
    );
}

export function withProjectConfigurationWrite<T>(
  db: Database,
  predicate: SQL,
  write: (tx: RepoTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await assertProjectConfigurationWritable(tx, predicate);
    return write(tx);
  });
}

/**
 * Serialize creation of project-scoped background work with project deletion.
 *
 * `project.claimDeletion()` updates (and therefore locks) this same row. If work
 * wins, its insert commits before deletion can claim and the teardown's in-lock
 * active read sees it. If deletion wins, the predicate is re-evaluated after the
 * wait and the work insert is refused. Callers MUST perform the durable work-row
 * insert inside `insert`; a precheck followed by a later insert reopens the race.
 *
 * A null project is mail-server-scoped work, so it has no project deletion gate;
 * it still uses the transaction so callers have one insertion contract.
 */
export async function withProjectWorkAdmission<T>(
  db: Database,
  projectId: string | readonly string[] | null | undefined,
  organizationId: string,
  insert: (tx: RepoTransaction) => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as RepoTransaction;
    const projectIds = [
      ...new Set(
        (Array.isArray(projectId) ? projectId : projectId ? [projectId] : []).filter(Boolean),
      ),
    ].sort();
    if (projectIds.length > 0) {
      // One migration may touch a source and a newly-created copy. Lock every
      // project in stable order so deletion of either side serializes with the
      // work claim without introducing cross-project deadlocks.
      const owners = await tx
        .select({ id: project.id })
        .from(project)
        .where(
          and(
            inArray(project.id, projectIds),
            eq(project.organizationId, organizationId),
            eq(project.deletionInProgress, false),
            isNull(project.deletedAt),
          ),
        )
        .orderBy(asc(project.id))
        .for("update");
      if (owners.length !== projectIds.length) return undefined;
    }
    return insert(tx);
  });
}
