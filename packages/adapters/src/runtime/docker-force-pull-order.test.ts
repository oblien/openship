import { describe, expect, it, vi } from "vitest";

import { DockerRuntime } from "./docker";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "./types";

const GROUP: MultiServiceGroupHandle = { id: "net-openship-demo" };

const CONFIG: MultiServiceDeployConfig = {
  deploymentId: "dep-1",
  projectId: "proj-1",
  slug: "demo",
  serviceName: "api",
  image: "ghcr.io/acme/api:staging",
  ports: [],
  environment: {},
  volumes: [],
  namespaceVolumes: true,
  forcePull: true,
};

describe("Docker service force-pull ordering", () => {
  it("reuses an existing local image after checking it before container removal", async () => {
    const inspectImage = vi.fn(async () => ({}));
    const remove = vi.fn(async () => undefined);
    const docker = {
      getImage: vi.fn(() => ({ inspect: inspectImage })),
      getContainer: vi.fn(() => ({ remove })),
      createContainer: vi.fn().mockRejectedValue(new Error("stop after proving ordering")),
    };
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    (runtime as unknown as { _docker: unknown })._docker = docker;

    await expect(
      runtime.deployServiceWorkload(GROUP, {
        ...CONFIG,
        forcePull: false,
        imageAlreadyPrepared: false,
      }),
    ).rejects.toThrow("stop after proving ordering");

    expect(inspectImage).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(inspectImage.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the running container intact when the replacement image cannot be pulled", async () => {
    const remove = vi.fn(async () => undefined);
    const docker = {
      getContainer: vi.fn(() => ({ remove })),
      createContainer: vi.fn(),
    };
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    (runtime as unknown as { _docker: unknown })._docker = docker;
    vi.spyOn(runtime, "pullImage").mockRejectedValue(new Error("registry unavailable"));

    await expect(runtime.deployServiceWorkload(GROUP, CONFIG)).rejects.toThrow(
      "registry unavailable",
    );

    expect(runtime.pullImage).toHaveBeenCalledWith(CONFIG.image, { force: true });
    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("pulls third-party images in the openship Docker Hub namespace", async () => {
    const docker = {
      getContainer: vi.fn(),
      createContainer: vi.fn(),
    };
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    (runtime as unknown as { _docker: unknown })._docker = docker;
    const pullImage = vi
      .spyOn(runtime, "pullImage")
      .mockRejectedValue(new Error("stop after proving pull"));

    await expect(
      runtime.deployServiceWorkload(GROUP, { ...CONFIG, image: "openship/agent:staging" }),
    ).rejects.toThrow("stop after proving pull");

    expect(pullImage).toHaveBeenCalledWith("openship/agent:staging", { force: true });
    expect(docker.getContainer).not.toHaveBeenCalled();
  });

  it("does not trust a registry tag merely because it resembles an internal build tag", async () => {
    const docker = {
      getContainer: vi.fn(),
      createContainer: vi.fn(),
    };
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    (runtime as unknown as { _docker: unknown })._docker = docker;
    const pullImage = vi
      .spyOn(runtime, "pullImage")
      .mockRejectedValue(new Error("stop after proving pull"));

    await expect(
      runtime.deployServiceWorkload(GROUP, {
        ...CONFIG,
        image: "openship/user-image:bld_release",
      }),
    ).rejects.toThrow("stop after proving pull");

    expect(pullImage).toHaveBeenCalledWith("openship/user-image:bld_release", { force: true });
    expect(docker.getContainer).not.toHaveBeenCalled();
  });

  it("skips a second pull only when the orchestrator explicitly prepared the image", async () => {
    const remove = vi.fn(async () => undefined);
    const docker = {
      getContainer: vi.fn(() => ({ remove })),
      createContainer: vi.fn().mockRejectedValue(new Error("stop after proving no pull")),
    };
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    (runtime as unknown as { _docker: unknown })._docker = docker;
    const pullImage = vi.spyOn(runtime, "pullImage");

    await expect(
      runtime.deployServiceWorkload(GROUP, { ...CONFIG, imageAlreadyPrepared: true }),
    ).rejects.toThrow("stop after proving no pull");

    expect(pullImage).not.toHaveBeenCalled();
    expect(docker.getContainer).toHaveBeenCalled();
  });
});
