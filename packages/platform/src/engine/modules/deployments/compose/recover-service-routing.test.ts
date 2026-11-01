import { afterEach, describe, expect, it, vi } from "vitest";
import { withKeyedMutex } from "@repo/core";
import { recoverServiceRouting } from "./recover-service-routing";
import type { CommandExecutor } from "@repo/adapters";

afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Compose routing recovery ownership", () => {
  it("restores both route views in order and releases its deadline after success", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    await recoverServiceRouting(
      async () => {
        order.push("project routes");
      },
      async () => {
        order.push("topology routes");
      },
    );
    expect(order).toEqual(["project routes", "topology routes"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a failed route pass without starting the next one", async () => {
    vi.useFakeTimers();
    const topology = vi.fn();
    const error = new Error("edge reload failed");
    await expect(
      recoverServiceRouting(async () => {
        throw error;
      }, topology),
    ).rejects.toBe(error);
    expect(topology).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not release execution ownership while a timed-out route pass can still write", async () => {
    vi.useFakeTimers();
    const host = "recovery-deadline-physical-target";
    const releaseHost = deferred();
    const hostHeld = deferred();
    const firstPassQueued = deferred();
    const writes: string[] = [];
    const blocker = withKeyedMutex(host, async () => {
      hostHeld.resolve();
      await releaseHost.promise;
    });
    await hostHeld.promise;
    const topology = vi.fn(async () => {
      await withKeyedMutex(host, async () => {
        writes.push("previous topology");
      });
    });
    let ownershipReleased = false;
    const recovery = recoverServiceRouting(async () => {
      firstPassQueued.resolve();
      await withKeyedMutex(host, async () => {
        writes.push("previous upstream");
      });
    }, topology)
      .catch((error: unknown) => error)
      .finally(() => {
        ownershipReleased = true;
      });
    await firstPassQueued.promise;
    await vi.advanceTimersByTimeAsync(30_001);
    const releasedAtDeadline = ownershipReleased;
    // A replacement attempt can begin only after recovery gives up ownership.
    const retry = recovery.then(() =>
      withKeyedMutex(host, async () => {
        writes.push("retry upstream");
      }),
    );
    releaseHost.resolve();
    const [error] = await Promise.all([recovery, retry, blocker]);
    await withKeyedMutex(host, async () => {});

    expect.soft(writes).toEqual(["previous upstream", "retry upstream"]);
    expect.soft(releasedAtDeadline).toBe(false);
    expect(error).toEqual(new Error("Previous service routing recovery timed out"));
    expect(topology).not.toHaveBeenCalled();
  });

  it("aborts executor commands at the deadline and waits for their channel to close", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const channelStarted = deferred();
    const abortObserved = deferred();
    const channelClosed = deferred();
    const executor: Pick<CommandExecutor, "runWithAbortSignal"> = {
      runWithAbortSignal: async (current, work) => {
        signal = current;
        return work();
      },
    };
    const topology = vi.fn();
    let settled = false;
    const recovery = recoverServiceRouting(
      async () => {
        signal.addEventListener("abort", () => abortObserved.resolve(), { once: true });
        channelStarted.resolve();
        await channelClosed.promise;
        throw new Error("remote command aborted");
      },
      topology,
      executor,
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await channelStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await abortObserved.promise;
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    channelClosed.resolve();
    await expect(recovery).resolves.toEqual(
      new Error("Previous service routing recovery timed out"),
    );
    expect(topology).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ownership until an already-started topology pass settles after its deadline", async () => {
    vi.useFakeTimers();
    const topologyStarted = deferred();
    const topologyFinished = deferred();
    let settled = false;
    const recovery = recoverServiceRouting(
      async () => {},
      async () => {
        topologyStarted.resolve();
        await topologyFinished.promise;
      },
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await topologyStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    topologyFinished.resolve();
    await expect(recovery).resolves.toEqual(
      new Error("Previous service routing recovery timed out"),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
