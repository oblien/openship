import type { DeploymentEvent } from "@repo/contracts";

/**
 * Subscribe before reading committed state. Notifications wake a single reader;
 * they never buffer copies of a run or carry uncommitted progress. Slow clients
 * coalesce changes, and reconnects receive a complete current snapshot.
 *
 * Reconciliation covers another controller's writes, missed notifications, and
 * expired worker leases. This is a server-side check, not browser HTTP polling.
 */
export async function* durableRunEvents<Row>(options: {
  subscribe(changed: () => void): () => void;
  load(): Promise<Row>;
  version(row: Row): number | string;
  complete(row: Row): boolean;
  signal?: AbortSignal;
  reconcileMs?: number;
}): AsyncGenerator<DeploymentEvent> {
  const { signal } = options;
  signal?.throwIfAborted();
  let dirty = true;
  let wake: (() => void) | undefined;
  let version: number | string | undefined;
  const changed = () => {
    dirty = true;
    wake?.();
  };
  const abort = () => wake?.();
  const unsubscribe = options.subscribe(changed);
  const timer = setInterval(changed, options.reconcileMs ?? 15_000);
  timer.unref();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      if (!dirty) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      dirty = false;
      const row = await options.load();
      signal?.throwIfAborted();
      // A new attempt may have started while a terminal snapshot was loading.
      if (dirty && options.complete(row)) continue;
      const nextVersion = options.version(row);
      if (version !== nextVersion) {
        version = nextVersion;
        yield {
          event: "snapshot",
          id: String(version),
          data: JSON.stringify({ type: "snapshot", run: row }),
        };
      }
      if (options.complete(row)) {
        yield {
          event: "complete",
          id: String(version),
          data: JSON.stringify({ type: "complete" }),
        };
        return;
      }
    }
  } finally {
    clearInterval(timer);
    unsubscribe();
    signal?.removeEventListener("abort", abort);
    wake = undefined;
  }
}
