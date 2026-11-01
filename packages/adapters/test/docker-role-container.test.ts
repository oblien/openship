import { describe, expect, it, vi } from "vitest";
import type { Oblien } from "oblien";

import { DockerRuntime } from "../src/runtime/docker";
import { CloudDockerRuntime, type CloudDockerOptions } from "../src/runtime/cloud/docker";
import { BareRuntime } from "../src/runtime/bare";
import { droppedRuntimeEnvMessage } from "../src/runtime/runtime-env";
import { OPENSHIP_LABEL } from "../src/system/port-owner";
import type { DeployConfig, LogEntry } from "../src/types";

/**
 * A runtime ROLE (#935) is a worker or scheduler process started from the same
 * image as the web app. `deployRole` must give it the app's env, mounts, restart
 * policy, caps and project network, and must NEVER give it a port, a network
 * alias or the web container's `openship.service` label. Pinned at the create
 * payload, as docker-portless-worker.test.ts does: the only way to know what
 * Docker was told is to look at what was passed.
 */

const ROLE = { name: "worker", command: "bundle exec sidekiq" };

function baseConfig(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    deploymentId: "dep_1",
    projectId: "proj_1",
    buildSessionId: "sess_1",
    imageRef: "openship/app:sess_1",
    environment: "production",
    port: 8000,
    envVars: { APP_NAME: "demo" },
    resources: { cpuCores: 1, memoryMb: 512, diskMb: 0 },
    runtimeName: "my-app",
    slug: "my-app",
    ...overrides,
  } as DeployConfig;
}

/** A daemon that records every create payload and hands back a controllable container. */
async function fakeDaemon(opts: { startError?: Error; removeError?: Error } = {}) {
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-test-absent.sock",
  });
  const creates: Array<Record<string, any>> = [];
  const start = vi.fn(async () => {
    if (opts.startError) throw opts.startError;
  });
  const remove = vi.fn(async (_opts?: unknown) => {
    if (opts.removeError) throw opts.removeError;
  });
  const createContainer = vi.fn(async (args: Record<string, any>) => {
    creates.push(args);
    return { id: "c".repeat(64), start, remove };
  });
  (runtime as unknown as { _docker: unknown })._docker = {
    createContainer,
    getImage: () => ({ inspect: async () => ({ Config: {} }) }),
  };
  const logs: LogEntry[] = [];
  const onLog = (entry: LogEntry) => {
    logs.push(entry);
  };
  return { runtime, creates, createContainer, start, remove, logs, onLog };
}

