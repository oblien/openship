import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { applyDockerEnvironment } from "./docker-environment";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const BUILD_TAG = "openship/openship-api:bld_previous-svc_api";

function setup() {
  const order: string[] = [];
  const original = {
    inspect: vi.fn(async () => before),
    stop: vi.fn(async () => { order.push("stop original"); }),
    start: vi.fn(async () => { order.push("restore original"); }),
    rename: vi.fn(async () => { order.push("rename original"); }),
    remove: vi.fn(async () => { order.push("remove original"); }),
  };
  const before = {
    Id: "old-container", Name: "/openship-demo-api", Image: IMAGE_ID,
    Config: {
      Image: BUILD_TAG, Hostname: "api", Env: ["FLAG=old", "REMOVE=old", "PORT=3000"],
      Cmd: ["node", "server.js"], Entrypoint: ["entrypoint.sh"], WorkingDir: "/app", User: "node",
      Labels: { "openship.project": "project-1", "openship.service": "api" },
      Volumes: { "/data": {} }, StopSignal: "SIGINT", StopTimeout: 30,
      Healthcheck: { Test: ["CMD", "check-health"], Interval: 1_000_000_000 },
    },
    State: { Running: true, Restarting: false, Paused: false },
    HostConfig: {
      AutoRemove: false, NetworkMode: "network-1", Memory: 512 * 1024 ** 2, NanoCpus: 1e9,
      RestartPolicy: { Name: "unless-stopped" }, Binds: ["/srv/config:/config:ro"],
      PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "31000" }] },
    },
    Mounts: [{ Type: "volume", Name: "existing-anonymous-volume", Destination: "/data", RW: true }],
    NetworkSettings: { Networks: { "openship-demo": {
      NetworkID: "network-1", IPAddress: "172.22.0.8", GlobalIPv6Address: "",
      IPAMConfig: null, Aliases: ["api", "custom-alias", "old-container"],
    } } },
  };
  const replacement = {
    id: "new-container",
    start: vi.fn(async () => { order.push("start replacement"); }),
    stop: vi.fn(async () => { order.push("stop replacement"); }),
    remove: vi.fn(async () => { order.push("remove replacement"); }),
    inspect: vi.fn(async () => ({ ...before, Id: "new-container" })),
  };
  const network = {
    disconnect: vi.fn(async () => { order.push("disconnect original"); }),
    connect: vi.fn(async () => { order.push("reconnect original"); }),
  };
  const imageInspect = vi.fn(async () => { order.push("verify image"); return { Id: IMAGE_ID }; });
  const docker = {
    getContainer: vi.fn(() => original), getNetwork: vi.fn(() => network),
    getImage: vi.fn((ref: string) => ({ inspect: ref === IMAGE_ID ? imageInspect : vi.fn().mockRejectedValue(new Error("missing old tag")) })),
    pull: vi.fn().mockRejectedValue(new Error("pull access denied")),
    buildImage: vi.fn(),
    createContainer: vi.fn(async (_config: Dockerode.ContainerCreateOptions) => { order.push("create replacement"); return replacement; }),
  };
  const options = {
    projectId: "project-1", serviceName: "api",
    onReplaced: vi.fn(async () => { order.push("commit identity"); }),
  };
  const apply = (environment = { FLAG: "new", PORT: "3000" }) =>
    applyDockerEnvironment(docker as unknown as Dockerode, before.Id, environment, options);
  return { before, original, replacement, network, imageInspect, docker, options, order, apply };
}

