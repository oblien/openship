import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPrepareStep } from "@repo/core";
import type { ExecOnly } from "@repo/adapters";
import { runAppPrepareCommand } from "@repo/platform/engine/modules/deployments/compose/app-prepare";

const step: AppPrepareStep = {
  service: "storage",
  command: "create-bucket",
  capture: "bucket",
  mustSucceed: true,
};
const executor = (exec: ExecOnly["exec"]): ExecOnly => ({ exec });
afterEach(() => vi.useRealTimers());
describe("catalog setup completion", () => {
  it("fails a required step when its runtime cannot execute it", async () => {
    await expect(runAppPrepareCommand(step, null)).rejects.toThrow("cannot execute");
    expect(await runAppPrepareCommand({ ...step, mustSucceed: false }, null)).toBe("");
  });
  it("never runs initialization before its readiness check succeeds", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("service not ready"));
    await expect(
      runAppPrepareCommand(
        { ...step, phase: "post-ready", readiness: { test: "ready", retries: 2, interval: 1 } },
        executor(exec),
      ),
    ).rejects.toThrow("readiness");
    expect(exec.mock.calls.map((call) => call[0])).toEqual(["ready", "ready"]);
  });
  it("retries startup races then returns only the captured output", async () => {
    vi.useFakeTimers();
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("starting"))
      .mockResolvedValueOnce("bucket=uploads\n");
    const result = runAppPrepareCommand({ ...step, capturePattern: "bucket=(.*)" }, executor(exec));
    const check = expect(result).resolves.toBe("uploads");
    await vi.runAllTimersAsync();
    await check;
  });
  it("does not claim success when required setup fails or captures no output", async () => {
    await expect(
      runAppPrepareCommand(step, executor(vi.fn().mockResolvedValue("\n"))),
    ).rejects.toThrow("no output");
    vi.useFakeTimers();
    const exec = vi.fn().mockRejectedValue(new Error("access denied"));
    const check = expect(runAppPrepareCommand(step, executor(exec))).rejects.toThrow(
      "access denied",
    );
    await vi.runAllTimersAsync();
    await check;
    expect(exec).toHaveBeenCalledTimes(5);
  });
});
