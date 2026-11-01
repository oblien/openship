import { describe, expect, it, vi } from "vitest";
import { SYSTEM } from "@repo/core";
import {
  resolveReadinessGate,
  runReadinessGate,
} from "@repo/platform/engine/modules/deployments/readiness-gate";

const effects = () => ({
  stabilize: vi.fn(async () => null as string | null),
  probe: vi.fn(async () => null as string | null),
  onWarn: vi.fn(),
  log: vi.fn(),
});

describe("managed Cloud startup verification", () => {
  it.each([undefined, null, {}, { enabled: false, stabilization: false }])(
    "watches startup without requiring custom readiness: %j",
    async (config) => {
      const fx = effects();
      await runReadinessGate({ gate: resolveReadinessGate(config, { managedCloud: true }), ...fx });
      expect(fx.stabilize).toHaveBeenCalledWith(SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS);
      expect(fx.probe).not.toHaveBeenCalled();
    },
  );

  it("rejects a crashing container even when the HTTP check only warns", async () => {
    const fx = effects();
    fx.stabilize.mockResolvedValue('"web" exited with code 127: next: not found');
    await expect(
      runReadinessGate({
        gate: resolveReadinessGate({ enabled: true, onFailure: "warn" }, { managedCloud: true }),
        ...fx,
      }),
    ).rejects.toThrow("next: not found");
    expect(fx.probe).not.toHaveBeenCalled();
    expect(fx.onWarn).not.toHaveBeenCalled();
  });

  it("preserves custom HTTP warning policy after startup passes", async () => {
    const fx = effects();
    fx.probe.mockResolvedValue("HTTP readiness timed out");
    await runReadinessGate({
      gate: resolveReadinessGate({ enabled: true, onFailure: "warn" }, { managedCloud: true }),
      ...fx,
    });
    expect(fx.stabilize).toHaveBeenCalledOnce();
    expect(fx.onWarn).toHaveBeenCalledWith("HTTP readiness timed out");
  });

  it("still honors a custom HTTP veto", async () => {
    const fx = effects();
    fx.probe.mockResolvedValue("HTTP readiness timed out");
    await expect(
      runReadinessGate({
        gate: resolveReadinessGate({ enabled: true, onFailure: "fail" }, { managedCloud: true }),
        ...fx,
      }),
    ).rejects.toThrow("HTTP readiness timed out");
  });

  it("uses at least the Cloud startup window, while allowing a longer watch", () => {
    expect(
      resolveReadinessGate({ stabilizationSeconds: 1 }, { managedCloud: true }).stabilization
        .windowMs,
    ).toBe(SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS);
    expect(
      resolveReadinessGate({ stabilizationSeconds: 30 }, { managedCloud: true }).stabilization
        .windowMs,
    ).toBe(30_000);
  });

  it("keeps the service startup verdict separate from its inherited probe policy", () => {
    const gate = resolveReadinessGate({ enabled: true, onFailure: "warn" }, { managedCloud: true });
    expect(gate.stabilization.onFailure).toBe("fail");
    expect(gate.onFailure).toBe("warn");
  });

  it("leaves non-Cloud deployments opt-in", async () => {
    const fx = effects();
    await runReadinessGate({ gate: resolveReadinessGate(null, { managedCloud: false }), ...fx });
    expect(fx.stabilize).not.toHaveBeenCalled();
    expect(fx.probe).not.toHaveBeenCalled();
  });
});
