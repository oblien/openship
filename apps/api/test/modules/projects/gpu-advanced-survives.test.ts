import { describe, expect, it } from "vitest";
import { DockerRuntime } from "../../../../../packages/adapters/src/runtime/docker";
import { toDiscoveredService } from "@repo/platform/engine/modules/migration/docker-reconcile";
import { buildAdoptedServiceRows } from "@repo/platform/engine/modules/migration/migrate.service";
import { parseComposeFile } from "@repo/platform/engine/lib/compose-parser";
import { mergeAdvanced } from "@repo/platform/engine/modules/services/service.service";

/**
 * `advanced.gpus` rides in the same JSONB blob as the other compose-owned keys. Adopting a running
 * container layers LIVE healthcheck/resources on top of the repo spec through `mergeAdvanced`, so
 * the GPU request must survive that merge or the next recreate would drop the card (the container
 * would come back on CPU, silently).
 */
describe("advanced.gpus through mergeAdvanced", () => {
  const gpus = { driver: "nvidia", count: "all" as const, capabilities: ["gpu"] };

  it("survives a live healthcheck/resources overlay (the adopt path)", () => {
    const next = mergeAdvanced(
      { gpus },
      { healthcheck: { test: "true" }, resources: { memoryMb: 512 } },
    );
    expect(next.gpus).toEqual(gpus);
    expect(next.healthcheck).toEqual({ test: "true" });
  });

  it("survives a PATCH that never mentions it", () => {
    expect(mergeAdvanced({ gpus }, { stopSignal: "SIGINT" }).gpus).toEqual(gpus);
  });

  it("is removed only by an explicit null", () => {
    expect(mergeAdvanced({ gpus }, { gpus: null }).gpus).toBeUndefined();
  });
});

it("carries inspected GPU selectors through discovery, adoption and the next container create", async () => {
  const creates: Record<string, any>[] = [];
  const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/openship-no-daemon.sock" });
  const raw = {
    Id: "c".repeat(64),
    Name: "/app",
    Image: "sha256:cuda",
    State: { Status: "running" },
    Config: { Image: "nvidia/cuda", Env: ["NVIDIA_VISIBLE_DEVICES=0"], Labels: {} },
    NetworkSettings: { Networks: {} },
    Mounts: [],
    HostConfig: {
      ShmSize: 2147483648,
      Runtime: "nvidia",
      DeviceRequests: [
        { Driver: "nvidia", Count: 0, DeviceIDs: ["GPU-specific"], Capabilities: [["gpu"]] },
      ],
    },
  };
  let removed = false;
  (runtime as any)._docker = {
    getContainer: () => ({
      inspect: async () => {
        if (removed) throw Object.assign(new Error("No such container"), { statusCode: 404 });
        return raw;
      },
      stop: async () => {},
      remove: async () => { removed = true; },
    }),
    getImage: () => ({ inspect: async () => ({ RepoDigests: [] }) }),
    createContainer: async (args: Record<string, any>) => {
      creates.push(args);
      return {
        id: "d".repeat(64),
        start: async () => {},
        inspect: async () => ({ NetworkSettings: { Networks: {} }, Config: {} }),
      };
    },
  };
  const detail = await runtime.inspectContainer(raw.Id);
  const discovered = toDiscoveredService(detail!, undefined);
  const { rows } = buildAdoptedServiceRows([discovered]);
  expect(rows[0]?.advanced).toMatchObject({
    runtime: "nvidia",
    gpus: { deviceIds: ["GPU-specific"] },
  });
  await runtime.deployServiceWorkload(
    { id: "net" } as never,
    {
      deploymentId: "dep",
      projectId: "project",
      slug: "demo",
      serviceName: "app",
      image: "nvidia/cuda",
      ports: [],
      volumes: [],
      environment: discovered.env,
      namespaceVolumes: true,
      imageAlreadyPrepared: true,
      advanced: rows[0]?.advanced,
    } as never,
  );
  expect(creates[0]!.HostConfig.ShmSize).toBe(2147483648);
  expect(creates[0]?.HostConfig).toMatchObject({
    Runtime: "nvidia",
    DeviceRequests: [{ Driver: "nvidia", DeviceIDs: ["GPU-specific"], Capabilities: [["gpu"]] }],
  });
});

it("preserves a discovered Compose declaration even without a separately mapped repository", () => {
  const declared = parseComposeFile("services:\n  app:\n    image: nvidia/cuda\n    gpus: all\n")
    .services[0]!;
  const discovered = toDiscoveredService(
    {
      id: "container",
      name: "app",
      image: "nvidia/cuda",
      imageId: "sha256:cuda",
      state: "running",
      env: [],
      labels: {},
      networks: [],
      mounts: [],
      ports: [],
    },
    declared,
  );
  expect(buildAdoptedServiceRows([discovered]).rows[0]?.advanced?.gpus).toEqual(
    declared.advanced?.gpus,
  );
});

it("does not apply a stale repository GPU request to a container that was running without it", () => {
  const repo = parseComposeFile(
    "services:\n  app:\n    image: nvidia/cuda\n    runtime: nvidia\n    gpus: all\n",
  ).services[0]!;
  const discovered = toDiscoveredService(
    {
      id: "container",
      name: "app",
      image: "nvidia/cuda",
      imageId: "sha256:cuda",
      state: "running",
      env: [],
      labels: {},
      networks: [],
      mounts: [],
      ports: [],
      gpu: {},
    },
    repo,
  );
  const row = buildAdoptedServiceRows(
    [discovered],
    undefined,
    undefined,
    undefined,
    new Map([["app", repo]]),
  ).rows[0]!;
  expect(row.advanced?.gpus).toBeUndefined();
  expect(row.advanced?.runtime).toBeUndefined();
});


it("keeps inspection usable for an unsupported GPU configuration and blocks its adoption", async () => {
  const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/openship-no-daemon.sock" });
  (runtime as any)._docker = {
    getContainer: () => ({
      inspect: async () => ({
        Id: "container",
        Name: "/app",
        Image: "sha256:cuda",
        State: { Status: "running" },
        Config: { Image: "nvidia/cuda", Env: ["NVIDIA_VISIBLE_DEVICES=0"], Labels: {} },
        NetworkSettings: { Networks: {} },
        Mounts: [],
        HostConfig: {
          DeviceRequests: [{ Driver: "nvidia", Count: 1, Capabilities: [["gpu"], ["compute"]] }],
        },
      }),
    }),
  };
  const detail = await runtime.inspectContainer("container");
  expect(detail?.state).toBe("running");
  expect(detail?.env).toContain("NVIDIA_VISIBLE_DEVICES=0");
  const discovered = toDiscoveredService(detail!, undefined);
  expect(discovered.warnings).toContain(
    "GPU requests with alternative capability groups cannot be imported safely",
  );
  expect(() => buildAdoptedServiceRows([discovered])).toThrow(/cannot be imported safely/);
});
