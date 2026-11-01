import { describe, expect, it, vi } from "vitest";
import { ClusterVolumeAdapter } from "./volumes";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";
import { longhornBase } from "./storage";
import { kubernetesIdLabel } from "./kubernetes-label";

const labels = {
  "app.kubernetes.io/managed-by": "openship",
  "openship.io/runtime": "runtime",
  "openship.io/project": kubernetesIdLabel("project"),
};
const signal = () => AbortSignal.timeout(5000);

function fixture() {
  const objects = new Map<string, KubernetesObject>();
  let sequence = 1;
  const merge = (before: any, patch: any): any => {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch))
      return structuredClone(patch);
    const next = { ...before };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = merge(before?.[key], value);
    }
    return next;
  };
  const put = (path: string, value: KubernetesObject) => {
    const object = structuredClone(value);
    object.metadata = {
      uid: `uid-${sequence}`,
      resourceVersion: String(sequence++),
      ...object.metadata,
    };
    objects.set(path, object);
    return object;
  };
  const request = vi.fn(async (method: string, path: string, body?: any) => {
    const url = new URL(`https://test${path}`);
    if (
      method === "GET" &&
      (url.searchParams.has("labelSelector") ||
        /\/(backups|replicas|engines|pods|volumes|storageclasses|persistentvolumeclaims)$/.test(
          url.pathname,
        ))
    ) {
      const labels = url.searchParams.get("labelSelector")?.split(",") ?? [];
      return {
        items: [...objects.entries()]
          .filter(
            ([key, object]) =>
              (key.startsWith(url.pathname + "/") ||
                (url.pathname === "/api/v1/persistentvolumeclaims" &&
                  key.includes("/persistentvolumeclaims/"))) &&
              labels.every((label) => {
                const [name, value] = label.split("=");
                return value
                  ? object.metadata.labels?.[name] === value
                  : object.metadata.labels?.[name] !== undefined;
              }),
          )
          .map(([, object]) => structuredClone(object)),
      };
    }
    const current = objects.get(url.pathname);
    if (method === "POST") {
      const location = `${url.pathname}/${body.metadata.name}`;
      if (objects.has(location)) throw new KubernetesApiError(409, "Exists");
      return structuredClone(put(location, body));
    }
    if (!current) throw new KubernetesApiError(404, "Missing");
    if (method === "GET") return structuredClone(current);
    if (method === "PATCH") {
      if (body.metadata.resourceVersion !== current.metadata.resourceVersion)
        throw new KubernetesApiError(409, "Changed");
      const next = merge(current, body);
      next.metadata.resourceVersion = String(sequence++);
      objects.set(url.pathname, next);
      return structuredClone(next);
    }
    if (method === "DELETE") {
      if (body.preconditions.uid !== current.metadata.uid)
        throw new KubernetesApiError(409, "Changed");
      if (
        body.preconditions.resourceVersion &&
        body.preconditions.resourceVersion !== current.metadata.resourceVersion
      )
        throw new KubernetesApiError(409, "Changed");
      objects.delete(url.pathname);
      return {};
    }
    throw new Error("Unexpected API request");
  });
  const api = { request } as unknown as KubernetesApi;
  const fence = vi.fn(async () => {});
  const adapter = new ClusterVolumeAdapter(api, "project", "runtime", signal(), fence);
  put(`/api/v1/namespaces/${adapter.namespace}`, { metadata: { name: adapter.namespace, labels } });
  put("/apis/storage.k8s.io/v1/storageclasses/openship-replicated", {
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: { name: "openship-replicated", labels: { "openship.io/runtime": "runtime" } },
    provisioner: "driver.longhorn.io",
    parameters: { numberOfReplicas: "2" },
  });
  return { objects, put, request, api, adapter, fence };
}
const archived = (name = "saved-files", project = labels["openship.io/project"]) => ({
  apiVersion: "longhorn.io/v1beta2",
  kind: "Backup",
  metadata: { name },
  spec: {},
  status: {
    labels: {
      "openship-project": project,
      "openship-runtime": "runtime",
      "openship-volume": "uploads",
    },
    state: "Completed",
    volumeSize: String(1024 ** 3),
    url: "s3://saved-test-archive",
    backupCreatedAt: "2026-09-20T00:00:00Z",
  },
});

