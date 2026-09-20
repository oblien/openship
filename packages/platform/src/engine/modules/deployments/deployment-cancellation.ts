/**
 * Process-local cancellation registry for a deployment's entire build → deploy
 * worker.
 *
 * Runtime adapters already have their own build abort maps, but those maps end
 * when the image/build method returns. A deployment can still be waiting in
 * preflight, a prompt, or a host-scoped provisioning lock at that point. This
 * registry is the single cancellation source for that outer worker so the API
 * cancel endpoint can wake every phase, not just docker build.
 */

import { repos } from "@repo/db";

const CANCELLATION_POLL_MS = 1_000;
const QUIESCENCE_POLL_MS = 100;
const QUIESCENCE_TIMEOUT_MS = 5_000;

interface DeploymentExecution {
  controller: AbortController;
  poll: ReturnType<typeof setInterval> | null;
  pollInFlight: boolean;
  keepProvisioned: boolean;
}

const executions = new Map<string, DeploymentExecution>();
const drainWaiters = new Set<() => void>();

/** Wait for this engine owner's work only. Shared database rows may belong to other owners. */
export async function drainDeploymentExecutions(): Promise<void> {
  while (executions.size > 0) await new Promise<void>(resolve => drainWaiters.add(resolve));
}

export class DeploymentCancelledError extends Error {
  constructor(message = "Deployment cancelled") {
    super(message);
    this.name = "DeploymentCancelledError";
  }
}

/** Register before firing the background worker. The returned signal is stable
 * for the worker's lifetime and is already aborted if a caller cancelled during
 * the tiny registration hand-off. */
export function registerDeploymentExecution(deploymentId: string): AbortSignal {
  const existing = executions.get(deploymentId);
  if (existing) return existing.controller.signal;
  const controller = new AbortController();
  const execution: DeploymentExecution = {
    controller,
    poll: null,
    pollInFlight: false,
    keepProvisioned: false,
  };
  execution.poll = setInterval(() => {
    if (execution.pollInFlight || controller.signal.aborted) return;
    execution.pollInFlight = true;
    // The database row is the durable cancellation source. This poll matters
    // when a cancel request lands on another API replica/process: its local
    // registry cannot see this controller, but the atomic cancelled transition
    // is shared and wakes this worker within one bounded interval.
    void (async () => {
      try {
        const dep = await repos.deployment.findById(deploymentId);
        if (dep?.status === "cancelled" && !controller.signal.aborted) {
          const cancellation = (dep.meta as { cancellation?: { keepProvisioned?: boolean } } | null)
            ?.cancellation;
          execution.keepProvisioned = cancellation?.keepProvisioned === true;
          controller.abort();
        }
      } catch {
        // A transient status read must not fail the deploy. The next poll retries;
        // normal lifecycle guards still prevent overwriting a cancelled row.
      } finally {
        execution.pollInFlight = false;
      }
    })();
  }, CANCELLATION_POLL_MS);
  // Do not keep a CLI/test/API process alive solely for a cancellation poll.
  (execution.poll as unknown as { unref?: () => void }).unref?.();
  executions.set(deploymentId, execution);
  return controller.signal;
}

/** Request cancellation. Returns false when no in-process worker owns the id;
 * a worker in another live process observes the durable cancelled row by poll. */
export function requestDeploymentCancellation(
  deploymentId: string,
  opts: { keepProvisioned?: boolean } = {},
): boolean {
  const execution = executions.get(deploymentId);
  if (!execution) return false;
  execution.keepProvisioned = opts.keepProvisioned === true;
  if (!execution.controller.signal.aborted) execution.controller.abort();
  return true;
}

/** Release only the controller registered by this worker; never delete a newer
 * execution if an id is ever reused by an integration test or import path. */
export function releaseDeploymentExecution(deploymentId: string, signal: AbortSignal): void {
  const execution = executions.get(deploymentId);
  if (execution?.controller.signal !== signal) return;
  if (execution.poll) clearInterval(execution.poll);
  executions.delete(deploymentId);
  for (const notify of drainWaiters) notify();
  drainWaiters.clear();
}

export function deploymentCancellationRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export function deploymentCancellationKeepsProvisioned(signal?: AbortSignal): boolean {
  if (!signal) return false;
  for (const execution of executions.values()) {
    if (execution.controller.signal === signal) return execution.keepProvisioned;
  }
  return false;
}

export function throwIfDeploymentCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DeploymentCancelledError();
}

/**
 * Wait for the durable execution lease to close after cancellation.
 *
 * The deployment row becomes `cancelled` when the request wins, but that is
 * only the requested outcome. `build_session.finishedAt` is the worker's
 * acknowledgement that its outermost finally has completed and it can no
 * longer mutate the target host. A cancel API must not report completion before
 * this turns false.
 */
export async function waitForDeploymentQuiescence(
  deploymentId: string,
  projectId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? QUIESCENCE_TIMEOUT_MS);
  const pollMs = Math.max(1, opts.pollMs ?? QUIESCENCE_POLL_MS);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      if (!(await repos.deployment.hasLiveBuildExecution(deploymentId, projectId))) return true;
    } catch {
      // An unreadable lease is never proof of quiescence. Keep polling inside
      // the same bounded window, then return the safe pending outcome.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  }
}

/** Race a phase that has no native AbortSignal seam (notably a human prompt)
 * against the outer worker cancellation. The underlying operation is allowed to
 * settle later; session cancellation closes its prompt registry entry. */
export function raceDeploymentCancellation<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(new DeploymentCancelledError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new DeploymentCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
