import { describe, expect, it, vi } from "vitest";
import type Dockerode from "dockerode";
import { DockerRuntime } from "./docker";
import {
  DockerReplicas,
  dockerReplicaRef,
  replicaGroupIdentity,
  replicaInventoryStatus,
  replicaLabels,
} from "./docker-replicas";
import { workloadGatewayConfig, workloadGatewayContainer } from "./workload-gateway";
import type { MultiServiceDeployConfig } from "./types";

function fixture() {
  const config: MultiServiceDeployConfig = {
    projectId: "project",
    deploymentId: "release",
    slug: "app",
    serviceName: "api",
    image: "api:stable",
    ports: ["127.0.0.1::8080"],
    environment: {},
    volumes: [],
    namespaceVolumes: true,
    imageAlreadyPrepared: true,
    replicas: 3,
  };
  const group = replicaGroupIdentity(config.projectId, config.deploymentId, config.serviceName);
  const ref = dockerReplicaRef(group);
  const labels = {
    "openship.project": "project",
    "openship.deployment": "release",
    "openship.service": "api",
  };
  const anchor = {
    Id: "gateway",
    Config: {
      Labels: { ...labels, ...replicaLabels({ group, index: 0 }), "openship.replica-count": "3" },
    },
    State: { Running: true },
  };
  const rows = [1, 2, 3].map((index) => ({
    Id: `member-${index}`,
    Labels: { ...labels, ...replicaLabels({ group, index }) },
    State: "running",
  })) as unknown as Dockerode.ContainerInfo[];
  const getContainer = vi.fn((id: string) => ({
    inspect: vi.fn(async () =>
      id.startsWith("opsh-replicas-")
        ? anchor
        : {
            ...anchor,
            Id: id,
            Config: { ...anchor.Config, Labels: rows.find((row) => row.Id === id)?.Labels },
            State: { Running: true, Status: "running" },
            RestartCount: 0,
          },
    ),
  }));
  const listContainers = vi.fn(async () => rows);
  const runtime = {
    supports: vi.fn(() => true),
    docker: {
      getContainer,
      listContainers,
      getImage: vi.fn(() => ({ inspect: vi.fn(async () => ({ Config: {} })) })),
    },
    pullImage: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
    restart: vi.fn(),
    destroy: vi.fn(),
    getContainerInfo: vi.fn(async (id: string) => ({ containerId: id, status: "running" })),
    getRuntimeLogs: vi.fn(async (id: string) => [
      { timestamp: "2026-11-17T01:00:00Z", message: id, level: "info" },
    ]),
    streamRuntimeLogs: vi.fn(),
  };
  const replicas = new DockerReplicas(runtime as unknown as DockerRuntime);
  return { config, group, ref, anchor, rows, runtime, replicas };
}

