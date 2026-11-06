import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { applyDockerEnvironment } from "./docker-environment";
const reported = vi.hoisted(() => vi.fn());
vi.mock("@repo/core/diagnostics", async (original) => ({
  ...(await original<typeof import("@repo/core/diagnostics")>()), reportCaughtError: reported,
}));

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const BUILD_TAG = "openship/openship-api:bld_previous-svc_api";

function setup() {
  const order: string[] = [];
  const original = {
    inspect: vi.fn(async () => before),
    stop: vi.fn(async () => {
      order.push("stop original");
    }),
    start: vi.fn(async () => {
      order.push("restore original");
    }),
    rename: vi.fn(async () => {
      order.push("rename original");
    }),
    remove: vi.fn(async () => {
      order.push("remove original");
    }),
  };
  const before = {
    Id: "old-container",
    Name: "/openship-demo-api",
    Image: IMAGE_ID,
    Config: {
      Image: BUILD_TAG,
      Hostname: "api",
      Env: ["FLAG=old", "REMOVE=old", "PORT=3000"],
      Cmd: ["node", "server.js"],
      Entrypoint: ["entrypoint.sh"],
      WorkingDir: "/app",
      User: "node",
      Labels: { "openship.project": "project-1", "openship.service": "api" },
      Volumes: { "/data": {} },
      StopSignal: "SIGINT",
      StopTimeout: 30,
      Healthcheck: { Test: ["CMD", "check-health"], Interval: 1_000_000_000 },
    },
    State: { Running: true, Restarting: false, Paused: false },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: "network-1",
      Memory: 512 * 1024 ** 2,
      NanoCpus: 1e9,
      RestartPolicy: { Name: "unless-stopped" },
      Binds: ["/srv/config:/config:ro"],
      PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "31000" }] },
    },
    Mounts: [{ Type: "volume", Name: "existing-anonymous-volume", Destination: "/data", RW: true }],
    NetworkSettings: {
      Networks: {
        "openship-demo": {
          NetworkID: "network-1",
          IPAddress: "172.22.0.8",
          GlobalIPv6Address: "",
          IPAMConfig: null as {
            IPv4Address?: string;
            IPv6Address?: string;
            LinkLocalIPs?: string[];
          } | null,
          Aliases: ["api", "custom-alias", "old-container"],
        },
      },
    },
  };
  const replacement = {
    id: "new-container",
    rename: vi.fn(async () => {
      order.push("rename replacement");
    }),
    start: vi.fn(async () => {
      order.push("start replacement");
    }),
    stop: vi.fn(async () => {
      order.push("stop replacement");
    }),
    remove: vi.fn(async () => {
      order.push("remove replacement");
    }),
    inspect: vi.fn(async () => ({ ...before, Id: "new-container" })),
  };
  const network = {
    disconnect: vi.fn(async () => {
      order.push("disconnect original");
    }),
    connect: vi.fn(async () => {
      order.push("reconnect original");
    }),
  };
  const imageInspect = vi.fn(async () => {
    order.push("verify image");
    return { Id: IMAGE_ID };
  });
  const docker = {
    getContainer: vi.fn(() => original),
    getNetwork: vi.fn(() => network),
    getImage: vi.fn((ref: string) => ({
      inspect:
        ref === IMAGE_ID ? imageInspect : vi.fn().mockRejectedValue(new Error("missing old tag")),
    })),
    pull: vi.fn().mockRejectedValue(new Error("pull access denied")),
    buildImage: vi.fn(),
    createContainer: vi.fn(async (_config: Dockerode.ContainerCreateOptions) => {
      order.push("create replacement");
      return replacement;
    }),
  };
  const options = {
    projectId: "project-1",
    serviceName: "api",
    onReplaced: vi.fn(async () => {
      order.push("commit identity");
    }),
    onRestored: vi.fn(async (_result: { containerId: string; ip?: string }) => {
      order.push("restore identity");
    }),
  };
  const apply = (environment = { FLAG: "new", PORT: "3000" }) =>
    applyDockerEnvironment(docker as unknown as Dockerode, before.Id, environment, options);
  return { before, original, replacement, network, imageInspect, docker, options, order, apply };
}

