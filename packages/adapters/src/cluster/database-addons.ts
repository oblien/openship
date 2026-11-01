import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseAllDocuments } from "yaml";
import { AppError } from "@repo/core";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";
import sources from "./database-addons.json";
import { kubernetesPodIssue } from "./kubernetes-health";

const resources: Record<string, [string, boolean]> = {
  Namespace: ["namespaces", false],
  ServiceAccount: ["serviceaccounts", true],
  Service: ["services", true],
  ConfigMap: ["configmaps", true],
  Secret: ["secrets", true],
  PersistentVolumeClaim: ["persistentvolumeclaims", true],
  Deployment: ["deployments", true],
  Job: ["jobs", true],
  DaemonSet: ["daemonsets", true],
  NetworkPolicy: ["networkpolicies", true],
  PriorityClass: ["priorityclasses", false],
  CSIDriver: ["csidrivers", false],
  ClusterRole: ["clusterroles", false],
  ClusterRoleBinding: ["clusterrolebindings", false],
  Role: ["roles", true],
  RoleBinding: ["rolebindings", true],
  CustomResourceDefinition: ["customresourcedefinitions", false],
  MutatingWebhookConfiguration: ["mutatingwebhookconfigurations", false],
  ValidatingWebhookConfiguration: ["validatingwebhookconfigurations", false],
  StorageClass: ["storageclasses", false],
};
export function addonCollection(object: KubernetesObject) {
  const resource = resources[object.kind!];
  if (!resource || !object.metadata.name)
    throw new Error(`Unsupported database add-on resource: ${object.kind}`);
  const prefix = object.apiVersion === "v1" ? "/api/v1" : `/apis/${object.apiVersion}`;
  return `${prefix}${resource[1] ? `/namespaces/${object.metadata.namespace}` : ""}/${resource[0]}`;
}

/** Read-only retries are bounded. Mutations are never replayed on transport errors. */
export async function waitForClusterResource<T>(
  signal: AbortSignal,
  inspect: () => Promise<T | null>,
  description: string,
  timeoutMs = 240_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (true) {
    signal.throwIfAborted();
    const value = await inspect();
    if (value !== null) return value;
    if (Date.now() >= until)
      throw new Error(
        `Timed out waiting for ${description}. Open its status and retry after resolving the reported issue.`,
      );
    await delay(2000, undefined, { signal });
  }
}

export async function clusterObject(
  api: KubernetesApi,
  path: string,
  signal?: AbortSignal,
): Promise<KubernetesObject | null> {
  try {
    return await api.request("GET", path, undefined, signal);
  } catch (error) {
    if (error instanceof KubernetesApiError && error.statusCode === 404) return null;
    throw error;
  }
}

/** Create once, adopt only this runtime's exact reviewed add-on version. */
export async function ensureClusterAddonObject(
  api: KubernetesApi,
  object: KubernetesObject,
  runtimeId: string,
  addon: string,
  signal: AbortSignal,
  fence: () => Promise<void>,
) {
  const path = addonCollection(object);
  const hash = createHash("sha256").update(JSON.stringify(object)).digest("hex");
  object.metadata.labels = {
    ...object.metadata.labels,
    "openship.io/runtime": runtimeId,
    "openship.io/addon": addon,
  };
  object.metadata.annotations = { ...object.metadata.annotations, "openship.io/addon-spec": hash };
  let current = await clusterObject(api, `${path}/${object.metadata.name}`, signal);
  if (!current) {
    await fence();
    try {
      current = await api.request("POST", path, object, signal);
    } catch (error) {
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409) throw error;
      current = await api.request("GET", `${path}/${object.metadata.name}`, undefined, signal);
    }
  }
  if (
    !current ||
    current.metadata.deletionTimestamp ||
    current.metadata.labels?.["openship.io/runtime"] !== runtimeId ||
    current.metadata.annotations?.["openship.io/addon-spec"] !== hash
  )
    throw new AppError(
      `${object.kind} ${object.metadata.name} already exists with different ownership or configuration. It was left unchanged.`,
      409,
      "CLUSTER_ADDON_CONFLICT",
    );
  return current;
}

const manifestCache = new Map<string, KubernetesObject[]>();
export async function downloadClusterAddon(
  name: keyof typeof sources,
  signal: AbortSignal,
): Promise<KubernetesObject[]> {
  signal.throwIfAborted();
  const cached = manifestCache.get(name);
  if (cached) return cached;
  const source = sources[name];
  const response = await fetch(source.url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok || !response.body)
    throw new Error(`Could not download the pinned ${name} add-on (HTTP ${response.status}).`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > source.bytes + 1024) {
      await response.body.cancel().catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "adapters/cluster/database-addons");
      });
      throw new Error(`The ${name} add-on exceeded its reviewed size.`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (createHash("sha256").update(raw).digest("hex") !== source.sha256)
    throw new Error(
      `The ${name} add-on checksum did not match. No resources from this download were applied.`,
    );
  const documents = parseAllDocuments(raw.toString())
    .map((doc) => {
      if (doc.errors.length) throw new Error(`The ${name} manifest could not be parsed.`);
      return doc.toJSON() as KubernetesObject;
    })
    .filter(Boolean);
  manifestCache.set(name, documents);
  return documents;
}

