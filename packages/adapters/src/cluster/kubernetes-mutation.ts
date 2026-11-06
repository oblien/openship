import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "@repo/core";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";

/** Retry only explicit delete conflicts caused by operator status updates.
 * Keep the original identity and spec generation; callers recheck ownership and
 * their operation fence before every attempt. Ambiguous failures are not replayed. */
export async function deleteKubernetesObject(
  api: KubernetesApi,
  path: string,
  expected: KubernetesObject,
  beforeDelete: (current: KubernetesObject) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const { uid, generation } = expected.metadata;
  let current = expected;
  for (let conflicts = 0; ; conflicts++) {
    signal?.throwIfAborted();
    if (
      !uid ||
      !current.metadata.resourceVersion ||
      current.metadata.uid !== uid ||
      current.metadata.generation !== generation
    )
      throw new AppError(
        "The Kubernetes resource changed while removing it. It was left unchanged.",
        409,
        "CLUSTER_RESOURCE_CHANGED",
      );
    await beforeDelete(current);
    if (current.metadata.deletionTimestamp) return;
    try {
      await api.request(
        "DELETE",
        path,
        {
          propagationPolicy: "Foreground",
          preconditions: { uid, resourceVersion: current.metadata.resourceVersion },
        },
        signal,
      );
      return;
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return;
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409 || conflicts >= 4)
        throw error;
    }
    await delay(25 * (conflicts + 1), undefined, { signal });
    try {
      current = await api.request("GET", path, undefined, signal);
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return;
      throw error;
    }
  }
}

/** Re-read after an explicit resource-version conflict or refused admission connection. Never replay a mutation
 * after an ambiguous transport failure, or touch a replacement object. Callers
 * check ownership and their operation fence on every attempt. */
export async function patchKubernetesObject(
  api: KubernetesApi,
  path: string,
  update: (current: KubernetesObject) => Record<string, unknown> | Promise<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<KubernetesObject> {
  let uid: string | undefined;
  let conflicts = 0;
  let admissionDeadline: number | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const current = await api.request("GET", path, undefined, signal);
    if (
      !current.metadata.uid ||
      !current.metadata.resourceVersion ||
      current.metadata.deletionTimestamp
    )
      throw new AppError(
        "The Kubernetes resource is unavailable or being deleted.",
        409,
        "CLUSTER_RESOURCE_CHANGED",
      );
    if (uid && current.metadata.uid !== uid)
      throw new AppError(
        "The Kubernetes resource was replaced while applying the change.",
        409,
        "CLUSTER_RESOURCE_CHANGED",
      );
    uid = current.metadata.uid;
    const patch = await update(current);
    try {
      return await api.request(
        "PATCH",
        path,
        {
          ...patch,
          metadata: {
            ...(patch.metadata as Record<string, unknown> | undefined),
            uid,
            resourceVersion: current.metadata.resourceVersion,
          },
        },
        signal,
      );
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 409 && conflicts++ < 4) {
        await delay(25 * conflicts, undefined, { signal });
        continue;
      }
      // Kubernetes explicitly rejected this request before admission: the
      // webhook connection was refused, so the resource was not mutated.
      // Manager readiness can precede its admission listener during startup.
      // Re-read UID/resourceVersion and re-run the caller's fence on retry.
      // Other 5xx responses and ambiguous transport failures remain fatal.
      if (error instanceof KubernetesApiError && error.statusCode === 500 &&
          /failed calling webhook "[^"]+": failed to call webhook:/.test(error.message) &&
          /connect: connection refused/.test(error.message)) {
        admissionDeadline ??= Date.now() + 60_000;
        if (Date.now() < admissionDeadline) {
          await delay(2_000, undefined, { signal });
          continue;
        }
      }
      throw error;
    }
  }
}
