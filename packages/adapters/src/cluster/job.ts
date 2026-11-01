import { createHash } from "node:crypto";
import { AppError } from "@repo/core";
import { clusterObject, waitForClusterResource } from "./database-addons";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";
import { kubernetesPodIssue } from "./kubernetes-health";

function terminalCondition(job: KubernetesObject, type: "Complete" | "Failed") {
  return job.status?.conditions?.find(
    (condition: { type: string; status: string }) =>
      condition.type === type && condition.status === "True",
  );
}

/** Reconcile a bounded native job. Only an explicitly failed job can be replaced;
 * a lost response is inspected on retry, never blindly replayed. */
export async function runClusterJob(
  api: KubernetesApi,
  definition: KubernetesObject,
  options: {
    signal: AbortSignal;
    fence(): Promise<void>;
    retryFailed?: boolean;
    log?(message: string): Promise<void>;
  },
) {
  const { signal, fence } = options;
  const job = structuredClone(definition);
  const signature = createHash("sha256").update(JSON.stringify(definition.spec)).digest("hex");
  job.metadata.annotations = { ...job.metadata.annotations, "openship.io/job-spec": signature };
  const base = `/apis/batch/v1/namespaces/${job.metadata.namespace}/jobs`;
  const path = `${base}/${job.metadata.name}`;
  const assertOwned = (object: KubernetesObject) => {
    if (
      !job.metadata.labels?.["openship.io/runtime"] ||
      Object.entries(job.metadata.labels).some(
        ([key, value]) => object.metadata.labels?.[key] !== value,
      ) ||
      object.metadata.annotations?.["openship.io/job-spec"] !== signature
    )
      throw new AppError(
        "An existing task has different ownership or configuration. It was left unchanged.",
        409,
        "CLUSTER_JOB_CONFLICT",
      );
  };
  let current = await clusterObject(api, path, signal);
  if (current) {
    assertOwned(current);
    if (
      current.metadata.deletionTimestamp ||
      (terminalCondition(current, "Failed") && options.retryFailed)
    ) {
      if (!current.metadata.deletionTimestamp) {
        await fence();
        await api.request(
          "DELETE",
          path,
          { propagationPolicy: "Foreground", preconditions: { uid: current.metadata.uid } },
          signal,
        );
      }
      await waitForClusterResource(
        signal,
        async () => (!(await clusterObject(api, path, signal)) ? true : null),
        "the previous task to stop",
      );
      current = null;
    }
  }
  if (!current) {
    await fence();
    try {
      current = await api.request<KubernetesObject>("POST", base, job, signal);
    } catch (error) {
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409) throw error;
      current = await api.request("GET", path, undefined, signal);
    }
  }
  if (!current) throw new Error("The cluster did not return the saved task.");
  assertOwned(current);
  const uid = current.metadata.uid;
  let lastIssue = "";
  const result = await waitForClusterResource(
    signal,
    async () => {
      const observed = await api.request("GET", path, undefined, signal);
      assertOwned(observed);
      if (observed.metadata.uid !== uid)
        throw new Error("The cluster task was replaced while waiting for its result.");
      const pods = await api.request<{ items: KubernetesObject[] }>(
        "GET",
        `/api/v1/namespaces/${job.metadata.namespace}/pods?labelSelector=${encodeURIComponent(`batch.kubernetes.io/controller-uid=${uid}`)}`,
        undefined,
        signal,
      );
      const issue = pods.items.map(kubernetesPodIssue).filter(Boolean).join("; ");
      if (issue && issue !== lastIssue) {
        lastIssue = issue;
        await options.log?.(issue);
      }
      // Pod counters are cumulative, not a Job result. A replacement can be
      // running after a failed pod, and one success need not complete a Job.
      // Wait for the controller's terminal condition before accepting or retrying.
      const failure = terminalCondition(observed, "Failed");
      if (!terminalCondition(observed, "Complete") && !failure) return null;
      let output = "";
      for (const pod of pods.items) {
        if (!pod.metadata.ownerReferences?.some((owner) => owner.uid === uid)) continue;
        try {
          for await (const line of api.logs(
            `/api/v1/namespaces/${job.metadata.namespace}/pods/${pod.metadata.name}/log?tailLines=80`,
            signal,
          ))
            output = (output + line + "\n").slice(-16000);
        } catch (error) {
          // A pod that never started has no logs. Preserve its scheduling/image
          // failure instead of replacing it with the logs endpoint's HTTP 400.
          if (!(error instanceof KubernetesApiError) || ![400, 404].includes(error.statusCode))
            throw error;
        }
      }
      if (failure)
        throw new Error(
          `The cluster task failed. ${
            [
              [failure.reason, failure.message].filter(Boolean).join(": "),
              output.trim() || issue || lastIssue,
            ]
              .filter(Boolean)
              .join(" · ") || "Inspect the saved task and retry."
          }`,
        );
      return { job: observed, output };
    },
    job.metadata.name ?? "cluster task",
    ((job.spec.activeDeadlineSeconds ?? 600) + 30) * 1000,
  );
  return result;
}
