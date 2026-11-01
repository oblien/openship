/**
 * The role rollout: decides the ORDER in which a deployment's worker and
 * scheduler containers are started, checked, handed over, kept or unwound.
 *
 * A deploy with roles runs: release phase, then this module, then the web
 * container's own pipeline, then `commit()` on success or `abort()` on failure.
 * Every side effect (start, verify, stop, restart, destroy) is injected, so the
 * ordering below is testable with fakes and no runtime, container or daemon.
 *
 * THE ORDER, and why:
 *
 *  1. Scalable roles (workers) start BESIDE the previous deployment's
 *     containers. The old ones keep running until `commit()`, so a deploy that
 *     fails leaves the previous version's workers untouched.
 *  2. Those replicas are checked BEFORE any singleton is touched. A broken
 *     worker must never cost the running scheduler its slot.
 *  3. Singleton roles (schedulers, or `singleton: true`) run exactly one
 *     instance, so the handover is stop-first: the previous containers for that
 *     role NAME are stopped and RETAINED (not destroyed), then the new one
 *     starts. A new and an old scheduler must never run together, or every cron
 *     tick fires twice. A previous singleton that no new role continues with
 *     the same name and command is OUTGOING (see `planSingletonHandover`):
 *     when another role changed, it is stopped and retained after the
 *     unchanged workers are checked and before any changed role starts.
 *  4. Any failure destroys what this deployment started, THEN restarts the
 *     retained singletons. Destroy comes first so the old and new singleton are
 *     never both up during the unwind either: a retained singleton is restored
 *     only after every replacement for its role was successfully removed. For
 *     an outgoing singleton, every changed role counts as a replacement.
 *     A failed or timed-out removal leaves that role stopped and logs the IDs
 *     requiring recovery; settling a request does not prove the process exited.
 *
 * Teardown is CONCURRENT: commit destroys every previous container at once, and
 * the unwind destroys every started container at once (then restarts every
 * retained one at once). Docker's stop waits up to each container's grace
 * period, so one at a time would make a deploy wait N grace periods while the
 * not-yet-stopped old replicas keep taking jobs.
 *
 * Teardown follows the web pipeline's rule (see `bestEffortTeardown` in
 * deploy-pipeline.ts): every unwind and cleanup call is bounded, because a
 * container runtime that never answers must not strand the deploy (#629), and
 * best-effort, because by then the outcome is already decided. The one
 * exception is the singleton stop: it gates the start of the new instance, so
 * its failure FAILS the rollout. A container only counts as retained when its
 * stop actually resolved, mirroring `stopPreviousRetaining`: claiming a
 * retention after a timeout would "restore" something that was never stopped.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { safeErrorMessage, withTimeout, type StackRole, type RoleContainerRef } from "@repo/core";
import { DeploymentCancelledError, throwIfDeploymentCancelled } from "./deployment-cancellation";

const ROLE_ROLLOUT_SOURCE = "platform/engine/modules/deployments/role-rollout";

/** Same ceiling as the web pipeline's teardown, for the same reason (#629). */
const DEFAULT_TEARDOWN_TIMEOUT_MS = 30_000;

export type { RoleContainerRef } from "@repo/core";

/** True for kind "scheduler" or `singleton: true`. */
export function isSingletonRole(role: Pick<StackRole, "kind" | "singleton">): boolean {
  return role.kind === "scheduler" || role.singleton === true;
}

/** Expand frozen roles into the replicas to start, in declared order. Null or undefined means none. */
export function planRoleReplicas(roles: readonly StackRole[] | null | undefined): {
  scalable: { role: StackRole; replica: number }[];
  singletons: { role: StackRole; replica: number }[];
} {
  const scalable: { role: StackRole; replica: number }[] = [];
  const singletons: { role: StackRole; replica: number }[] = [];
  for (const role of roles ?? []) {
    if (isSingletonRole(role)) {
      singletons.push({ role, replica: 1 });
      continue;
    }
    const count = Math.max(1, role.replicas ?? 1);
    for (let replica = 1; replica <= count; replica++) scalable.push({ role, replica });
  }
  return { scalable, singletons };
}

/**
 * True when `next` runs the same workload as `old` in the same shape. `command`
 * is the only part of a role that says what it runs: the image and the env come
 * from the deployment and are shared by every role. `kind` adds nothing here: a
 * scheduler and a `singleton: true` worker run the same way.
 */
function continuesRole(old: StackRole, next: StackRole): boolean {
  return (
    old.name === next.name &&
    isSingletonRole(old) === isSingletonRole(next) &&
    old.command === next.command
  );
}

