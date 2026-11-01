import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runClusterJob } from "./job";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";

vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

const definition: KubernetesObject = {
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: { name: "check", namespace: "owned", labels: { "openship.io/runtime": "runtime" } },
  spec: { backoffLimit: 2, activeDeadlineSeconds: 300 },
};
const complete = { conditions: [{ type: "Complete", status: "True" }], succeeded: 1 };
const failed = {
  conditions: [
    {
      type: "Failed",
      status: "True",
      reason: "BackoffLimitExceeded",
      message: "Job has reached the specified backoff limit",
    },
  ],
  failed: 3,
};

function fixture(statuses: Record<string, unknown>[], existing?: Record<string, unknown>) {
  const collection = "/apis/batch/v1/namespaces/owned/jobs";
  const path = `${collection}/check`;
  let current: KubernetesObject | null = existing
    ? {
        ...structuredClone(definition),
        metadata: {
          ...definition.metadata,
          uid: "original",
          annotations: {
            "openship.io/job-spec": createHash("sha256")
              .update(JSON.stringify(definition.spec))
              .digest("hex"),
          },
        },
        status: existing,
      }
    : null;
  let firstRead = true;
  let sequence = 0;
  let pods: KubernetesObject[] = [];
  const request = vi.fn(async (method: string, location: string, body?: any) => {
    if (method === "GET" && location.includes("/pods?")) return { items: pods };
    if (method === "POST" && location === collection) {
      if (current) throw new KubernetesApiError(409, "Already exists");
      current = {
        ...structuredClone(body),
        metadata: { ...body.metadata, uid: `new-${sequence++}` },
      };
      return structuredClone(current);
    }
    if (location !== path) throw new Error(`Unexpected request: ${method} ${location}`);
    if (method === "GET") {
      if (current && !firstRead && statuses.length) current.status = statuses.shift();
      firstRead = false;
      if (!current) throw new KubernetesApiError(404, "Missing");
      return structuredClone(current);
    }
    if (method === "DELETE") {
      expect(body).toEqual({
        propagationPolicy: "Foreground",
        preconditions: { uid: current?.metadata.uid },
      });
      current = null;
      return {};
    }
    throw new Error(`Unexpected request: ${method} ${location}`);
  });
  const logs = vi.fn(async function* (_path: string, _signal: AbortSignal) {
    yield "checker output";
  });
  const api = { request, logs } as unknown as KubernetesApi;
  const fence = vi.fn(async () => {});
  const options = { signal: AbortSignal.timeout(5000), fence, log: vi.fn(async () => {}) };
  return {
    api,
    request,
    logs,
    options,
    statuses,
    setPods: (value: KubernetesObject[]) => {
      pods = value;
    },
    current: () => current,
    mutations: () => request.mock.calls.filter(([method]) => method !== "GET"),
  };
}

