import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";
import type { CloudBuildActivity, CloudBuildActivityIdentity, Deployment, Project } from "@repo/db";
import { currentManagedCommandTracking } from "../../adapters/src/runtime/cloud/command-tracking";

const h = vi.hoisted(() => ({
  cloud: true,
  remote: false,
  binding: "vm",
  rows: new Map<string, CloudBuildActivity>(),
  recovered: [] as string[],
  exclusive: vi.fn(),
  dispose: vi.fn(),
  failRecovery: false,
  deployment: null as Deployment | null,
  project: null as Project | null,
  sessionFinished: false,
  acknowledge: vi.fn(),
  updateStatus: vi.fn(),
  collect: vi.fn(),
  cleanup: vi.fn(),
  removeWorker: vi.fn(),
  verifyWorker: vi.fn(),
  finish: vi.fn(),
  releaseSlot: vi.fn(),
  claimError: undefined as unknown,
}));
vi.mock("../src/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("../src/engine/lib/cloud-build-worker-recovery", () => ({
  verifyCloudBuildWorkerStopped: h.verifyWorker,
}));
vi.mock("@repo/adapters", async () => ({
  ...(await import("../../adapters/src/runtime/cloud/command-tracking")),
  removeProjectBuildKitWorker: h.removeWorker,
}));
vi.mock("../src/engine/lib/cloud/server-link", () => ({
  remoteCloudRequest: vi.fn(),
  requireLinkedCloudServer: vi.fn(),
}));
vi.mock("../src/engine/lib/provision-lock", async () => {
  const { withKeyedMutex, tryWithKeyedMutex } = await import("@repo/core");
  return {
    createProvisionLock: (key: string) => ({
      run: (work: () => Promise<unknown>, signal?: AbortSignal) =>
        withKeyedMutex(key, work, signal),
    }),
    tryWithProvisionLock: (key: string, work: () => Promise<unknown>) =>
      tryWithKeyedMutex(key, work),
  };
});
vi.mock("../src/engine/lib/cloud-workspace-host", () => ({
  openCloudWorkspaceExecutor: async () => ({
    recoverCommand: async (command: { marker: string }) => {
      h.recovered.push(command.marker);
      if (h.failRecovery) throw new Error("exit unconfirmed");
    },
    dispose: h.dispose,
  }),
}));
vi.mock("../src/engine/modules/projects/project-cleanup.service", () => ({
  collectDeploymentManifest: h.collect,
  executeCleanup: h.cleanup,
}));
vi.mock("@repo/db", () => {
  const find = (input: CloudBuildActivityIdentity) => h.rows.get(input.deploymentId);
  const owner = (input: CloudBuildActivityIdentity, token: string) => {
    const row = find(input);
    if (!row || row.ownerToken !== token || row.finishedAt) throw new Error("owner changed");
    return row;
  };
  return {
    repos: {
      deployment: {
        findById: async () => h.deployment,
        updateStatus: h.updateStatus,
        findBuildSessionByDeploymentId: async () => ({
          id: "session",
          finishedAt: h.sessionFinished ? new Date() : null,
        }),
        acknowledgeBuildExecutionFinished: h.acknowledge,
      },
      project: { findById: async () => h.project },
      cloudWorkspace: {
        findById: async () => ({ id: "w", organizationId: "org", remote: h.remote ? {} : null }),
        claimActivity: async (_id: string, _org: string, activity: unknown) => {
          h.exclusive();
          return activity;
        },
        settleActivity: vi.fn(),
        releaseActivity: vi.fn(),
      },
      cloudDockerWorkspace: { find: async () => ({ workspaceId: h.binding }) },
      cloudBuildActivity: {
        find: async (input: CloudBuildActivityIdentity) => find(input),
        cancelReservation: async (input: CloudBuildActivityIdentity) => {
          const row = find(input);
          if (!row || row.finishedAt || row.ownerToken) return false;
          row.finishedAt = new Date();
          row.slotReleasedAt = new Date();
          return true;
        },
        claim: async (input: CloudBuildActivityIdentity, token: string) => {
          if (h.claimError) throw h.claimError;
          if (find(input)) throw new Error("duplicate execution");
          const row: CloudBuildActivity = {
            ...input,
            ownerToken: token,
            providerWorkspaceId: "vm",
            commands: [],
            buildSessionId: null,
            resources: null,
            exclusivePreparation: false,
            reservedAt: new Date(),
            startedAt: new Date(),
            finishedAt: null,
            slotReleasedAt: null,
          };
          h.rows.set(input.deploymentId, row);
          return row;
        },
        recordCommand: async (
          input: CloudBuildActivityIdentity,
          token: string,
          command: CloudBuildActivity["commands"][number],
        ) => {
          owner(input, token).commands.push(command);
        },
        completeCommand: async (
          input: CloudBuildActivityIdentity,
          token: string,
          marker: string,
        ) => {
          const row = owner(input, token);
          row.commands = row.commands.filter((command) => command.marker !== marker);
        },
        finish: async (input: CloudBuildActivityIdentity, token: string) => {
          h.finish(input, token);
          const row = owner(input, token);
          if (row.commands.length) throw new Error("exit unconfirmed");
          row.finishedAt = new Date();
        },
        releaseSlot: async (input: CloudBuildActivityIdentity, token: string) => {
          h.releaseSlot(input, token);
          const row = owner(input, token);
          if (row.commands.length) throw new Error("exit unconfirmed");
          row.slotReleasedAt = new Date();
        },
        takeRecoveryOwnership: async (input: CloudBuildActivityIdentity, token: string) => {
          const row = find(input);
          if (!row || row.finishedAt || !row.ownerToken) return undefined;
          row.ownerToken = token;
          return row;
        },
      },
    },
  };
});
import {
  withCloudBuildActivity,
  withCloudBuildExecutionOwnership,
  releaseCloudBuildSlot,
  recoverCloudBuildActivity,
  runOutsideCloudBuildActivity,
  CloudBuildAdmissionDeferredError,
} from "../src/engine/lib/cloud-build-activity";
import { tryWithProvisionLock } from "../src/engine/lib/provision-lock";
import {
  withCloudWorkspaceActivity,
  runOutsideCloudWorkspaceActivity,
  isCloudWorkspaceActivityHeld,
} from "../src/engine/lib/cloud-workspace-lock";
import { recoverManagedDeploymentExecution } from "../src/engine/modules/deployments/deployment-recovery";
const { verifyCloudBuildWorkerStopped } = await vi.importActual<
  typeof import("../src/engine/lib/cloud-build-worker-recovery")
