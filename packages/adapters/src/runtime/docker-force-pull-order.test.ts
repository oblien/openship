import { describe, expect, it, vi } from "vitest";

import { DockerRuntime } from "./docker";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "./types";

const GROUP: MultiServiceGroupHandle = { id: "net-openship-demo" };

/** A real daemon pins names to a full ID and returns 404 after removal. */
function removableContainer(stop: (...args: unknown[]) => unknown, remove: (...args: unknown[]) => unknown) {
  let gone = false;
  return {
    inspect: async () => {
      if (gone) throw Object.assign(new Error("No such container"), { statusCode: 404 });
      return { Id: "a".repeat(64), State: { Status: "exited" } };
    },
    stop,
    remove: async (...args: unknown[]) => { await remove(...args); gone = true; },
  };
}

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

describe("Docker service replacement ordering", () => {
  it("pulls a missing image before inspecting startup labels for a service command", async () => {
    let acquired = false;
    const inspectImage = vi.fn(async () => {
      if (!acquired) throw Object.assign(new Error("No such image"), { statusCode: 404 });
      return { Config: { Labels: {} } };
    });
    const stop = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const existing = removableContainer(stop, remove);
    const docker = {
      getImage: vi.fn(() => ({ inspect: inspectImage })),
      getContainer: vi.fn(() => existing),
      createContainer: vi.fn().mockRejectedValue(new Error("replacement payload reached")),
    };
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/openship-test-absent.sock" });
    (runtime as unknown as { _docker: unknown })._docker = docker;
    const pull = vi.spyOn(runtime, "pullImage").mockImplementation(async () => { acquired = true; });
    await expect(runtime.deployServiceWorkload(GROUP, { ...CONFIG, command: "node server.js" }))
      .rejects.toThrow("replacement payload reached");
    expect(pull.mock.invocationCallOrder[0]).toBeLessThan(inspectImage.mock.invocationCallOrder[0]!);
    expect(inspectImage.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]!);
    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      Cmd: ["sh", "-c", "node server.js"],
    }));
  });
  it("does not stop the live container when an immutable prepared image disappeared", async () => {
    const stop = vi.fn();
    const remove = vi.fn();
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(Object.assign(new Error("No such image"), { statusCode: 404 })) })),
      getContainer: vi.fn(() => ({ stop, remove })), createContainer: vi.fn(),
    };
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/openship-test-absent.sock" });
    (runtime as unknown as { _docker: unknown })._docker = docker;
    await expect(runtime.deployServiceWorkload(GROUP, {
      ...CONFIG, image: `sha256:${"a".repeat(64)}`, imageAlreadyPrepared: true,
    })).rejects.toThrow("No such image");
    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
  it("reuses an existing local image after checking it before container removal", async () => {
    const inspectImage = vi.fn(async () => ({}));
    const stop = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const existing = removableContainer(stop, remove);
    const docker = {
      getImage: vi.fn(() => ({ inspect: inspectImage })),
      getContainer: vi.fn(() => existing),
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

    expect(inspectImage).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledExactlyOnceWith({ abortSignal: expect.any(AbortSignal) });
    expect(remove).toHaveBeenCalledOnce();
    expect(inspectImage.mock.invocationCallOrder.at(-1)).toBeLessThan(
      stop.mock.invocationCallOrder[0]!,
    );
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
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

    await expect(runtime.deployServiceWorkload(GROUP, { ...CONFIG, command: "node server.js" })).rejects.toThrow(
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
    const existing = removableContainer(vi.fn(async () => undefined), remove);
    const docker = {
      getImage: () => ({ inspect: async () => ({ Config: {} }) }),
      getContainer: vi.fn(() => existing),
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

  it.each(["replace", "destroy"] as const)(
    "%s does not force-remove a container when graceful stop fails",
    async (operation) => {
      const error = Object.assign(new Error("daemon refused stop"), { statusCode: 500 });
      const stop = vi.fn().mockRejectedValue(error);
      const remove = vi.fn(async () => undefined);
      const docker = {
        getImage: () => ({ inspect: async () => ({ Config: {} }) }),
        getContainer: vi.fn(() => ({
          stop,
          remove,
          inspect: async () => ({ Id: "a".repeat(64), Config: { StopTimeout: 30 } }),
        })),
        createContainer: vi.fn(),
      };
      const runtime = await DockerRuntime.create({
        dockerSocketPath: "/tmp/openship-test-absent.sock",
      });
      (runtime as unknown as { _docker: unknown })._docker = docker;
      const result =
        operation === "replace"
          ? runtime.deployServiceWorkload(GROUP, { ...CONFIG, imageAlreadyPrepared: true })
          : runtime.destroy("old-container");

      await expect(result).rejects.toBe(error);
      expect(remove).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
    },
  );

  it("does not try to create a duplicate after removal fails", async () => {
    const error = Object.assign(new Error("daemon refused removal"), { statusCode: 403 });
    const docker = {
      getImage: () => ({ inspect: async () => ({ Config: {} }) }),
      getContainer: vi.fn(() => ({
        inspect: async () => ({ Id: "a".repeat(64), State: { Status: "exited" } }),
        stop: vi.fn(async () => undefined),
        remove: vi.fn().mockRejectedValue(error),
      })),
      createContainer: vi.fn(),
    };
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    (runtime as unknown as { _docker: unknown })._docker = docker;
    await expect(
      runtime.deployServiceWorkload(GROUP, { ...CONFIG, imageAlreadyPrepared: true }),
    ).rejects.toBe(error);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
});
