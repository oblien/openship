import { afterEach, describe, expect, it, vi } from "vitest";
import { KubernetesApiError, type KubernetesApi } from "./kubernetes-api";
import { deleteKubernetesObject, patchKubernetesObject } from "./kubernetes-mutation";

afterEach(() => vi.useRealTimers());

describe("Kubernetes optimistic deletion", () => {
  const original = () => ({
    metadata: {
      uid: "owned",
      resourceVersion: "1",
      generation: 3,
      labels: { owner: "ours" },
    },
  });

  it("rereads status conflicts and reruns the fence before deleting the same generation", async () => {
    let deletes = 0;
    const request = vi.fn(async (method: string, _path: string, body?: any) => {
      if (method === "GET") return { metadata: { ...original().metadata, resourceVersion: "2" } };
      expect(body.preconditions).toEqual({ uid: "owned", resourceVersion: String(++deletes) });
      if (deletes === 1) throw new KubernetesApiError(409, "operator updated status");
    });
    const fence = vi.fn();
    await deleteKubernetesObject(
      { request } as unknown as KubernetesApi,
      "/resource",
      original(),
      fence,
    );
    expect(deletes).toBe(2);
    expect(fence).toHaveBeenCalledTimes(2);
  });

  it.each(["identity", "generation", "ownership"])(
    "keeps an object after its %s changes",
    async (change) => {
      const next = original();
      next.metadata.resourceVersion = "2";
      if (change === "identity") next.metadata.uid = "replacement";
      if (change === "generation") next.metadata.generation++;
      if (change === "ownership") next.metadata.labels.owner = "theirs";
      const request = vi.fn(async (method: string) => {
        if (method === "GET") return next;
        throw new KubernetesApiError(409, "changed");
      });
      await expect(
        deleteKubernetesObject(
          { request } as unknown as KubernetesApi,
          "/resource",
          original(),
          (current) => {
            if (current.metadata.labels?.owner !== "ours") throw new Error("ownership changed");
          },
        ),
      ).rejects.toThrow(/changed/);
      expect(request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    },
  );

  it.each(["missing", "deleting"])(
    "accepts a concurrent %s result without repeating deletion",
    async (state) => {
      const request = vi.fn(async (method: string) => {
        if (method === "GET") {
          if (state === "missing") throw new KubernetesApiError(404, "gone");
          return {
            metadata: { ...original().metadata, deletionTimestamp: "2026-11-06T00:00:00Z" },
          };
        }
        throw new KubernetesApiError(409, "changed");
      });
      await deleteKubernetesObject(
        { request } as unknown as KubernetesApi,
        "/resource",
        original(),
        () => {},
      );
      expect(request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    },
  );

  it("does not replay an ambiguous deletion or bypass a rejected fence", async () => {
    const request = vi.fn().mockRejectedValue(new Error("connection lost"));
    await expect(
      deleteKubernetesObject(
        { request } as unknown as KubernetesApi,
        "/resource",
        original(),
        () => {},
      ),
    ).rejects.toThrow("connection lost");
    expect(request).toHaveBeenCalledOnce();
    request.mockClear();
    await expect(
      deleteKubernetesObject(
        { request } as unknown as KubernetesApi,
        "/resource",
        original(),
        () => {
          throw new Error("lease lost");
        },
      ),
    ).rejects.toThrow("lease lost");
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds repeated conflicts and honors cancellation", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "GET") return original();
      throw new KubernetesApiError(409, "status keeps changing");
    });
    await expect(
      deleteKubernetesObject(
        { request } as unknown as KubernetesApi,
        "/resource",
        original(),
        () => {},
      ),
    ).rejects.toThrow("status keeps changing");
    expect(request.mock.calls.filter(([method]) => method === "DELETE").length).toBeLessThanOrEqual(
      5,
    );
    const controller = new AbortController();
    controller.abort();
    request.mockClear();
    await expect(
      deleteKubernetesObject(
        { request } as unknown as KubernetesApi,
        "/resource",
        original(),
        () => {},
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });
});
const unavailableAdmission = () => new KubernetesApiError(500,
  'Internal error occurred: failed calling webhook "mutator.example.com": failed to call webhook: Post "https://admission.example.com": dial tcp 10.0.0.1:9502: connect: connection refused');

function admissionFixture(failures = Infinity, replacement = false) {
  let reads = 0;
  let writes = 0;
  const request = vi.fn(async (method: string, _path: string, body?: any) => {
    if (method === "GET") return { metadata: {
      uid: ++reads > 1 && replacement ? "replacement" : "owned", resourceVersion: String(reads),
    } };
    if (++writes <= failures) throw unavailableAdmission();
    return body;
  });
  const validate = vi.fn(() => ({ spec: { replicas: 3 } }));
  const run = (signal?: AbortSignal) =>
    patchKubernetesObject({ request } as unknown as KubernetesApi, "/resource", validate, signal);
  return { request, validate, run };
}

describe("Kubernetes optimistic mutations", () => {
  it("re-reads and revalidates after a controller changes resourceVersion", async () => {
    let version = 1;
    const request = vi.fn(async (method: string, _path: string, body?: any) => {
      if (method === "GET") return { metadata: { uid: "owned", resourceVersion: String(version) } };
      if (version++ === 1) throw new KubernetesApiError(409, "status changed");
      expect(body.metadata).toEqual({ uid: "owned", resourceVersion: "2" });
      return body;
    });
    const validate = vi.fn(() => ({ spec: { replicas: 3 } }));
    await patchKubernetesObject({ request } as unknown as KubernetesApi, "/resource", validate);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not replay an ambiguous request or overwrite a replacement resource", async () => {
    for (const replaced of [false, true]) {
      let reads = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "GET")
          return {
            metadata: { uid: ++reads === 1 ? "original" : "replacement", resourceVersion: "1" },
          };
        throw replaced ? new KubernetesApiError(409, "changed") : new Error("connection lost");
      });
      await expect(
        patchKubernetesObject({ request } as unknown as KubernetesApi, "/resource", () => ({
          spec: {},
        })),
      ).rejects.toThrow(replaced ? /replaced/ : /connection lost/);
      expect(request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
    }
  });

  it("rechecks ownership and resourceVersion while an admission listener starts", async () => {
    vi.useFakeTimers();
    const f = admissionFixture(2);
    const work = f.run();
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(work).resolves.toMatchObject({ metadata: { uid: "owned", resourceVersion: "3" } });
    expect(f.validate).toHaveBeenCalledTimes(3);
    expect(f.request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(3);
  }, 10_000);

  it("bounds a permanently unavailable admission listener", async () => {
    vi.useFakeTimers();
    const f = admissionFixture();
    const result = expect(f.run()).rejects.toThrow("connect: connection refused");
    await vi.advanceTimersByTimeAsync(60_001);
    await result;
    expect(f.validate.mock.calls.length).toBeLessThanOrEqual(31);
  });

  it("cancels an admission wait without another mutation", async () => {
    vi.useFakeTimers();
    const f = admissionFixture();
    const cancel = new AbortController();
    const result = expect(f.run(cancel.signal)).rejects.toMatchObject({ code: "ABORT_ERR" });
    await vi.advanceTimersByTimeAsync(0);
    cancel.abort();
    await result;
    expect(f.validate).toHaveBeenCalledOnce();
  });

  it("does not mutate a replacement resource after admission recovers", async () => {
    vi.useFakeTimers();
    const f = admissionFixture(1, true);
    const result = expect(f.run()).rejects.toThrow("replaced");
    await vi.advanceTimersByTimeAsync(2_000);
    await result;
    expect(f.validate).toHaveBeenCalledOnce();
  });

  it.each([
    new KubernetesApiError(500, "etcd request timed out"),
    new KubernetesApiError(403, "admission denied"),
    new KubernetesApiError(500, 'failed calling webhook "mutator.example.com": admission denied'),
    new Error(unavailableAdmission().message),
  ])("does not replay other API or transport errors: %s", async error => {
    const request = vi.fn(async (method: string) => {
      if (method === "GET") return { metadata: { uid: "owned", resourceVersion: "1" } };
      throw error;
    });
    await expect(patchKubernetesObject({ request } as unknown as KubernetesApi, "/resource", () => ({ spec: {} })))
      .rejects.toBe(error);
    expect(request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
  });
});