>("../src/engine/lib/cloud-build-worker-recovery");

const identity = (id = "a", projectId = `p-${id}`): CloudBuildActivityIdentity => ({
  deploymentId: id,
  projectId,
  workspaceId: "w",
  organizationId: "org",
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  h.cloud = true;
  h.remote = false;
  h.binding = "vm";
  h.failRecovery = false;
  h.rows.clear();
  h.recovered = [];
  h.exclusive.mockClear();
  h.dispose.mockClear();
  h.deployment = {
    id: "a",
    projectId: "p-a",
    organizationId: "org",
    status: "building",
    meta: { deployTarget: "cloud", serverId: "server", managedWorkspaceId: "w" },
  } as Deployment;
  h.project = { id: "p-a", organizationId: "org", workspaceId: "w", serverId: "server" } as Project;
  h.sessionFinished = false;
  h.acknowledge.mockReset();
  h.updateStatus.mockReset().mockImplementation(async (_id: string, status: string) => {
    h.deployment!.status = status as Deployment["status"];
  });
  h.collect.mockReset().mockResolvedValue({ resources: [] });
  h.cleanup.mockReset().mockResolvedValue({ failed: [] });
  h.removeWorker.mockReset().mockResolvedValue(undefined);
  h.verifyWorker.mockReset().mockResolvedValue(undefined);
  h.finish.mockReset();
  h.releaseSlot.mockReset();
  h.claimError = undefined;
});

