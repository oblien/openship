import type { KubernetesApi, KubernetesObject } from "./kubernetes-api";
import { createHash } from "node:crypto";
import { kubernetesIdLabel } from "./kubernetes-label";

export const kubernetesProjectNamespace = (id: string) =>
  `os-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
export function projectNamespaceManifest(projectId: string, runtimeId: string): KubernetesObject {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: kubernetesProjectNamespace(projectId),
      labels: {
        "app.kubernetes.io/managed-by": "openship",
        "openship.io/project": kubernetesIdLabel(projectId),
        "openship.io/runtime": runtimeId,
        "pod-security.kubernetes.io/enforce": "baseline",
      },
    },
  };
}

/** Discover custom resources as well as built-ins before any namespace purge. */
export async function listNamespaceResources(
  api: KubernetesApi,
  namespace: string,
  signal: AbortSignal,
): Promise<KubernetesObject[]> {
  const groups = await api.request<{
    groups: Array<{ preferredVersion: { groupVersion: string } }>;
  }>("GET", "/apis", undefined, signal);
  const versions = [
    "/api/v1",
    ...groups.groups
      .filter((group) => !group.preferredVersion.groupVersion.startsWith("metrics.k8s.io/"))
      .map((group) => `/apis/${group.preferredVersion.groupVersion}`),
  ];
  const collections: Array<{ path: string; kind: string }> = [];
  for (const version of versions) {
    const discovery = await api.request<{
      resources: Array<{ name: string; kind: string; namespaced: boolean; verbs: string[] }>;
    }>("GET", version, undefined, signal);
    for (const resource of discovery.resources)
      if (
        resource.namespaced &&
        !resource.name.includes("/") &&
        resource.name !== "events" &&
        resource.verbs.includes("list")
      )
        collections.push({
          path: `${version}/namespaces/${namespace}/${resource.name}`,
          kind: resource.kind,
        });
  }
  const objects: KubernetesObject[] = [];
  for (let index = 0; index < collections.length; index += 4) {
    const lists = await Promise.all(
      collections.slice(index, index + 4).map(async (collection) => {
        const list = await api.request<{ items: KubernetesObject[] }>(
          "GET",
          collection.path,
          undefined,
          signal,
        );
        return list.items.map((object) => ({ ...object, kind: collection.kind }));
      }),
    );
    objects.push(...lists.flat());
  }
  return objects;
}
