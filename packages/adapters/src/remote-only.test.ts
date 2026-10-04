import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "./types";

const h = vi.hoisted(() => ({
  system: vi.fn(),
  bare: vi.fn(),
  docker: vi.fn(),
  localEdge: vi.fn(),
  remoteEdge: vi.fn(),
  detectEdge: vi.fn(),
  cloudOptions: vi.fn(),
  cloudDocker: vi.fn(),
  runtime: { name: "remote-runtime", deploy: vi.fn() },
  infra: { registerRoute: vi.fn(), renewCert: vi.fn() },
}));

vi.mock("./system/setup", () => ({
  SystemManager: class {
    constructor(...args: unknown[]) {
      h.system(...args);
    }
  },
}));
vi.mock("./runtime/bare", () => ({
  BareRuntime: class {
    constructor(options: unknown) {
      h.bare(options);
      return h.runtime;
    }
  },
}));
vi.mock("./runtime/docker", () => ({ DockerRuntime: { create: h.docker } }));
vi.mock("./system/proxy/ensure-container-edge", () => ({
  localContainerEdgeProvider: h.localEdge,
  containerEdgeProvider: h.remoteEdge,
}));
vi.mock("./system/proxy/detect", () => ({ resolveOurEdgeContainer: h.detectEdge }));
vi.mock("./oblien", () => ({ Oblien: class {} }));
vi.mock("./runtime/cloud", () => ({
  CloudRuntime: class {
    constructor(_client: unknown, options: unknown) {
      h.cloudOptions(options);
    }
  },
}));
vi.mock("./runtime/cloud/docker", () => ({ CloudDockerRuntime: { forWorkspace: h.cloudDocker } }));
vi.mock("./infra/cloud", () => ({ CloudInfraProvider: class {} }));

import { createPlatform } from "./platform";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENSHIP_REMOTE_ONLY", "true");
  // A stale local-edge setting must never make the remote server use this edge.
  vi.stubEnv("OPENSHIP_EDGE_MODE", "docker");
  h.detectEdge.mockResolvedValue("remote-edge");
  h.remoteEdge.mockResolvedValue(h.infra);
  h.docker.mockResolvedValue(h.runtime);
  h.cloudDocker.mockResolvedValue(h.runtime);
  h.runtime.deploy.mockResolvedValue({ containerId: "remote-container" });
});
afterEach(() => vi.unstubAllEnvs());

describe("remote-only platform", () => {
  it.each(["bare", "docker"] as const)(
    "boots without constructing or probing a local %s runtime",
    async (runtime) => {
      const p = await createPlatform({ target: "selfhosted", runtime });
      expect(p).toMatchObject({
        target: "selfhosted",
        localHost: false,
        executor: null,
        system: null,
      });
      expect(p.runtime.supports("containerInfo")).toBe(false);
      await expect(p.runtime.deploy({} as never)).rejects.toThrow(/remote servers only/);
      await expect(p.runtime.build({} as never)).rejects.toThrow(/remote servers only/);
      await expect(p.runtime.getContainerInfo("old-local-container")).rejects.toThrow(
        /remote servers only/,
      );
      await expect(p.routing.registerRoute({} as never)).rejects.toThrow(/remote servers only/);
      await expect(p.ssl.renewCert("local.example.test")).rejects.toThrow(/remote servers only/);
      expect(h.system).not.toHaveBeenCalled();
      expect(h.bare).not.toHaveBeenCalled();
      expect(h.docker).not.toHaveBeenCalled();
      expect(h.localEdge).not.toHaveBeenCalled();
      expect(h.detectEdge).not.toHaveBeenCalled();
    },
  );

  it("cannot opt into local execution with a misleading localHost hint or injected executor", async () => {
    const executor = { exec: vi.fn() } as unknown as CommandExecutor;
    for (const config of [
      { localHost: false },
      { localHost: false, executor },
      { localHost: true, executor },
    ]) {
      const p = await createPlatform({ target: "selfhosted", ...config });
      await expect(p.runtime.start("old-local-container")).rejects.toThrow(/remote servers only/);
    }
    expect(executor.exec).not.toHaveBeenCalled();
    expect(h.system).not.toHaveBeenCalled();
    expect(h.docker).not.toHaveBeenCalled();
  });

  it("rejects the desktop local-process adapter", async () => {
    await expect(createPlatform({ target: "desktop" })).rejects.toThrow(/remote servers only/);
    expect(h.bare).not.toHaveBeenCalled();
  });

  it.each(["bare", "docker"] as const)(
    "retains the existing remote %s runtime, routing, and certificate provider",
    async (runtime) => {
      const executor = { exec: vi.fn() } as unknown as CommandExecutor;
      const docker = {
        transport: "ssh" as const,
        host: "remote.example.test",
        privateKey: "test-key",
        executor,
      };
      const p = await createPlatform({
        target: "selfhosted",
        runtime,
        executor,
        docker,
        ssh: { host: docker.host, privateKey: docker.privateKey },
      });
      expect(p.executor).toBe(executor);
      expect(p.localHost).toBe(false);
      expect(p.routing).toBe(h.infra);
      expect(p.ssl).toBe(h.infra);
      expect(await p.runtime.deploy({} as never)).toEqual({ containerId: "remote-container" });
      await p.routing.registerRoute({ domain: "app.example.test" } as never);
      await p.ssl.renewCert("app.example.test");
      expect(h.infra.registerRoute).toHaveBeenCalled();
      expect(h.infra.renewCert).toHaveBeenCalledWith("app.example.test");
      expect(h.detectEdge).toHaveBeenCalledWith(executor);
      expect(h.remoteEdge).toHaveBeenCalledWith(executor, "remote-edge", undefined);
      expect(h.localEdge).not.toHaveBeenCalled();
      if (runtime === "docker")
        expect(h.docker).toHaveBeenCalledWith(docker, expect.anything(), undefined);
      else expect(h.bare).toHaveBeenCalledWith(expect.objectContaining({ executor }));
    },
  );

  it("denies local Cloud builds and local Docker sources even with an explicit opt-in", async () => {
    const config = {
      target: "cloud" as const,
      allowHostBuild: true,
      cloudToken: "token",
      cloudNamespace: "customer",
    };
    await createPlatform(config);
    expect(h.cloudOptions).toHaveBeenCalledWith(expect.objectContaining({ allowHostBuild: false }));
    await createPlatform({
      ...config,
      cloudDocker: {
        workspaceId: "ws",
        projectId: "project",
        provisionLock: { run: (fn) => fn() },
        resolveRegistryAuth: async () => undefined,
      },
    });
    expect(h.cloudDocker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowHostSource: false }),
    );
  });
});
