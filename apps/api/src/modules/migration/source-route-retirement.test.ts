import { beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import type { HostPortTargetIdentity } from "../../lib/host-port-target";

const h = vi.hoisted(() => ({
  lock: vi.fn(),
  converge: vi.fn(),
}));

vi.mock("../deployments/pinned-host-ports", () => ({
  withHostPortTargetLock: (...args: unknown[]) => h.lock(...args),
  convergeTargetHostPortClaimsUnlocked: (...args: unknown[]) => h.converge(...args),
}));

import { migrationOrchestrator, retireSourceManagedRoutes } from "./migration.orchestrator";

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

describe("interrupted project-move cutover recovery", () => {
  it.each([
    { failed: [], releaseClaims: true },
    {
      failed: [{ name: "web", containerId: "container-1", reason: "still running" }],
      releaseClaims: false,
    },
  ])(
    "replays source route retirement with releaseClaims=$releaseClaims",
    async ({ failed, releaseClaims }) => {
      const run = {
        id: "migration-1",
        status: "cutover",
        mode: "project_move",
        projectId: "project-1",
        organizationId: "org-1",
        sourceServerId: "source-server",
        targetServerId: "target-server",
        scannedContainerIds: { web: "container-1" },
      };
      const listInFlight = vi
        .spyOn(repos.dockerMigrationRun, "listInFlight")
        .mockResolvedValue([run] as never);
      const transition = vi
        .spyOn(repos.dockerMigrationRun, "transition")
        .mockResolvedValue(undefined as never);
      const internals = migrationOrchestrator as unknown as {
        cutover: () => Promise<{ failed: typeof failed }>;
        retireSourceRoutes: (
          projectId: string,
          sourceServerId: string,
          organizationId: string,
          releaseClaims: boolean,
        ) => Promise<void>;
      };
      const cutover = vi.spyOn(internals, "cutover").mockResolvedValue({ failed });
      const retireRoutes = vi.spyOn(internals, "retireSourceRoutes").mockResolvedValue(undefined);

      await migrationOrchestrator.recoverInterruptedMigrations();

      expect(cutover).toHaveBeenCalledWith("source-server", "org-1", {
        web: "container-1",
      });
      expect(retireRoutes).toHaveBeenCalledWith(
        "project-1",
        "source-server",
        "org-1",
        releaseClaims,
      );
      expect(transition).toHaveBeenCalledWith("migration-1", "succeeded");

      retireRoutes.mockRestore();
      cutover.mockRestore();
      transition.mockRestore();
      listInFlight.mockRestore();
    },
  );

  it("parks an interrupted resume again instead of tearing down its live target", async () => {
    const run = {
      id: "migration-resume",
      status: "moving_data",
      mode: "project_move",
      projectId: "project-1",
      organizationId: "org-1",
      sourceServerId: "source-server",
      targetServerId: "target-server",
      pendingItems: [],
      executionStartedAt: new Date(),
      executionFinishedAt: null,
    };
    const listInFlight = vi
      .spyOn(repos.dockerMigrationRun, "listInFlight")
      .mockResolvedValue([run] as never);
    const transition = vi
      .spyOn(repos.dockerMigrationRun, "transition")
      .mockResolvedValue(undefined as never);
    const acknowledge = vi
      .spyOn(repos.dockerMigrationRun, "acknowledgeExecutionFinished")
      .mockResolvedValue(undefined as never);
    const internals = migrationOrchestrator as unknown as {
      teardownTargetAndRestoreSource: () => Promise<void>;
    };
    const teardown = vi
      .spyOn(internals, "teardownTargetAndRestoreSource")
      .mockResolvedValue(undefined);

    await migrationOrchestrator.recoverInterruptedMigrations();

    expect(transition).toHaveBeenCalledWith("migration-resume", "partial", {
      errorMessage: "Resume was interrupted — review pending paths and retry.",
    });
    expect(acknowledge).toHaveBeenCalledWith("migration-resume");
    expect(teardown).not.toHaveBeenCalled();

    teardown.mockRestore();
    acknowledge.mockRestore();
    transition.mockRestore();
    listInFlight.mockRestore();
  });

  it("keeps an interrupted cutover retryable when source cleanup is still unreachable", async () => {
    const run = {
      id: "migration-cutover-failed",
      status: "cutover",
      mode: "project_move",
      projectId: "project-1",
      organizationId: "org-1",
      sourceServerId: "source-server",
      targetServerId: "target-server",
      scannedContainerIds: { web: "container-1" },
      executionStartedAt: new Date(),
      executionFinishedAt: null,
    };
    const listInFlight = vi
      .spyOn(repos.dockerMigrationRun, "listInFlight")
      .mockResolvedValue([run] as never);
    const transition = vi
      .spyOn(repos.dockerMigrationRun, "transition")
      .mockResolvedValue(undefined as never);
    const acknowledge = vi
      .spyOn(repos.dockerMigrationRun, "acknowledgeExecutionFinished")
      .mockResolvedValue(undefined as never);
    const internals = migrationOrchestrator as unknown as {
      cutover: () => Promise<{ failed: [] }>;
      retireSourceRoutes: () => Promise<void>;
    };
    const cutover = vi.spyOn(internals, "cutover").mockRejectedValue(new Error("host lost"));
    const retireRoutes = vi.spyOn(internals, "retireSourceRoutes").mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await migrationOrchestrator.recoverInterruptedMigrations();

    expect(transition).toHaveBeenCalledWith(
      "migration-cutover-failed",
      "cutover",
      expect.objectContaining({ errorMessage: expect.stringContaining("host lost") }),
    );
    expect(transition).not.toHaveBeenCalledWith("migration-cutover-failed", "succeeded");
    expect(retireRoutes).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledWith("migration-cutover-failed");

    warn.mockRestore();
    retireRoutes.mockRestore();
    cutover.mockRestore();
    acknowledge.mockRestore();
    transition.mockRestore();
    listInFlight.mockRestore();
  });
});

describe("cutover execution claim", () => {
  it("keeps a failed destructive claim retryable and acknowledges every attempt", async () => {
    const initial = {
      id: "migration-claim",
      status: "awaiting_cutover",
      mode: "cross_server",
      projectId: "project-1",
      organizationId: "org-1",
      sourceServerId: "source-server",
      targetServerId: "target-server",
      scannedContainerIds: { web: "container-1" },
      confirmationToken: "token-1",
    };
    const claimed = {
      ...initial,
      status: "cutover",
      executionStartedAt: new Date(),
      executionFinishedAt: null,
    };
    const find = vi.spyOn(repos.dockerMigrationRun, "findById").mockResolvedValue(initial as never);
    const claim = vi
      .spyOn(repos.dockerMigrationRun, "claimExecution")
      .mockResolvedValue(claimed as never);
    const acknowledge = vi
      .spyOn(repos.dockerMigrationRun, "acknowledgeExecutionFinished")
      .mockResolvedValue(undefined as never);
    const transition = vi
      .spyOn(repos.dockerMigrationRun, "transition")
      .mockResolvedValue(undefined as never);
    const internals = migrationOrchestrator as unknown as {
      cutover: () => Promise<{ failed: [] }>;
    };
    const cutover = vi
      .spyOn(internals, "cutover")
      .mockRejectedValueOnce(new Error("host lost"))
      .mockResolvedValueOnce({ failed: [] });

    await expect(
      migrationOrchestrator.resolveCutover("migration-claim", "org-1", "token-1", true),
    ).rejects.toThrow("host lost");

    find.mockResolvedValueOnce({
      ...claimed,
      executionFinishedAt: new Date(),
      errorMessage: "Cutover incomplete",
    } as never);
    await expect(
      migrationOrchestrator.resolveCutover("migration-claim", "org-1", "token-1", true),
    ).resolves.toEqual({ ok: true, leftBehind: [] });

    expect(claim).toHaveBeenNthCalledWith(1, {
      id: "migration-claim",
      organizationId: "org-1",
      from: "awaiting_cutover",
      to: "cutover",
    });
    expect(claim).toHaveBeenNthCalledWith(2, {
      id: "migration-claim",
      organizationId: "org-1",
      from: "cutover",
      to: "cutover",
    });
    expect(cutover).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenCalledWith(
      "migration-claim",
      "cutover",
      expect.objectContaining({ errorMessage: expect.stringContaining("host lost") }),
    );
    expect(transition).toHaveBeenCalledWith("migration-claim", "succeeded", undefined);
    expect(acknowledge).toHaveBeenCalledTimes(2);

    cutover.mockRestore();
    transition.mockRestore();
    acknowledge.mockRestore();
    claim.mockRestore();
    find.mockRestore();
  });
});
