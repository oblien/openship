import { describe, it, expect, vi } from "vitest";
import { DockerRuntime } from "./docker";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "./types";

async function fixture(swapInfo: Record<string, unknown>) {
  let removed = false;
  const remove = vi.fn(async () => { removed = true; });
  const create = vi.fn(async (_args: Record<string, any>) => ({
    id: "c".repeat(64),
    start: async () => {},
    remove: async () => {},
    inspect: async () => ({ NetworkSettings: { Networks: {} }, Config: {} }),
  }));
  const info = vi.fn(async () => swapInfo);
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-swap-test-no-daemon.sock",
  });
  const docker = {
    info,
    getContainer: () => ({
      stop: async () => {}, remove,
      inspect: async () => {
        if (removed) throw Object.assign(new Error("No such container"), { statusCode: 404 });
        return { Id: "a".repeat(64), State: { Status: "exited" } };
      },
    }),
    createContainer: create,
    getImage: () => ({ inspect: async () => ({ RepoDigests: [] }) }),
  };
  (runtime as unknown as { _docker: unknown })._docker = docker;
  const config: MultiServiceDeployConfig = {
    deploymentId: "dep",
    projectId: "project",
    slug: "demo",
    serviceName: "vault",
    image: "example/vault:1",
    ports: [],
    environment: {},
    volumes: [],
    namespaceVolumes: true,
    resources: { cpuCores: 0, memoryMb: 128, swapDisabled: true },
  };
  const deploy = () =>
    runtime.deployServiceWorkload({ id: "net-demo" } as MultiServiceGroupHandle, config);
  return { runtime, config, deploy, info, create, remove };
}

describe("Docker swap enforcement at container replacement", () => {
  it.each([{ SwapLimit: false }, {}, { SwapLimit: "true" }])(
    "rejects unverified host support before touching the old container (%j)",
    async (support) => {
      const run = await fixture(support);
      await expect(run.deploy()).rejects.toMatchObject({ code: "SWAP_DISABLED_UNSUPPORTED_HOST" });
      expect(run.remove).not.toHaveBeenCalled();
      expect(run.create).not.toHaveBeenCalled();
    },
  );
  it("creates the actual service with equal positive memory and swap caps", async () => {
    const run = await fixture({ SwapLimit: true });
    await run.deploy();
    expect(run.create.mock.calls[0]![0].HostConfig).toMatchObject({
      Memory: 134217728,
      MemorySwap: 134217728,
    });
  });
  it("retries a failed host probe before a later deployment", async () => {
    const run = await fixture({ SwapLimit: true });
    run.info.mockRejectedValueOnce(new Error("connection interrupted"));
    await expect(run.deploy()).rejects.toMatchObject({ code: "SWAP_DISABLED_HOST_PROBE_FAILED" });
    expect(run.remove).not.toHaveBeenCalled();
    expect(run.create).not.toHaveBeenCalled();
    await run.deploy();
    expect(run.info).toHaveBeenCalledTimes(2);
    expect(run.create).toHaveBeenCalledOnce();
  });
  it("does not probe swap support or add a swap cap for ordinary services", async () => {
    const run = await fixture({ SwapLimit: false });
    run.config.resources!.swapDisabled = false;
    await run.deploy();
    expect(run.info).not.toHaveBeenCalled();
    expect(run.create.mock.calls[0]![0].HostConfig).not.toHaveProperty("MemorySwap");
  });
  it("rejects missing memory before probing or removing the live container", async () => {
    const run = await fixture({ SwapLimit: true });
    run.config.resources!.memoryMb = 0;
    await expect(run.deploy()).rejects.toMatchObject({
      code: "SWAP_DISABLED_REQUIRES_MEMORY_LIMIT",
    });
    expect(run.info).not.toHaveBeenCalled();
    expect(run.remove).not.toHaveBeenCalled();
    expect(run.create).not.toHaveBeenCalled();
  });
});
