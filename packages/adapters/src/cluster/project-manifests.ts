import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";
import { AppError } from "@repo/core";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";
import { kubernetesIdLabel } from "./kubernetes-label";

/**
 * User-supplied Kubernetes manifests for a cluster project (#1039).
 *
 * Every object is confined to the project's own namespace, which already enforces
 * the PodSecurity `baseline` profile and the edge-only NetworkPolicy. On top of that,
 * this admission refuses anything that could outlive or escape the project: cluster
 * scoped kinds, RBAC, node ports, host access, persistent storage (which would block
 * project deletion) and ownerReferences (which could pull foreign objects into
 * cleanup). The allowlist is deliberately small; widening it is a separate decision.
 */
export const PROJECT_MANIFEST_KINDS: Readonly<
  Record<
    string,
    { apiVersion: string; plural: string; order: number; update: "replace" | "create-only" }
  >
> = {
  ConfigMap: { apiVersion: "v1", plural: "configmaps", order: 0, update: "replace" },
  Secret: { apiVersion: "v1", plural: "secrets", order: 0, update: "replace" },
  Service: { apiVersion: "v1", plural: "services", order: 1, update: "replace" },
  Deployment: { apiVersion: "apps/v1", plural: "deployments", order: 2, update: "replace" },
  Job: { apiVersion: "batch/v1", plural: "jobs", order: 2, update: "create-only" },
  CronJob: { apiVersion: "batch/v1", plural: "cronjobs", order: 2, update: "replace" },
};

export const MAX_PROJECT_MANIFEST_BYTES = 1024 * 1024;
export const MAX_PROJECT_MANIFEST_OBJECTS = 64;

/** Marks objects created from manifests, so Openship's own workload objects are never touched. */
export const PROJECT_MANIFEST_LABEL = "openship.io/manifest";
const HASH_ANNOTATION = "openship.io/manifest-hash";
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_1035_LABEL = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

export interface ProjectManifestOwner {
  projectId: string;
  runtimeId: string;
  namespace: string;
}

const invalid = (message: string) => new AppError(message, 400, "CLUSTER_MANIFEST_INVALID");

export function projectManifestLabels(owner: ProjectManifestOwner): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "openship",
    "openship.io/project": kubernetesIdLabel(owner.projectId),
    "openship.io/runtime": owner.runtimeId,
    [PROJECT_MANIFEST_LABEL]: "true",
  };
}

/** Parse multi-document YAML into objects. Empty documents (a trailing `---`) are skipped. */
export function parseProjectManifests(source: string): KubernetesObject[] {
  if (Buffer.byteLength(source) > MAX_PROJECT_MANIFEST_BYTES)
    throw invalid(`Manifests are larger than ${MAX_PROJECT_MANIFEST_BYTES / 1024} KiB.`);
  const objects: KubernetesObject[] = [];
  parseAllDocuments(source).forEach((doc, index) => {
    if (doc.errors.length)
      throw invalid(`Document ${index + 1} could not be parsed: ${doc.errors[0]!.message}`);
    const value = doc.toJSON();
    if (value === null || value === undefined) return;
    if (typeof value !== "object" || Array.isArray(value))
      throw invalid(`Document ${index + 1} is not a Kubernetes object.`);
    objects.push({ metadata: {}, ...value } as KubernetesObject);
  });
  if (objects.length > MAX_PROJECT_MANIFEST_OBJECTS)
    throw invalid(`Manifests contain more than ${MAX_PROJECT_MANIFEST_OBJECTS} objects.`);
  return objects;
}

function podSpecOf(object: KubernetesObject): Record<string, any> | undefined {
  if (object.kind === "CronJob") return object.spec?.jobTemplate?.spec?.template?.spec;
  if (object.kind === "Deployment" || object.kind === "Job") return object.spec?.template?.spec;
  return undefined;
}