it("runs different projects concurrently, rejects recovery of a live owner, and isolates command tracking", async () => {
  const enteredA = deferred(),
    enteredB = deferred(),
    stop = deferred();
  const run = (id: string, entered: ReturnType<typeof deferred>) =>
    withCloudBuildActivity(identity(id), async () => {
      const tracking = currentManagedCommandTracking()!;
      await tracking.record({ workspaceId: "vm", marker: id });
      entered.resolve();
      await stop.promise;
      await tracking.complete(id);
    });
  const a = run("a", enteredA),
    b = run("b", enteredB);
  await Promise.all([enteredA.promise, enteredB.promise]);
  expect(h.rows.get("a")?.commands.map((command) => command.marker)).toEqual(["a"]);
  expect(h.rows.get("b")?.commands.map((command) => command.marker)).toEqual(["b"]);
  const cleanup = vi.fn();
  expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(false);
  expect(cleanup).not.toHaveBeenCalled();
  expect(h.recovered).toEqual([]);
  stop.resolve();
  await Promise.all([a, b]);
});

it("serializes whole pipelines for the same project without blocking nested project activity", async () => {
  const entered = deferred(),
    stop = deferred();
  const events: string[] = [];
  const a = withCloudBuildActivity(identity("a", "p"), async () => {
    await withCloudWorkspaceActivity(
      "w",
      async () => {
        events.push("nested");
      },
      undefined,
      { scope: "project:p" },
    );
    entered.resolve();
    await stop.promise;
  });
  await entered.promise;
  const b = withCloudBuildActivity(identity("b", "p"), async () => {
    events.push("b");
  });
  await Promise.resolve();
  expect(events).toEqual(["nested"]);
  stop.resolve();
  await Promise.all([a, b]);
  expect(events).toEqual(["nested", "b"]);
  expect(h.exclusive).not.toHaveBeenCalled();
});

it("rejects implicit upgrades and retains lifecycle ownership after releasing the build slot", async () => {
  await withCloudBuildActivity(identity(), async () => {
    for (const options of [
      {},
      { scope: "project:other" },
      { scope: "project:p-a", lifecycle: true },
    ])
      await expect(
        withCloudWorkspaceActivity("w", async () => {}, undefined, options),
      ).rejects.toMatchObject({ code: "CLOUD_BUILD_ACTIVITY_UPGRADE_FORBIDDEN" });
    const tracking = currentManagedCommandTracking()!;
    await tracking.record({ workspaceId: "vm", marker: "build" });
    await expect(releaseCloudBuildSlot()).rejects.toThrow("exit unconfirmed");
    await tracking.complete("build");
    await releaseCloudBuildSlot();
    expect(h.rows.get("a")?.finishedAt).toBeNull();
    await tracking.record({ workspaceId: "vm", marker: "deploy" });
    await tracking.complete("deploy");
  });
  expect(h.rows.get("a")?.slotReleasedAt).toBeInstanceOf(Date);
});

it("retains unresolved work, recovers only the exact execution, and fences late command callbacks", async () => {
  let stale: ReturnType<typeof currentManagedCommandTracking>;
  await expect(
    withCloudBuildActivity(identity(), async () => {
      stale = currentManagedCommandTracking();
      await stale!.record({ workspaceId: "vm", marker: "a" });
    }),
  ).rejects.toThrow("exit unconfirmed");
  expect(h.rows.get("a")?.finishedAt).toBeNull();
  await expect(stale!.record({ workspaceId: "vm", marker: "late" })).rejects.toMatchObject({
    code: "CLOUD_BUILD_ACTIVITY_CHANGED",
  });
  const cleanup = vi.fn(async () => {});
  h.failRecovery = true;
  await expect(recoverCloudBuildActivity(identity(), cleanup)).rejects.toThrow("exit unconfirmed");
  expect(cleanup).not.toHaveBeenCalled();
  expect(h.rows.get("a")?.finishedAt).toBeNull();
  h.failRecovery = false;
  expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(h.recovered).toEqual(["a", "a"]);
  expect(h.dispose).toHaveBeenCalledTimes(2);
});

it("does not recover against a replacement provider binding or release on failed cleanup", async () => {
  await expect(
    withCloudBuildActivity(identity(), async () => {
      await currentManagedCommandTracking()!.record({ workspaceId: "vm", marker: "a" });
    }),
  ).rejects.toThrow();
  h.binding = "other";
  await expect(recoverCloudBuildActivity(identity(), async () => {})).rejects.toMatchObject({
    code: "CLOUD_SERVER_IDENTITY_MISMATCH",
  });
  expect(h.recovered).toEqual([]);
  h.binding = "vm";
  await expect(
    recoverCloudBuildActivity(identity(), async () => {
      throw new Error("cleanup failed");
    }),
  ).rejects.toThrow("cleanup failed");
  expect(h.rows.get("a")?.finishedAt).toBeNull();
});