export function prepareDatabaseAddon(
  name: "postgres" | "redis" | "local",
  documents: KubernetesObject[],
  runtimeId: string,
): KubernetesObject[] {
  const result = structuredClone(documents);
  if (name === "local") {
    // A separate class does not change the cluster's default. Retain data even
    // if a PVC is accidentally removed; explicit database deletion owns purge.
    for (const object of result) {
      if (object.kind === "StorageClass") {
        object.metadata.name = "openship-local";
        object.provisioner = "openship.io/local-path";
        object.reclaimPolicy = "Retain";
      }
      if (object.kind === "Deployment") {
        object.spec.template.spec.containers[0].command.push(
          "--provisioner-name",
          "openship.io/local-path",
        );
        object.spec.template.spec.containers[0].resources = {
          requests: { cpu: "50m", memory: "64Mi" },
          limits: { cpu: "250m", memory: "128Mi" },
        };
      }
      if (object.kind === "ConfigMap") {
        object.data["config.json"] = JSON.stringify({
          nodePathMap: [
            {
              node: "DEFAULT_PATH_FOR_NON_LISTED_NODES",
              paths: ["/var/lib/openship/database-volumes"],
            },
          ],
        });
        object.data["helperPod.yaml"] = object.data["helperPod.yaml"].replace(
          "image: busybox",
          "image: busybox:1.37.0",
        );
      }
    }
  }
  if (name === "redis") {
    result.unshift({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "redis-operator", namespace: "ot-operators" },
    });
    for (const object of result) {
      if (object.kind === "ClusterRole" && object.metadata.name === "manager-role")
        object.metadata.name = "redis-operator-manager-role";
      if (object.kind === "Deployment") {
        const container = object.spec.template.spec.containers[0];
        container.image = "quay.io/opstree/redis-operator:v0.26.0";
        container.imagePullPolicy = "IfNotPresent";
        container.env.push(
          { name: "INIT_CONTAINER_IMAGE", value: "quay.io/opstree/redis-operator:v0.26.0" },
          { name: "SERVICE_DNS_DOMAIN", value: "cluster.local" },
        );
        container.args = [
          "--leader-elect",
          "--metrics-bind-address=0",
          "--enable-webhooks=false",
          "--max-concurrent-reconciles=2",
        ];
        container.resources = {
          requests: { cpu: "100m", memory: "128Mi" },
          limits: { cpu: "500m", memory: "512Mi" },
        };
      }
    }
  }
  for (const object of result) {
    if (object.kind === "Deployment")
      object.spec.template.spec.nodeSelector = { "openship.io/runtime": runtimeId };
  }
  // All namespaces and CRDs must exist before their consumers. Keep upstream
  // roles, services and webhooks in their authored order within that constraint.
  const order = (object: KubernetesObject) =>
    object.kind === "Namespace" ? 0 : object.kind === "CustomResourceDefinition" ? 1 : 2;
  return result.sort((a, b) => order(a) - order(b));
}

export async function installDatabaseAddon(
  api: KubernetesApi,
  name: "postgres" | "redis" | "local",
  runtimeId: string,
  signal: AbortSignal,
  fence: () => Promise<void>,
  log: (message: string) => Promise<void>,
) {
  const names: Array<keyof typeof sources> =
    name === "redis"
      ? (Object.keys(sources).filter((key) => key.startsWith("redis-")) as Array<
          keyof typeof sources
        >)
      : [name];
  const manifests: KubernetesObject[] = [];
  for (const key of names) manifests.push(...(await downloadClusterAddon(key, signal)));
  const objects = prepareDatabaseAddon(name, manifests, runtimeId);
  for (const object of objects) {
    await ensureClusterAddonObject(api, object, runtimeId, name, signal, fence);
    if (object.kind === "CustomResourceDefinition")
      await waitForClusterResource(
        signal,
        async () => {
          const current = await api.request(
            "GET",
            `${addonCollection(object)}/${object.metadata.name}`,
            undefined,
            signal,
          );
          return current.status?.conditions?.some(
            (c: any) => c.type === "Established" && c.status === "True",
          )
            ? current
            : null;
        },
        `${object.metadata.name} to become available`,
      );
  }
  for (const object of objects.filter((item) => item.kind === "Deployment")) {
    await log(
      `Waiting for ${name === "local" ? "storage provisioning" : `${name} database management`} to become ready.`,
    );
    let lastIssue = "";
    await waitForClusterResource(
      signal,
      async () => {
        const current = await api.request(
          "GET",
          `${addonCollection(object)}/${object.metadata.name}`,
          undefined,
          signal,
        );
        if (
          current.status?.observedGeneration >= current.metadata.generation! &&
          current.status?.availableReplicas >= 1
        )
          return current;
        const selector = Object.entries(current.spec?.selector?.matchLabels ?? {})
          .map(([key, value]) => `${key}=${value}`)
          .join(",");
        if (selector) {
          const pods = await api.request<{ items: KubernetesObject[] }>(
            "GET",
            `/api/v1/namespaces/${object.metadata.namespace}/pods?labelSelector=${encodeURIComponent(selector)}`,
            undefined,
            signal,
          );
          const issue = pods.items.map(kubernetesPodIssue).filter(Boolean).join("\n");
          if (issue && issue !== lastIssue) {
            lastIssue = issue;
            await log(issue);
          }
        }
        const failed = current.status?.conditions?.find(
          (condition: any) => condition.type === "Progressing" && condition.status === "False",
        );
        if (failed)
          throw new Error(
            `${name} database management could not start: ${failed.message ?? failed.reason}${lastIssue ? `\n${lastIssue}` : ""}`,
          );
        return null;
      },
      `${name} add-on readiness`,
    );
  }
}