describe("DockerRuntime.deployRole: container shape", () => {
  it("names the replica, runs the role command through sh -c and keeps the image entrypoint", async () => {
    const { runtime, creates } = await fakeDaemon();
    const result = await runtime.deployRole(baseConfig(), ROLE, 2);

    expect(result).toEqual({ containerId: "c".repeat(64) });
    expect(creates).toHaveLength(1);
    const created = creates[0]!;
    expect(created.name).toBe("openship-my-app-dep_1-worker-2");
    expect(created.Image).toBe("openship/app:sess_1");
    expect(created.Cmd).toEqual(["sh", "-c", "bundle exec sidekiq"]);
    expect("Entrypoint" in created).toBe(false);
  });

  it("falls back to the project id in the name when there is no runtime name", async () => {
    const { runtime, creates } = await fakeDaemon();
    await runtime.deployRole(baseConfig({ runtimeName: undefined }), ROLE, 1);
    expect(creates[0]!.name).toBe("openship-proj_1-dep_1-worker-1");
  });

  it("disables the web image's inherited healthcheck for portless roles", async () => {
    const { runtime, creates } = await fakeDaemon();
    await runtime.deployRole(baseConfig({ imageRef: "web-with-http-healthcheck:1" }), ROLE, 1);
    expect(creates[0]!.Healthcheck).toEqual({ Test: ["NONE"] });
  });

  it("injects no PORT even for a web config with a port, keeps user env, and warns on a dropped var", async () => {
    const { runtime, creates, logs, onLog } = await fakeDaemon();
    const config = baseConfig({ envVars: { APP_NAME: "demo", PATH: "/usr/bin" } });
    expect(config.portless).toBeUndefined();
    await runtime.deployRole(config, ROLE, 1, onLog);

    const env: string[] = creates[0]!.Env;
    expect(env.some((e) => e.startsWith("PORT="))).toBe(false);
    expect(env).toContain("APP_NAME=demo");
    expect(env).toContain("NODE_ENV=production");
    expect(env.some((e) => e.startsWith("PATH="))).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: droppedRuntimeEnvMessage(["PATH"]),
      }),
    );
  });

  it("drops a project-set PORT and unsets any PORT the image inherits", async () => {
    const { runtime, creates } = await fakeDaemon();
    await runtime.deployRole(baseConfig({ envVars: { PORT: "8080", APP_NAME: "demo" } }), ROLE, 1);

    const env: string[] = creates[0]!.Env;
    expect(env.filter((e) => e === "PORT" || e.startsWith("PORT="))).toEqual(["PORT"]);
    expect(env).toContain("APP_NAME=demo");
    expect(env).toContain("NODE_ENV=production");
  });

  it("labels project, deployment and role, never service or build", async () => {
    const { runtime, creates } = await fakeDaemon();
    await runtime.deployRole(baseConfig({ networkAlias: "web" }), ROLE, 1);

    const labels: Record<string, string> = creates[0]!.Labels;
    expect(labels[OPENSHIP_LABEL.project]).toBe("proj_1");
    expect(labels[OPENSHIP_LABEL.deployment]).toBe("dep_1");
    expect(labels[OPENSHIP_LABEL.role]).toBe("worker");
    expect(labels).not.toHaveProperty(OPENSHIP_LABEL.service);
    expect(labels).not.toHaveProperty(OPENSHIP_LABEL.build);
  });
});

describe("DockerRuntime.deployRole: network and ports", () => {
  it("joins the project network by id only, with no alias, hostname or port", async () => {
    const { runtime, creates } = await fakeDaemon();
    const ensureNetwork = vi.fn(async () => "net_123");
    runtime.ensureNetwork = ensureNetwork;
    await runtime.deployRole(baseConfig({ networkAlias: "web", extraAliases: ["api"] }), ROLE, 1);

    expect(ensureNetwork).toHaveBeenCalledWith("my-app");
    const created = creates[0]!;
    expect(created.HostConfig.NetworkMode).toBe("net_123");
    expect(created.NetworkingConfig).toBeUndefined();
    expect(created.Hostname).toBeUndefined();
    expect(created.ExposedPorts).toBeUndefined();
    expect(created.HostConfig.PortBindings).toBeUndefined();
  });

  it("does not join any network without a network alias", async () => {
    const { runtime, creates } = await fakeDaemon();
    const ensureNetwork = vi.fn(async () => "net_123");
    runtime.ensureNetwork = ensureNetwork;
    await runtime.deployRole(baseConfig(), ROLE, 1);

    expect(ensureNetwork).not.toHaveBeenCalled();
    expect(creates[0]!.HostConfig).not.toHaveProperty("NetworkMode");
    expect(creates[0]!.ExposedPorts).toBeUndefined();
    expect(creates[0]!.HostConfig.PortBindings).toBeUndefined();
  });

  it("warns and still creates the container when the network cannot be set up", async () => {
    const { runtime, creates, logs, onLog } = await fakeDaemon();
    runtime.ensureNetwork = vi.fn(async () => {
      throw new Error("network boom");
    });
    await runtime.deployRole(baseConfig({ networkAlias: "web" }), ROLE, 1, onLog);

    expect(creates).toHaveLength(1);
    expect(creates[0]!.HostConfig).not.toHaveProperty("NetworkMode");
    expect(logs.some((l) => l.level === "warn" && l.message.includes("network boom"))).toBe(true);
  });
});

