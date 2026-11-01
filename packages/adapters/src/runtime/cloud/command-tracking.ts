import {
  observedAllSettled,
  reportCaughtError as observeCaughtError,
} from "@repo/core/diagnostics";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ManagedCommandRef } from "@repo/core";

/** The controller persists intent before a remote command starts. Transport
 * failures leave it pending until the same controller verifies termination. */
export interface ManagedCommandTracking {
  record(command: ManagedCommandRef): Promise<void>;
  complete(marker: string): Promise<void>;
}

const tracking = new AsyncLocalStorage<
  ManagedCommandTracking & {
    /** A streamed Docker response can finish just before its durable acknowledgement. */
    defer(completion: Promise<void>): void;
    /** Await acknowledgements before an in-scope quiescence/capacity check. This
     * never clears, retries or recovers an unconfirmed remote command. */
    flush(): Promise<void>;
  }
>();
export async function withManagedCommandTracking<T>(
  hooks: ManagedCommandTracking,
  work: () => Promise<T>,
) {
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let flushing: Promise<void> | undefined;
  const flush = (): Promise<void> =>
    (flushing ??= (async () => {
      while (pending.size) {
        const batch = [...pending];
        pending.clear();
        for (const result of await observedAllSettled(
          batch,
          "adapters/runtime/cloud/command-tracking",
        ))
          if (result.status === "rejected") failures.push(result.reason);
      }
      // Keep acknowledgement failures sticky even if an inner caller catches one;
      // leaving the outer tracking scope must not report a successful completion.
      if (failures.length) throw failures[0];
    })().finally(() => {
      flushing = undefined;
    }));
  return tracking.run(
    {
      ...hooks,
      flush,
      defer(completion) {
        pending.add(completion);
        void completion.catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/command-tracking");
        });
      },
    },
    async () => {
      try {
        return await work();
      } finally {
        await flush();
      }
    },
  );
}
export const currentManagedCommandTracking = () => tracking.getStore();
