import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { dockerServiceCutover } from "./docker-service-cutover";
import type { MultiServiceDeployConfig } from "./types";

const config: MultiServiceDeployConfig = {
  projectId: "project-a",
  deploymentId: "deployment-new",
  previousContainerId: "original-id",
  slug: "shop",
  serviceName: "api",
  image: "shop-api:built",
  ports: ["3000"],
  environment: {},
  volumes: [],
  namespaceVolumes: true,
  publicPort: 3000,
  resources: { cpuCores: 0.5, memoryMb: 512 },
};

function fixture() {
  const labels = {
    "openship.project": config.projectId,
    "openship.service": config.serviceName,
    "openship.deployment": config.deploymentId,
  };
  const previous = {
    Id: "original-id",
    Name: "/openship-shop-api",
    Config: { Labels: { ...labels, "openship.deployment": "deployment-old" } },
    State: { Running: true, Restarting: false },
    RestartCount: 0,
    NetworkSettings: {
      Networks: {
        "openship-shop": { NetworkID: "network-id", IPAddress: "172.20.0.2", Aliases: ["api"] },
        "operator-network": {
          NetworkID: "operator-network-id",
          IPAddress: "172.21.0.2",
          Aliases: ["shared-api"],
        },
      },
    },
  } as unknown as Dockerode.ContainerInspectInfo;
  const candidate = {
    Id: "candidate-id",
    Name: "/openship-cutover-deploymentnew-api",
    Config: { Labels: { ...labels } },
    State: { Running: true, Restarting: false },
    RestartCount: 0,
    NetworkSettings: {
      Networks: {
        "openship-shop": { NetworkID: "network-id", IPAddress: "172.20.0.3", Aliases: [] },
      },
    },
  } as unknown as Dockerode.ContainerInspectInfo;
  const events: string[] = [];
  const handle = (info: Dockerode.ContainerInspectInfo) => ({
    inspect: vi.fn(async () => structuredClone(info)),
    rename: vi.fn(async ({ name }: { name: string }) => {
      events.push(`rename:${info.Id}:${name}`);
      info.Name = `/${name}`;
    }),
    stop: vi.fn(async () => {
      events.push(`stop:${info.Id}`);
    }),
    remove: vi.fn(async () => {
      events.push(`remove:${info.Id}`);
    }),
  });
  const originalHandle = handle(previous);
  const candidateHandle = handle(candidate);
  const network = {
    disconnect: vi.fn(async ({ Container }: { Container: string }) => {
      events.push(`disconnect:${Container}`);
      if (Container !== candidate.Id) throw new Error("The original network must stay untouched");
      candidate.NetworkSettings.Networks = {};
    }),
    connect: vi.fn(
      async ({
        Container,
        EndpointConfig,
      }: {
        Container: string;
        EndpointConfig: { Aliases: string[] };
      }) => {
        events.push(`connect:${Container}`);
        if (Container !== candidate.Id) throw new Error("The original network must stay untouched");
        candidate.NetworkSettings.Networks = {
          "openship-shop": {
            NetworkID: "network-id",
            IPAddress: "172.20.0.4",
            Aliases: [...EndpointConfig.Aliases],
          } as Dockerode.ContainerInspectInfo["NetworkSettings"]["Networks"][string],
        };
      },
    ),
  };
  const docker = {
    getContainer: vi.fn((id: string) => {
      if (id === "candidate-id") return candidateHandle;
      if (id === "original-id") return originalHandle;
      throw new Error(`Unexpected container: ${id}`);
    }),
    getNetwork: vi.fn((id: string) => {
      if (id !== "network-id") throw new Error(`Unexpected network: ${id}`);
      return network;
    }),
  };
  const destroy = vi.fn(async (id: string) => {
    events.push(`destroy:${id}`);
  });
  const plan = dockerServiceCutover(
    docker as unknown as Dockerode,
    { id: "network-id" },
    config,
    structuredClone(previous),
    ["api", "api-private"],
    destroy,
  );
  return { plan, previous, candidate, originalHandle, candidateHandle, network, destroy, events };
}

