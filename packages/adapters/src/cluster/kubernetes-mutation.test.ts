import { afterEach, describe, expect, it, vi } from "vitest";
import { KubernetesApiError, type KubernetesApi } from "./kubernetes-api";
import { patchKubernetesObject } from "./kubernetes-mutation";

afterEach(() => vi.useRealTimers());
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
