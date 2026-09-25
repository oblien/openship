import { describe, expect, it, vi } from "vitest";
import { KubernetesRuntime } from "./kubernetes";
import {
  KubernetesApiError,
  type KubernetesApi,
  type KubernetesObject,
} from "../cluster/kubernetes-api";
import type { DockerRuntime } from "./docker";
import type { DeployConfig } from "../types";

const image = `ghcr.io/team/api@sha256:${"a".repeat(64)}`;
const config = (id = "deploy-1"): DeployConfig => ({
  deploymentId: id,
  projectId: "project-1",
  buildSessionId: "build-1",
  imageRef: image,
  port: 3000,
  environment: "production",
  envVars: { DATABASE_URL: "private-value" },
  resources: { cpuCores: 0.5, memoryMb: 256, diskMb: 1024 },
});
function setup() {
  const resources = new Map<string, KubernetesObject>();
  let version = 1;
  const ready = (object: KubernetesObject) => {
    object.status = {
      observedGeneration: object.metadata.generation,
      availableReplicas: object.spec.replicas,
      readyReplicas: object.spec.replicas,
      updatedReplicas: object.spec.replicas,
    };
  };
  const request = vi.fn(async (method: string, path: string, body?: any) => {
    const clean = path.split("?")[0];
    if (method === "GET") {
      if (path.includes("labelSelector="))
        return {
          items: [...resources.entries()]
            .filter(([key]) => key.startsWith(clean + "/"))
            .map(([, value]) => structuredClone(value)),
        };
      const found = resources.get(path);
      if (!found) throw new KubernetesApiError(404, "Not found");
      return structuredClone(found);
    }
    if (method === "POST") {
      const key = `${path}/${body.metadata.name}`;
      if (resources.has(key)) throw new KubernetesApiError(409, "Already exists");
      const value = structuredClone(body);
      value.metadata.uid = `uid-${version}`;
      value.metadata.resourceVersion = String(version++);
      value.metadata.generation = 1;
      if (value.kind === "Service") value.spec.clusterIP = "10.43.0.20";
      resources.set(key, value);
      return structuredClone(value);
    }
    const found = resources.get(path);
    if (!found) throw new KubernetesApiError(404, "Not found");
    if (method === "PATCH") {
      if (body.metadata.resourceVersion !== found.metadata.resourceVersion)
        throw new KubernetesApiError(409, "Changed");
      found.spec = { ...found.spec, ...body.spec };
      found.metadata.resourceVersion = String(version++);
      found.metadata.generation!++;
      if (found.kind === "Deployment") ready(found);
      return structuredClone(found);
    }
    if (method === "DELETE") {
      expect(body.preconditions.uid).toBe(found.metadata.uid);
      resources.delete(path);
      return {};
    }
    throw new Error("Unexpected request");
  });
  const watch = vi.fn(async function* (path: string) {
    const name = new URL(`https://cluster${path}`).searchParams.get("fieldSelector")!.split("=")[1];
    const value = resources.get(path.split("?")[0] + "/" + name)!;
    yield { type: "BOOKMARK", object: { metadata: { resourceVersion: "2" } } };
    ready(value);
    yield { type: "MODIFIED", object: structuredClone(value) };
  });
  const api = {
    request,
    watch,
    logs: vi.fn(async function* () {}),
    dispose: vi.fn(async () => {}),
  } as unknown as KubernetesApi;
  const builder = {
    docker: {
      getImage: vi.fn(() => ({
        inspect: vi.fn(async () => ({ Architecture: "arm64", Os: "linux" })),
      })),
    },
    build: vi.fn(async () => ({
      sessionId: "build-1",
      status: "deploying",
      imageRef: "local:image",
    })),
    prepareImage: vi.fn(async () => ({
      sessionId: "build-1",
      status: "deploying",
      imageRef: image,
      artifactOwned: false,
    })),
    publishImage: vi.fn(async () => image),
    pullImage: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    removeImage: vi.fn(async () => {}),
  };
  const create = (projectId = "project-1") =>
    new KubernetesRuntime({
      api,
      projectId,
      runtimeId: "runtime-1",
      edgePrivateIp: "10.20.0.1",
      servers: [{ serverId: "server-a", name: "Production A", nodeName: "openship-a" }],
      config: { replicas: 3, imageRepository: "ghcr.io/team/api" },
      builder: async () => builder as unknown as DockerRuntime,
      resolveRegistryAuth: async () => ({
        username: "user",
        password: "registry-secret",
        serveraddress: "ghcr.io",
      }),
    });
  return { runtime: create(), create, resources, request, watch, builder, ready, api };
}

