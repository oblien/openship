import { expect, it } from "vitest";
import { currentManagedCommandTracking, withManagedCommandTracking } from "./command-tracking";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const hooks = { record: async () => {}, complete: async () => {} };

it("waits for acknowledgements added during a concurrent phase drain", async () => {
  const first = deferred();
  const second = deferred();
  await withManagedCommandTracking(hooks, async () => {
    const tracking = currentManagedCommandTracking()!;
    tracking.defer(first.promise.then(() => tracking.defer(second.promise)));
    let completed = 0;
    const drains = [tracking.flush(), tracking.flush()].map((promise) =>
      promise.then(() => {
        completed++;
      }),
    );
    try {
      first.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(completed).toBe(0);
    } finally {
      first.resolve();
      second.resolve();
      await Promise.all(drains);
    }
    expect(completed).toBe(2);
  });
});

it("cannot turn a failed acknowledgement into success by catching a phase drain", async () => {
  const failure = new Error("durable acknowledgement unavailable");
  await expect(
    withManagedCommandTracking(hooks, async () => {
      const tracking = currentManagedCommandTracking()!;
      tracking.defer(Promise.reject(failure));
      await expect(tracking.flush()).rejects.toBe(failure);
      // A later phase must still refuse to report quiescence.
      await expect(tracking.flush()).rejects.toBe(failure);
    }),
  ).rejects.toBe(failure);
});

it("keeps phase drains scoped to their own build activity", async () => {
  const acknowledgement = deferred();
  const entered = deferred();
  let firstFinished = false;
  const first = withManagedCommandTracking(hooks, async () => {
    currentManagedCommandTracking()!.defer(acknowledgement.promise);
    entered.resolve();
    await currentManagedCommandTracking()!.flush();
    firstFinished = true;
  });
  try {
    await entered.promise;
    await withManagedCommandTracking(hooks, async () => {
      await currentManagedCommandTracking()!.flush();
      expect(firstFinished).toBe(false);
    });
  } finally {
    acknowledgement.resolve();
    await first;
  }
  expect(currentManagedCommandTracking()).toBeUndefined();
});
