import { AsyncLocalStorage } from "node:async_hooks";
import { repos, type Project } from "@repo/db";
import { createProvisionLock } from "./provision-lock";
import { withCloudWorkspaceActivity } from "./cloud-workspace-lock";

/** Locks already owned by the current async call tree (nested helpers are safe). */
const heldProjectRuntimeLocks = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

/**
 * One cross-process critical section for a project's live routing/runtime state.
 *
 * A project edit may re-emit routes after committing its DB rows, while deletion
 * removes those same routes and then drops the rows that describe them. Both must
 * use this lock: if the edit wins, deletion waits and removes its result; if
 * deletion wins, the edit rechecks the row under the lock and performs no remote
 * write. The underlying provision lock is an in-process mutex plus a Postgres
 * session advisory lock, so this also holds across Cloud API replicas without a
 * long-running database transaction.
 */
export function projectRuntimeLockKey(projectId: string): string {
  return `project-runtime:${projectId}`;
}

export async function withProjectRuntimeLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const held = heldProjectRuntimeLocks.getStore();
  if (held?.get(projectId)?.active) return fn();

  const project = await repos.project.findById(projectId);
  return withCloudWorkspaceActivity(project?.workspaceId, () => createProvisionLock(projectRuntimeLockKey(projectId)).run(async () => {
    const scope = { active: true };
    const next = new Map(held);
    next.set(projectId, scope);
    try {
      return await heldProjectRuntimeLocks.run(next, fn);
    } finally {
      // A detached deployment inherits the async context, not ownership of a
      // lock that its request has already released. It must reacquire normally.
      scope.active = false;
    }
  }), undefined, { scope: `project:${projectId}` });
}

/**
 * The sole admission gate for code that can mutate a project's live remote
 * state (routes, certificates, or equivalent) after its DB mutation commits.
 *
 * Re-reading under the shared teardown lock closes both orderings: a writer that
 * wins is cleaned by the later delete; a delete that wins leaves no live row (or
 * a claimed one), so the stale writer is skipped. `undefined` means no mutation
 * ran because teardown owns/removed the project.
 */
export function withLiveProjectRuntimeMutation<T>(
  projectId: string,
  mutate: (project: Project) => Promise<T>,
): Promise<T | undefined> {
  return withProjectRuntimeLock(projectId, async () => {
    const project = await repos.project.findById(projectId);
    if (!project || project.deletionInProgress) return undefined;
    return mutate(project);
  });
}
