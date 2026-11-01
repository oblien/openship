import { describe, expect, it, vi } from "vitest";
import type { ClusterDatabaseConfig } from "@repo/core";
import { ClusterDatabaseAdapter, clusterDatabaseUrl } from "./database";
import { KubernetesApiError, type KubernetesApi } from "./kubernetes-api";
import { projectNamespaceManifest } from "./namespace";

const original: ClusterDatabaseConfig = {
  engine: "postgres",
  version: "18",
  mode: "standalone",
  instances: 1,
  storageClass: "openship-local",
  storageGiB: 20,
  cpuMillis: 500,
  memoryMiB: 512,
  databaseName: "app",
};
// Kubernetes Merge Patch retains omitted fields and removes explicit nulls.
function merge(current: any, patch: any): any {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const result = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = merge(result[key], value);
  }
  return result;
}
describe("PostgreSQL operator scaling", () => {
  it("updates one owned Cluster in place and removes synchronous waiting when returning to one primary", async () => {
    const saved = new Map<string, any>();
    let revision = 0;
    const request = vi.fn(async (method: string, path: string, value?: any) => {
      if (method === "GET") {
        if (path.startsWith("/api/v1/namespaces?")) return { items: [] };
        const item = saved.get(path);
        if (!item) throw new KubernetesApiError(404, "Not found");
        return structuredClone(item);
      }
      if (method === "POST") {
        const key = `${path}/${value.metadata.name}`;
        if (saved.has(key)) throw new KubernetesApiError(409, "Already exists");
        const item = {
          ...value,
          metadata: {
            ...value.metadata,
            uid: `uid-${++revision}`,
            resourceVersion: String(revision),
          },
        };
        saved.set(key, item);
        return structuredClone(item);
      }
      if (method === "PATCH") {
        const previous = saved.get(path);
        if (
          value.metadata.uid !== previous.metadata.uid ||
          value.metadata.resourceVersion !== previous.metadata.resourceVersion
        )
          throw new KubernetesApiError(409, "Resource changed");
        const item = merge(previous, value);
        item.metadata.resourceVersion = String(++revision);
        saved.set(path, item);
        return structuredClone(item);
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const api = { request } as unknown as KubernetesApi;
    const database = (config: ClusterDatabaseConfig, generation: number) =>
      new ClusterDatabaseAdapter(
        api,
        {
          id: "database-id",
          projectId: "project",
          runtimeId: "runtime",
          generation,
          config,
          hosts: [],
        },
        new AbortController().signal,
        async () => {},
      );
    const one = database(original, 1);
    await one.apply("password");
    const clusterPath = `/apis/postgresql.cnpg.io/v1/namespaces/${one.namespace}/clusters/database`;
    const secretPath = `/api/v1/namespaces/${one.namespace}/secrets/credentials`;
    const initial = structuredClone(saved.get(clusterPath));
    const secret = structuredClone(saved.get(secretPath));
    const pvcPath = `/api/v1/namespaces/${one.namespace}/persistentvolumeclaims/database-1`;
    const pvc = { metadata: { uid: "existing-data" }, spec: { volumeName: "data-disk" } };
    saved.set(pvcPath, pvc);
    await database({ ...original, mode: "cluster", instances: 3 }, 2).apply("password");
    expect(saved.get(clusterPath)).toMatchObject({
      metadata: { uid: initial.metadata.uid },
      spec: {
        instances: 3,
        imageName: initial.spec.imageName,
        bootstrap: initial.spec.bootstrap,
        postgresql: { synchronous: { number: 1, dataDurability: "required" } },
      },
    });
    await database(original, 3).apply("password");
    expect(saved.get(clusterPath).metadata.uid).toBe(initial.metadata.uid);
    expect(saved.get(clusterPath).spec.instances).toBe(1);
    expect(saved.get(clusterPath).spec.postgresql.synchronous).toBeUndefined();
    expect(saved.get(secretPath)).toEqual(secret);
    expect(saved.get(pvcPath)).toEqual(pvc);
    expect(request.mock.calls.some(([method]) => method === "DELETE")).toBe(false);
    expect(
      request.mock.calls.filter(
        ([method, path]) => method === "POST" && path.endsWith("/clusters"),
      ),
    ).toHaveLength(1);
    await expect(
      database({ ...original, mode: "cluster", instances: 2 }, 2).apply("password"),
    ).rejects.toThrow("newer database operation");
    expect(saved.get(clusterPath).spec.instances).toBe(1);
  });

  it.each([
    ["project", "containers"],
    ["shared-consumer", "containers"],
    ["project", "initContainers"],
    ["shared-consumer", "initContainers"],
  ])(
    "keeps the final reader when a disconnected %s still uses it in %s",
    async (projectId, containerType) => {
      const labels = {
        "openship.io/database": "db",
        "openship.io/project": "project",
        "openship.io/runtime": "runtime",
      };
      const current = new ClusterDatabaseAdapter(
        { request: vi.fn() } as unknown as KubernetesApi,
        {
          id: "db",
          projectId: "project",
          runtimeId: "runtime",
          generation: 2,
          config: original,
          hosts: [],
        },
        new AbortController().signal,
        async () => {},
      );
      const namespace = projectNamespaceManifest(projectId, "runtime");
      const oldReader = clusterDatabaseUrl(
        "db",
        { ...original, mode: "cluster", instances: 3 },
        "password",
        "read",
      );
      const use = {
        [containerType]: [{ envFrom: [{ secretRef: { name: "previous-release-env" } }] }],
      };
      let deploymentReplicas = 1;
      let runningPod = true;
      const request = vi.mocked(current.api.request);
      request.mockImplementation(async (method, path, value) => {
        if (method === "GET") {
          if (path.startsWith("/api/v1/namespaces?")) return { items: [namespace] } as any;
          if (path === `/apis/apps/v1/namespaces/${namespace.metadata.name}/deployments`)
            return {
              items: [{ spec: { replicas: deploymentReplicas, template: { spec: use } } }],
            } as any;
          if (path === `/api/v1/namespaces/${namespace.metadata.name}/secrets`)
            return {
              items: [
                {
                  metadata: { name: "previous-release-env" },
                  data: { DATABASE_READ_URL: Buffer.from(oldReader).toString("base64") },
                },
              ],
            } as any;
          if (path === `/api/v1/namespaces/${namespace.metadata.name}/pods`)
            return {
              items: runningPod
                ? [{ metadata: { name: "old-pod" }, status: { phase: "Running" }, spec: use }]
                : [],
            } as any;
          if (path.endsWith("/clusters/database"))
            return {
              metadata: { name: "database", uid: "database", resourceVersion: "1", labels },
              spec: { instances: 3, storage: { size: "20Gi" } },
            } as any;
          if (path.endsWith("/credentials"))
            return {
              metadata: { name: "credentials", labels },
              data: { password: Buffer.from("password").toString("base64") },
            } as any;
          if (path === `/api/v1/namespaces/${current.namespace}`)
            return { metadata: { name: current.namespace, labels } } as any;
          throw new KubernetesApiError(404, "Missing fixture");
        }
        return {
          ...(value as any),
          metadata: { ...(value as any)?.metadata, uid: "new", resourceVersion: "1" },
        };
      });
      await expect(current.apply("password")).rejects.toThrow(/still uses.*reader endpoint/);
      // A stopped Deployment can still have a terminating or old active pod.
      deploymentReplicas = 0;
      await expect(current.apply("password")).rejects.toThrow(/still uses.*reader endpoint/);
      expect(
        request.mock.calls.some(
          ([method, path]) => method === "PATCH" && path.endsWith("/clusters/database"),
        ),
      ).toBe(false);
      runningPod = false;
      await expect(current.apply("password")).resolves.toBeUndefined();
      expect(
        request.mock.calls.some(
          ([method, path]) => method === "PATCH" && path.endsWith("/clusters/database"),
        ),
      ).toBe(true);
    },
  );

  it("keeps writer URLs compatible and requires explicit existing reader capacity", () => {
    const clustered = { ...original, mode: "cluster" as const, instances: 3 };
    expect(clusterDatabaseUrl("db", clustered, "pass@word")).toContain("@database-rw.");
    expect(clusterDatabaseUrl("db", clustered, "pass@word", "read")).toContain(
      "pass%40word@database-ro.",
    );
    expect(() => clusterDatabaseUrl("db", original, "password", "read")).toThrow(
      "Add PostgreSQL read replicas",
    );
    expect(() =>
      clusterDatabaseUrl("db", { ...original, engine: "redis" }, "password", "read"),
    ).toThrow();
  });
});