describe("Docker workload references and lifecycle", () => {
  it("refuses managed/unsupported runtimes before inspecting any container", async () => {
    const h = fixture();
    h.runtime.supports.mockReturnValue(false);
    for (const run of [
      () => h.replicas.members(h.ref),
      () => h.replicas.stop(h.ref),
      () => h.replicas.start(h.ref),
      () => h.replicas.restart(h.ref),
      () => h.replicas.destroy(h.ref),
      () => h.replicas.info(h.ref),
      () => h.replicas.logs(h.ref),
      () => h.replicas.prepare(h.config),
    ])
      await expect(run()).rejects.toMatchObject({ code: "WORKLOAD_REPLICAS_UNSUPPORTED" });
    expect(h.runtime.docker.getContainer).not.toHaveBeenCalled();
    expect(h.runtime.docker.getImage).not.toHaveBeenCalled();
  });
  it("verifies ownership and validates the reference before selecting members", async () => {
    const h = fixture();
    await expect(h.replicas.members("replicas:../../other")).rejects.toMatchObject({
      code: "WORKLOAD_REFERENCE_INVALID",
    });
    h.anchor.Config.Labels["openship.project"] = "other";
    await expect(h.replicas.members(h.ref)).rejects.toMatchObject({
      code: "WORKLOAD_OWNERSHIP_CHANGED",
    });
    expect(h.runtime.docker.listContainers).not.toHaveBeenCalled();
  });
  it("uses a full project/deployment/service filter and notices missing or duplicate members", async () => {
    const h = fixture();
    await h.replicas.members(h.ref);
    expect(h.runtime.docker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: {
        label: expect.arrayContaining([
          "openship.project=project",
          "openship.deployment=release",
          "openship.service=api",
        ]),
      },
    });
    h.rows.pop();
    await expect(h.replicas.members(h.ref)).rejects.toMatchObject({
      code: "WORKLOAD_REPLICAS_INCOMPLETE",
    });
    expect(await h.replicas.status(h.ref)).toMatchObject({
      desired: 3,
      ready: 2,
      message: expect.stringContaining("missing"),
    });
    h.rows.push(h.rows[0]!);
    await expect(h.replicas.members(h.ref, true)).rejects.toMatchObject({
      code: "WORKLOAD_REPLICAS_INCOMPLETE",
    });
  });
  it("stops ingress before members and retains durable identity when cleanup fails", async () => {
    const h = fixture();
    h.runtime.destroy.mockImplementation(async (id) => {
      if (id === "member-2") throw new Error("daemon unavailable");
    });
    await expect(h.replicas.destroy(h.ref)).rejects.toThrow(/operations failed/);
    expect(h.runtime.stop).toHaveBeenCalledWith("gateway");
    expect(h.runtime.destroy.mock.calls.map((call) => call[0]).sort()).toEqual([
      "member-1",
      "member-2",
      "member-3",
    ]);
    expect(h.runtime.destroy).not.toHaveBeenCalledWith("gateway");
  });
  it("does no image/gateway work for the default count", async () => {
    const h = fixture();
    await h.replicas.prepare({ ...h.config, replicas: 1 });
    expect(h.runtime.pullImage).not.toHaveBeenCalled();
    expect(h.runtime.docker.getImage).not.toHaveBeenCalled();
  });
  it("refuses image-declared writable volumes before pulling or touching a workload", async () => {
    const h = fixture();
    h.runtime.docker.getImage.mockReturnValue({
      inspect: vi.fn(async () => ({ Config: { Volumes: { "/data": {} } } })),
    });
    await expect(h.replicas.prepare(h.config)).rejects.toMatchObject({
      code: "WORKLOAD_REPLICAS_UNSUPPORTED",
    });
    expect(h.runtime.pullImage).not.toHaveBeenCalled();
    expect(h.runtime.stop).not.toHaveBeenCalled();
  });
  it("closes every member stream when any source closes and emits one end event", async () => {
    const h = fixture(),
      stopped = [vi.fn(), vi.fn(), vi.fn()],
      onEnd = vi.fn();
    let closed: (() => void) | undefined;
    h.runtime.streamRuntimeLogs.mockImplementation(async (_id, _log, options) => {
      closed = options.onEnd;
      return stopped[h.runtime.streamRuntimeLogs.mock.calls.length - 1];
    });
    const stop = await h.replicas.stream(h.ref, vi.fn(), { onEnd });
    closed?.();
    closed?.();
    stop();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(stopped.every((callback) => callback.mock.calls.length > 0)).toBe(true);
  });
  it("uses the gateway's durable identity in handover recovery", () => {
    const h = fixture();
    expect(DockerRuntime.deploymentContainerName({ ...h.config, networkAlias: "api" })).toBe(
      `opsh-replicas-${h.group}-0`,
    );
    expect(DockerRuntime.deploymentContainerName({ ...h.config, replicas: 1 })).toBe(
      "openship-project-release",
    );
  });
  it("reports a broken member in deployment inventory even while the gateway is running", () => {
    const h = fixture();
    const anchor = { ...h.rows[0]!, Labels: h.anchor.Config.Labels };
    expect(replicaInventoryStatus(anchor, h.rows)).toBe("running");
    h.rows[0]!.State = "exited";
    expect(replicaInventoryStatus(anchor, h.rows)).toBe("stopped");
    expect(replicaInventoryStatus(anchor, h.rows.slice(1))).toBe("missing");
  });
});

describe("private workload gateway", () => {
  it("validates all configuration fragments and confines its process", () => {
    expect(() => workloadGatewayConfig(["safe; evil"], ["80/tcp"])).toThrow();
    for (const port of ["0/tcp", "65536/tcp", "80/tcp;evil", "80/sctp", "80/tcp/evil"])
      expect(() => workloadGatewayConfig(["safe"], [port])).toThrow();
    const conf = workloadGatewayConfig(["first", "second"], ["8080/tcp", "53/udp"]);
    expect(conf).toContain("server first:8080");
    expect(conf).toContain("server second:8080");
    expect(conf).toContain("listen 53 udp");
    expect(workloadGatewayContainer(conf)).toMatchObject({
      User: "101:101",
      HostConfig: {
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 32,
      },
    });
  });
});
