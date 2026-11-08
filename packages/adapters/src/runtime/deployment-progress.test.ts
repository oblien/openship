import { afterEach, expect, it, vi } from "vitest";
import { withDeploymentProgress } from "./deployment-progress";

afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "reports the existing wait and clears its timer on failure=%s",
  async (fail) => {
    vi.useFakeTimers();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const log = vi.fn();
    const run = vi.fn(() => promise);
    const work = withDeploymentProgress({ log }, "the existing TLS check", run);
    const settled = work.catch((error) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("2s elapsed"));
    if (fail) reject(new Error("TLS failed"));
    else resolve();
    const result = await settled;
    if (fail) expect(result).toBeInstanceOf(Error);
    const calls = log.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  },
);
