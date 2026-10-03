import { AsyncLocalStorage } from "node:async_hooks";
import type { ManagedCommandRef } from "@repo/core";

/** The controller persists intent before a remote command starts. Transport
 * failures leave it pending until the same controller verifies termination. */
export interface ManagedCommandTracking {
  record(command: ManagedCommandRef): Promise<void>;
  complete(marker: string): Promise<void>;
}

const tracking = new AsyncLocalStorage<ManagedCommandTracking & {
  /** A streamed Docker response can finish just before its durable acknowledgement. */
  defer(completion: Promise<void>): void;
}>();
export async function withManagedCommandTracking<T>(hooks: ManagedCommandTracking, work: () => Promise<T>) {
  const pending = new Set<Promise<void>>();
  return tracking.run({
    ...hooks,
    defer(completion) {
      pending.add(completion);
      void completion.catch(() => {});
    },
  }, async () => {
    try {
      return await work();
    } finally {
      const failures: unknown[] = [];
      while (pending.size) {
        const batch = [...pending];
        pending.clear();
        for (const result of await Promise.allSettled(batch))
          if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length) throw failures[0];
    }
  });
}
export const currentManagedCommandTracking = () => tracking.getStore();
