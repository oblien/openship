import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";
import { SERVER_STATS_COMMAND } from "../system/server-stats";
import type { CommandExecutor } from "../types";
import type { MultiServiceDeployConfig } from "./types";

const GIB = 1024 ** 3;
const GROUP = { id: "project-network" };
const CONFIG: MultiServiceDeployConfig = {
  deploymentId: "dep-new",
  previousContainerId: "old-id",
  projectId: "project-id",
  slug: "demo",
  serviceName: "api",
  image: "openship/demo:bld_new",
  ports: ["3000"],
  publicPort: 3000,
  volumes: [],
  environment: {},
  namespaceVolumes: true,
  imageAlreadyPrepared: true,
  resources: { cpuCores: 1, memoryMb: 512 },
};

async function fixture(options: { freeMemory?: number; cpu?: number; imageHealth?: boolean } = {}) {
  const old = {
    Id: "old-id",
    Name: "/openship-demo-api",
    Mounts: [],
    Config: { Labels: { "openship.project": "project-id", "openship.service": "api" } },
    State: { Running: true, Restarting: false, Status: "running" },
    NetworkSettings: { Networks: { [GROUP.id]: { NetworkID: GROUP.id, IPAddress: "172.20.0.2" } } },
  };
  const oldContainer = { inspect: vi.fn(async () => old), stop: vi.fn(), remove: vi.fn() };
  const candidate = {
    id: "candidate-id",
    start: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({
      NetworkSettings: { Networks: { [GROUP.id]: { IPAddress: "172.20.0.3" } } },
    })),
  };
  const image = {
    Config: {
      Labels: {},
      ...(options.imageHealth ? { Healthcheck: { Test: ["CMD", "check"] } } : {}),
    },
    RepoDigests: [],
  };
  const docker = {
    info: vi.fn(async () => ({
      OSType: "linux",
      OperatingSystem: "Ubuntu",
      NCPU: 4,
      MemTotal: 8 * GIB,
    })),
    getContainer: vi.fn((id: string) => (id === "old-id" ? oldContainer : candidate)),
    getImage: vi.fn(() => ({ inspect: vi.fn(async () => image) })),
    createContainer: vi.fn(async () => candidate),
  };
  const exec = vi.fn(async (command: string) => {
    if (command !== SERVER_STATS_COMMAND) throw new Error("Unexpected host command");
    return JSON.stringify({
      cpu: options.cpu ?? 10,
      memTotal: 8 * GIB,
      memUsed: 8 * GIB - (options.freeMemory ?? 4 * GIB),
      memAvail: options.freeMemory ?? 4 * GIB,
      diskTotal: 20 * GIB,
      diskUsed: GIB,
      diskAvail: 19 * GIB,
      uptime: "10",
      load1: "0.1",
      load5: "0.1",
      load15: "0.1",
    });
  });
  const executor = { exec } as unknown as CommandExecutor;
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-test-absent.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = docker;
  vi.spyOn(
    runtime as unknown as {
      serviceVolumeBinds(config: MultiServiceDeployConfig): Promise<string[]>;
    },
    "serviceVolumeBinds",
  ).mockResolvedValue([]);
  return { runtime, docker, old, oldContainer, candidate, executor, exec };
}

describe("optional service cutover admission", () => {
  it("stages a candidate without touching the incumbent or publishing live aliases", async () => {
    const f = await fixture();
    const plan = await f.runtime.prepareServiceCutover(GROUP, CONFIG, { executor: f.executor });
    expect(plan).not.toBeNull();
    await f.runtime.deployServiceWorkload(GROUP, plan!.config);
    expect(f.oldContainer.stop).not.toHaveBeenCalled();
    expect(f.oldContainer.remove).not.toHaveBeenCalled();
    expect(f.docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "openship-cutover-depnew-api",
        HostConfig: expect.objectContaining({ NanoCpus: 1_000_000_000, Memory: 512 * 1024 * 1024 }),
        NetworkingConfig: { EndpointsConfig: { [GROUP.id]: { Aliases: [] } } },
      }),
    );
    expect(plan!.config.resources).toEqual(CONFIG.resources);
  });

  it.each([{ freeMemory: 128 * 1024 ** 2 }, { cpu: 95 }])(
    "does not overlap when the target lacks headroom: %j",
    async (options) => {
      const f = await fixture(options);
      expect(
        await f.runtime.prepareServiceCutover(GROUP, CONFIG, { executor: f.executor }),
      ).toBeNull();
      expect(f.docker.createContainer).not.toHaveBeenCalled();
      expect(f.oldContainer.stop).not.toHaveBeenCalled();
    },
  );

  it("does not invent limits or measure API-host resources for uncapped services", async () => {
    const f = await fixture();
    expect(
      await f.runtime.prepareServiceCutover(
        GROUP,
        { ...CONFIG, resources: undefined },
        { executor: f.executor },
      ),
    ).toBeNull();
    expect(f.exec).not.toHaveBeenCalled();
    expect(await f.runtime.prepareServiceCutover(GROUP, CONFIG)).toBeNull();
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("falls back when host sampling fails or measures a different machine", async () => {
    const f = await fixture();
    f.exec.mockRejectedValueOnce(new Error("host unavailable"));
    expect(
      await f.runtime.prepareServiceCutover(GROUP, CONFIG, { executor: f.executor }),
    ).toBeNull();
    f.docker.info.mockResolvedValueOnce({
      OSType: "linux",
      OperatingSystem: "Docker Desktop",
      NCPU: 4,
      MemTotal: 8 * GIB,
    });
    expect(
      await f.runtime.prepareServiceCutover(GROUP, CONFIG, { executor: f.executor }),
    ).toBeNull();
    expect(f.oldContainer.stop).not.toHaveBeenCalled();
  });

  it("preserves the normal path for explicit Docker health checks and extra networks", async () => {
    const f = await fixture({ imageHealth: true });
    expect(
      await f.runtime.prepareServiceCutover(GROUP, CONFIG, { executor: f.executor }),
    ).toBeNull();
    const g = await fixture();
    Object.assign(g.old.NetworkSettings.Networks, {
      external: { NetworkID: "external", IPAddress: "172.21.0.2" },
    });
    expect(
      await g.runtime.prepareServiceCutover(GROUP, CONFIG, { executor: g.executor }),
    ).toBeNull();
    expect(g.oldContainer.remove).not.toHaveBeenCalled();
  });

  it("refuses a foreign incumbent even when its container name resembles this service", async () => {
    const f = await fixture();
    f.old.Config.Labels["openship.project"] = "other-project";
    expect(
      await f.runtime.prepareServiceCutover(GROUP, CONFIG, { executor: f.executor }),
    ).toBeNull();
    expect(f.oldContainer.stop).not.toHaveBeenCalled();
  });
});