describe("native cluster Job reconciliation", () => {
  it("waits for a replacement pod instead of treating the failed-pod count as terminal", async () => {
    const context = fixture([
      { failed: 1, active: 1 },
      { ...complete, failed: 1 },
    ]);
    const result = await runClusterJob(context.api, definition, context.options);
    expect(result.job.status.conditions).toEqual(complete.conditions);
    expect(context.statuses).toHaveLength(0);
    expect(context.mutations().map(([method]) => method)).toEqual(["POST"]);
  });

  it("resumes an accepted Job that is still retrying without deleting or replaying it", async () => {
    const context = fixture(
      [
        { failed: 1, active: 1 },
        { ...complete, failed: 1 },
      ],
      { failed: 1, active: 1 },
    );
    const result = await runClusterJob(context.api, definition, {
      ...context.options,
      retryFailed: true,
    });
    expect(result.job.metadata.uid).toBe("original");
    expect(context.mutations()).toEqual([]);
    expect(context.options.fence).not.toHaveBeenCalled();
  });

  it("requires a true terminal condition even when some pods already succeeded", async () => {
    const context = fixture([
      { succeeded: 1, active: 1, conditions: [{ type: "Failed", status: "False" }] },
      { ...complete, succeeded: 2 },
    ]);
    const result = await runClusterJob(context.api, definition, context.options);
    expect(result.job.status.succeeded).toBe(2);
    expect(context.statuses).toHaveLength(0);
  });

  it("reports the terminal failure reason even when the deleted pod has no logs", async () => {
    const context = fixture([failed]);
    await expect(runClusterJob(context.api, definition, context.options)).rejects.toThrow(
      "BackoffLimitExceeded: Job has reached the specified backoff limit",
    );
    expect(context.logs).not.toHaveBeenCalled();
    expect(context.mutations().map(([method]) => method)).toEqual(["POST"]);
  });

  it("fails on the controller's failure result and includes only the owned checker logs", async () => {
    const context = fixture([{ ...failed, succeeded: 1 }]);
    context.setPods([
      {
        metadata: {
          name: "foreign",
          ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: "check", uid: "foreign" }],
        },
      },
      {
        metadata: {
          name: "checker",
          ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: "check", uid: "new-0" }],
        },
      },
    ]);
    await expect(runClusterJob(context.api, definition, context.options)).rejects.toThrow(
      "checker output",
    );
    expect(context.logs).toHaveBeenCalledTimes(1);
    expect(context.logs.mock.calls[0]?.[0]).toBe(
      "/api/v1/namespaces/owned/pods/checker/log?tailLines=80",
    );
  });

  it("replaces a terminal failed Job only on explicit retry, using its UID precondition", async () => {
    const context = fixture([complete], failed);
    const result = await runClusterJob(context.api, definition, {
      ...context.options,
      retryFailed: true,
    });
    expect(result.job.metadata.uid).toBe("new-0");
    expect(context.mutations().map(([method]) => method)).toEqual(["DELETE", "POST"]);
    expect(context.options.fence).toHaveBeenCalledTimes(2);
  });

  it("does not replace a failed Job without explicit retry", async () => {
    const context = fixture([failed], failed);
    await expect(runClusterJob(context.api, definition, context.options)).rejects.toThrow(
      "BackoffLimitExceeded",
    );
    expect(context.mutations()).toEqual([]);
  });

  it("adopts a saved Job after a lost create response without replaying the mutation", async () => {
    const context = fixture([complete]);
    const actual = context.request.getMockImplementation()!;
    context.request.mockImplementation(async (method, path, body) => {
      const result = await actual(method, path, body);
      if (method === "POST") throw new Error("Connection lost after admission");
      return result;
    });
    await expect(runClusterJob(context.api, definition, context.options)).rejects.toThrow(
      "Connection lost",
    );
    context.request.mockImplementation(actual);
    const result = await runClusterJob(context.api, definition, context.options);
    expect(result.job.metadata.uid).toBe("new-0");
    expect(context.mutations().map(([method]) => method)).toEqual(["POST"]);
  });

  it.each(["ownership", "configuration"])(
    "leaves a Job with different %s untouched",
    async (kind) => {
      const context = fixture([], failed);
      const current = context.current()!;
      if (kind === "ownership") current.metadata.labels = { "openship.io/runtime": "foreign" };
      else current.metadata.annotations = { "openship.io/job-spec": "different-spec" };
      await expect(
        runClusterJob(context.api, definition, { ...context.options, retryFailed: true }),
      ).rejects.toThrow("different ownership or configuration");
      expect(context.mutations()).toEqual([]);
    },
  );

  it("rejects a replacement Job while waiting instead of accepting its result", async () => {
    const context = fixture([complete], { active: 1 });
    const actual = context.request.getMockImplementation()!;
    let reads = 0;
    context.request.mockImplementation(async (method, path, body) => {
      const result = await actual(method, path, body);
      if (method === "GET" && path.endsWith("/jobs/check") && ++reads > 1)
        (result as KubernetesObject).metadata.uid = "replacement";
      return result;
    });
    await expect(runClusterJob(context.api, definition, context.options)).rejects.toThrow(
      "replaced while waiting",
    );
    expect(context.mutations()).toEqual([]);
  });
});