describe("runtime-only environment apply", () => {
  it("uses the running image ID even when its old build tag cannot be pulled", async () => {
    const h = setup();
    await expect(h.apply()).resolves.toEqual({ containerId: "new-container", ip: "172.22.0.8" });
    expect(h.docker.getImage).toHaveBeenCalledExactlyOnceWith(IMAGE_ID);
    expect(h.docker.pull).not.toHaveBeenCalled();
    expect(h.docker.buildImage).not.toHaveBeenCalled();
    const create = h.docker.createContainer.mock.calls[0]![0] as unknown as Dockerode.ContainerCreateOptions;
    expect(create).toMatchObject({
      name: "openship-demo-api", Image: IMAGE_ID, Env: ["FLAG=new", "PORT=3000"],
      Hostname: "api", Cmd: ["node", "server.js"], Entrypoint: ["entrypoint.sh"], User: "node", WorkingDir: "/app",
      StopSignal: "SIGINT", StopTimeout: 30,
      HostConfig: {
        Memory: 512 * 1024 ** 2, NanoCpus: 1e9, RestartPolicy: { Name: "unless-stopped" },
        Binds: ["/srv/config:/config:ro", "existing-anonymous-volume:/data:rw"],
        PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "31000" }] },
      },
      NetworkingConfig: { EndpointsConfig: { "openship-demo": {
        IPAMConfig: { IPv4Address: "172.22.0.8" }, Aliases: ["api", "custom-alias"],
      } } },
    });
    expect(h.original.stop).toHaveBeenCalledWith();
    expect(h.original.remove).toHaveBeenCalledWith();
    expect(h.order).toEqual([
      "verify image", "stop original", "rename original", "disconnect original",
      "create replacement", "start replacement", "commit identity", "remove original",
    ]);
    expect(h.before.Config.Env).toEqual(["FLAG=old", "REMOVE=old", "PORT=3000"]);
  });

  it.each([404, 401, 503])("never stops the service or tries a registry after image inspection fails (%s)", async statusCode => {
    const h = setup();
    h.imageInspect.mockRejectedValue(Object.assign(new Error("image inspection failed"), { statusCode }));
    await expect(h.apply()).rejects.toThrow(statusCode === 404 ? "Use Redeploy" : "image inspection failed");
    expect(h.original.stop).not.toHaveBeenCalled();
    expect(h.original.remove).not.toHaveBeenCalled();
    expect(h.docker.createContainer).not.toHaveBeenCalled();
    expect(h.docker.pull).not.toHaveBeenCalled();
    expect(h.options.onReplaced).not.toHaveBeenCalled();
  });

  it.each(["create", "start", "persist"])("restores the original container and routes if %s fails", async stage => {
    const h = setup();
    if (stage === "create") h.docker.createContainer.mockRejectedValue(new Error("create failed"));
    if (stage === "start") h.replacement.start.mockRejectedValue(new Error("start failed"));
    if (stage === "persist") h.options.onReplaced.mockRejectedValue(new Error("persist failed"));
    await expect(h.apply()).rejects.toMatchObject({ code: "SERVICE_ENVIRONMENT_APPLY_FAILED" });
    expect(h.original.remove).not.toHaveBeenCalled();
    expect(h.original.rename).toHaveBeenLastCalledWith({ name: "openship-demo-api" });
    expect(h.network.connect).toHaveBeenCalledWith({ Container: "old-container", EndpointConfig: expect.objectContaining({ IPAMConfig: { IPv4Address: "172.22.0.8" } }) });
    expect(h.original.start).toHaveBeenCalledOnce();
    if (stage !== "create") expect(h.replacement.remove).toHaveBeenCalledOnce();
    if (stage !== "persist") expect(h.options.onReplaced).not.toHaveBeenCalled();
  });

  it("keeps an already stopped container stopped when apply fails", async () => {
    const h = setup();
    h.before.State.Running = false;
    h.docker.createContainer.mockRejectedValue(new Error("cannot create"));
    await expect(h.apply()).rejects.toThrow("configuration was preserved");
    expect(h.original.stop).not.toHaveBeenCalled();
    expect(h.original.start).not.toHaveBeenCalled();
  });

  it("does not roll back a successful apply when only old-container cleanup fails", async () => {
    const h = setup();
    h.original.remove.mockRejectedValue(new Error("cleanup failed"));
    await expect(h.apply()).resolves.toMatchObject({ containerId: "new-container", warning: expect.stringContaining("Environment applied") });
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
    const error = await h.apply({ FLAG: "private\0value", PORT: "3000" }).catch(error => error);
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
});