/**
 * Which previous singletons must hand over before which new roles start (#1253).
 *
 * A new role CONTINUES a previous one only when the name, the singleton flag
 * and the command all match. A name alone proves nothing: two
 * singletons can swap names, and a worker name can take over a scheduler's
 * command. Every other new role is CHANGED. A changed role may run the workload
 * of any previous singleton that no new role continues, so those singletons
 * are OUTGOING: they stop before the first changed role starts, and an unwind
 * restores them only after every changed role is confirmed removed. With no
 * changed role, this comparison identifies no replacement, so outgoing
 * singletons remain running until commit.
 *
 * Unknown previous definitions give no outgoing singletons. Same-name handover
 * then applies exactly as before.
 */
export function planSingletonHandover(
  roles: readonly StackRole[] | null | undefined,
  previousRoles: readonly StackRole[] | null | undefined,
  previous: readonly RoleContainerRef[],
): { outgoing: RoleContainerRef[]; changed: Set<string> } {
  if (!previousRoles) return { outgoing: [], changed: new Set() };
  const before = new Map(previousRoles.map((role) => [role.name, role]));
  const continued = new Set<string>();
  const changed = new Set<string>();
  for (const role of roles ?? []) {
    const old = before.get(role.name);
    if (old && continuesRole(old, role)) continued.add(role.name);
    else changed.add(role.name);
  }
  if (changed.size === 0) return { outgoing: [], changed };
  const outgoing = previous.filter((ref) => {
    const old = before.get(ref.role);
    return old !== undefined && isSingletonRole(old) && !continued.has(ref.role);
  });
  return { outgoing, changed };
}

export interface RoleRolloutDeps {
  roles: readonly StackRole[] | null | undefined;
  /**
   * The previous deployment's frozen roles. They tell a renamed or re-kinded
   * singleton apart from a worker. Without them, only same-name handover applies.
   */
  previousRoles?: readonly StackRole[] | null;
  /** Verified unchanged replicas carried into a configuration revision. */
  reuse?: readonly RoleContainerRef[];
  /** The previous deployment's recorded role containers. */
  previous: readonly RoleContainerRef[] | null | undefined;
  /** Start one replica for the NEW deployment and resolve to its container id. */
  startReplica(
    role: StackRole,
    replica: number,
    created?: (containerId: string) => Promise<void>,
  ): Promise<string>;
  /** Record the created container before its process can start. */
  recordCreated?(ref: RoleContainerRef): Promise<void>;
  /** Durable stop intent must precede the remote stop request. */
  recordStopIntent?(ref: RoleContainerRef): Promise<void>;
  /** Startup check across the given containers: null when every one stayed up, else a failure detail. */
  verify(containers: readonly RoleContainerRef[]): Promise<string | null>;
  /** Stop must confirm shutdown (or absence), not just a non-running UI status. */
  stopPrevious(containerId: string): Promise<void>;
  startPrevious(containerId: string): Promise<void>;
  destroyPrevious(containerId: string): Promise<void>;
  /** Resolve only once the replacement is gone; reject if removal is uncertain. */
  destroyStarted(containerId: string): Promise<void>;
  log(message: string, level?: "info" | "warn"): void;
  signal?: AbortSignal;
  /** On cancellation, leave every container exactly as it is (the pipeline's keepProvisionedOnCancel). */
  keepProvisionedOnCancel?: boolean;
  /** Bound for each teardown call in commit/abort/unwind. Default 30_000. */
  teardownTimeoutMs?: number;
}

export interface RoleRollout {
  readonly started: readonly RoleContainerRef[];
  /**
   * Retire the previous deployment's containers. Never throws: resolves to a
   * warning for the deploy naming every container it could not remove, or null.
   */
  commit(): Promise<string | null>;
  abort(): Promise<void>;
}

const NOOP_ROLLOUT: RoleRollout = {
  started: [],
  commit: async () => null,
  abort: async () => {},
};

/**
 * The deploy warning for previous containers that commit could not remove. A
 * failed removal does not prove the container still runs, so it says "may".
 */
export function roleRetirementWarning(failed: readonly RoleContainerRef[]): string | null {
  if (failed.length === 0) return null;
  const names = failed
    .map((ref) => `${ref.role} replica ${ref.replica} (${ref.containerId.slice(0, 12)})`)
    .join(", ");
  return failed.length === 1
    ? `Previous role container ${names} could not be removed. ` +
        "It may still be running the previous release's code. Remove it manually."
    : `${failed.length} previous role containers could not be removed: ${names}. ` +
        "They may still be running the previous release's code. Remove them manually.";
}

