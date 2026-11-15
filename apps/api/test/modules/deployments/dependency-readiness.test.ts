import { afterEach, expect, it, vi } from "vitest";
import { BuildLogger, type RuntimeAdapter, type ContainerStabilitySample } from "@repo/adapters";
import { waitForDependencyCondition } from "@repo/platform/engine/modules/deployments/dependency-readiness";

afterEach(() => vi.useRealTimers());
const sample = (overrides: Partial<ContainerStabilitySample> = {}): ContainerStabilitySample => ({
  state: "running",
  health: "starting",
  restartCount: 0,
  oomKilled: false,
  exitCode: null,
  errorLine: null,
  restartPolicy: "no",
  ...overrides,
});
function fixture(
  condition: "service_healthy" | "service_completed_successfully" = "service_healthy",
) {
  const inspect = vi.fn(async () => sample());
  const run = (signal?: AbortSignal, timeoutMs = 120_000) =>
    waitForDependencyCondition({
      runtime: { sampleStability: inspect } as unknown as RuntimeAdapter,
      containerId: "db-container",
      serviceName: "db",
      condition,
      logger: new BuildLogger(() => {}),
      signal,
      timeoutMs,
    });
  return { inspect, run };
}

it("waits for Docker health, then releases the dependent without a fixed sleep", async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.inspect.mockResolvedValueOnce(sample()).mockResolvedValue(sample({ health: "healthy" }));
  const work = h.run();
  await vi.advanceTimersByTimeAsync(1_000);
  await work;
  expect(h.inspect).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  sample({ health: null }),
  sample({ health: "unhealthy" }),
  sample({ state: "missing" }),
  sample({ state: "exited", exitCode: 1 }),
  sample({ oomKilled: true }),
])("refuses an unsatisfied required health condition: %j", async (status) => {
  const h = fixture();
  h.inspect.mockResolvedValue(status);
  await expect(h.run()).rejects.toThrow(/Dependency/);
});

it("accepts a successful one-shot dependency and rejects its nonzero exit", async () => {
  const h = fixture("service_completed_successfully");
  h.inspect.mockResolvedValue(sample({ state: "exited", exitCode: 0 }));
  await expect(h.run()).resolves.toBeUndefined();
  h.inspect.mockResolvedValue(sample({ state: "exited", exitCode: 2 }));
  await expect(h.run()).rejects.toThrow("exit code 2");
});

it("ends bounded waiting and cancellation without leaving timers", async () => {
  vi.useFakeTimers();
  const h = fixture();
  const timedOut = expect(h.run(undefined, 1_000)).rejects.toThrow("Timed out");
  await vi.advanceTimersByTimeAsync(1_000);
  await timedOut;
  const abort = new AbortController();
  const cancelled = expect(h.run(abort.signal)).rejects.toThrow(/aborted/i);
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await cancelled;
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels even if a read-only Docker inspection never answers", async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.inspect.mockImplementation(() => new Promise(() => {}));
  const abort = new AbortController();
  const cancelled = expect(h.run(abort.signal)).rejects.toThrow(/aborted/i);
  abort.abort();
  await cancelled;
  expect(vi.getTimerCount()).toBe(0);
});
