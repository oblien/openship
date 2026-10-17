/**
 * Per-build-host cap on concurrent image builds (GH-676).
 *
 * Every self-hosted deploy used to start its image build the moment it was
 * claimed. One push to a branch that several projects auto-deploy from starts
 * all of them at once, and N simultaneous BuildKit exports against one
 * Docker/containerd host can corrupt its content store — "failed to commit …
 * no space left on device" on a disk with 200 GB free, then "lease does not
 * exist" on retry, until someone prunes the builder by hand.
 *
 * So the image-build phase of a deploy takes a slot for its build HOST first.
 * Extra builds wait in FIFO order and start as soon as a slot frees. Only the
 * build holds a slot: preflight, activation, health and routing run outside it,
 * so a queued deploy waits for other BUILDS, not for other deploys to finish.
 *
 * In-process by design: a self-hosted control plane is one API process, and the
 * slots must be released by the same worker that took them. Managed Cloud does
 * not come through here — it has its own durable, plan-based build queue.
 */

import { DeploymentCancelledError } from "./deployment-cancellation";

/** Releases a held slot. Idempotent, so a `finally` may call it after an early release. */
export type BuildSlotRelease = () => void;

interface Waiter {
  grant: () => void;
  reject: (err: Error) => void;
}

interface HostSlots {
  running: number;
  queue: Waiter[];
}

const hosts = new Map<string, HostSlots>();

/** Build-host key: the target server, or this machine for a local deploy. */
export function buildHostKey(serverId: string | null | undefined): string {
  return serverId ? `server:${serverId}` : "local";
}

function slotsFor(key: string): HostSlots {
  let slots = hosts.get(key);
  if (!slots) {
    slots = { running: 0, queue: [] };
    hosts.set(key, slots);
  }
  return slots;
}

function releaseOne(key: string): void {
  const slots = hosts.get(key);
  if (!slots) return;
  const next = slots.queue.shift();
  if (next) {
    // Hand the slot straight to the next waiter: `running` stays the same.
    next.grant();
    return;
  }
  slots.running = Math.max(0, slots.running - 1);
  if (slots.running === 0) hosts.delete(key);
}

/**
 * Take a build slot on `key`, waiting while `limit` builds already hold one.
 *
 * - `limit <= 0` means uncapped: resolves immediately with a no-op release.
 * - `onWait` fires once, only when the caller actually has to queue, with how
 *   many builds are ahead of it (running + queued before it).
 * - An aborted `signal` drops the caller out of the queue and rejects with
 *   `DeploymentCancelledError`, so a cancelled deploy never takes a slot.
 */
export function acquireBuildSlot(
  key: string,
  limit: number,
  opts: { signal?: AbortSignal; onWait?: (ahead: number) => void } = {},
): Promise<BuildSlotRelease> {
  const { signal, onWait } = opts;
  if (signal?.aborted) return Promise.reject(new DeploymentCancelledError());
  if (!(limit > 0)) return Promise.resolve(() => {});

  const slots = slotsFor(key);
  const once = (): BuildSlotRelease => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseOne(key);
    };
  };

  if (slots.running < limit && slots.queue.length === 0) {
    slots.running++;
    return Promise.resolve(once());
  }

  onWait?.(slots.running + slots.queue.length);
  return new Promise<BuildSlotRelease>((resolve, reject) => {
    const onAbort = () => {
      const index = slots.queue.indexOf(waiter);
      if (index !== -1) slots.queue.splice(index, 1);
      reject(new DeploymentCancelledError());
    };
    const waiter: Waiter = {
      grant: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(once());
      },
      reject,
    };
    slots.queue.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run `work` while holding a build slot on `key`; the slot is always released. */
export async function withBuildSlot<T>(
  key: string,
  limit: number,
  work: () => Promise<T>,
  opts: { signal?: AbortSignal; onWait?: (ahead: number) => void } = {},
): Promise<T> {
  const release = await acquireBuildSlot(key, limit, opts);
  try {
    return await work();
  } finally {
    release();
  }
}

/** Current state for a host — for tests and diagnostics. */
export function buildSlotState(key: string): { running: number; queued: number } {
  const slots = hosts.get(key);
  return { running: slots?.running ?? 0, queued: slots?.queue.length ?? 0 };
}