function assertPodSpec(spec: Record<string, any> | undefined, where: string) {
  if (!spec || typeof spec !== "object") throw invalid(`${where} has no pod template.`);
  for (const field of ["hostNetwork", "hostPID", "hostIPC"])
    if (spec[field]) throw invalid(`${where} sets ${field}, which is not allowed.`);
  if (spec.nodeName) throw invalid(`${where} pins a node with nodeName, which is not allowed.`);
  const account = spec.serviceAccountName ?? spec.serviceAccount;
  if (account && account !== "default")
    throw invalid(
      `${where} uses service account "${account}". Only the default account is allowed.`,
    );
  for (const volume of spec.volumes ?? []) {
    if (volume?.hostPath) throw invalid(`${where} mounts a hostPath volume, which is not allowed.`);
    if (volume?.persistentVolumeClaim)
      throw invalid(
        `${where} mounts a persistent volume claim. Persistent storage is not supported here.`,
      );
  }
  const containers = [
    ...(spec.initContainers ?? []),
    ...(spec.containers ?? []),
    ...(spec.ephemeralContainers ?? []),
  ];
  if (!(spec.containers ?? []).length) throw invalid(`${where} has no containers.`);
  for (const container of containers) {
    const name = container?.name ?? "container";
    if (container?.securityContext?.privileged)
      throw invalid(`${where} runs ${name} as privileged, which is not allowed.`);
    if ((container?.ports ?? []).some((port: any) => port?.hostPort))
      throw invalid(`${where} binds a hostPort in ${name}, which is not allowed.`);
  }
}

function assertNoReservedKeys(
  map: Record<string, string> | undefined,
  field: string,
  where: string,
) {
  for (const key of Object.keys(map ?? {}))
    if (key.startsWith("openship.io/") || key === "app.kubernetes.io/managed-by")
      throw invalid(`${where} sets the reserved ${field} "${key}".`);
}

function assertMetadata(metadata: Record<string, any> | undefined, where: string) {
  if (metadata?.ownerReferences !== undefined)
    throw invalid(`${where}: ownerReferences are not allowed.`);
  if (metadata?.finalizers !== undefined) throw invalid(`${where}: finalizers are not allowed.`);
  assertNoReservedKeys(metadata?.labels, "label", where);
  assertNoReservedKeys(metadata?.annotations, "annotation", where);
}

function assertSelector(selector: Record<string, any> | undefined, where: string) {
  assertNoReservedKeys(selector?.matchLabels, "selector", where);
  for (const expression of selector?.matchExpressions ?? []) {
    if (typeof expression?.key === "string")
      assertNoReservedKeys({ [expression.key]: "" }, "selector", where);
  }
}

function assertWorkloadMetadata(object: KubernetesObject, where: string) {
  const workload = object.kind === "CronJob" ? object.spec?.jobTemplate : object;
  const templates = [workload?.spec?.template];
  if (object.kind === "CronJob") templates.push(workload);
  for (const template of templates) {
    assertMetadata(template?.metadata, `${where} template`);
    if (template?.metadata?.namespace) throw invalid(`${where}: templates cannot set a namespace.`);
  }
  assertSelector(workload?.spec?.selector, where);
}

/**
 * Validate parsed manifests and return the objects to apply: namespaced into the
 * project, stamped with ownership labels and a content hash, ordered so config and
 * services exist before the workloads that reference them.
 */
