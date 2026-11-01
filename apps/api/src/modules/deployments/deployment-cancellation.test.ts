import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  hasLiveBuildExecution: vi.fn(),
  acknowledgeBuildExecutionFinished: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      findById: mocks.findById,
      hasLiveBuildExecution: mocks.hasLiveBuildExecution,
      acknowledgeBuildExecutionFinished: mocks.acknowledgeBuildExecutionFinished,
    },
  },
}));

import {
  DeploymentCancelledError,
  bindDeploymentBuildCancellation,
  completeDeploymentExecution,
  deploymentCancellationKeepsProvisioned,
  drainDeploymentExecutions,
  raceDeploymentCancellation,
  registerDeploymentExecution,
  releaseDeploymentExecution,
  requestDeploymentCancellation,
  waitForDeploymentQuiescence,
} from "@repo/platform/engine/modules/deployments/deployment-cancellation";

describe("deployment cancellation", () => {
  const ids: Array<{ id: string; signal: AbortSignal }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.findById.mockResolvedValue({ status: "building" });
    mocks.hasLiveBuildExecution.mockResolvedValue(false);
    mocks.acknowledgeBuildExecutionFinished.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const { id, signal } of ids.splice(0)) releaseDeploymentExecution(id, signal);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("mirrors a durable cancellation from another process into the local signal", async () => {
    const id = "dep_remote_cancel";
    const signal = registerDeploymentExecution(id);
    ids.push({ id, signal });
    const cancelBuild = vi.fn(async () => {});
    const finish = bindDeploymentBuildCancellation(signal, cancelBuild);
    mocks.findById.mockResolvedValue({ status: "cancelled" });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(signal.aborted).toBe(true);
    await finish();
    expect(cancelBuild).toHaveBeenCalledOnce();
  });

  it("forwards an earlier cancellation once when the build runtime finishes resolving", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancel = vi.fn(async () => {});
    const finish = bindDeploymentBuildCancellation(controller.signal, cancel);
    await finish();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels only its own build and detaches the runtime when work finishes", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const cancelFirst = vi.fn(async () => {});
    const cancelSecond = vi.fn(async () => {});
    const finishFirst = bindDeploymentBuildCancellation(first.signal, cancelFirst);
    const finishSecond = bindDeploymentBuildCancellation(second.signal, cancelSecond);
    first.abort();
    await finishFirst();
    expect(cancelFirst).toHaveBeenCalledOnce();
    expect(cancelSecond).not.toHaveBeenCalled();
    await finishSecond();
    second.abort();
    await Promise.resolve();
    expect(cancelSecond).not.toHaveBeenCalled();
  });

  it("wakes a prompt-like promise when cancellation is requested", async () => {
    const id = "dep_prompt_cancel";
    const signal = registerDeploymentExecution(id);
    ids.push({ id, signal });
    const neverSettles = new Promise<string>(() => {});
    const waiting = raceDeploymentCancellation(neverSettles, signal);

    expect(requestDeploymentCancellation(id)).toBe(true);

    await expect(waiting).rejects.toBeInstanceOf(DeploymentCancelledError);
  });

  it("carries the record-only cleanup policy with the cancellation signal", () => {
    const id = "dep_record_only";
    const signal = registerDeploymentExecution(id);
    ids.push({ id, signal });

    requestDeploymentCancellation(id, { keepProvisioned: true });

    expect(deploymentCancellationKeepsProvisioned(signal)).toBe(true);
  });

  it("waits until the worker acknowledges its durable lease", async () => {
    mocks.hasLiveBuildExecution.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const waiting = waitForDeploymentQuiescence("dep_wait", "project_1", {
      timeoutMs: 1_000,
      pollMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toBe(true);
    expect(mocks.hasLiveBuildExecution).toHaveBeenNthCalledWith(1, "dep_wait", "project_1");
    expect(mocks.hasLiveBuildExecution).toHaveBeenCalledTimes(2);
  });

  it("keeps cancellation pending when the worker does not release its lease", async () => {
    mocks.hasLiveBuildExecution.mockResolvedValue(true);

    const waiting = waitForDeploymentQuiescence("dep_stuck", "project_1", {
      timeoutMs: 200,
      pollMs: 100,
    });
    await vi.advanceTimersByTimeAsync(200);

    await expect(waiting).resolves.toBe(false);
  });

  it("fails closed when the durable lease cannot be read", async () => {
    mocks.hasLiveBuildExecution.mockRejectedValue(new Error("database unavailable"));

    const waiting = waitForDeploymentQuiescence("dep_unknown", "project_1", {
      timeoutMs: 100,
      pollMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toBe(false);
  });

  it("backs off during a prolonged completion-write outage and recovers without a restart", async () => {
    const id = "dep_completion_outage";
    const signal = registerDeploymentExecution(id);
    ids.push({ id, signal });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.acknowledgeBuildExecutionFinished.mockRejectedValue(new Error("Database unavailable"));
    try {
      const completing = completeDeploymentExecution(id, "session_outage", signal);
      let drained = false;
      const drain = drainDeploymentExecutions().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(drained).toBe(false);
      expect(mocks.acknowledgeBuildExecutionFinished.mock.calls.length).toBeLessThanOrEqual(8);
      // The worker has returned: only the completion retry needs a timer.
      expect(mocks.findById).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      mocks.acknowledgeBuildExecutionFinished.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(30_000);
      await completing;
      await drain;
      expect(requestDeploymentCancellation(id)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it("does not overlap completion writes while a database call is still pending", async () => {
    const id = "dep_completion_slow";
    const signal = registerDeploymentExecution(id);
    ids.push({ id, signal });
    let acknowledge!: () => void;
    mocks.acknowledgeBuildExecutionFinished.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const completing = completeDeploymentExecution(id, "session_slow", signal);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.acknowledgeBuildExecutionFinished).toHaveBeenCalledOnce();

    acknowledge();
    await completing;
    expect(requestDeploymentCancellation(id)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