describe("runtime-only environment apply", () => {
  it.each([{ argv: ["sh", "-c", "printf '%s' 'space and $literal'"] }, { argv: [] }])(
    "uses resolved Cmd while preserving the image and entrypoint: %j", async ({ argv }) => {
      const h = setup();
      await applyDockerEnvironment(h.docker as unknown as Dockerode, h.before.Id,
        { FLAG: "new" }, { ...h.options, commandArgv: argv });
      expect(h.docker.createContainer.mock.calls[0]?.[0]).toMatchObject({
        Cmd: argv, Entrypoint: ["entrypoint.sh"], Image: IMAGE_ID,
      });
    },
  );
  it("applies on an automatic-subnet network without requesting the daemon-assigned IP", async () => {
    const h = setup();
    const create = h.docker.createContainer.getMockImplementation()!;
    h.docker.createContainer.mockImplementation(async (config) => {
      for (const endpoint of Object.values(config.NetworkingConfig?.EndpointsConfig ?? {})) {
        if (endpoint.IPAMConfig?.IPv4Address || endpoint.IPAMConfig?.IPv6Address) {
          throw Object.assign(
            new Error(
              "user specified IP address is supported only when connecting to networks with user configured subnets",
            ),
            { statusCode: 400 },
          );
        }
      }
      return create(config);
    });
    await expect(h.apply()).resolves.toMatchObject({ containerId: "new-container" });
    expect(h.network.disconnect).not.toHaveBeenCalled();
  });

  it("uses the running image ID even when its old build tag cannot be pulled", async () => {
    const h = setup();
    await expect(h.apply()).resolves.toEqual({ containerId: "new-container", ip: "172.22.0.8" });
    expect(h.docker.getImage).toHaveBeenCalledExactlyOnceWith(IMAGE_ID);
    expect(h.docker.pull).not.toHaveBeenCalled();
    expect(h.docker.buildImage).not.toHaveBeenCalled();
    const create = h.docker.createContainer.mock
      .calls[0]![0] as unknown as Dockerode.ContainerCreateOptions;
    expect(create).toMatchObject({
      name: expect.stringMatching(/^openship-demo-api-env-next-/),
      Image: IMAGE_ID,
      Env: ["FLAG=new", "PORT=3000"],
      Hostname: "api",
      Cmd: ["node", "server.js"],
      Entrypoint: ["entrypoint.sh"],
      User: "node",
      WorkingDir: "/app",
      StopSignal: "SIGINT",
      StopTimeout: 30,
      HostConfig: {
        Memory: 512 * 1024 ** 2,
        NanoCpus: 1e9,
        RestartPolicy: { Name: "unless-stopped" },
        Binds: ["/srv/config:/config:ro", "existing-anonymous-volume:/data:rw"],
        PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "31000" }] },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          "openship-demo": {
            Aliases: ["api", "custom-alias"],
          },
        },
      },
    });
    expect(create.NetworkingConfig?.EndpointsConfig?.["openship-demo"]?.IPAMConfig).toBeUndefined();
    expect(h.original.stop).toHaveBeenCalledWith();
    expect(h.replacement.rename).toHaveBeenCalledExactlyOnceWith({ name: "openship-demo-api" });
    expect(h.original.remove).toHaveBeenCalledWith();
    expect(h.order).toEqual([
      "verify image",
      "create replacement",
      "stop original",
      "rename original",
      "rename replacement",
      "start replacement",
      "commit identity",
      "remove original",
    ]);
    expect(h.before.Config.Env).toEqual(["FLAG=old", "REMOVE=old", "PORT=3000"]);
  });

  it("preserves explicitly configured static addresses and releases them before starting", async () => {
    const h = setup();
    const ipam = {
      IPv4Address: "172.22.0.8",
      IPv6Address: "fd00::8",
      LinkLocalIPs: ["169.254.1.8"],
    };
    h.before.NetworkSettings.Networks["openship-demo"].IPAMConfig = ipam;
    await h.apply();
    expect(
      h.docker.createContainer.mock.calls[0]![0].NetworkingConfig?.EndpointsConfig?.[
        "openship-demo"
      ]?.IPAMConfig,
    ).toEqual(ipam);
    expect(h.order.indexOf("disconnect original")).toBeLessThan(
      h.order.indexOf("start replacement"),
    );
  });

  it("does not turn a dynamically assigned IPv6 address into a static assignment", async () => {
    const h = setup();
    h.before.NetworkSettings.Networks["openship-demo"].GlobalIPv6Address = "fd00::8";
    await h.apply();
    expect(
      h.docker.createContainer.mock.calls[0]![0].NetworkingConfig?.EndpointsConfig?.[
        "openship-demo"
      ]?.IPAMConfig,
    ).toBeUndefined();
  });

  it.each([404, 401, 503])(
    "never stops the service or tries a registry after image inspection fails (%s)",
    async (statusCode) => {
      const h = setup();
      h.imageInspect.mockRejectedValue(
        Object.assign(new Error("image inspection failed"), { statusCode }),
      );
      await expect(h.apply()).rejects.toThrow(
        statusCode === 404 ? "Use Redeploy" : `The service image could not be inspected (HTTP ${statusCode})`,
      );
      expect(h.original.stop).not.toHaveBeenCalled();
      expect(h.original.remove).not.toHaveBeenCalled();
      expect(h.docker.createContainer).not.toHaveBeenCalled();
      expect(h.docker.pull).not.toHaveBeenCalled();
      expect(h.options.onReplaced).not.toHaveBeenCalled();
    },
  );

  it("keeps the original running when Docker rejects the replacement's network settings", async () => {
    const h = setup();
    h.docker.createContainer.mockRejectedValue(
      Object.assign(
        new Error(
          "user specified IP address is supported only when connecting to networks with user configured subnets",
        ),
        { statusCode: 400 },
      ),
    );
    await expect(h.apply()).rejects.toMatchObject({ code: "SERVICE_ENVIRONMENT_APPLY_FAILED" });
    expect(h.original.stop).not.toHaveBeenCalled();
    expect(h.original.rename).not.toHaveBeenCalled();
    expect(h.network.disconnect).not.toHaveBeenCalled();
    expect(h.network.connect).not.toHaveBeenCalled();
    expect(h.original.remove).not.toHaveBeenCalled();
    expect(h.options.onReplaced).not.toHaveBeenCalled();
  });

  it.each(["rename", "start", "persist"])(
    "restores the original container and routes if %s fails",
    async (stage) => {
      const h = setup();
      h.before.NetworkSettings.Networks["openship-demo"].IPAMConfig = { IPv4Address: "172.22.0.8" };
      if (stage === "rename") h.replacement.rename.mockRejectedValue(new Error("rename failed"));
      if (stage === "start") h.replacement.start.mockRejectedValue(new Error("start failed"));
      if (stage === "persist") h.options.onReplaced.mockRejectedValue(new Error("persist failed"));
      await expect(h.apply()).rejects.toMatchObject({ code: "SERVICE_ENVIRONMENT_APPLY_FAILED" });
      expect(h.original.remove).not.toHaveBeenCalled();
      expect(h.original.rename).toHaveBeenLastCalledWith({ name: "openship-demo-api" });
      expect(h.network.connect).toHaveBeenCalledWith({
        Container: "old-container",
        EndpointConfig: expect.objectContaining({ IPAMConfig: { IPv4Address: "172.22.0.8" } }),
      });
      expect(h.original.start).toHaveBeenCalledOnce();
      expect(h.replacement.remove).toHaveBeenCalledOnce();
      if (stage !== "persist") expect(h.options.onReplaced).not.toHaveBeenCalled();
    },
  );

  it("reports the restored container's actual dynamic IP after a failed commit", async () => {
    const h = setup();
    h.options.onReplaced.mockRejectedValue(new Error("persist failed"));
    h.original.inspect.mockResolvedValueOnce(h.before).mockResolvedValue({
      ...h.before,
      NetworkSettings: {
        Networks: {
          "openship-demo": {
            ...h.before.NetworkSettings.Networks["openship-demo"],
            IPAddress: "172.22.0.12",
          },
        },
      },
    });
    await expect(h.apply()).rejects.toMatchObject({ code: "SERVICE_ENVIRONMENT_APPLY_FAILED" });
    expect(h.network.disconnect).not.toHaveBeenCalled();
    expect(h.network.connect).not.toHaveBeenCalled();
    expect(h.options.onRestored).toHaveBeenCalledExactlyOnceWith({
      containerId: "old-container",
      ip: "172.22.0.12",
    });
    expect(h.order.indexOf("restore identity")).toBeGreaterThan(
      h.order.indexOf("restore original"),
    );
  });

  it("reports incomplete recovery if restoring the service's routes fails", async () => {
    const h = setup();
    h.options.onReplaced.mockRejectedValue(new Error("persist failed"));
    h.options.onRestored.mockRejectedValue(new Error("routing unavailable"));
    await expect(h.apply()).rejects.toMatchObject({ code: "SERVICE_ENVIRONMENT_RECOVERY_FAILED" });
    expect(h.original.start).toHaveBeenCalledOnce();
    expect(h.original.remove).not.toHaveBeenCalled();
  });

  it("keeps an already stopped container stopped when apply fails", async () => {
    const h = setup();
    h.before.State.Running = false;
    h.docker.createContainer.mockRejectedValue(new Error("cannot create"));
    await expect(h.apply()).rejects.toThrow("configuration was preserved");
    expect(h.original.stop).not.toHaveBeenCalled();
    expect(h.original.start).not.toHaveBeenCalled();
  });

  it("restores the old container when the replacement looks running between startup crashes", async () => {
    const h = setup();
    h.replacement.inspect.mockResolvedValue({
      ...h.before,
      Id: "new-container",
      RestartCount: 3,
    } as typeof h.before);
    await expect(h.apply()).rejects.toMatchObject({ code: "SERVICE_ENVIRONMENT_APPLY_FAILED" });
    expect(h.options.onReplaced).not.toHaveBeenCalled();
    expect(h.original.remove).not.toHaveBeenCalled();
    expect(h.original.start).toHaveBeenCalledOnce();
    expect(h.replacement.remove).toHaveBeenCalledOnce();
  });

  it("says why the replacement did not start (#1613)", async () => {
    const h = setup();
    h.replacement.inspect.mockResolvedValue({
      ...h.before,
      Id: "new-container",
      State: { ...h.before.State, Running: false, ExitCode: 1, OOMKilled: false, Error: "" },
      RestartCount: 2,
    } as typeof h.before);
    const error = await h.apply().catch((value) => value);
    expect(error.message).toContain("restarted 2 times");
    expect(error.message).toContain("exit code 1");
  });

  it.each([
    [{ OOMKilled: true, ExitCode: 137 }, "OOM-killed"],
    [
      { Error: 'exec: "redis-server": not found', ExitCode: 127 },
      "code 127",
    ],
    [{ Running: true, Health: { Status: "unhealthy" } }, "its healthcheck reports unhealthy"],
  ])("names the startup failure from container state: %j", async (state, reason) => {
    const h = setup();
    h.replacement.inspect.mockResolvedValue({
      ...h.before,
      Id: "new-container",
      State: { ...h.before.State, Running: false, ...state },
    } as typeof h.before);
    await expect(h.apply()).rejects.toThrow(reason);
  });

  it("does not roll back a successful apply when only old-container cleanup fails", async () => {
    const h = setup();
    h.original.remove.mockRejectedValue(new Error("cleanup failed"));
    await expect(h.apply()).resolves.toMatchObject({
      containerId: "new-container",
      warning: expect.stringContaining("Environment applied"),
    });
    expect(h.options.onReplaced).toHaveBeenCalledOnce();
    expect(h.replacement.stop).not.toHaveBeenCalled();
    expect(h.original.start).not.toHaveBeenCalled();
  });

  it("rejects a mismatched project before touching its container", async () => {
    const h = setup();
    h.options.projectId = "another-project";
    await expect(h.apply()).rejects.toThrow("does not belong");
    expect(h.docker.getImage).not.toHaveBeenCalled();
    expect(h.original.stop).not.toHaveBeenCalled();
  });

  it("rejects invalid env without printing its value or stopping the service", async () => {
    const h = setup();
    const error = await h.apply({ FLAG: "private\0value", PORT: "3000" }).catch((error) => error);
    expect(error.code).toBe("INVALID_ENVIRONMENT");
    expect(error.message).not.toContain("private");
    expect(h.original.stop).not.toHaveBeenCalled();
    expect(h.docker.createContainer).not.toHaveBeenCalled();
  });

  it("does not start two containers over the same volumes if replacement cleanup is uncertain", async () => {
    const h = setup();
    h.options.onReplaced.mockRejectedValue(new Error("database unavailable"));
    h.replacement.stop.mockRejectedValue(new Error("connection lost"));
    await expect(h.apply()).rejects.toMatchObject({ code: "SERVICE_ENVIRONMENT_RECOVERY_FAILED" });
    expect(h.original.start).not.toHaveBeenCalled();
    expect(h.original.remove).not.toHaveBeenCalled();
  });
  it.each(["create", "start", "inspect", "cleanup", "recovery"])(
    "redacts current and previous environment values in %s errors and diagnostics", async (phase) => {
      const h = setup();
      const previous = "prior-private-value";
      const current = "current-private-value";
      h.before.Config.Env.push(`INNOCENT=${previous}`);
      const error = new Error(`exec: "${previous}" "${current}": failed`);
      Object.assign(error, { response: { body: current }, cause: new Error(previous) });
      reported.mockClear();
      if (phase === "create") h.docker.createContainer.mockRejectedValue(error);
      if (phase === "start") h.replacement.start.mockRejectedValue(error);
      if (phase === "inspect") h.replacement.inspect.mockRejectedValue(error);
      if (phase === "cleanup") h.original.remove.mockRejectedValue(error);
      if (phase === "recovery") {
        h.replacement.start.mockRejectedValue(new Error("start failed"));
        h.original.rename.mockRejectedValueOnce(error);
      }
      const result = await h.apply({ FLAG: current, PORT: "3000" }).catch((value) => value);
      if (phase === "cleanup") expect(result.warning).toContain("Environment applied");
      else expect(result).toBeInstanceOf(Error);
      const exposed = [result.message, ...reported.mock.calls.map(([value]) => value.message)].join(" ");
      expect(exposed).not.toContain(previous);
      expect(exposed).not.toContain(current);
      expect(reported).toHaveBeenCalled();
      for (const [value] of reported.mock.calls) {
        expect(value).not.toHaveProperty("cause");
        expect(value).not.toHaveProperty("response");
      }
    },
  );
  it("does not expose an environment value echoed by Docker State.Error", async () => {
    const h = setup();
    const secret = "review-secret-value";
    h.replacement.inspect.mockResolvedValue({
      ...h.before, Id: "new-container",
      State: { ...h.before.State, Running: false, Error: `exec: \"${secret}\": executable file not found in $PATH`, ExitCode: 127 },
    } as typeof h.before);
    const error = await h.apply({ FLAG: secret, PORT: "3000" }).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(secret);
  });

  it("redacts command-only values from current and replacement arguments", async () => {
    const h = setup();
    h.before.Config.Cmd = ["old-command-private"];
    const next = "next-command-private";
    h.replacement.start.mockRejectedValue(new Error(`exec: ${next}: failed after old-command-private`));
    reported.mockClear();
    const error = await applyDockerEnvironment(h.docker as unknown as Dockerode, h.before.Id,
      { FLAG: "new" }, { ...h.options, commandArgv: [next] }).catch((value) => value);
    const exposed = [error.message, ...reported.mock.calls.map(([value]) => value.message)].join(" ");
    expect(exposed).not.toContain(next);
    expect(exposed).not.toContain("old-command-private");
    expect(h.docker.createContainer.mock.calls[0]?.[0].Cmd).toEqual([next]);
  });

  it("keeps structured exit codes and restart counts visible with boolean environment values", async () => {
    const h = setup();
    h.replacement.inspect.mockResolvedValue({ ...h.before, Id: "new-container",
      State: { ...h.before.State, Running: false, ExitCode: 1, Error: "" }, RestartCount: 1,
    } as typeof h.before);
    reported.mockClear();
    await expect(h.apply({ FLAG: "1", PORT: "3000" })).rejects.toThrow("exit code 1");
    expect(reported.mock.calls.at(-1)?.[0].message).toContain("exit code 1");
    expect(reported.mock.calls.at(-1)?.[0].message).toContain("restarted 1 time");
  });

  it("uses approved operation details instead of unknown provider text", async () => {
    const h = setup();
    const secret = "credential-not-in-the-service-environment";
    const message = vi.fn(() => secret);
    const error = Object.defineProperty({ code: "ECONNREFUSED", statusCode: 503 }, "message", { get: message });
    h.replacement.start.mockRejectedValue(error);
    reported.mockClear();
    const result = await h.apply().catch((failure) => failure);
    expect(result.message).toContain("Starting the replacement container failed");
    expect(result.message).toContain("ECONNREFUSED");
    expect(result.message).toContain("HTTP 503");
    expect(message).not.toHaveBeenCalled();
    expect(JSON.stringify([result.message, reported.mock.calls])).not.toContain(secret);
    expect(h.original.start).toHaveBeenCalledOnce();
  });

  it("keeps unregistered credentials in Docker State.Error out of the startup verdict", async () => {
    const h = setup();
    const secret = "provider-private-value-not-in-env";
    h.replacement.inspect.mockResolvedValue({ ...h.before, Id: "new-container",
      State: { ...h.before.State, Running: false, ExitCode: 17, Error: secret },
    } as typeof h.before);
    reported.mockClear();
    const result = await h.apply().catch((failure) => failure);
    expect(result.message).toContain("code 17");
    expect(JSON.stringify([result.message, reported.mock.calls])).not.toContain(secret);
  });

});