describe("DockerRuntime.deployRole: stop config", () => {
  it("carries the role's stop signal and grace period on the container", async () => {
    const { runtime, creates } = await fakeDaemon();
    await runtime.deployRole(
      baseConfig(),
      { ...ROLE, stopSignal: "SIGQUIT", stopGracePeriod: "90s" },
      1,
    );
    expect(creates[0]!.StopSignal).toBe("SIGQUIT");
    expect(creates[0]!.StopTimeout).toBe(90);
  });

  it("leaves Docker's defaults when the role sets neither", async () => {
    const { runtime, creates } = await fakeDaemon();
    await runtime.deployRole(baseConfig(), ROLE, 1);
    expect(creates[0]!).not.toHaveProperty("StopSignal");
    expect(creates[0]!).not.toHaveProperty("StopTimeout");
  });
});

describe("DockerRuntime.deployRole: parity with the web container", () => {
  it("gets the same binds, restart policy and resource limits as deploy() for the same config", async () => {
    const { runtime, creates } = await fakeDaemon();
    const config = baseConfig({
      volumes: ["data:/app/data", "/srv/uploads:/app/uploads"],
      restartPolicy: "on-failure",
      resources: { cpuCores: 1.5, memoryMb: 768, diskMb: 0 },
    });
    await runtime.deploy(config);
    await runtime.deployRole(config, ROLE, 1);

    expect(creates).toHaveLength(2);
    const [web, role] = [creates[0]!.HostConfig, creates[1]!.HostConfig];
    expect(web.Binds).toHaveLength(2);
    expect(role.Binds).toEqual(web.Binds);
    expect(web.RestartPolicy).toEqual({ Name: "on-failure", MaximumRetryCount: 5 });
    expect(role.RestartPolicy).toEqual(web.RestartPolicy);
    expect(web.Memory).toBe(768 * 1024 * 1024);
    expect(role.Memory).toEqual(web.Memory);
    expect(web.NanoCpus).toBe(1_500_000_000);
    expect(role.NanoCpus).toEqual(web.NanoCpus);
    expect(role.LogConfig).toEqual(web.LogConfig);
  });

  it("leaves Binds undefined when there are no volumes, like deploy()", async () => {
    const { runtime, creates } = await fakeDaemon();
    await runtime.deployRole(baseConfig(), ROLE, 1);
    expect(creates[0]!.HostConfig.Binds).toBeUndefined();
  });
});

describe("DockerRuntime.deployRole: start failure and input validation", () => {
  it("starts the container exactly once", async () => {
    const { runtime, start, remove } = await fakeDaemon();
    await runtime.deployRole(baseConfig(), ROLE, 1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the created container and rethrows the start error", async () => {
    const startError = new Error("start boom");
    const { runtime, remove } = await fakeDaemon({ startError });
    await expect(runtime.deployRole(baseConfig(), ROLE, 1)).rejects.toBe(startError);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ force: true });
  });

  it("still rethrows the original start error when the cleanup remove also fails", async () => {
    const startError = new Error("start boom");
    const { runtime, remove } = await fakeDaemon({
      startError,
      removeError: new Error("remove boom"),
    });
    await expect(runtime.deployRole(baseConfig(), ROLE, 1)).rejects.toBe(startError);
    expect(remove).toHaveBeenCalledWith({ force: true });
  });

  it.each([
    ["a missing imageRef", baseConfig({ imageRef: undefined }), 1],
    ["replica 0", baseConfig(), 0],
    ["replica 1.5", baseConfig(), 1.5],
  ])("throws before creating anything for %s", async (_label, config, replica) => {
    const { runtime, createContainer } = await fakeDaemon();
    const ensureNetwork = vi.fn(async () => "net_123");
    runtime.ensureNetwork = ensureNetwork;
    await expect(
      runtime.deployRole({ ...config, networkAlias: "web" }, ROLE, replica),
    ).rejects.toThrow();
    expect(createContainer).not.toHaveBeenCalled();
    expect(ensureNetwork).not.toHaveBeenCalled();
  });
});