describe("Docker staged service publication and retirement", () => {
  it("does not mutate either container while constructing the plan", () => {
    const { plan, events, destroy } = fixture();
    expect(plan.previousContainerId).toBe("original-id");
    expect(plan.previousDeploymentId).toBe("deployment-old");
    expect(plan.config).toBe(config);
    expect(events).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("publishes only the candidate and returns its observed reconnect IP", async () => {
    const { plan, previous, network, destroy, originalHandle } = fixture();
    const before = structuredClone(previous);
    expect(await plan.publish("candidate-id")).toEqual({ ip: "172.20.0.4" });
    expect(network.disconnect).toHaveBeenCalledExactlyOnceWith({ Container: "candidate-id" });
    expect(network.connect).toHaveBeenCalledExactlyOnceWith({
      Container: "candidate-id",
      EndpointConfig: { Aliases: ["api", "api-private"] },
    });
    expect(previous).toEqual(before);
    expect(originalHandle.rename).not.toHaveBeenCalled();
    expect(originalHandle.stop).not.toHaveBeenCalled();
    expect(originalHandle.remove).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("leaves all original names and networks unchanged when candidate reconnect fails", async () => {
    const { plan, previous, network, originalHandle, destroy } = fixture();
    const before = structuredClone(previous);
    const failure = new Error("Docker rejected candidate endpoint");
    network.connect.mockRejectedValueOnce(failure);
    await expect(plan.publish("candidate-id")).rejects.toBe(failure);
    expect(network.disconnect).toHaveBeenCalledExactlyOnceWith({ Container: "candidate-id" });
    expect(previous).toEqual(before);
    expect(originalHandle.rename).not.toHaveBeenCalled();
    expect(originalHandle.stop).not.toHaveBeenCalled();
    expect(originalHandle.remove).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each(["openship.project", "openship.service", "openship.deployment"])(
    "rejects a stale or foreign candidate before networking or retirement: %s",
    async (label) => {
      const { plan, candidate, previous, network, originalHandle, destroy } = fixture();
      candidate.Config.Labels[label] = "other-owner";
      const before = structuredClone(previous);
      await expect(plan.publish("candidate-id")).rejects.toThrow("does not belong");
      await expect(plan.retire("candidate-id")).rejects.toThrow("does not belong");
      expect(network.disconnect).not.toHaveBeenCalled();
      expect(network.connect).not.toHaveBeenCalled();
      expect(originalHandle.rename).not.toHaveBeenCalled();
      expect(previous).toEqual(before);
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it("never accepts the original itself as a staged replacement", async () => {
    const { plan, previous, network, destroy } = fixture();
    previous.Config.Labels["openship.deployment"] = config.deploymentId;
    await expect(plan.publish("original-id")).rejects.toThrow("does not belong");
    await expect(plan.retire("original-id")).rejects.toThrow("does not belong");
    expect(network.disconnect).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("preserves the original when the candidate has no project endpoint", async () => {
    const { plan, candidate, previous, network, destroy } = fixture();
    candidate.NetworkSettings.Networks = {};
    const before = structuredClone(previous);
    await expect(plan.publish("candidate-id")).rejects.toThrow("no project network endpoint");
    expect(network.disconnect).not.toHaveBeenCalled();
    expect(previous).toEqual(before);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("restores the original stable name when candidate rename is refused", async () => {
    const { plan, previous, originalHandle, candidateHandle, destroy } = fixture();
    const before = structuredClone(previous);
    const failure = new Error("Candidate rename refused");
    candidateHandle.rename.mockRejectedValueOnce(failure);
    await expect(plan.retire("candidate-id")).rejects.toBe(failure);
    expect(originalHandle.rename.mock.calls).toEqual([
      [{ name: "openship-shop-api-previous-original-id" }],
      [{ name: "openship-shop-api" }],
    ]);
    expect(previous).toEqual(before);
    expect(originalHandle.stop).not.toHaveBeenCalled();
    expect(originalHandle.remove).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("does not remove either container if the original stable name cannot be moved", async () => {
    const { plan, previous, originalHandle, candidateHandle, destroy } = fixture();
    const before = structuredClone(previous);
    originalHandle.rename.mockRejectedValueOnce(new Error("Original rename refused"));
    await expect(plan.retire("candidate-id")).rejects.toThrow("Original rename refused");
    expect(candidateHandle.rename).not.toHaveBeenCalled();
    expect(previous).toEqual(before);
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each([
    "crashed",
    "paused",
    "dead",
    "oom-killed",
    "restarting",
    "restarted",
    "unhealthy",
    "starting",
  ])("keeps the original when a previously probed candidate is now %s", async (condition) => {
    const { plan, candidate, previous, originalHandle, destroy } = fixture();
    await plan.publish("candidate-id");
    if (condition === "crashed") candidate.State.Running = false;
    if (condition === "paused") candidate.State.Paused = true;
    if (condition === "dead") candidate.State.Dead = true;
    if (condition === "oom-killed") candidate.State.OOMKilled = true;
    if (condition === "restarting") candidate.State.Restarting = true;
    if (condition === "restarted") candidate.RestartCount = 1;
    if (condition === "unhealthy" || condition === "starting")
      candidate.State.Health = { Status: condition, FailingStreak: 0, Log: [] };
    const before = structuredClone(previous);
    await expect(plan.retire("candidate-id")).rejects.toThrow("previous service was preserved");
    expect(originalHandle.rename).not.toHaveBeenCalled();
    expect(originalHandle.stop).not.toHaveBeenCalled();
    expect(originalHandle.remove).not.toHaveBeenCalled();
    expect(previous).toEqual(before);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("rechecks the original owner before retirement", async () => {
    const { plan, previous, originalHandle, destroy } = fixture();
    previous.Config.Labels["openship.project"] = "other-project";
    await expect(plan.retire("candidate-id")).rejects.toThrow("ownership changed");
    expect(originalHandle.rename).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("retires through the existing destroy callback only after explicit retirement", async () => {
    const { plan, candidate, previous, destroy, originalHandle, events } = fixture();
    await plan.publish("candidate-id");
    expect(destroy).not.toHaveBeenCalled();
    expect(previous.Name).toBe("/openship-shop-api");
    await plan.retire("candidate-id");
    expect(events).toEqual([
      "disconnect:candidate-id",
      "connect:candidate-id",
      "rename:original-id:openship-shop-api-previous-original-id",
      "rename:candidate-id:openship-shop-api",
      "destroy:original-id",
    ]);
    expect(candidate.Name).toBe("/openship-shop-api");
    expect(destroy).toHaveBeenCalledExactlyOnceWith("original-id");
    expect(originalHandle.stop).not.toHaveBeenCalled();
    expect(originalHandle.remove).not.toHaveBeenCalled();
  });
});