it("keeps self-hosted execution on the exclusive protocol", async () => {
  h.cloud = false;
  await withCloudBuildActivity(identity(), async () => {
    await releaseCloudBuildSlot();
  });
  expect(h.exclusive).toHaveBeenCalledOnce();
  expect(h.rows.size).toBe(0);
  expect(await recoverCloudBuildActivity(identity(), async () => {})).toBe(false);
});

it("detaches a new build while the parent's activity is still active", async () => {
  await withCloudBuildActivity(identity(), async () => {
    await expect(withCloudBuildActivity(identity("b"), async () => {})).rejects.toMatchObject({
      code: "CLOUD_BUILD_ACTIVITY_NESTED",
    });
    await runOutsideCloudBuildActivity(() =>
      withCloudBuildActivity(identity("b"), async () => {
        expect(h.rows.get("a")?.finishedAt).toBeNull();
        await currentManagedCommandTracking()!.record({ workspaceId: "vm", marker: "b" });
        expect(h.rows.get("a")?.commands).toEqual([]);
        await currentManagedCommandTracking()!.complete("b");
      }),
    );
    await releaseCloudBuildSlot();
    expect(h.rows.get("a")?.slotReleasedAt).toBeInstanceOf(Date);
  });
});

it("detaches exclusive admission context without releasing the parent's ownership", async () => {
  await withCloudWorkspaceActivity("w", async () => {
    expect(isCloudWorkspaceActivityHeld("w")).toBe(true);
    await runOutsideCloudWorkspaceActivity(async () => {
      await Promise.resolve();
      expect(isCloudWorkspaceActivityHeld("w")).toBe(false);
    });
    expect(isCloudWorkspaceActivityHeld("w")).toBe(true);
  });
});

it("holds execution ownership before shared admission and through final acknowledgement", async () => {
  const backups = deferred(),
    startBuild = deferred(),
    acknowledging = deferred(),
    acknowledged = deferred();
  const run = withCloudBuildExecutionOwnership("a", async () => {
    backups.resolve();
    await startBuild.promise;
    await withCloudBuildExecutionOwnership("a", () =>
      withCloudBuildActivity(identity(), async () => {}),
    );
    acknowledging.resolve();
    await acknowledged.promise;
  });
  await backups.promise;
  const cleanup = vi.fn(async () => {});
  expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(false);
  startBuild.resolve();
  await acknowledging.promise;
  expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(false);
  expect(cleanup).not.toHaveBeenCalled();
  acknowledged.resolve();
  await run;
  expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(true);
});

it.each(["queued", "building", "deploying"] as const)(
  "settles a stranded %s deployment when its build activity finished before a crash",
  async (status) => {
    await withCloudBuildActivity(identity(), async () => {});
    h.deployment!.status = status;
    h.verifyWorker.mockClear();
    h.finish.mockClear();
    expect(
      await recoverManagedDeploymentExecution(h.deployment!, h.project!, {
        recoverInterrupted: true,
      }),
    ).toBe(true);
    expect(h.deployment!.status).toBe("failed");
    expect(h.updateStatus).toHaveBeenCalledWith(
      "a",
      "failed",
      expect.objectContaining({
        errorCode: "DEPLOYMENT_INTERRUPTED",
      }),
    );
    expect(h.updateStatus.mock.invocationCallOrder[0]).toBeLessThan(
      h.acknowledge.mock.invocationCallOrder[0]!,
    );
    expect(h.acknowledge).toHaveBeenCalledWith("session");
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.verifyWorker).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
  },
);

it("retries a failed deployment-state write before acknowledging an already-finished activity", async () => {
  await withCloudBuildActivity(identity(), async () => {});
  h.updateStatus.mockRejectedValueOnce(new Error("Database unavailable"));
  await expect(
    recoverManagedDeploymentExecution(h.deployment!, h.project!, {
      recoverInterrupted: true,
    }),
  ).rejects.toThrow("Database unavailable");
  expect(h.deployment!.status).toBe("building");
  expect(h.acknowledge).not.toHaveBeenCalled();
  expect(
    await recoverManagedDeploymentExecution(h.deployment!, h.project!, {
      recoverInterrupted: true,
    }),
  ).toBe(true);
  expect(h.deployment!.status).toBe("failed");
  expect(h.acknowledge).toHaveBeenCalledOnce();
});

