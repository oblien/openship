import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  AppError,
  MANAGED_STORAGE_CLASS,
  validateClusterStorage,
  type ClusterStorageConfig,
  type ClusterStorageObservation,
  type ClusterRuntimeHost,
} from "@repo/core";
import {
  addonCollection,
  clusterObject,
  downloadClusterAddon,
  ensureClusterAddonObject,
  waitForClusterResource,
} from "./database-addons";
import { patchKubernetesObject } from "./kubernetes-mutation";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";
import type { ClusterDatabaseBackupStorage } from "./database-backups";
import { runClusterJob } from "./job";
import { StorageProbe } from "./storage-probe";
import { kubernetesPodIssue } from "./kubernetes-health";

export const LONGHORN_NAMESPACE = "longhorn-system";
export const longhornBase = `/apis/longhorn.io/v1beta2/namespaces/${LONGHORN_NAMESPACE}`;
export const storageDiskName = (serverId: string) =>
  `openship-${createHash("sha256").update(serverId).digest("hex").slice(0, 12)}`;
const GiB = 1024 ** 3;
const conflict = (message: string) => new AppError(message, 409, "CLUSTER_STORAGE_CONFLICT");
export function managedStorageClass(runtimeId: string, replicas: number): KubernetesObject {
  return {
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: {
      name: MANAGED_STORAGE_CLASS,
      labels: { "openship.io/runtime": runtimeId, "openship.io/addon": "longhorn" },
      annotations: { "storageclass.kubernetes.io/is-default-class": "false" },
    },
    provisioner: "driver.longhorn.io",
    reclaimPolicy: "Retain",
    allowVolumeExpansion: true,
    volumeBindingMode: "Immediate",
    parameters: {
      numberOfReplicas: String(replicas),
      fsType: "ext4",
      diskSelector: "openship",
      dataLocality: "disabled",
      dataEngine: "v1",
      replicaSoftAntiAffinity: "disabled",
      replicaDiskSoftAntiAffinity: "disabled",
    },
  };
}
export function prepareStorageAddon(
  documents: KubernetesObject[],
  runtimeId: string,
  config: ClusterStorageConfig,
) {
  validateClusterStorage(config);
  // File management stays in OpenShip. The bundled infrastructure dashboard is
  // unnecessary and must not add another exposed management surface.
  const result = structuredClone(documents).filter(
    (object) =>
      !(
        (object.kind === "Deployment" && object.metadata.name === "longhorn-ui") ||
        (object.kind === "Service" && object.metadata.name === "longhorn-frontend")
      ),
  );
  for (const object of result) {
    if (object.kind === "Namespace")
      object.metadata.labels = {
        ...object.metadata.labels,
        "pod-security.kubernetes.io/enforce": "privileged",
      };
    if (object.kind === "ConfigMap" && object.metadata.name === "longhorn-default-setting") {
      const defaults = parse(object.data["default-setting.yaml"]) ?? {};
      object.data["default-setting.yaml"] = stringify({
        ...defaults,
        "create-default-disk-labeled-nodes": "true",
        "default-replica-count": String(config.replicas),
        "replica-soft-anti-affinity": "false",
        "storage-over-provisioning-percentage": "100",
        "storage-minimal-available-percentage": "25",
        "system-managed-components-node-selector": `openship.io/runtime:${runtimeId}`,
        "guaranteed-instance-manager-cpu": "5",
        "node-down-pod-deletion-policy": "do-nothing",
        "upgrade-checker": "false",
      });
    }
    if (object.kind === "ConfigMap" && object.metadata.name === "longhorn-storageclass") {
      const storage = parse(object.data["storageclass.yaml"]);
      storage.metadata.annotations["storageclass.kubernetes.io/is-default-class"] = "false";
      storage.metadata.labels = {
        "openship.io/runtime": runtimeId,
        "openship.io/addon": "longhorn",
      };
      storage.reclaimPolicy = "Retain";
      object.data["storageclass.yaml"] = stringify(storage);
    }
    if (object.kind === "DaemonSet" || object.kind === "Deployment") {
      object.spec.template.spec.nodeSelector = {
        ...object.spec.template.spec.nodeSelector,
        "openship.io/runtime": runtimeId,
      };
    }
  }
  const order = (o: KubernetesObject) =>
    o.kind === "Namespace" ? 0 : o.kind === "CustomResourceDefinition" ? 1 : 2;
  return result.sort((a, b) => order(a) - order(b));
}

