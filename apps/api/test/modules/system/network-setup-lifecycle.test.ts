import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  driver: "pglite",
  register: vi.fn(),
  preparations: vi.fn(),
  clusters: vi.fn(),
  runtimes: vi.fn(),
  databases: vi.fn(),
  storage: vi.fn(),
  interruptStorage: vi.fn(),
  interruptDatabase: vi.fn(),
  interruptRuntime: vi.fn(),
  interruptPreparation: vi.fn(),
  interruptOperation: vi.fn(),
  interruptVerification: vi.fn(),
  notify: vi.fn(),
  notifyDatabase: vi.fn(),
  defer: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  getDriver: () => h.driver,
  repos: {
    clusterStorage: { recoverInterrupted: h.storage, interrupt: h.interruptStorage },
    clusterDatabase: { recoverInterrupted: h.databases, interrupt: h.interruptDatabase },
    clusterRuntime: { recoverInterrupted: h.runtimes, interrupt: h.interruptRuntime },
    networkPreparation: { recoverInterrupted: h.preparations, interrupt: h.interruptPreparation },
    serverCluster: {
      recoverInterrupted: h.clusters,
      interruptOperation: h.interruptOperation,
      interruptVerification: h.interruptVerification,
    },
  },
}));
vi.mock("@repo/platform/engine/lib/startup/index", () => ({ registerStartupHook: h.register }));
vi.mock("@repo/platform/engine/lib/background-work", () => ({ deferBackgroundWork: h.defer }));
vi.mock("@repo/platform/engine/modules/system/network-setup-bus", () => ({
  notifyNetworkSetup: h.notify,
}));
vi.mock("@repo/platform/engine/modules/projects/cluster-database.events", () => ({
  notifyClusterDatabase: h.notifyDatabase,
}));

import {
  createNetworkSetupLifecycle,
  deferNetworkSetupWork,
  recoverNetworkSetups,
  stopNetworkSetups,
} from "@repo/platform/engine/modules/system/network-setup-lifecycle";
import { registerNetworkSetupRecovery } from "@repo/platform/engine/lib/startup/network-setups";

const worker = {
  kind: "preparation" as const,
  id: "prep-a",
  organizationId: "org-a",
  generation: 3,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.driver = "pglite";
  h.preparations.mockResolvedValue([]);
  h.clusters.mockResolvedValue({ operations: [], verifications: [] });
  h.runtimes.mockResolvedValue([]);
  h.databases.mockResolvedValue([]);
  h.storage.mockResolvedValue([]);
  h.defer.mockResolvedValue(undefined);
});

