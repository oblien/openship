import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostPortTargetIdentity } from "@repo/platform/engine/lib/host-port-target";

const h = vi.hoisted(() => ({
  lock: vi.fn(),
  converge: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/deployments/pinned-host-ports", () => ({
  withHostPortTargetLock: (...args: unknown[]) => h.lock(...args),
  convergeTargetHostPortClaimsUnlocked: (...args: unknown[]) => h.converge(...args),
}));

import { retireSourceManagedRoutes } from "@repo/platform/engine/modules/migration/migration.orchestrator";

const target: HostPortTargetIdentity = {
  targetKey: "host:source-machine",
  legacyTargetKeys: ["server:source"],
  stable: true,
};

describe("retireSourceManagedRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.lock.mockImplementation(async (_target: unknown, fn: () => Promise<unknown>) => fn());
    h.converge.mockResolvedValue({ released: 1, retained: [] });
  });

  it("serializes route removal and unlocked claim convergence under one target lock", async () => {
    const order: string[] = [];
    h.lock.mockImplementation(async (_target: unknown, fn: () => Promise<unknown>) => {
      order.push("lock-enter");
      const result = await fn();
      order.push("lock-exit");
      return result;
    });
    const routing = {
      removeRoute: vi.fn(async (hostname: string) => {
        order.push(`remove:${hostname}`);
      }),
    };
    const edgeProxy = { listLoopbackUpstreamPortsStrict: vi.fn() };
    h.converge.mockImplementation(async () => {
      order.push("converge");
      return { released: 1, retained: [] };
    });

    await retireSourceManagedRoutes({
      projectId: "project-1",
      hostnames: ["one.example.com", "two.example.com", "one.example.com"],
      routing,
      target,
      edgeProxy,
      releaseClaims: true,
    });

    expect(h.lock).toHaveBeenCalledWith(target, expect.any(Function));
    expect(routing.removeRoute).toHaveBeenCalledTimes(2);
    expect(h.converge).toHaveBeenCalledWith({
      target,
      projectId: "project-1",
      desiredPublishes: [],
      edgeProxy,
    });
    expect(order).toEqual([
      "lock-enter",
      "remove:one.example.com",
      "remove:two.example.com",
      "converge",
      "lock-exit",
    ]);
  });

  it("removes routes but retains every claim while a source workload survived", async () => {
    const routing = { removeRoute: vi.fn().mockResolvedValue(undefined) };

    await retireSourceManagedRoutes({
      projectId: "project-1",
      hostnames: ["app.example.com"],
      routing,
      target,
      edgeProxy: { listLoopbackUpstreamPortsStrict: vi.fn() },
      releaseClaims: false,
    });

    expect(routing.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(h.converge).not.toHaveBeenCalled();
  });

  it("retains every claim when any route removal is uncertain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const routing = {
      removeRoute: vi
        .fn()
        .mockRejectedValueOnce(new Error("source edge unavailable"))
        .mockResolvedValueOnce(undefined),
    };

    await expect(
      retireSourceManagedRoutes({
        projectId: "project-1",
        hostnames: ["one.example.com", "two.example.com"],
        routing,
        target,
        edgeProxy: { listLoopbackUpstreamPortsStrict: vi.fn() },
        releaseClaims: true,
      }),
    ).resolves.toBeUndefined();

    expect(routing.removeRoute).toHaveBeenCalledTimes(2);
    expect(h.converge).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("host-port claims retained"),
      "source edge unavailable",
    );
    warn.mockRestore();
  });

  it("keeps completed cutover best-effort when the strict scan or database convergence fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.converge.mockRejectedValueOnce(new Error("strict edge scan unavailable"));

    await expect(
      retireSourceManagedRoutes({
        projectId: "project-1",
        hostnames: [],
        routing: { removeRoute: vi.fn() },
        target,
        edgeProxy: { listLoopbackUpstreamPortsStrict: vi.fn() },
        releaseClaims: true,
      }),
    ).resolves.toBeUndefined();

    // Empty hostname sets still converge: they can occur after domain deletion,
    // and stale claims must not survive forever when the workloads are gone.
    expect(h.converge).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("claims retained"),
      "strict edge scan unavailable",
    );
    warn.mockRestore();
  });
});
