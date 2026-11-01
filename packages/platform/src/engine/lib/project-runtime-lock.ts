import { AsyncLocalStorage } from "node:async_hooks";
import { repos, type Project } from "@repo/db";
import { AppError } from "@repo/core";
import { createProvisionLock } from "./provision-lock";
import { withCloudWorkspaceActivity } from "./cloud-workspace-lock";

/** Locks already owned by the current async call tree (nested helpers are safe). */
const heldProjectRuntimeLocks = new AsyncLocalStorage<
  ReadonlyMap<string, { active: boolean; runtime: boolean; transition?: boolean }>
>();

/** Detached deployment workers must acquire their own project ownership. */
export function runOutsideProjectRuntimeLock<T>(work: () => T): T {
  return heldProjectRuntimeLocks.exit(work);
}

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

export async function withProjectRuntimeLock<T>(
  projectId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const held = heldProjectRuntimeLocks.getStore();
  const owner = held?.get(projectId);
  if (owner?.active) {
    if (!owner.runtime)
      throw new AppError(
        "Project state admission cannot acquire runtime privileges",
        409,
        "PROJECT_RUNTIME_LOCK_UPGRADE_FORBIDDEN",
      );
    return fn();
  }

  const project = await repos.project.findById(projectId);
  return withCloudWorkspaceActivity(
    project?.workspaceId,
    () => runProjectLock(projectId, fn, true, signal),
    signal,
    { scope: `project:${projectId}` },
  );
}

/** DB-only submission shares deletion's project lock without claiming the host.
 * Runtime work must acquire workspace admission first, never upgrade this scope. */
export function withProjectStateLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const guarded = async () => {
    await assertRuntimeTransitionSettled(projectId);
    return fn();
  };
  if (heldProjectRuntimeLocks.getStore()?.get(projectId)?.active) return guarded();
  return runProjectLock(projectId, guarded, false);
}

async function assertRuntimeTransitionSettled(projectId: string): Promise<void> {
  if (heldProjectRuntimeLocks.getStore()?.get(projectId)?.transition) return;
  if ((await repos.deployment.listPendingRoleHandovers(projectId)).length > 0) {
    throw new AppError(
      "A runtime role handover still needs recovery. Retry when the server is reachable, or discard the cancelled deployment's kept containers.",
      409,
      "ROLE_HANDOVER_RECOVERY_PENDING",
    );
  }
}

/** The transition owner may finish/recover its durable work. Other project
 * edits and runtime writers must wait for that work to settle. */
export function withProjectRuntimeTransition<T>(
  projectId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withProjectRuntimeLock(
    projectId,
    async () => {
      const scope = heldProjectRuntimeLocks.getStore()!.get(projectId)!;
      const previous = scope.transition;
      scope.transition = true;
      try {
        return await fn();
      } finally {
        scope.transition = previous;
      }
    },
    signal,
  );
}

function runProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
  runtime: boolean,
  signal?: AbortSignal,
): Promise<T> {
  return createProvisionLock(projectRuntimeLockKey(projectId)).run(async () => {
    const held = heldProjectRuntimeLocks.getStore();
    const scope = { active: true, runtime };
    const next = new Map(held);
    next.set(projectId, scope);
    try {
      return await heldProjectRuntimeLocks.run(next, fn);
    } finally {
      // A detached deployment inherits the async context, not ownership of a
      // lock that its request has already released. It must reacquire normally.
      scope.active = false;
    }
  }, signal);
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
    await assertRuntimeTransitionSettled(projectId);
    return mutate(project);
  });
}
