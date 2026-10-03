import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({
  repos: { project: { findById: async (id: string) => ({ id, workspaceId: null }) } },
  withAdvisoryLock: async (_key: string, run: () => Promise<unknown>) => run(),
}));
import { withProjectRuntimeLock } from "@repo/platform/engine/lib/project-runtime-lock";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("project runtime lock ownership", () => {
  it("permits awaited nesting but does not pass an expired lock to a background worker", async () => {
    const workerReady = deferred();
    const workerReleased = deferred();
    const competingEntered = deferred();
    const competingReleased = deferred();
    const order: string[] = [];
    let worker!: Promise<void>;
    await withProjectRuntimeLock("capacity-project", async () => {
      await withProjectRuntimeLock("capacity-project", async () => {
        order.push("nested");
      });
      worker = (async () => {
        await workerReleased.promise;
        workerReady.resolve();
        await withProjectRuntimeLock("capacity-project", async () => {
          order.push("worker");
        });
      })();
    });
    const competitor = withProjectRuntimeLock("capacity-project", async () => {
      order.push("competitor");
      competingEntered.resolve();
      await competingReleased.promise;
      order.push("released");
    });
    await competingEntered.promise;
    workerReleased.resolve();
    await workerReady.promise;
    await Promise.resolve();
    expect(order).toEqual(["nested", "competitor"]);
    competingReleased.resolve();
    await Promise.all([competitor, worker]);
    expect(order).toEqual(["nested", "competitor", "released", "worker"]);
  });

  it("releases ownership after a callback fails", async () => {
    await expect(
      withProjectRuntimeLock("failed-project", async () => {
        throw new Error("request failed");
      }),
    ).rejects.toThrow("request failed");
    await expect(withProjectRuntimeLock("failed-project", async () => "acquired")).resolves.toBe(
      "acquired",
    );
  });
});
