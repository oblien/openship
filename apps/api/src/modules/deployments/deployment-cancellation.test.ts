import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  hasLiveBuildExecution: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      findById: mocks.findById,
      hasLiveBuildExecution: mocks.hasLiveBuildExecution,
    },
  },
}));

import {
  DeploymentCancelledError,
  deploymentCancellationKeepsProvisioned,
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
    mocks.findById.mockResolvedValue({ status: "cancelled" });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(signal.aborted).toBe(true);
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
});
