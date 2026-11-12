import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import type { PrivateImportPlan } from "@repo/platform/engine/modules/migration/platform-import-plan";

const h = vi.hoisted(() => ({ execute: vi.fn(), cleanup: vi.fn(), revoke: vi.fn() }));
vi.mock("@repo/platform/engine/modules/migration/platform-import-worker", () => ({
  executePlatformImport: h.execute,
  pauseFailedPlatformImport: h.cleanup,
}));
vi.mock("@repo/platform/engine/modules/migration/providers/railway-data", () => ({
  revokeRailwayImportKey: h.revoke,
}));
vi.mock("@repo/platform/engine/lib/provision-lock", async () => {
  const { withKeyedMutex, tryWithKeyedMutex } = await import("@repo/core");
  return {
    createProvisionLock: (key: string) => ({
      run: (work: () => Promise<unknown>) => withKeyedMutex(key, work),
    }),
    tryWithProvisionLock: (key: string, work: () => Promise<unknown>) =>
      tryWithKeyedMutex(key, work),
  };
});
import { migrationOrchestrator } from "@repo/platform/engine/modules/migration/migration.orchestrator";

type Run = NonNullable<Awaited<ReturnType<typeof repos.dockerMigrationRun.findById>>>;
const engine = migrationOrchestrator as unknown as {
  runWorker(id: string, work: () => Promise<void>): Promise<void>;
  runPlatformImport(ctx: ExecutionContext, id: string, plan: PrivateImportPlan): Promise<void>;
};
const ctx = { organizationId: "org", userId: "user" } as ExecutionContext;
let run: Run;
let signal: AbortSignal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  run = {
    id: "import",
    organizationId: "org",
    mode: "provider_import",
    status: "moving_data",
    sourceServerId: null,
    targetServerId: null,
    deploymentId: null,
    executionStartedAt: new Date(),
    executionFinishedAt: null,
    recovery: {},
  } as unknown as Run;
  vi.spyOn(repos.dockerMigrationRun, "findById").mockImplementation(async () => run);
  vi.spyOn(repos.dockerMigrationRun, "requestCancel").mockImplementation(async () => {
    run.recovery.cancelRequested = true;
    return true;
  });
  vi.spyOn(repos.dockerMigrationRun, "transition").mockImplementation(
    async (_id, status, patch) => {
      run = { ...run, status, ...patch } as Run;
    },
  );
  vi.spyOn(repos.dockerMigrationRun, "updateLogs").mockResolvedValue();
  vi.spyOn(repos.dockerMigrationRun, "acknowledgeExecutionFinished").mockImplementation(
    async () => {
      run.executionFinishedAt = new Date();
    },
  );
  h.execute.mockImplementation(async (_ctx, _id, _plan, lifecycle) => {
    signal = lifecycle.signal;
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  h.cleanup.mockResolvedValue(undefined);
  h.revoke.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("stopping provider imports", () => {
  it("interrupts deployment polling immediately rather than waiting for its interval", async () => {
    vi.spyOn(repos.deployment, "findById").mockResolvedValue({
      id: "deployment",
      status: "building",
    } as never);
    h.execute.mockImplementation(async (_ctx, _id, _plan, lifecycle) => {
      await lifecycle.wait("deployment");
    });
    const worker = engine.runWorker(run.id, () =>
      engine.runPlatformImport(ctx, run.id, {} as PrivateImportPlan),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(repos.deployment.findById).toHaveBeenCalledWith("deployment");
    try {
      await migrationOrchestrator.cancel(run.id, "org");
      await vi.advanceTimersByTimeAsync(0);
      expect(h.cleanup).toHaveBeenCalledWith(run.id);
    } finally {
      await vi.advanceTimersByTimeAsync(5000);
      await worker;
    }
    expect(run.status).toBe("rolled_back");
  });

  it("recovers a recently abandoned worker immediately under execution ownership", async () => {
    run.lastEventAt = new Date();
    expect(await migrationOrchestrator.cancel(run.id, "org")).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.cleanup).toHaveBeenCalledWith(run.id);
    expect(run.status).toBe("rolled_back");
    expect(run.executionFinishedAt).toBeInstanceOf(Date);
    await expect(
      engine.runWorker(run.id, async () => {
        throw new Error("late worker ran");
      }),
    ).rejects.toThrow("already finished or was recovered");
  });

  it.each(["same replica", "another replica"])(
    "aborts on %s and waits for recovery before reporting stopped",
    async (replica) => {
      const cleanup = deferred();
      h.cleanup.mockReturnValue(cleanup.promise);
      const worker = engine.runWorker(run.id, () =>
        engine.runPlatformImport(ctx, run.id, {} as PrivateImportPlan),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(signal.aborted).toBe(false);
      const canceller =
        replica === "same replica"
          ? migrationOrchestrator
          : new (migrationOrchestrator.constructor as new () => typeof migrationOrchestrator)();
      try {
        expect(await canceller.cancel(run.id, "org")).toEqual({ ok: true });
        await vi.advanceTimersByTimeAsync(replica === "same replica" ? 0 : 1000);
        expect(signal.aborted).toBe(true);
        expect(h.cleanup).toHaveBeenCalledWith(run.id);
        expect(run.recovery.cancelRequested).toBe(true);
        expect(run.status).toBe("moving_data");
        expect(run.executionFinishedAt).toBeNull();
      } finally {
        cleanup.resolve();
        await worker;
      }
      expect(run.status).toBe("rolled_back");
      expect(run.errorMessage).toContain("Import stopped");
      expect(run.executionFinishedAt).toBeInstanceOf(Date);
    },
  );

  it("retains the pending stop when recovery cannot finish", async () => {
    h.cleanup.mockRejectedValue(new Error("source unavailable"));
    const worker = engine.runWorker(run.id, () =>
      engine.runPlatformImport(ctx, run.id, {} as PrivateImportPlan),
    );
    const completion = expect(worker).rejects.toThrow("source unavailable");
    await vi.advanceTimersByTimeAsync(0);
    await migrationOrchestrator.cancel(run.id, "org");
    await completion;
    expect(run.recovery.cancelRequested).toBe(true);
    expect(run.status).not.toBe("rolled_back");
  });
});