export function admitProjectManifests(
  objects: KubernetesObject[],
  owner: ProjectManifestOwner,
): KubernetesObject[] {
  const seen = new Set<string>();
  const admitted = objects.map((source, index) => {
    const kind = source.kind;
    const spec =
      kind && Object.hasOwn(PROJECT_MANIFEST_KINDS, kind)
        ? PROJECT_MANIFEST_KINDS[kind]
        : undefined;
    const where =
      `Document ${index + 1} (${kind ?? "no kind"} ${source.metadata?.name ?? ""})`.replace(
        " )",
        ")",
      );
    if (!spec)
      throw invalid(
        `${where}: kind is not supported. Supported kinds: ${Object.keys(PROJECT_MANIFEST_KINDS).join(", ")}.`,
      );
    if (source.apiVersion !== spec.apiVersion)
      throw invalid(`${where}: ${kind} must use apiVersion ${spec.apiVersion}.`);
    const name = source.metadata?.name;
    const pattern = kind === "Service" ? DNS_1035_LABEL : DNS_LABEL;
    if (typeof name !== "string" || !pattern.test(name))
      throw invalid(`${where}: metadata.name must be a valid lowercase DNS label.`);
    if (source.metadata.namespace && source.metadata.namespace !== owner.namespace)
      throw invalid(`${where}: objects must stay in the project's namespace.`);
    assertMetadata(source.metadata, where);
    const key = `${kind}/${name}`;
    if (seen.has(key)) throw invalid(`${where}: ${key} is defined more than once.`);
    seen.add(key);

    if (kind === "Service") {
      assertNoReservedKeys(source.spec?.selector, "selector", where);
      const type = source.spec?.type ?? "ClusterIP";
      if (type !== "ClusterIP")
        throw invalid(`${where}: only ClusterIP services are allowed, not ${type}.`);
      if (source.spec?.externalIPs?.length) throw invalid(`${where}: externalIPs are not allowed.`);
    }
    if (kind === "Deployment" || kind === "Job" || kind === "CronJob") {
      assertWorkloadMetadata(source, where);
      assertPodSpec(podSpecOf(source), where);
    }

    const object = structuredClone(source);
    delete object.status;
    for (const field of [
      "uid",
      "resourceVersion",
      "creationTimestamp",
      "generation",
      "managedFields",
      "selfLink",
      "deletionTimestamp",
    ])
      delete (object.metadata as Record<string, unknown>)[field];
    object.metadata.namespace = owner.namespace;
    object.metadata.labels = { ...object.metadata.labels, ...projectManifestLabels(owner) };
    const podSpec = podSpecOf(object);
    // The namespace has no RBAC for workloads, so a mounted token only widens exposure.
    if (podSpec) podSpec.automountServiceAccountToken = false;
    const hash = createHash("sha256").update(JSON.stringify(object)).digest("hex");
    object.metadata.annotations = { ...object.metadata.annotations, [HASH_ANNOTATION]: hash };
    return object;
  });
  return admitted.sort(
    (a, b) => PROJECT_MANIFEST_KINDS[a.kind!]!.order - PROJECT_MANIFEST_KINDS[b.kind!]!.order,
  );
}

export function projectManifestCollection(kind: string, namespace: string): string {
  const spec = Object.hasOwn(PROJECT_MANIFEST_KINDS, kind)
    ? PROJECT_MANIFEST_KINDS[kind]
    : undefined;
  if (!spec) throw invalid(`Unsupported manifest kind: ${kind}`);
  const prefix = spec.apiVersion === "v1" ? "/api/v1" : `/apis/${spec.apiVersion}`;
  return `${prefix}/namespaces/${namespace}/${spec.plural}`;
}

const isMissing = (error: unknown) =>
  error instanceof KubernetesApiError && error.statusCode === 404;

function assertManifestOwned(object: KubernetesObject, owner: ProjectManifestOwner) {
  const labels = object.metadata.labels ?? {};
  for (const [key, value] of Object.entries(projectManifestLabels(owner)))
    if (labels[key] !== value)
      throw new AppError(
        `${object.kind} ${object.metadata.name} already exists and is not managed by this project's manifests. It was left unchanged.`,
        409,
        "CLUSTER_MANIFEST_CONFLICT",
      );
}

export interface ApplyProjectManifestsResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  deleted: string[];
}

/**
 * Apply admitted objects, then prune manifest objects of this project that are no
 * longer declared. Only objects carrying this project's manifest labels are ever
 * replaced or deleted; Openship's own app objects and anything foreign stay untouched.
 * Jobs are create-only; other kinds use server-validated replacement. A dry-run
 * validates the complete set before any mutation. This is NOT a cross-resource
 * transaction: concurrent edits/network failures can still interrupt the commit.
 * resourceVersion/UID preconditions reject stale writes, and pruning never runs
 * after a failed create/update. There is no implicit delete-and-recreate fallback.
 */
