import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../client";
import { project } from "../schema";

type RepoTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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