it("preserves a successful deployment after its finished activity is recovered", async () => {
  await withCloudBuildActivity(identity(), async () => {});
  h.deployment!.status = "ready";
  expect(
    await recoverManagedDeploymentExecution(h.deployment!, h.project!, {
      recoverInterrupted: true,
    }),
  ).toBe(true);
  expect(h.deployment!.status).toBe("ready");
  expect(h.updateStatus).not.toHaveBeenCalled();
  expect(h.cleanup).not.toHaveBeenCalled();
  expect(h.acknowledge).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "recovers an unactivated reservation only after its outer owner exits (callback cancels: %s)",
  async (callbackCancels) => {
    h.rows.set("a", {
      ...identity(),
      buildSessionId: "s",
      ownerToken: null,
      providerWorkspaceId: null,
      resources: null,
      exclusivePreparation: false,
      reservedAt: new Date(),
      startedAt: null,
      finishedAt: null,
      slotReleasedAt: null,
      commands: [],
    });
    const backups = deferred(),
      crash = deferred();
    const run = withCloudBuildExecutionOwnership("a", async () => {
      backups.resolve();
      await crash.promise;
    });
    await backups.promise;
    const cleanup = vi.fn(async (_state: { activated: boolean }) => {
      if (callbackCancels) {
        h.rows.get("a")!.finishedAt = new Date();
        h.rows.get("a")!.slotReleasedAt = new Date();
      }
    });
    expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    crash.resolve();
    await run;
    await expect(
      recoverCloudBuildActivity(identity(), async () => {
        throw new Error("DB unavailable");
      }),
    ).rejects.toThrow("DB unavailable");
    expect(h.rows.get("a")?.finishedAt).toBeNull();
    expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(true);
    expect(cleanup).toHaveBeenCalledWith({ activated: false });
    expect(h.rows.get("a")?.slotReleasedAt).toBeInstanceOf(Date);
    expect(h.recovered).toEqual([]);
  },
);

it("clears execution ownership for detached workers while retaining the live parent's context", async () => {
  await withCloudBuildExecutionOwnership("a", async () => {
    await expect(withCloudBuildExecutionOwnership("b", async () => {})).rejects.toMatchObject({
      code: "CLOUD_BUILD_EXECUTION_OWNERSHIP_CHANGED",
    });
    await runOutsideCloudBuildActivity(() => withCloudBuildExecutionOwnership("b", async () => {}));
    await withCloudBuildExecutionOwnership("a", async () => {});
  });
});

it("recovery winning before worker ownership fails the reservation and a delayed worker skips backups", async () => {
  h.rows.set("a", {
    ...identity(),
    buildSessionId: "session",
    ownerToken: null,
    providerWorkspaceId: null,
    resources: null,
    exclusivePreparation: false,
    reservedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    slotReleasedAt: null,
    commands: [],
  });
  expect(
    await recoverManagedDeploymentExecution(h.deployment!, h.project!, {
      recoverInterrupted: true,
    }),
  ).toBe(true);
  expect(h.deployment!.status).toBe("failed");
  expect(h.collect).not.toHaveBeenCalled();
  expect(h.cleanup).not.toHaveBeenCalled();
  expect(h.acknowledge).toHaveBeenCalledWith("session");
  const backups = vi.fn();
  await withCloudBuildExecutionOwnership("a", async () => {
    // Same durable recheck required at the pipeline's outer ownership boundary.
    if (!["building", "deploying"].includes(h.deployment!.status)) return;
    backups();
  });
  expect(backups).not.toHaveBeenCalled();
});

it("integrated recovery preserves a live worker in its pre-build backup phase", async () => {
  h.rows.set("a", {
    ...identity(),
    buildSessionId: "session",
    ownerToken: null,
    providerWorkspaceId: null,
    resources: null,
    exclusivePreparation: false,
    reservedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    slotReleasedAt: null,
    commands: [],
  });
  const entered = deferred(),
    done = deferred();
  const worker = withCloudBuildExecutionOwnership("a", async () => {
    entered.resolve();
    await done.promise;
  });
  await entered.promise;
  expect(
    await recoverManagedDeploymentExecution(h.deployment!, h.project!, {
      recoverInterrupted: true,
    }),
  ).toBe(false);
  expect(h.deployment!.status).toBe("building");
  expect(h.acknowledge).not.toHaveBeenCalled();
  done.resolve();
  await worker;
});

it("integrated recovery drains unfinished activity even after session acknowledgement", async () => {
  await expect(
    withCloudBuildActivity(identity(), async () => {
      await currentManagedCommandTracking()!.record({ workspaceId: "vm", marker: "orphan" });
    }),
  ).rejects.toThrow("exit unconfirmed");
  h.sessionFinished = true;
  expect(
    await recoverManagedDeploymentExecution(h.deployment!, h.project!, {
      recoverInterrupted: true,
    }),
  ).toBe(true);
  expect(h.recovered).toEqual(["orphan"]);
  expect(h.cleanup).toHaveBeenCalledOnce();
  expect(h.rows.get("a")?.finishedAt).toBeInstanceOf(Date);
  expect(h.acknowledge).not.toHaveBeenCalled();
});

it("integrated recovery acknowledges a finished activity without touching ready resources", async () => {
  await withCloudBuildActivity(identity(), async () => {});
  h.deployment!.status = "ready";
  expect(
    await recoverManagedDeploymentExecution(h.deployment!, h.project!, {
      recoverInterrupted: true,
    }),
  ).toBe(true);
  expect(h.deployment!.status).toBe("ready");
  expect(h.collect).not.toHaveBeenCalled();
  expect(h.cleanup).not.toHaveBeenCalled();
  expect(h.acknowledge).toHaveBeenCalledWith("session");
});

it("defers recovery without waiting behind another live deployment's project lock", async () => {
  h.rows.set("a", {
    ...identity(),
    buildSessionId: "session",
    ownerToken: null,
    providerWorkspaceId: null,
    resources: null,
    exclusivePreparation: false,
    reservedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    slotReleasedAt: null,
    commands: [],
  });
  const entered = deferred(),
    done = deferred();
  const worker = withCloudBuildActivity(identity("b", "p-a"), async () => {
    entered.resolve();
    await done.promise;
  });
  await entered.promise;
  const cleanup = vi.fn(async () => {});
  try {
    expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  } finally {
    done.resolve();
    await worker;
  }
});

it("retains slot and activity when daemon worker quiescence fails despite no tracked commands", async () => {
  const verify = vi.fn(async () => {
    throw new Error("BuildKit worker still running");
  });
  await expect(
    withCloudBuildActivity(
      identity(),
      async () => {
        await expect(releaseCloudBuildSlot()).rejects.toThrow("BuildKit worker still running");
        expect(h.rows.get("a")?.slotReleasedAt).toBeNull();
      },
      undefined,
      { verifyQuiescence: verify },
    ),
  ).rejects.toThrow("BuildKit worker still running");
  expect(h.rows.get("a")?.commands).toEqual([]);
  expect(h.rows.get("a")?.finishedAt).toBeNull();
  const cleanup = vi.fn(async () => {});
  await expect(
    recoverCloudBuildActivity(identity(), cleanup, { verifyQuiescence: verify }),
  ).rejects.toThrow("BuildKit worker still running");
  expect(cleanup).not.toHaveBeenCalled();
  expect(h.rows.get("a")?.finishedAt).toBeNull();
  verify.mockImplementation(async () => {});
  expect(await recoverCloudBuildActivity(identity(), cleanup, { verifyQuiescence: verify })).toBe(
    true,
  );
  expect(cleanup).toHaveBeenCalledOnce();
  expect(h.rows.get("a")?.finishedAt).toBeInstanceOf(Date);
});

it("checks daemon worker quiescence before each capacity or activity release", async () => {
  const events: string[] = [];
  await withCloudBuildActivity(
    identity(),
    async () => {
      events.push("build finished");
      await releaseCloudBuildSlot();
      events.push("slot released");
      expect(h.rows.get("a")?.finishedAt).toBeNull();
    },
    undefined,
    {
      verifyQuiescence: async () => {
        events.push("verified");
      },
    },
  );
  expect(events).toEqual(["build finished", "verified", "slot released", "verified"]);
});

it("binds worker cleanup to the admitted project and refuses cleanup outside activity ownership", async () => {
  await expect(verifyCloudBuildWorkerStopped()).rejects.toMatchObject({
    code: "CLOUD_BUILD_ACTIVITY_CHANGED",
  });
  expect(h.removeWorker).not.toHaveBeenCalled();
  await withCloudBuildActivity(
    identity(),
    async () => {
      await releaseCloudBuildSlot();
    },
    undefined,
    { verifyQuiescence: verifyCloudBuildWorkerStopped },
  );
  expect(h.removeWorker).toHaveBeenCalledTimes(2);
  expect(h.removeWorker).toHaveBeenCalledWith(expect.any(Object), "p-a");
});

it("recovers issuing commands before checking the daemon-owned worker", async () => {
  await expect(
    withCloudBuildActivity(
      identity(),
      async () => {
        await currentManagedCommandTracking()!.record({
          workspaceId: "vm",
          marker: "issuing-command",
        });
      },
      undefined,
      { verifyQuiescence: verifyCloudBuildWorkerStopped },
    ),
  ).rejects.toMatchObject({ code: "CLOUD_COMMAND_EXIT_UNCONFIRMED" });
  expect(h.removeWorker).not.toHaveBeenCalled();
  h.removeWorker.mockImplementation(async () => {
    expect(h.recovered).toEqual(["issuing-command"]);
  });
  expect(
    await recoverCloudBuildActivity(identity(), async () => {}, {
      verifyQuiescence: verifyCloudBuildWorkerStopped,
    }),
  ).toBe(true);
  expect(h.removeWorker).toHaveBeenCalledOnce();
});

it("requires worker verification by default and never releases capacity or activity on failure", async () => {
  h.verifyWorker.mockRejectedValue(new Error("worker exit unconfirmed"));
  await expect(
    withCloudBuildActivity(identity(), async () => {
      await expect(releaseCloudBuildSlot()).rejects.toThrow("worker exit unconfirmed");
    }),
  ).rejects.toThrow("worker exit unconfirmed");
  expect(h.verifyWorker).toHaveBeenCalledTimes(2);
  expect(h.finish).not.toHaveBeenCalled();
  expect(h.releaseSlot).not.toHaveBeenCalled();
  expect(h.rows.get("a")?.finishedAt).toBeNull();
  expect(h.rows.get("a")?.slotReleasedAt).toBeNull();
  const cleanup = vi.fn(async () => {});
  await expect(recoverCloudBuildActivity(identity(), cleanup)).rejects.toThrow(
    "worker exit unconfirmed",
  );
  expect(cleanup).not.toHaveBeenCalled();
  expect(h.finish).not.toHaveBeenCalled();
  h.verifyWorker.mockResolvedValue(undefined);
  expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(h.finish).toHaveBeenCalledOnce();
});

it("runs default recovery verification after command recovery and before cleanup", async () => {
  await expect(
    withCloudBuildActivity(identity(), async () => {
      await currentManagedCommandTracking()!.record({ workspaceId: "vm", marker: "issuing" });
    }),
  ).rejects.toThrow("exit unconfirmed");
  h.verifyWorker.mockClear().mockImplementation(async () => {
    expect(h.recovered).toEqual(["issuing"]);
  });
  const cleanup = vi.fn(async () => {
    expect(h.verifyWorker).toHaveBeenCalledOnce();
  });
  expect(await recoverCloudBuildActivity(identity(), cleanup)).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
});

const deferredCodes = [
  "CLOUD_WORKSPACE_ACTIVITY_BUSY",
  "CLOUD_WORKSPACE_BUSY",
  "CLOUD_BUILD_PROJECT_BUSY",
  "CLOUD_BUILD_HOST_NOT_READY",
  "CLOUD_WORKSPACE_BUILD_CAPACITY",
] as const;

it.each(deferredCodes)(
  "returns an identifiable pre-activation refusal for %s without work or finish",
  async (code) => {
    const original = new AppError("Activation refused", 409, code);
    h.claimError = original;
    const work = vi.fn(async () => {});
    await withCloudBuildExecutionOwnership("a", async () => {
      const error = await withCloudBuildActivity(identity(), work).catch((error) => error);
      expect(error).toBeInstanceOf(CloudBuildAdmissionDeferredError);
      expect(error).toMatchObject({
        code: "CLOUD_BUILD_ADMISSION_DEFERRED",
        reason: code,
        cause: original,
      });
      expect(error.cause).toBe(original);
      expect(await tryWithProvisionLock("cloud:build-project:p-a", async () => true)).toBe(true);
      // Main can atomically defer while keeping ownership of the entire worker.
      expect(await recoverCloudBuildActivity(identity(), async () => {})).toBe(false);
    });
    expect(work).not.toHaveBeenCalled();
    expect(h.verifyWorker).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.releaseSlot).not.toHaveBeenCalled();
    expect(h.rows.size).toBe(0);
  },
);