/**
 * Start the deployment's role containers in the order described in the file
 * header. Resolves to a handle whose `commit()` retires the previous
 * deployment's containers and whose `abort()` undoes this rollout. Throws the
 * original error after unwinding when any step fails.
 */
export async function rolloutRoles(deps: RoleRolloutDeps): Promise<RoleRollout> {
  const { signal, log } = deps;
  const teardownTimeoutMs = deps.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  const plan = planRoleReplicas(deps.roles);
  const reuse = deps.reuse ?? [];
  const reusedIds = new Set(reuse.map(ref => ref.containerId));
  plan.scalable = plan.scalable.filter(entry => !reuse.some(ref => ref.role === entry.role.name && ref.replica === entry.replica));
  plan.singletons = plan.singletons.filter(entry => !reuse.some(ref => ref.role === entry.role.name && ref.replica === entry.replica));
  const previous = (deps.previous ?? []).filter(ref => !reusedIds.has(ref.containerId));
  const handover = planSingletonHandover(deps.roles, deps.previousRoles, previous);
  // With an outgoing singleton, changed workers start only after it stops.
  const handingOver = handover.outgoing.length > 0;
  const firstScalable = plan.scalable.filter(
    (r) => !handingOver || !handover.changed.has(r.role.name),
  );
  const laterScalable = plan.scalable.filter(
    (r) => handingOver && handover.changed.has(r.role.name),
  );

  if (plan.scalable.length === 0 && plan.singletons.length === 0 && previous.length === 0 && reuse.length === 0) {
    return NOOP_ROLLOUT;
  }

  const started: RoleContainerRef[] = [];
  /** Previous singleton containers whose stop resolved: the only ones an unwind may restart. */
  const retained: RoleContainerRef[] = [];

  /** One bounded teardown call; a rejection or a timeout is a warning, never a failure. */
  const bestEffort = async (what: string, run: () => Promise<void>): Promise<boolean> => {
    try {
      await withTimeout(
        run(),
        teardownTimeoutMs,
        `timed out after ${teardownTimeoutMs}ms (the container runtime never answered)`,
      );
      return true;
    } catch (err) {
      observeCaughtError(err, ROLE_ROLLOUT_SOURCE);
      log(`Warning: ${what}: ${safeErrorMessage(err)}`, "warn");
      return false;
    }
  };

  /**
   * Destroy everything this deployment started concurrently, and only once ALL
   * of those settled restart only the retained roles whose replacements are
   * confirmed removed. Unrelated cleanup failures must not block safe restores.
   */
  const unwind = async (): Promise<void> => {
    if (started.length > 0) {
      log(
        `Removing ${started.length} role container${started.length === 1 ? "" : "s"} started by this deploy...`,
      );
    }
    const removed = await Promise.all(
      started.map((ref) =>
        bestEffort(
          `failed to remove role container ${ref.role} ${ref.replica} (${ref.containerId})`,
          () => deps.destroyStarted(ref.containerId),
        ),
      ),
    );
    const uncertainByRole = new Map<string, string[]>();
    started.forEach((ref, index) => {
      if (removed[index]) return;
      const ids = uncertainByRole.get(ref.role) ?? [];
      ids.push(ref.containerId);
      uncertainByRole.set(ref.role, ids);
    });
    const restorable = retained.filter((ref) => {
      // An outgoing singleton may have been replaced by any changed role.
      const replacedBy = handover.outgoing.includes(ref)
        ? new Set([ref.role, ...handover.changed])
        : new Set([ref.role]);
      const uncertain = [...replacedBy].flatMap((role) => uncertainByRole.get(role) ?? []);
      if (uncertain.length === 0) return true;
      log(
        `Rollback incomplete: previous role "${ref.role}" container ${ref.containerId} remains stopped because replacement container(s) ${uncertain.join(", ")} could not be removed. Remove those replacements before restarting the previous container.`,
        "warn",
      );
      return false;
    });
    if (restorable.length > 0) {
      log(
        `Restarting ${restorable.length} previous role container${restorable.length === 1 ? "" : "s"}...`,
      );
    }
    await Promise.all(
      restorable.map((ref) =>
        bestEffort(`failed to restart previous role container ${ref.role} ${ref.replica}`, () =>
          deps.startPrevious(ref.containerId),
        ),
      ),
    );
  };

  const verifyContainers = async (containers: readonly RoleContainerRef[]): Promise<void> => {
    const detail = await deps.verify(containers);
    if (detail !== null) throw new Error(`Role startup check failed: ${detail}`);
  };

  /** Stop a previous singleton and retain it; the new instance must not start otherwise. */
  const stopRetaining = async (old: RoleContainerRef): Promise<void> => {
    // A cancellation must be seen before the old scheduler is stopped, or
    // keepProvisionedOnCancel would leave no scheduler running at all.
    throwIfDeploymentCancelled(signal);
    await deps.recordStopIntent?.(old);
    log(`Stopping previous ${old.role} (kept restorable until this deploy is healthy)...`);
    try {
      await withTimeout(
        deps.stopPrevious(old.containerId),
        teardownTimeoutMs,
        `timed out after ${teardownTimeoutMs}ms (the container runtime never answered)`,
      );
    } catch (err) {
      observeCaughtError(err, ROLE_ROLLOUT_SOURCE);
      throw new Error(
        `Could not stop the previous "${old.role}" container, so a single instance cannot be guaranteed: ${safeErrorMessage(err)}`,
      );
    }
    retained.push(old);
  };

  const startOne = async (role: StackRole, replica: number): Promise<RoleContainerRef> => {
    throwIfDeploymentCancelled(signal);
    log(`Starting role ${role.name} replica ${replica}...`);
    let ref: RoleContainerRef | undefined;
    const created = async (containerId: string) => {
      if (ref) {
        if (ref.containerId !== containerId)
          throw new Error("A role replica created multiple containers");
        return;
      }
      ref = { role: role.name, replica, containerId };
      // Register in memory before awaiting persistence: a failed write still
      // has to unwind the container, even if the adapter's removal also fails.
      started.push(ref);
      await deps.recordCreated?.(ref);
    };
    const containerId = await deps.startReplica(role, replica, created);
    await created(containerId);
    if (!ref) throw new Error("Role creation returned no container");
    return ref;
  };

  try {
    if (reuse.length) {
      await verifyContainers(reuse);
      throwIfDeploymentCancelled(signal);
    }
    // Scalable phase: beside the previous containers, checked before any singleton moves.
    const scalableRefs: RoleContainerRef[] = [];
    for (const { role, replica } of firstScalable) {
      scalableRefs.push(await startOne(role, replica));
    }
    if (scalableRefs.length > 0) {
      await verifyContainers(scalableRefs);
      throwIfDeploymentCancelled(signal);
    }

    // Outgoing singletons stop before any changed role, the possible replacement, starts.
    for (const old of handover.outgoing) await stopRetaining(old);
    const changedRefs: RoleContainerRef[] = [];
    for (const { role, replica } of laterScalable) {
      changedRefs.push(await startOne(role, replica));
    }
    if (changedRefs.length > 0) {
      await verifyContainers(changedRefs);
      throwIfDeploymentCancelled(signal);
    }

    // Singleton phase: stop-first, retaining the old container so a failure can restore it.
    const singletonRefs: RoleContainerRef[] = [];
    for (const { role, replica } of plan.singletons) {
      // An outgoing singleton of this name was already stopped and retained above.
      const same = previous.filter((ref) => ref.role === role.name && !retained.includes(ref));
      for (const old of same) await stopRetaining(old);
      singletonRefs.push(await startOne(role, replica));
    }
    if (singletonRefs.length > 0) {
      await verifyContainers(singletonRefs);
      throwIfDeploymentCancelled(signal);
    }
  } catch (err) {
    const cancelled = err instanceof DeploymentCancelledError || signal?.aborted === true;
    if (cancelled && deps.keepProvisionedOnCancel) throw err;
    await unwind();
    throw err;
  }

  // Commit and abort are mutually exclusive and idempotent: the first one to run wins.
  let settled = false;

  return {
    started,
    async commit() {
      if (settled) return null;
      settled = true;
      if (previous.length > 0) {
        log(
          `Removing ${previous.length} previous role container${previous.length === 1 ? "" : "s"}...`,
        );
      }
      const removed = await Promise.all(
        previous.map((ref) =>
          bestEffort(`failed to remove previous role container ${ref.role} ${ref.replica}`, () =>
            deps.destroyPrevious(ref.containerId),
          ),
        ),
      );
      return roleRetirementWarning(previous.filter((_, index) => !removed[index]));
    },
    async abort() {
      if (settled) return;
      settled = true;
      await unwind();
    },
  };
}