export class ClusterStorageAdapter {
  constructor(
    readonly api: KubernetesApi,
    readonly runtimeId: string,
    readonly config: ClusterStorageConfig,
    readonly hosts: Pick<ClusterRuntimeHost, "serverId" | "name" | "nodeName">[],
    readonly signal: AbortSignal,
    private readonly fence: () => Promise<void>,
  ) {}
  private ensure(object: KubernetesObject) {
    return ensureClusterAddonObject(
      this.api,
      object,
      this.runtimeId,
      "longhorn",
      this.signal,
      this.fence,
    );
  }
  async assertOwned(allowDeleting = false) {
    const namespace = await clusterObject(
      this.api,
      `/api/v1/namespaces/${LONGHORN_NAMESPACE}`,
      this.signal,
    );
    if (
      !namespace ||
      namespace.metadata.labels?.["openship.io/runtime"] !== this.runtimeId ||
      (!allowDeleting && namespace.metadata.deletionTimestamp)
    )
      throw conflict("The managed storage installation is unavailable or has different ownership.");
  }
  async install(log: (message: string) => Promise<void>) {
    const objects = prepareStorageAddon(
      await downloadClusterAddon("longhorn", this.signal),
      this.runtimeId,
      this.config,
    );
    for (const object of objects) {
      await this.ensure(object);
      if (object.kind === "CustomResourceDefinition")
        await waitForClusterResource(
          this.signal,
          async () => {
            const current = await this.api.request(
              "GET",
              `${addonCollection(object)}/${object.metadata.name}`,
              undefined,
              this.signal,
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
    await log("Waiting for storage management and volume drivers on the cluster servers.");
    let lastIssue = "";
    await waitForClusterResource(
      this.signal,
      async () => {
        const manager = await this.api.request(
          "GET",
          `/apis/apps/v1/namespaces/${LONGHORN_NAMESPACE}/daemonsets/longhorn-manager`,
          undefined,
          this.signal,
        );
        const pods = await this.api.request<{ items: KubernetesObject[] }>(
          "GET",
          `/api/v1/namespaces/${LONGHORN_NAMESPACE}/pods`,
          undefined,
          this.signal,
        );
        const issue = pods.items.map(kubernetesPodIssue).filter(Boolean).join("; ");
        if (issue && issue !== lastIssue) {
          lastIssue = issue;
          await log(issue);
        }
        return manager.status?.numberReady >= this.hosts.length ? manager : null;
      },
      "storage management on every cluster server",
      600_000,
    );
    await this.ensure(managedStorageClass(this.runtimeId, this.config.replicas));
  }
  async disks(log: (message: string) => Promise<void>) {
    await this.assertOwned();
    for (const disk of this.config.disks) {
      const host = this.hosts.find((h) => h.serverId === disk.serverId);
      if (!host) throw conflict("A selected storage server is no longer in the cluster.");
      const path = `${longhornBase}/nodes/${host.nodeName}`;
      await waitForClusterResource(
        this.signal,
        () => clusterObject(this.api, path, this.signal),
        `${host.name}'s storage agent`,
      );
      await patchKubernetesObject(
        this.api,
        path,
        async (current) => {
          await this.fence();
          const name = storageDiskName(disk.serverId);
          const existing = current.spec.disks?.[name];
          if (existing && existing.path !== disk.path)
            throw conflict(
              `${host.name}'s storage path changed. Its existing data was left untouched.`,
            );
          return {
            spec: {
              allowScheduling: true,
              disks: {
                [name]: {
                  path: disk.path,
                  diskType: "filesystem",
                  allowScheduling: true,
                  evictionRequested: false,
                  storageReserved: disk.reservedGiB * GiB,
                  tags: ["openship"],
                },
              },
            },
          };
        },
        this.signal,
      );
      await log(`${host.name}: using ${disk.path}; ${disk.reservedGiB} GiB reserved for the host.`);
    }
  }
  async backupDestination(storage: ClusterDatabaseBackupStorage) {
    await this.assertOwned();
    const parsed = new URL(storage.destinationPath);
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "openship-backup-destination", namespace: LONGHORN_NAMESPACE },
      type: "Opaque",
      data: Object.fromEntries(
        Object.entries({
          AWS_ACCESS_KEY_ID: storage.accessKeyId,
          AWS_SECRET_ACCESS_KEY: storage.secretAccessKey,
          AWS_ENDPOINTS: storage.endpoint ?? "",
          AWS_CERT: "",
          VIRTUAL_HOSTED_STYLE: "false",
        }).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
      ),
    };
    const secretPath = `/api/v1/namespaces/${LONGHORN_NAMESPACE}/secrets/${secret.metadata.name}`;
    if (!(await clusterObject(this.api, secretPath, this.signal))) await this.ensure(secret);
    else
      await patchKubernetesObject(
        this.api,
        secretPath,
        async (current) => {
          if (
            current.metadata.labels?.["openship.io/runtime"] !== this.runtimeId ||
            current.metadata.labels?.["openship.io/addon"] !== "longhorn"
          )
            throw conflict("The storage backup credentials have different ownership.");
          await this.fence();
          return { data: secret.data };
        },
        this.signal,
      );
    const path = `${longhornBase}/backuptargets/default`;
    await waitForClusterResource(
      this.signal,
      () => clusterObject(this.api, path, this.signal),
      "the storage backup target",
    );
    await patchKubernetesObject(
      this.api,
      path,
      async (current) => {
        const owner = current.metadata.labels?.["openship.io/runtime"];
        if (
          (owner && owner !== this.runtimeId) ||
          (!owner && (current.spec.backupTargetURL || current.spec.credentialSecret))
        )
          throw conflict(
            "A different backup destination is already configured. It was left unchanged.",
          );
        await this.fence();
        return {
          metadata: { labels: { "openship.io/runtime": this.runtimeId } },
          spec: {
            backupTargetURL: `s3://${parsed.hostname}@${storage.region}${parsed.pathname}/volumes/${this.runtimeId}`,
            credentialSecret: secret.metadata.name,
            pollInterval: "5m0s",
          },
        };
      },
      this.signal,
    );
  }
  async observe(): Promise<ClusterStorageObservation> {
    await this.assertOwned();
    const nodes = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `${longhornBase}/nodes`,
      undefined,
      this.signal,
    );
    const volumes = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `${longhornBase}/volumes`,
      undefined,
      this.signal,
    );
    const observed = this.config.disks.map((disk) => {
      const host = this.hosts.find((h) => h.serverId === disk.serverId)!;
      const node = nodes.items.find((n) => n.metadata.name === host.nodeName);
      const status = node?.status?.diskStatus?.[storageDiskName(disk.serverId)];
      const conditions = [...(node?.status?.conditions ?? []), ...(status?.conditions ?? [])];
      const ready =
        !!status &&
        conditions
          .filter((c) => ["Ready", "Schedulable"].includes(c.type))
          .every((c) => c.status === "True") &&
        conditions.some((c) => c.type === "Ready" && c.status === "True");
      return {
        serverId: disk.serverId,
        name: host.name,
        ready,
        availableGiB: (status?.storageAvailable ?? 0) / GiB,
        scheduledGiB: (status?.storageScheduled ?? 0) / GiB,
        message:
          conditions
            .filter((c) => c.status !== "True")
            .map((c) => c.message || c.reason)
            .filter(Boolean)
            .join(" · ") || (ready ? "Storage ready" : "Waiting for the storage disk"),
      };
    });
    return {
      observedAt: new Date().toISOString(),
      ready: observed.length >= this.config.replicas && observed.every((n) => n.ready),
      nodes: observed,
      volumes: volumes.items.map((v) => ({
        name: v.metadata.name!,
        state: v.status?.state ?? "unknown",
        robustness: v.status?.robustness ?? "unknown",
        sizeGiB: Number(v.spec.size) / GiB,
        replicas: v.spec.numberOfReplicas,
      })),
    };
  }
  async verify(log: (message: string) => Promise<void>) {
    let lastMessage = "";
    await waitForClusterResource(
      this.signal,
      async () => {
        const current = await this.observe();
        const message = current.nodes
          .filter((n) => !n.ready)
          .map((n) => `${n.name}: ${n.message}`)
          .join("; ");
        if (message && message !== lastMessage) {
          await log(message);
          lastMessage = message;
        }
        return current.ready ? current : null;
      },
      "the selected storage disks",
      600_000,
    );
    await waitForClusterResource(
      this.signal,
      async () => {
        const driver = await clusterObject(
          this.api,
          `/apis/apps/v1/namespaces/${LONGHORN_NAMESPACE}/daemonsets/longhorn-csi-plugin`,
          this.signal,
        );
        return driver && driver.status?.numberReady >= this.hosts.length ? driver : null;
      },
      "persistent and shared volume attachment on every server",
      600_000,
    );
    await new StorageProbe(this.api, this.runtimeId, this.signal, this.fence).run(
      managedStorageClass(this.runtimeId, this.config.replicas),
      this.hosts,
      log,
    );
    return this.observe();
  }
  async remove(log: (message: string) => Promise<void>) {
    const namespace = await clusterObject(
      this.api,
      `/api/v1/namespaces/${LONGHORN_NAMESPACE}`,
      this.signal,
    );
    if (namespace) await this.assertOwned(true);
    await new StorageProbe(this.api, this.runtimeId, this.signal, this.fence).cleanup();
    const volumes = await clusterObject(this.api, `${longhornBase}/volumes`, this.signal);
    const claims = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      "/api/v1/persistentvolumes",
      undefined,
      this.signal,
    );
    const pending = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      "/api/v1/persistentvolumeclaims",
      undefined,
      this.signal,
    );
    if (
      volumes?.items?.length ||
      claims.items.some((v) => v.spec?.csi?.driver === "driver.longhorn.io") ||
      pending.items.some(
        (c) =>
          c.spec.storageClassName === MANAGED_STORAGE_CLASS ||
          c.spec.storageClassName?.startsWith("openship-restore-"),
      )
    )
      throw conflict(
        "Persistent or retained volumes still use this storage. Move or explicitly delete their data before removing storage.",
      );
    await log(
      "Removing the empty storage installation. External backup archives remain in their destination.",
    );
    const uninstall = structuredClone(
      await downloadClusterAddon("longhorn-uninstall", this.signal),
    );
    if (namespace && !namespace.metadata.deletionTimestamp && volumes) {
      const confirmation = `${longhornBase}/settings/deleting-confirmation-flag`;
      let setting = await clusterObject(this.api, confirmation, this.signal);
      if (!setting) {
        // Longhorn reads its default (false) when this Setting is absent. A
        // missing record must be created before starting the native uninstaller.
        await this.fence();
        try {
          setting = await this.api.request<KubernetesObject>(
            "POST",
            `${longhornBase}/settings`,
            {
              apiVersion: "longhorn.io/v1beta2",
              kind: "Setting",
              metadata: {
                name: "deleting-confirmation-flag",
                namespace: LONGHORN_NAMESPACE,
              },
              value: "true",
            },
            this.signal,
          );
        } catch (error) {
          // The manager may have created the default concurrently. Re-read and
          // patch that record; ambiguous transport failures are not replayed.
          if (!(error instanceof KubernetesApiError) || error.statusCode !== 409) throw error;
        }
      }
      if (setting?.value !== "true")
        setting = await patchKubernetesObject(
          this.api,
          confirmation,
          async () => {
            await this.fence();
            return { value: "true" };
          },
          this.signal,
        );
      if (setting.value !== "true")
        throw conflict(
          "Longhorn did not confirm storage removal. The installation was left in place.",
        );
      // The pinned native uninstaller removes controllers/finalizers in order.
      for (const object of uninstall) {
        if (object.kind !== "Job") await this.ensure(object);
        else {
          object.metadata.labels = {
            ...object.metadata.labels,
            "openship.io/runtime": this.runtimeId,
          };
          // Keep the pinned job's bounded retry. Its settings informer can still
          // be cold when other caches have synced, reporting the default false
          // even after confirmation was saved. Disabling native retry turns that
          // startup race into a failed removal. Cleanup still waits for the Job's
          // terminal success through runClusterJob.
          object.spec.template.spec.nodeSelector = { "openship.io/runtime": this.runtimeId };
          await runClusterJob(this.api, object, {
            signal: this.signal,
            fence: this.fence,
            retryFailed: true,
            log,
          });
        }
      }
    }
    // Finish cluster-scoped leftovers after an interrupted or partial uninstall.
    const install = prepareStorageAddon(
      await downloadClusterAddon("longhorn", this.signal),
      this.runtimeId,
      this.config,
    );
    const classes = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `/apis/storage.k8s.io/v1/storageclasses?labelSelector=${encodeURIComponent(`openship.io/runtime=${this.runtimeId},openship.io/addon=longhorn`)}`,
      undefined,
      this.signal,
    );
    const ownedClasses = classes.items
      .filter(
        (object) =>
          object.provisioner === "driver.longhorn.io" &&
          object.metadata.labels?.["openship.io/addon"] === "longhorn",
      )
      // List entries can omit their type. This endpoint identifies them as
      // StorageClasses, so restore that identity before resolving cleanup URLs.
      .map((object) => ({ ...object, apiVersion: "storage.k8s.io/v1", kind: "StorageClass" }));
    for (const object of [...install, ...uninstall, ...ownedClasses].filter(
      (o) => !o.metadata.namespace && o.kind !== "Namespace",
    )) {
      const path = `${addonCollection(object)}/${object.metadata.name}`;
      const current = await clusterObject(this.api, path, this.signal);
      if (!current) continue;
      if (current.metadata.labels?.["openship.io/runtime"] !== this.runtimeId)
        throw conflict(
          `Storage cleanup found ${object.metadata.name} with different ownership. It was left unchanged.`,
        );
      await this.fence();
      await this.api.request(
        "DELETE",
        path,
        { preconditions: { uid: current.metadata.uid } },
        this.signal,
      );
    }
    const current = await clusterObject(
      this.api,
      `/api/v1/namespaces/${LONGHORN_NAMESPACE}`,
      this.signal,
    );
    if (current) {
      if (current.metadata.labels?.["openship.io/runtime"] !== this.runtimeId)
        throw conflict("The storage namespace changed ownership before cleanup.");
      await this.fence();
      if (!current.metadata.deletionTimestamp)
        await this.api.request(
          "DELETE",
          `/api/v1/namespaces/${LONGHORN_NAMESPACE}`,
          { preconditions: { uid: current.metadata.uid } },
          this.signal,
        );
      await waitForClusterResource(
        this.signal,
        async () =>
          !(await clusterObject(this.api, `/api/v1/namespaces/${LONGHORN_NAMESPACE}`, this.signal))
            ? true
            : null,
        "storage removal",
        240_000,
      );
    }
  }
}