function discoverForCleanup(
  fixture: ReturnType<typeof setup>,
  extra?: { kind: string; name: string; value: KubernetesObject },
) {
  const original = fixture.request.getMockImplementation()!;
  const collections = [
    { name: "secrets", kind: "Secret" },
    { name: "services", kind: "Service" },
    ...(extra ? [{ name: extra.name, kind: extra.kind }] : []),
  ];
  fixture.request.mockImplementation(async (method, path, body) => {
    if (method === "GET" && path === "/apis") return { groups: [] } as any;
    if (method === "GET" && path === "/api/v1")
      return {
        resources: collections.map((resource) => ({
          ...resource,
          namespaced: true,
          verbs: ["list"],
        })),
      } as any;
    const collection = collections.find(
      (item) => path === `/api/v1/namespaces/${fixture.runtime.namespace}/${item.name}`,
    );
    if (method === "GET" && collection) {
      return {
        items:
          extra?.name === collection.name
            ? [extra.value]
            : [...fixture.resources.entries()]
                .filter(([key]) => key.startsWith(path + "/"))
                .map(([, value]) => value),
      } as any;
    }
    return original(method, path, body);
  });
}

describe("Kubernetes workload lifecycle", () => {
  it.each(["_", "-", ".", "a".repeat(80)])("routes and manages IDs ending in %s through valid, consistent labels", async (suffix) => {
    const projectId = `proj_label${suffix}`;
    const deploymentId = `dep_label${suffix}`;
    const { create, resources, request } = setup();
    const runtime = create(projectId);
    const result = await runtime.deploy({ ...config(deploymentId), projectId });
    expect(result.deploymentId).toBe(deploymentId);
    const values = [...resources.values()];
    const workload = values.find((value) => value.kind === "Deployment")!;
    const projectLabel = workload.metadata.labels!["openship.io/project"];
    const deploymentLabel = workload.metadata.labels!["openship.io/deployment"];
    for (const value of values) {
      for (const label of Object.values(value.metadata.labels ?? {})) {
        expect(label).toMatch(/^[a-z0-9](?:[-a-z0-9_.]*[a-z0-9])?$/i);
        expect(label.length).toBeLessThanOrEqual(63);
      }
      expect(value.metadata.labels!["openship.io/project"]).toBe(projectLabel);
      if (value.kind === "Service")
        expect(value.spec.selector).toEqual({ "openship.io/deployment": deploymentLabel });
    }
    expect(workload.spec.template.metadata.labels).toEqual(workload.metadata.labels);
    expect(workload.spec.selector.matchLabels).toEqual({ "openship.io/deployment": deploymentLabel });
    expect(workload.spec.template.spec.topologySpreadConstraints[0].labelSelector.matchLabels)
      .toEqual({ "openship.io/project": projectLabel });
    expect(await runtime.listProjectContainerIds(projectId)).toEqual([result.containerId]);
    expect(request.mock.calls.at(-1)?.[1]).toContain(
      `labelSelector=${encodeURIComponent(`openship.io/project=${projectLabel}`)}`,
    );
    await runtime.stop(result.containerId!);
    await runtime.start(result.containerId!);
    expect(await runtime.getContainerInfo(result.containerId!)).toMatchObject({ status: "running" });
    await runtime.destroy(result.containerId!);
    expect(await runtime.listProjectContainerIds(projectId)).toEqual([]);
    await runtime.dispose();
  });

  it("creates isolated replicas, pins the architecture and waits before exposing a stable service", async () => {
    const { runtime, resources, watch } = setup();
    const result = await runtime.deploy(config());
    const values = [...resources.values()];
    const deployment = values.find((value) => value.kind === "Deployment")!;
    expect(watch).toHaveBeenCalledTimes(1);
    expect(deployment.spec.replicas).toBe(3);
    expect(deployment.spec.template.spec).toMatchObject({
      automountServiceAccountToken: false,
      nodeSelector: { "openship.io/runtime": "runtime-1", "kubernetes.io/arch": "arm64" },
      containers: [{ image, resources: { requests: { cpu: "0.5", memory: "256Mi" } } }],
    });
    expect(JSON.stringify(deployment)).not.toContain("private-value");
    expect(JSON.stringify(deployment)).not.toContain("registry-secret");
    expect(values.find((value) => value.metadata.name === "app")!.spec.selector).toEqual(
      deployment.spec.selector.matchLabels,
    );
    expect(await runtime.getContainerInfo(result.containerId!)).toMatchObject({
      status: "running",
      ip: "10.43.0.20",
    });
    for (const [name, nodeName] of [
      ["instance-a", "openship-a"],
      ["instance-b", "unrecognized-node"],
    ]) {
      resources.set(`/api/v1/namespaces/${runtime.namespace}/pods/${name}`, {
        kind: "Pod",
        metadata: { ...deployment.spec.template.metadata, name },
        spec: { nodeName },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      });
    }
    const status = await runtime.status(result.containerId!);
    expect(status.pods).toEqual([
      {
        name: "instance-a",
        nodeName: "openship-a",
        serverId: "server-a",
        serverName: "Production A",
        ready: true,
        phase: "Running",
        restarts: 0,
      },
      {
        name: "instance-b",
        nodeName: "unrecognized-node",
        serverId: null,
        serverName: null,
        ready: true,
        phase: "Running",
        restarts: 0,
      },
    ]);
  });
  it("publishes a source build through the existing builder and records an immutable artifact", async () => {
    const { runtime, builder } = setup();
    const result = await runtime.build({ sessionId: "build-1" } as never);
    expect(builder.build).toHaveBeenCalledOnce();
    expect(builder.publishImage).toHaveBeenCalledWith(
      "local:image",
      expect.stringMatching(/^ghcr.io\/team\/api:release-/),
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({ imageRef: image, artifactOwned: false });
    expect(builder.removeImage).toHaveBeenCalledWith(
      expect.stringMatching(/^ghcr.io\/team\/api:release-/),
    );
    expect(builder.removeImage).not.toHaveBeenCalledWith("local:image");
  });

  it.each(["failed", "cancelled"])(
    "preserves a %s image acquisition without trying to inspect or deploy it",
    async (status) => {
      const { runtime, builder, request } = setup();
      builder.prepareImage.mockResolvedValueOnce({
        sessionId: "build-1",
        status,
        imageRef: "app:latest",
        artifactOwned: false,
      });
      expect(
        await runtime.prepareImage({ sessionId: "build-1", imageRef: "app:latest" } as never),
      ).toMatchObject({ status });
      expect(builder.docker.getImage).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("refuses a known database image before pulling it or creating workload resources", async () => {
    const { runtime, builder, request } = setup();
    await expect(
      runtime.deploy({
        ...config(),
        imageRef: `docker.io/library/postgres@sha256:${"a".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_WORKLOAD_UNSUPPORTED" });
    expect(builder.pullImage).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses stateful mounts and another project's reference without sending a mutation", async () => {
    const { runtime, request } = setup();
    await expect(runtime.deploy({ ...config(), volumes: ["data:/var/lib/db"] })).rejects.toThrow(
      "Persistent mounts",
    );
    await expect(runtime.destroy("k8s:foreign:release-1")).rejects.toThrow("another project");
    expect(request).not.toHaveBeenCalled();
  });
  it("leaves a foreign namespace untouched", async () => {
    const { runtime, resources, request } = setup();
    resources.set(`/api/v1/namespaces/${runtime.namespace}`, {
      metadata: { name: runtime.namespace, labels: { "openship.io/project": "other-project" } },
    });
    await expect(runtime.deploy(config())).rejects.toThrow("not owned");
    expect(
      request.mock.calls.some(
        ([method, path]) => method === "POST" && path.includes("/deployments"),
      ),
    ).toBe(false);
  });
  it("reconnects an expired watch by reading state without replaying deployment creation", async () => {
    const { runtime, watch, request } = setup();
    watch.mockImplementationOnce(async function* () {
      yield { type: "ERROR", object: { metadata: {}, code: 410 } };
    });
    await runtime.deploy(config());
    expect(watch).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.filter(
        ([method, path]) => method === "POST" && path.endsWith("/deployments"),
      ),
    ).toHaveLength(1);
  });
  it("pause and resume preserve the chosen replica count", async () => {
    const { runtime } = setup();
    const result = await runtime.deploy(config());
    await runtime.stop(result.containerId!);
    expect(await runtime.getContainerInfo(result.containerId!)).toMatchObject({
      status: "stopped",
    });
    await runtime.start(result.containerId!);
    expect((await runtime.status(result.containerId!)).desired).toBe(3);
  });
  it("keeps the old internal service when a new rollout fails and removes only the failed release", async () => {
    const { runtime, resources, watch } = setup();
    const old = await runtime.deploy(config());
    const appPath = `/api/v1/namespaces/${runtime.namespace}/services/app`;
    const selector = structuredClone(resources.get(appPath)!.spec.selector);
    watch.mockImplementationOnce(async function* (path: string) {
      const name = new URL(`https://cluster${path}`).searchParams
        .get("fieldSelector")!
        .split("=")[1];
      const value = structuredClone(resources.get(path.split("?")[0] + "/" + name)!);
      value.status = {
        conditions: [
          {
            type: "Progressing",
            status: "False",
            message: "ImagePullBackOff: registry denied access",
          },
        ],
      };
      yield { type: "MODIFIED", object: value };
    });
    await expect(
      runtime.deploy({ ...config("deploy-2"), previousDeploymentId: "deploy-1" }),
    ).rejects.toThrow("registry denied");
    expect(resources.get(appPath)!.spec.selector).toEqual(selector);
    expect(await runtime.getContainerInfo(old.containerId!)).toMatchObject({ status: "running" });
    expect([...resources.values()].filter((value) => value.kind === "Deployment")).toHaveLength(1);
  });
  it("restores the still-running previous internal service when a ready release is rolled back", async () => {
    const { runtime, resources } = setup();
    await runtime.deploy(config());
    const next = await runtime.deploy({ ...config("deploy-2"), previousDeploymentId: "deploy-1" });
    await runtime.destroy(next.containerId!);
    expect(
      resources.get(`/api/v1/namespaces/${runtime.namespace}/services/app`)!.spec.selector[
        "openship.io/deployment"
      ],
    ).toBe("deploy-1");
  });
  it("reports a removed workload as missing for the existing lifecycle readers", async () => {
    const { runtime } = setup();
    const deployment = await runtime.deploy(config());
    await runtime.destroy(deployment.containerId!);
    expect(await runtime.getContainerInfo(deployment.containerId!)).toMatchObject({
      status: "missing",
    });
  });
  it("removes an owned, empty project namespace after its workload is gone", async () => {
    const fixture = setup();
    const deployment = await fixture.runtime.deploy(config());
    await fixture.runtime.destroy(deployment.containerId!);
    discoverForCleanup(fixture);
    await fixture.runtime.cleanupProject("project-1");
    expect(fixture.resources.has(`/api/v1/namespaces/${fixture.runtime.namespace}`)).toBe(false);
  });
  it.each(["PersistentVolumeClaim", "PostgresCluster"])(
    "preserves attached %s even with copied ownership labels and omitted item kind",
    async (kind) => {
      const fixture = setup();
      const deployment = await fixture.runtime.deploy(config());
      const namespace = `/api/v1/namespaces/${fixture.runtime.namespace}`;
      const labels = fixture.resources.get(namespace)!.metadata.labels;
      await fixture.runtime.destroy(deployment.containerId!);
      discoverForCleanup(fixture, {
        kind,
        name: "attached-data",
        value: { metadata: { name: "database", uid: "attached", labels } },
      });
      await expect(fixture.runtime.cleanupProject("project-1")).rejects.toThrow(
        kind === "PersistentVolumeClaim" ? "persistent storage" : "PostgresCluster",
      );
      expect(fixture.resources.has(namespace)).toBe(true);
      expect(
        fixture.request.mock.calls.some(
          ([method, path]) => method === "DELETE" && path === namespace,
        ),
      ).toBe(false);
    },
  );
});