export async function applyProjectManifests(
  api: KubernetesApi,
  objects: KubernetesObject[],
  owner: ProjectManifestOwner,
  signal?: AbortSignal,
): Promise<ApplyProjectManifestsResult> {
  const result: ApplyProjectManifestsResult = {
    created: [],
    updated: [],
    unchanged: [],
    deleted: [],
  };
  const writes: Array<{
    method: "POST" | "PUT" | "DELETE";
    path: string;
    body: unknown;
    ref: string;
    result: "created" | "updated" | "deleted";
  }> = [];
  const declared = new Set<string>();
  for (const object of objects) {
    const ref = `${object.kind}/${object.metadata.name}`;
    declared.add(ref);
    const collection = projectManifestCollection(object.kind!, owner.namespace);
    const path = `${collection}/${object.metadata.name}`;
    let current: KubernetesObject | undefined;
    try {
      current = await api.request("GET", path, undefined, signal);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!current) {
      writes.push({ method: "POST", path: collection, body: object, ref, result: "created" });
      continue;
    }
    assertManifestOwned(current, owner);
    if (
      current.metadata.annotations?.[HASH_ANNOTATION] ===
      object.metadata.annotations?.[HASH_ANNOTATION]
    ) {
      result.unchanged.push(ref);
      continue;
    }
    if (PROJECT_MANIFEST_KINDS[object.kind!]!.update === "create-only")
      throw new AppError(
        `${ref} cannot be changed after creation. Use a new Job name to run a changed definition. No manifests were changed.`,
        409,
        "CLUSTER_MANIFEST_IMMUTABLE",
      );
    const replacement = structuredClone(object);
    replacement.metadata.uid = current.metadata.uid;
    replacement.metadata.resourceVersion = current.metadata.resourceVersion;
    if (object.kind === "Service") {
      // The API server assigns these once; a replacement must carry them unchanged.
      replacement.spec = { ...replacement.spec };
      for (const field of ["clusterIP", "clusterIPs", "ipFamilies", "ipFamilyPolicy"])
        if (replacement.spec[field] === undefined && current.spec?.[field] !== undefined)
          replacement.spec[field] = current.spec[field];
    }
    writes.push({ method: "PUT", path, body: replacement, ref, result: "updated" });
  }

  const selector = Object.entries(projectManifestLabels(owner))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  for (const kind of Object.keys(PROJECT_MANIFEST_KINDS)) {
    const collection = projectManifestCollection(kind, owner.namespace);
    const list = await api.request<{ items?: KubernetesObject[] }>(
      "GET",
      `${collection}?labelSelector=${encodeURIComponent(selector)}`,
      undefined,
      signal,
    );
    for (const item of list.items ?? []) {
      const ref = `${kind}/${item.metadata.name}`;
      if (declared.has(ref) || item.metadata.deletionTimestamp) continue;
      assertManifestOwned({ ...item, kind }, owner);
      writes.push({
        method: "DELETE",
        path: `${collection}/${item.metadata.name}`,
        body: {
          propagationPolicy: "Foreground",
          preconditions: { uid: item.metadata.uid, resourceVersion: item.metadata.resourceVersion },
        },
        ref,
        result: "deleted",
      });
    }
  }
  // Kubernetes owns schema validation, defaults and immutable-field rules.
  // Preflight EVERY write before committing the first one; a late validation or
  // ownership failure must not leave earlier ConfigMaps/Secrets partly updated.
  for (const write of writes) {
    // DELETE decodes DeleteOptions from the body; its query alone is not enough
    // when a body is present. Without this, a supposed preflight can really delete.
    const body =
      write.method === "DELETE"
        ? { ...(write.body as Record<string, unknown>), dryRun: ["All"] }
        : write.body;
    await api.request(
      write.method,
      `${write.path}?dryRun=All&fieldValidation=Strict`,
      body,
      signal,
    );
  }
  for (const write of writes) {
    try {
      await api.request(write.method, write.path, write.body, signal);
      result[write.result].push(write.ref);
    } catch (error) {
      if (write.method !== "DELETE" || !isMissing(error)) throw error;
    }
  }
  return result;
}