describe("DockerRuntime.deployRole: beforeStart hook", () => {
  it("runs once with the container id before the process starts", async () => {
    const { runtime, start, remove } = await fakeDaemon();
    const beforeStart = vi.fn(async (_id: string) => {});
    await runtime.deployRole(baseConfig(), ROLE, 1, undefined, { beforeStart });

    expect(beforeStart).toHaveBeenCalledTimes(1);
    expect(beforeStart).toHaveBeenCalledWith("c".repeat(64));
    expect(start).toHaveBeenCalledTimes(1);
    expect(beforeStart.mock.invocationCallOrder[0]!).toBeLessThan(
      start.mock.invocationCallOrder[0]!,
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the container, never starts it, and rethrows when the hook rejects", async () => {
    const hookError = new Error("attach boom");
    const { runtime, start, remove } = await fakeDaemon();
    await expect(
      runtime.deployRole(baseConfig(), ROLE, 1, undefined, {
        beforeStart: async () => {
          throw hookError;
        },
      }),
    ).rejects.toBe(hookError);
    expect(start).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ force: true });
  });

  it("still rethrows the hook error when the cleanup remove also fails", async () => {
    const hookError = new Error("attach boom");
    const { runtime, start, remove } = await fakeDaemon({ removeError: new Error("remove boom") });
    await expect(
      runtime.deployRole(baseConfig(), ROLE, 1, undefined, {
        beforeStart: async () => {
          throw hookError;
        },
      }),
    ).rejects.toBe(hookError);
    expect(start).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith({ force: true });
  });
});

describe("DockerRuntime.deployRole: storage log", () => {
  it("logs the persistent storage line when volumes are set", async () => {
    const { runtime, creates, logs, onLog } = await fakeDaemon();
    await runtime.deployRole(baseConfig({ volumes: ["data:/app/data"] }), ROLE, 1, onLog);
    const binds: string[] = creates[0]!.HostConfig.Binds;
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: `Persistent storage: ${binds.join(", ")}\n`,
      }),
    );
  });

  it("logs no persistent storage line without volumes", async () => {
    const { runtime, logs, onLog } = await fakeDaemon();
    await runtime.deployRole(baseConfig(), ROLE, 1, onLog);
    expect(logs.some((l) => l.message.startsWith("Persistent storage:"))).toBe(false);
  });
});

describe("roles capability", () => {
  it("is declared by DockerRuntime", async () => {
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    expect(runtime.supports("roles")).toBe(true);
  });

  it("is refused by CloudDockerRuntime, which keeps every other Docker capability", () => {
    // The real class, built through its private constructor so its own field
    // initializers run. The constructor only wires the connection (no I/O), so
    // an empty client is enough; `forWorkspace` would also dial the workspace.
    const Ctor = CloudDockerRuntime as unknown as new (
      client: Oblien,
      options: CloudDockerOptions,
    ) => CloudDockerRuntime;
    const cloud = new Ctor({} as Oblien, {
      workspaceId: "ws_1",
      projectId: "proj_1",
      ownerWorkspaceId: "owner_1",
      namespace: "ns_1",
      provisionLock: { run: (fn) => fn() },
      resolveRegistryAuth: async () => undefined,
    });
    expect(cloud.supports("roles")).toBe(false);
    expect([...cloud.capabilities].sort()).toEqual(
      DockerRuntime.CAPABILITIES.filter((cap) => cap !== "roles").sort(),
    );
  });

  it("is not declared by BareRuntime", () => {
    const bare = new BareRuntime({ executor: {} as never });
    expect(bare.supports("roles")).toBe(false);
  });
});