describe("shared file ownership and recovery", () => {
  it("cleans an unused recovery class after a definitive claim rejection, while keeping the archive", async () => {
    const { adapter, put, request, objects } = fixture();
    put(`${longhornBase}/backups/saved-files`, archived());
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, body) => {
      if (method === "POST" && path.endsWith("persistentvolumeclaims"))
        throw new KubernetesApiError(422, "Claim rejected");
      return original(method, path, body);
    });
    await expect(
      adapter.create({
        name: "recovered",
        sizeGiB: 2,
        requestId: "request-one",
        restoreFrom: { volumeName: "uploads", backupName: "saved-files" },
      }),
    ).rejects.toThrow(/Claim rejected/);
    expect(
      [...objects.values()].some((object) => object.metadata.name?.startsWith("openship-restore-")),
    ).toBe(false);
    expect(objects.has(`${longhornBase}/backups/saved-files`)).toBe(true);
  });
  it("keeps deletion pending when an unbound claim is bound during the reviewed delete", async () => {
    const { adapter, request, objects } = fixture();
    const volume = await adapter.create({ name: "uploads", sizeGiB: 2, requestId: "request-one" });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, body) => {
      if (method === "DELETE" && path.endsWith("persistentvolumeclaims/shared-uploads")) {
        objects.get(path)!.metadata.resourceVersion = "new-binding";
        throw new KubernetesApiError(409, "The provisioner bound the claim");
      }
      return original(method, path, body);
    });
    await expect(adapter.remove("uploads", volume.resourceVersion)).rejects.toThrow(
      /bound the claim/,
    );
    expect(
      objects.has(`/api/v1/namespaces/${adapter.namespace}/persistentvolumeclaims/shared-uploads`),
    ).toBe(true);
    expect((await adapter.list())[0].phase).toBe("Deleting");
  });
  it("finds and restores a native archive after its original PVC has gone", async () => {
    const { adapter, put, objects } = fixture();
    put(`${longhornBase}/backups/saved-files`, archived());
    put(`${longhornBase}/backups/foreign`, archived("foreign", "another-project"));
    expect(await adapter.archive.list()).toMatchObject([
      { name: "saved-files", volumeName: "uploads", sizeGiB: 1 },
    ]);
    const restored = await adapter.create({
      name: "recovered",
      sizeGiB: 2,
      requestId: "request-one",
      restoreFrom: { volumeName: "uploads", backupName: "saved-files" },
    });
    expect(restored).toMatchObject({ name: "recovered", phase: "Pending" });
    const storageClass = [...objects.values()].find((object) =>
      object.metadata.name?.startsWith("openship-restore-"),
    );
    expect(storageClass?.parameters.fromBackup).toBe("s3://saved-test-archive");
  });
  it("refuses foreign, incomplete and undersized restores without creating a claim", async () => {
    for (const problem of ["foreign", "incomplete", "undersized"]) {
      const { adapter, put, request } = fixture();
      const backup = archived();
      if (problem === "foreign") backup.status.labels["openship-project"] = "foreign";
      if (problem === "incomplete") backup.status.state = "InProgress";
      if (problem === "undersized") backup.status.volumeSize = String(3 * 1024 ** 3);
      put(`${longhornBase}/backups/saved-files`, backup);
      request.mockClear();
      await expect(
        adapter.create({
          name: "recovered",
          sizeGiB: 2,
          requestId: "request-one",
          restoreFrom: { volumeName: "uploads", backupName: "saved-files" },
        }),
      ).rejects.toThrow(/completed file backup/);
      expect(
        request.mock.calls.some(
          ([method, path]) => method === "POST" && path.includes("persistentvolumeclaims"),
        ),
      ).toBe(false);
    }
  });
  it("reuses a create after a lost response but refuses changed size or ownership", async () => {
    const { adapter, objects } = fixture();
    const input = { name: "uploads", sizeGiB: 2, requestId: "request-one" };
    const first = await adapter.create(input);
    expect((await adapter.create(input)).resourceVersion).toBe(first.resourceVersion);
    await expect(adapter.create({ ...input, sizeGiB: 3 })).rejects.toThrow(/different request/);
    objects.get(
      `/api/v1/namespaces/${adapter.namespace}/persistentvolumeclaims/shared-uploads`,
    )!.metadata.labels!["openship.io/runtime"] = "another-runtime";
    await expect(adapter.create(input)).rejects.toThrow(/different project or cluster/);
  });
  it("refuses to adopt a claim whose configuration drifted after creation", async () => {
    const { adapter, objects } = fixture();
    const input = { name: "uploads", sizeGiB: 2, requestId: "request-one" };
    await adapter.create(input);
    objects.get(
      `/api/v1/namespaces/${adapter.namespace}/persistentvolumeclaims/shared-uploads`,
    )!.spec.storageClassName = "unmanaged-storage";
    await expect(adapter.create(input)).rejects.toThrow(/no longer matches/);
  });
  it("protects an archive during a pending restore and during the actual data copy", async () => {
    const { adapter, put, objects } = fixture();
    const backupPath = `${longhornBase}/backups/saved-files`;
    put(backupPath, archived());
    await adapter.create({
      name: "recovered",
      sizeGiB: 2,
      requestId: "request-one",
      restoreFrom: { volumeName: "uploads", backupName: "saved-files" },
    });
    await expect(adapter.archive.remove("saved-files")).rejects.toThrow(/being restored/);
    expect(objects.has(backupPath)).toBe(true);
    const claim = objects.get(
      `/api/v1/namespaces/${adapter.namespace}/persistentvolumeclaims/shared-recovered`,
    )!;
    claim.spec.volumeName = "restored-pv";
    put("/api/v1/persistentvolumes/restored-pv", {
      metadata: { name: "restored-pv" },
      spec: { csi: { volumeHandle: "restored-disk" } },
    });
    const disk = put(`${longhornBase}/volumes/restored-disk`, {
      metadata: { name: "restored-disk" },
      spec: { fromBackup: archived().status.url },
      status: { restoreInitiated: true, restoreRequired: true },
    });
    await expect(adapter.archive.remove("saved-files")).rejects.toThrow(/being restored/);
    disk.status.restoreRequired = false;
    await adapter.archive.remove("saved-files");
    expect(objects.has(backupPath)).toBe(false);
  });
  it("refuses archive deletion or restore when another project owns it", async () => {
    const { adapter, put, request } = fixture();
    put(`${longhornBase}/backups/foreign`, archived("foreign", "another-project"));
    request.mockClear();
    await expect(adapter.archive.remove("foreign")).rejects.toThrow(/another project/);
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("keeps a deletion request visible after a lost response and resumes without recreating data", async () => {
    const { adapter, request, objects } = fixture();
    const volume = await adapter.create({ name: "uploads", sizeGiB: 2, requestId: "request-one" });
    const original = request.getMockImplementation()!;
    let lost = false;
    request.mockImplementation(async (method, path, body) => {
      const result = await original(method, path, body);
      if (method === "DELETE" && path.endsWith("persistentvolumeclaims/shared-uploads") && !lost) {
        lost = true;
        throw new Error("response lost");
      }
      return result;
    });
    await expect(adapter.remove("uploads", volume.resourceVersion)).rejects.toThrow(
      /response lost/,
    );
    const [pending] = await adapter.list();
    expect(pending.phase).toBe("Deleting");
    await expect(
      adapter.create({ name: "uploads", sizeGiB: 2, requestId: "request-two" }),
    ).rejects.toThrow(/Finish removing/);
    await adapter.remove("uploads", pending.resourceVersion);
    expect(await adapter.list()).toEqual([]);
    expect(
      [...objects.values()].some(
        (object) => object.metadata.labels?.["openship.io/volume-deletion"],
      ),
    ).toBe(false);
  });
  it("refuses to delete files while a live pod still mounts them", async () => {
    const { adapter, put, request } = fixture();
    const volume = await adapter.create({ name: "uploads", sizeGiB: 2, requestId: "request-one" });
    put(`/api/v1/namespaces/${adapter.namespace}/pods/app`, {
      metadata: { name: "app" },
      spec: { volumes: [{ persistentVolumeClaim: { claimName: "shared-uploads" } }] },
      status: { phase: "Running" },
    });
    request.mockClear();
    await expect(adapter.remove("uploads", volume.resourceVersion)).rejects.toThrow(
      /still mounted/,
    );
    expect(request.mock.calls.some(([method]) => method !== "GET")).toBe(false);
  });
});
