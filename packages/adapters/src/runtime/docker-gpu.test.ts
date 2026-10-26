import { describe, expect, it } from "vitest";

import { DockerRuntime, inspectGpuConfig } from "./docker";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "./types";
import { getAppTemplate, appServiceGpuConfig } from "@repo/core";

/**
 * What a compose GPU request becomes at container create.
 *
 * Pinned at the create payload, like docker-entrypoint.test.ts: `toDeviceRequests` can return the
 * right value and the container still never sees a card if `deployServiceWorkload` forgets to put it
 * on `HostConfig`. That is the whole bug — Docker only hands out a GPU when the create call carries
 * `DeviceRequests`, and `NVIDIA_VISIBLE_DEVICES` alone does nothing under the default runtime.
 */

const GROUP: MultiServiceGroupHandle = { id: "net-openship-demo" } as MultiServiceGroupHandle;

function baseConfig(overrides: Partial<MultiServiceDeployConfig> = {}): MultiServiceDeployConfig {
  return {
    deploymentId: "dep-1",
    projectId: "proj-1",
    slug: "demo",
    serviceName: "worker",
    image: "nvidia/cuda:12.4.1-base-ubuntu22.04",
    ports: [],
    environment: {},
    volumes: [],
    namespaceVolumes: true,
    ...overrides,
  } as MultiServiceDeployConfig;
}

async function createWith(config: MultiServiceDeployConfig) {
  const creates: Array<Record<string, any>> = [];
  const docker = {
    getContainer: () => ({
      inspect: async () => { throw Object.assign(new Error("No such container"), { statusCode: 404 }); },
      stop: async () => undefined,
      remove: async () => undefined,
    }),
    createContainer: async (args: Record<string, any>) => {
      creates.push(args);
      return {
        id: "c".repeat(64),
        start: async () => undefined,
        remove: async () => undefined,
        inspect: async () => ({ NetworkSettings: { Networks: {} }, Config: {} }),
      };
    },
    getImage: () => ({ inspect: async () => ({ RepoDigests: [] }) }),
  };
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-test-absent.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = docker;
  await runtime.deployServiceWorkload(GROUP, config);
  return creates[0]!;
}

describe("deployServiceWorkload — GPU", () => {
  it("deploys the vLLM template with one GPU and private shared memory", async () => {
    const service = getAppTemplate("vllm")!.services![0]!;
    const args = await createWith(baseConfig({ advanced: { ...appServiceGpuConfig(service, true), shmSize: service.shmSize } }));
    expect(args.HostConfig.DeviceRequests).toEqual([{ Driver: "nvidia", Count: 1, Capabilities: [["gpu"]] }]);
    expect(args.HostConfig.ShmSize).toBe(2147483648);
    expect(args.HostConfig).not.toHaveProperty("IpcMode");
    expect(args.HostConfig).not.toHaveProperty("Privileged");
    const ordinary = await createWith(baseConfig());
    expect(ordinary.HostConfig).not.toHaveProperty("ShmSize");
  });
  it("rejects invalid shared memory before creating a replacement", async () => {
    await expect(createWith(baseConfig({ advanced: { shmSize: -1 } }))).rejects.toThrow(/Shared memory/);
  });
  it("puts DeviceRequests on HostConfig when the service asks for a GPU", async () => {
    const args = await createWith(
      baseConfig({ advanced: { gpus: { driver: "nvidia", count: "all", capabilities: ["gpu"] } } }),
    );
    expect(args.HostConfig.DeviceRequests).toEqual([
      { Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] },
    ]);
  });

  it("sends no DeviceRequests key at all for a service without a GPU", async () => {
    const args = await createWith(baseConfig());
    expect("DeviceRequests" in args.HostConfig).toBe(false);
  });

  it("refuses a driver it cannot honor instead of creating a CPU container", async () => {
    await expect(createWith(baseConfig({ advanced: { gpus: { driver: "amd" } } }))).rejects.toThrow(
      /only.*NVIDIA/,
    );
  });
});

it("passes the legacy runtime and restricted environment without requesting every GPU", async () => {
  const args = await createWith(
    baseConfig({ advanced: { runtime: "nvidia" }, environment: { NVIDIA_VISIBLE_DEVICES: "0" } }),
  );
  expect(args.HostConfig.Runtime).toBe("nvidia");
  expect(args.HostConfig).not.toHaveProperty("DeviceRequests");
  expect(args.Env).toContain("NVIDIA_VISIBLE_DEVICES=0");
});

it("sends both device groups through the actual container create path", async () => {
  const args = await createWith(
    baseConfig({ advanced: { gpus: [{ deviceIds: ["0"] }, { deviceIds: ["1"] }] } }),
  );
  expect(args.HostConfig.DeviceRequests).toEqual([
    { Driver: "nvidia", DeviceIDs: ["0"], Capabilities: [["gpu"]] },
    { Driver: "nvidia", DeviceIDs: ["1"], Capabilities: [["gpu"]] },
  ]);
});

it("retains live GPU identity and legacy runtime from Docker inspect", () => {
  expect(
    inspectGpuConfig({
      Runtime: "nvidia",
      DeviceRequests: [
        {
          Driver: "nvidia",
          Count: 0,
          DeviceIDs: ["GPU-specific"],
          Capabilities: [["gpu", "compute"]],
          Options: { mode: "passthrough" },
        },
      ],
    } as never),
  ).toEqual({
    runtime: "nvidia",
    gpus: {
      driver: "nvidia",
      deviceIds: ["GPU-specific"],
      capabilities: ["gpu", "compute"],
      options: { mode: "passthrough" },
    },
  });
  expect(inspectGpuConfig({ Runtime: "runc" } as never)).toEqual({});
});

it("refuses imported alternative capability groups it cannot replay exactly", () => {
  expect(() =>
    inspectGpuConfig({
      DeviceRequests: [{ Driver: "nvidia", Count: 1, Capabilities: [["gpu"], ["compute"]] }],
    } as never),
  ).toThrow(/cannot be imported safely/);
});