describe("network setup controller lifecycle", () => {
  it.each(["pglite", "pg"])(
    "registers boot recovery with %s ownership before accepting setup work",
    async (driver) => {
      h.driver = driver;
      registerNetworkSetupRecovery();
      const hook = h.register.mock.calls[0]![0];
      expect(hook).toMatchObject({
        id: "network-setup-recovery",
        modes: ["selfhosted", "desktop"],
      });
      await hook.run();
      expect(h.preparations).toHaveBeenCalledWith(driver === "pglite");
      expect(h.clusters).toHaveBeenCalledWith(driver === "pglite");
      expect(h.runtimes).toHaveBeenCalledWith(driver === "pglite");
      expect(h.databases).toHaveBeenCalledWith(driver === "pglite");
      expect(h.storage).toHaveBeenCalledWith(driver === "pglite");
      expect(h.defer).not.toHaveBeenCalled();
    },
  );
  it("publishes recovered progress after persistence without scheduling host work", async () => {
    h.storage.mockImplementation(async () => {
      expect(h.notify).not.toHaveBeenCalled();
      return [{ clusterId: "pool-a", organizationId: "org-a" }];
    });
    h.databases.mockImplementation(async () => {
      expect(h.notifyDatabase).not.toHaveBeenCalled();
      return [{ projectId: "project-a", organizationId: "org-a" }];
    });
    h.runtimes.mockResolvedValue([{ clusterId: "pool-b", organizationId: "org-b" }]);
    h.preparations.mockResolvedValue([{ id: "prep-a", organizationId: "org-a" }]);
    h.clusters.mockResolvedValue({
      operations: [{ id: "operation-b", organizationId: "org-b" }],
      verifications: [{ organizationId: "org-c" }],
    });
    await recoverNetworkSetups(true);
    expect(h.notify.mock.calls).toEqual([
      ["org-a", "storage", "pool-a"],
      ["org-b", "runtime", "pool-b"],
      ["org-a", "preparation", "prep-a"],
      ["org-b", "operation", "operation-b"],
      ["org-c", "overview"],
    ]);
    expect(h.notifyDatabase).toHaveBeenCalledExactlyOnceWith("org-a", "project-a");
    expect(h.defer).not.toHaveBeenCalled();
  });
  it("owns queued work immediately so shutdown cannot miss it", async () => {
    const queue: Array<() => Promise<void>> = [];
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const hostWork = vi.fn();
    const lifecycle = createNetworkSetupLifecycle({
      interrupt,
      defer: async (work) => {
        queue.push(work);
      },
    });
    await lifecycle.defer(worker, hostWork);
    await lifecycle.stop();
    expect(interrupt).toHaveBeenCalledWith(worker);
    await queue[0]!();
    expect(hostWork).not.toHaveBeenCalled();
    expect(() => lifecycle.assertAcceptingWork()).toThrow("OpenShip is stopping");
  });
  it("fences running work before aborting it and does not revisit completed work", async () => {
    const started = deferred();
    const fence = deferred();
    const finished = deferred();
    const events: string[] = [];
    const interrupt = vi.fn(async () => {
      await fence.promise;
      events.push("fenced");
    });
    const lifecycle = createNetworkSetupLifecycle({ interrupt, defer: (work) => work() });
    await lifecycle.defer(worker, async (signal) => {
      signal.addEventListener(
        "abort",
        () => {
          events.push("aborted");
          finished.resolve();
        },
        { once: true },
      );
      started.resolve();
      await finished.promise;
    });
    await started.promise;
    const stopped = lifecycle.stop();
    expect(events).toEqual([]);
    fence.resolve();
    await stopped;
    await finished.promise;
    expect(events).toEqual(["fenced", "aborted"]);
    await lifecycle.stop();
    expect(interrupt).toHaveBeenCalledOnce();
  });
  it("interrupts a claim that finishes after shutdown without starting the deferred worker", async () => {
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn();
    const work = vi.fn();
    const lifecycle = createNetworkSetupLifecycle({ interrupt, defer });
    await lifecycle.stop();
    await expect(lifecycle.defer(worker, work)).rejects.toMatchObject({
      code: "NETWORK_SETUP_STOPPING",
    });
    expect(interrupt).toHaveBeenCalledWith(worker);
    expect(defer).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
  it("does not interrupt a worker that already recorded completion", async () => {
    const interrupt = vi.fn();
    const completed = deferred();
    const lifecycle = createNetworkSetupLifecycle({
      interrupt,
      defer: async (work) => {
        await work();
        completed.resolve();
      },
    });
    await lifecycle.defer(worker, async () => undefined);
    await completed.promise;
    await lifecycle.stop();
    expect(interrupt).not.toHaveBeenCalled();
  });
  it("cancels every local worker and reports a database failure instead of extending leases", async () => {
    const finished = deferred();
    let signal: AbortSignal | undefined;
    const lifecycle = createNetworkSetupLifecycle({
      interrupt: async () => {
        throw new Error("Database unavailable");
      },
      defer: (work) => work(),
    });
    await lifecycle.defer(worker, async (value) => {
      signal = value;
      value.addEventListener("abort", finished.resolve, { once: true });
      await finished.promise;
    });
    await expect(lifecycle.stop()).rejects.toThrow("Could not save interrupted network setups");
    expect(signal!.aborted).toBe(true);
    await finished.promise;
  });
  it("persists interruption for every setup, database and check owned by this process", async () => {
    h.interruptPreparation.mockResolvedValue([{ id: worker.id }]);
    h.interruptOperation.mockResolvedValue([{ id: "operation-a" }]);
    h.interruptVerification.mockResolvedValue([{ id: "check-a" }]);
    h.interruptRuntime.mockResolvedValue([{ id: "runtime-a" }]);
    h.interruptStorage.mockResolvedValue([{ id: "storage-a" }]);
    h.interruptDatabase.mockResolvedValue([{ id: "database-a" }]);
    const work = vi.fn();
    await deferNetworkSetupWork(worker, work);
    await deferNetworkSetupWork(
      { ...worker, kind: "operation", id: "operation-a", generation: 4 },
      work,
    );
    await deferNetworkSetupWork(
      { kind: "verification", organizationId: "org-a", id: "check-a" },
      work,
    );
    await deferNetworkSetupWork(
      {
        kind: "runtime",
        organizationId: "org-a",
        id: "runtime-a",
        clusterId: "pool-a",
        generation: 2,
      },
      work,
    );
    await deferNetworkSetupWork(
      {
        kind: "storage",
        organizationId: "org-a",
        id: "storage-a",
        clusterId: "pool-a",
        generation: 5,
      },
      work,
    );
    await deferNetworkSetupWork(
      {
        kind: "database",
        organizationId: "org-a",
        id: "database-a",
        projectId: "project-a",
        generation: 6,
      },
      work,
    );
    await stopNetworkSetups();
    expect(h.interruptPreparation).toHaveBeenCalledWith(
      "prep-a",
      3,
      expect.stringContaining("OpenShip stopped"),
    );
    expect(h.interruptOperation).toHaveBeenCalledWith(
      "operation-a",
      4,
      expect.stringContaining("host rollback timers run independently"),
    );
    expect(h.interruptVerification).toHaveBeenCalledWith(
      "check-a",
      expect.stringContaining("Run the checks again"),
    );
    expect(h.interruptRuntime).toHaveBeenCalledWith(
      "runtime-a",
      2,
      expect.stringContaining("OpenShip stopped"),
    );
    expect(h.interruptStorage).toHaveBeenCalledWith(
      "storage-a",
      5,
      expect.stringContaining("OpenShip stopped"),
    );
    expect(h.interruptDatabase).toHaveBeenCalledWith(
      "database-a",
      6,
      expect.stringContaining("OpenShip stopped"),
    );
    expect(h.notify.mock.calls).toEqual([
      ["org-a", "preparation", "prep-a"],
      ["org-a", "operation", "operation-a"],
      ["org-a", "overview"],
      ["org-a", "runtime", "pool-a"],
      ["org-a", "storage", "pool-a"],
    ]);
    expect(h.notifyDatabase).toHaveBeenCalledExactlyOnceWith("org-a", "project-a");
    expect(work).not.toHaveBeenCalled();
  });
});