it.each(deferredCodes)("does not reclassify %s thrown inside admitted work", async (code) => {
  const original = new AppError("Work failed", 409, code);
  await expect(
    withCloudBuildActivity(identity(), async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  expect(h.finish).toHaveBeenCalledOnce();
  expect(h.rows.get("a")?.finishedAt).toBeInstanceOf(Date);
});

it.each([
  "BUILD_OWNERSHIP_MISMATCH",
  "CLOUD_BUILD_ACTIVITY_CHANGED",
  "CLOUD_BUILD_ACTIVITY_LOCAL_ONLY",
])("does not defer a permanent claim refusal %s", async (code) => {
  const original = new AppError("Invalid ownership", 409, code);
  h.claimError = original;
  await expect(withCloudBuildActivity(identity(), async () => {})).rejects.toBe(original);
  expect(h.finish).not.toHaveBeenCalled();
});

it("does not reclassify a matching error from worker verification", async () => {
  const original = new AppError("Verification failed", 409, "CLOUD_WORKSPACE_ACTIVITY_BUSY");
  h.verifyWorker.mockRejectedValue(original);
  await expect(withCloudBuildActivity(identity(), async () => {})).rejects.toBe(original);
  expect(h.finish).not.toHaveBeenCalled();
});

it("waits for streamed Docker acknowledgements before releasing static-build capacity", async () => {
  const acknowledgement = deferred();
  const extracted = deferred();
  let released = false;
  const worker = withCloudBuildActivity(identity(), async () => {
    const tracking = currentManagedCommandTracking()!;
    await tracking.record({ workspaceId: "vm", marker: "static-archive", kind: "docker" });
    tracking.defer(acknowledgement.promise.then(() => tracking.complete("static-archive")));
    // Archive bytes have already been extracted. Its asynchronous durable
    // acknowledgement is still in flight when the build phase completes.
    extracted.resolve();
    await releaseCloudBuildSlot();
    released = true;
  }, undefined, { verifyQuiescence: verifyCloudBuildWorkerStopped });
  const outcome = worker.then(() => null, error => error);
  await extracted.promise;
  await new Promise(resolve => setImmediate(resolve));
  expect(released).toBe(false);
  expect(h.removeWorker).not.toHaveBeenCalled();
  acknowledgement.resolve();
  expect(await outcome).toBeNull();
  expect(released).toBe(true);
  expect(h.rows.get("a")?.commands).toEqual([]);
  expect(h.rows.get("a")?.slotReleasedAt).toBeInstanceOf(Date);
  expect(h.rows.get("a")?.finishedAt).toBeInstanceOf(Date);
});

it("retains build capacity when a streamed acknowledgement fails even if its error is caught", async () => {
  const failure = new Error("durable acknowledgement unavailable");
  await expect(withCloudBuildActivity(identity(), async () => {
    const tracking = currentManagedCommandTracking()!;
    await tracking.record({ workspaceId: "vm", marker: "static-archive", kind: "docker" });
    tracking.defer(Promise.reject(failure));
    await expect(releaseCloudBuildSlot()).rejects.toBe(failure);
  }, undefined, { verifyQuiescence: verifyCloudBuildWorkerStopped })).rejects.toBe(failure);
  expect(h.removeWorker).not.toHaveBeenCalled();
  expect(h.releaseSlot).not.toHaveBeenCalled();
  expect(h.finish).not.toHaveBeenCalled();
  expect(h.rows.get("a")?.commands.map(command => command.marker)).toEqual(["static-archive"]);
  expect(h.rows.get("a")?.slotReleasedAt).toBeNull();
  expect(h.rows.get("a")?.finishedAt).toBeNull();
});
