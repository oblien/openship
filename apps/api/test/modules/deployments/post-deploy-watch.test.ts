/**
 * GH-672: the background restart-loop watch that runs AFTER a deploy reported
 * ready. It must never block or fail the deploy, must only flag a release that
 * is still live, and must stay silent when it can't see the runtime.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerStabilitySample, RuntimeAdapter } from "@repo/adapters";

const { findById, setRestartLoop, listByDeployment } = vi.hoisted(() => ({
  findById: vi.fn(),
  setRestartLoop: vi.fn(),
  listByDeployment: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: { findById, setRestartLoop },
    serviceDeployment: { listByDeployment },
  },
}));

import {
  collectWatchTargets,
  runBackgroundStabilityWatch,
} from "@repo/platform/engine/modules/deployments/post-deploy-watch.service";

const FAST = { windowMs: 60, pollMs: 5 };

function sample(over: Partial<ContainerStabilitySample> = {}): ContainerStabilitySample {
  return {
    state: "running",
    exitCode: null,
    restartCount: 0,
    health: null,
    errorLine: null,
    oomKilled: false,
    restartPolicy: "always",
    ...over,
  };
}

function runtimeStub(sampleStability: (id: string) => Promise<ContainerStabilitySample>): RuntimeAdapter {
  return {
    name: "docker",
    supports: (cap: string) => cap === "stabilityProbe",
    sampleStability,
    getRuntimeLogs: async () => [{ message: "Error: connect ECONNREFUSED" }],
  } as unknown as RuntimeAdapter;
}

function series(...samples: ContainerStabilitySample[]) {
  let i = 0;
  return async () => samples[Math.min(i++, samples.length - 1)];
}

const crashLoop = series(
  sample({ restartCount: 0 }),
  sample({ state: "restarting", restartCount: 2, exitCode: 1 }),
  sample({ state: "restarting", restartCount: 5, exitCode: 1 }),
);

const dep = (over: Record<string, unknown> = {}) => ({
  id: "dep-1",
  projectId: "proj-1",
  organizationId: "org-1",
  status: "ready",
  containerId: "c-app",
  meta: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  listByDeployment.mockResolvedValue([]);
  setRestartLoop.mockResolvedValue(true);
});

describe("collectWatchTargets", () => {
  it("watches only compose services this release started successfully", async () => {
    listByDeployment.mockResolvedValue([
      { serviceId: "svc_api", serviceName: "api", containerId: "c1", status: "success" },
      { serviceId: "svc_db", serviceName: "db", containerId: "c2", status: "skipped" },
      { serviceId: "svc_job", serviceName: "job", containerId: null, status: "success" },
    ]);
    expect(await collectWatchTargets(dep() as never)).toEqual([
      { serviceId: "svc_api", serviceName: "api", containerId: "c1" },
    ]);
  });

  it("skips a static release directory — files, not a process", async () => {
    expect(await collectWatchTargets(dep({ containerId: "/srv/releases/r1" }) as never)).toEqual([]);
  });
});

describe("runBackgroundStabilityWatch", () => {
  it("flags a ready release whose container starts restart-looping", async () => {
    findById.mockResolvedValue(dep());
    const release = vi.fn();

    const finding = await runBackgroundStabilityWatch("dep-1", {
      ...FAST,
      resolveRuntime: async () => runtimeStub(crashLoop),
      release,
    });

    expect(finding?.services).toHaveLength(1);
    expect(finding?.services[0]).toMatchObject({ serviceName: "app", exitCode: 1 });
    expect(finding?.services[0]?.detail).toContain("ECONNREFUSED");
    expect(setRestartLoop).toHaveBeenCalledWith("dep-1", expect.objectContaining({ services: expect.any(Array) }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("records nothing when the container stays up", async () => {
    findById.mockResolvedValue(dep());
    const finding = await runBackgroundStabilityWatch("dep-1", {
      ...FAST,
      resolveRuntime: async () => runtimeStub(series(sample())),
      release: () => {},
    });
    expect(finding).toBeNull();
    expect(setRestartLoop).not.toHaveBeenCalled();
  });

  it("leaves a release that is no longer live alone", async () => {
    findById.mockResolvedValue(dep({ status: "cancelled" }));
    const resolveRuntime = vi.fn();
    expect(await runBackgroundStabilityWatch("dep-1", { ...FAST, resolveRuntime })).toBeNull();
    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it("stays silent when the runtime can't be reached", async () => {
    findById.mockResolvedValue(dep());
    const finding = await runBackgroundStabilityWatch("dep-1", {
      ...FAST,
      resolveRuntime: async () => {
        throw new Error("ssh: connect timed out");
      },
    });
    expect(finding).toBeNull();
    expect(setRestartLoop).not.toHaveBeenCalled();
  });

  it("does not report a finding the row refused (superseded meanwhile)", async () => {
    findById.mockResolvedValue(dep());
    setRestartLoop.mockResolvedValue(false);
    const finding = await runBackgroundStabilityWatch("dep-1", {
      ...FAST,
      resolveRuntime: async () => runtimeStub(crashLoop),
      release: () => {},
    });
    expect(finding).toBeNull();
  });
});
