import { createHash } from "node:crypto";
import {
  AppError,
  MANAGED_STORAGE_CLASS,
  type ClusterVolume,
  type ClusterRuntimeHost,
  type ClusterVolumeBackupSchedule,
  type ClusterVolumeBackup,
} from "@repo/core";
import { clusterObject, waitForClusterResource } from "./database-addons";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";
import { patchKubernetesObject } from "./kubernetes-mutation";
import { kubernetesProjectNamespace, projectNamespaceManifest } from "./namespace";
import { kubernetesIdLabel } from "./kubernetes-label";
import { longhornBase, LONGHORN_NAMESPACE } from "./storage";
import { VolumeBackups } from "./volume-backups";

const GiB = 1024 ** 3;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const clusterVolumeClaim = (name: string) => `shared-${name}`;
export const clusterVolumeMountName = (name: string) => `volume-${hash(name).slice(0, 16)}`;
const conflict = (message: string) => new AppError(message, 409, "CLUSTER_VOLUME_CONFLICT");
const defaultSchedule: ClusterVolumeBackupSchedule = { frequency: "manual", retain: 7 };
interface VolumeDeletion {
  name: string;
  claimName: string;
  claimUid: string;
  sizeGiB: number;
  pvName?: string;
  pvUid?: string;
  volumeName?: string;
  volumeUid?: string;
  storageClassName: string;
}
export class ClusterVolumeAdapter {
  readonly namespace: string;
  private readonly labels: Record<string, string>;
  readonly archive: VolumeBackups;
  constructor(
    readonly api: KubernetesApi,
    readonly projectId: string,
    readonly runtimeId: string,
    readonly signal: AbortSignal,
    private readonly fence: () => Promise<void>,
    private readonly hosts: Pick<ClusterRuntimeHost, "nodeName" | "name">[] = [],
  ) {
    this.namespace = kubernetesProjectNamespace(projectId);
    this.labels = {
      "app.kubernetes.io/managed-by": "openship",
      "openship.io/project": kubernetesIdLabel(projectId),
      "openship.io/runtime": runtimeId,
    };
    this.archive = new VolumeBackups(api, this.labels, signal, fence);
  }
  private get claims() {
    return `/api/v1/namespaces/${this.namespace}/persistentvolumeclaims`;
  }
  private get records() {
    return `/api/v1/namespaces/${this.namespace}/configmaps`;
  }
  private deletionPath(name: string) {
    return `${this.records}/delete-volume-${hash(name).slice(0, 24)}`;
  }
  private owned(object: KubernetesObject, name?: string) {
    if (
      Object.entries(this.labels).some(([key, value]) => object.metadata.labels?.[key] !== value) ||
      (name && object.metadata.labels?.["openship.io/volume"] !== name)
    )
      throw conflict(
        "This volume belongs to a different project or cluster. It was left unchanged.",
      );
  }
  async claim(name: string) {
    const claim = await this.api.request(
      "GET",
      `${this.claims}/${clusterVolumeClaim(name)}`,
      undefined,
      this.signal,
    );
    this.owned(claim, name);
    return claim;
  }
  private async namespaceReady() {
    const path = `/api/v1/namespaces/${this.namespace}`;
    let ns = await clusterObject(this.api, path, this.signal);
    if (!ns) {
      await this.fence();
      try {
        ns = await this.api.request(
          "POST",
          "/api/v1/namespaces",
          projectNamespaceManifest(this.projectId, this.runtimeId),
          this.signal,
        );
      } catch (error) {
        if (!(error instanceof KubernetesApiError) || error.statusCode !== 409) throw error;
        ns = await this.api.request("GET", path, undefined, this.signal);
      }
    }
    if (!ns)
      throw conflict(
        "The project storage namespace could not be created. Refresh its status before retrying.",
      );
    this.owned(ns);
    if (ns.metadata.deletionTimestamp) throw conflict("The project namespace is being removed.");
  }
  private async createOnce(path: string, object: KubernetesObject) {
    let current = await clusterObject(this.api, `${path}/${object.metadata.name}`, this.signal);
    if (!current) {
      await this.fence();
      try {
        current = await this.api.request("POST", path, object, this.signal);
      } catch (error) {
        if (!(error instanceof KubernetesApiError) || error.statusCode !== 409) throw error;
        current = await this.api.request(
          "GET",
          `${path}/${object.metadata.name}`,
          undefined,
          this.signal,
        );
      }
    }
    if (!current)
      throw conflict(
        "The storage request has no saved result. Refresh its status before retrying.",
      );
    this.owned(current);
    if (
      current.metadata.deletionTimestamp ||
      current.metadata.annotations?.["openship.io/request"] !==
        object.metadata.annotations?.["openship.io/request"]
    )
      throw conflict(
        "This volume operation already exists with a different request. Refresh its status before continuing.",
      );
    if (
      object.kind === "PersistentVolumeClaim" &&
      (current.spec.storageClassName !== object.spec.storageClassName ||
        current.spec.volumeMode !== object.spec.volumeMode ||
        JSON.stringify(current.spec.accessModes) !== JSON.stringify(object.spec.accessModes) ||
        current.spec.resources?.requests?.storage !== object.spec.resources.requests.storage)
    )
      throw conflict(
        "The saved volume no longer matches this creation request. Refresh its status before continuing.",
      );
    if (
      object.kind === "StorageClass" &&
      (current.provisioner !== object.provisioner ||
        Object.entries(object.parameters ?? {}).some(
          ([key, value]) => current.parameters?.[key] !== value,
        ))
    )
      throw conflict("The saved recovery settings changed. Refresh the volume before continuing.");
    return current;
  }
  private async longhornVolume(claim: KubernetesObject) {
    if (!claim.spec.volumeName) return null;
    const pv = await clusterObject(
      this.api,
      `/api/v1/persistentvolumes/${claim.spec.volumeName}`,
      this.signal,
    );
    if (!pv && claim.metadata.deletionTimestamp) return null;
    if (!pv)
      throw conflict(
        "The backing volume is unavailable. Refresh its status before changing stored files.",
      );
    if (
      pv.spec.claimRef?.uid !== claim.metadata.uid ||
      pv.spec.claimRef?.namespace !== this.namespace ||
      pv.spec.csi?.driver !== "driver.longhorn.io"
    )
      throw conflict("The volume's backing disk no longer matches its saved claim.");
    const volume = await clusterObject(
      this.api,
      `${longhornBase}/volumes/${pv.spec.csi.volumeHandle}`,
      this.signal,
    );
    if (!volume && claim.metadata.deletionTimestamp) return null;
    if (!volume)
      throw conflict(
        "The backing disk is unavailable. Inspect storage health before changing stored files.",
      );
    return { pv, volume };
  }
  async present(
    claim: KubernetesObject,
    savedBackups?: ClusterVolumeBackup[],
  ): Promise<ClusterVolume> {
    this.owned(claim);
    const backing = await this.longhornVolume(claim);
    const backups = savedBackups ?? (await this.archive.list());
    const replicas = backing
      ? await this.api.request<{ items: KubernetesObject[] }>(
          "GET",
          `${longhornBase}/replicas?labelSelector=${encodeURIComponent(`longhornvolume=${backing.volume.metadata.name}`)}`,
          undefined,
          this.signal,
        )
      : { items: [] };
    const engines = backing
      ? await this.api.request<{ items: KubernetesObject[] }>(
          "GET",
          `${longhornBase}/engines?labelSelector=${encodeURIComponent(`longhornvolume=${backing.volume.metadata.name}`)}`,
          undefined,
          this.signal,
        )
      : { items: [] };
    const copies: ClusterVolume["copies"] = replicas.items.map((replica) => {
      const engine = engines.items.find(
        (engine) => engine.status?.currentReplicaAddressMap?.[replica.metadata.name!],
      );
      const address = engine?.status?.currentReplicaAddressMap?.[replica.metadata.name!];
      const mode =
        engine?.status?.replicaModeMap?.[replica.metadata.name!] ??
        (address && engine?.status?.replicaModeMap?.[address]);
      const rebuild = address && engine?.status?.rebuildStatus?.[address];
      return {
        name: replica.metadata.name!,
        serverName:
          this.hosts.find((host) => host.nodeName === replica.spec.nodeID)?.name ??
          replica.spec.nodeID ??
          "Assigning a server",
        state:
          mode === "ERR" || replica.spec.failedAt
            ? "failed"
            : mode === "WO" || rebuild?.isRebuilding
              ? "rebuilding"
              : mode === "RW" ||
                  (backing?.volume.status?.state === "detached" && replica.spec.healthyAt)
                ? "ready"
                : "pending",
        progress: typeof rebuild?.progress === "number" ? rebuild.progress : null,
      };
    });
    const message =
      [...(claim.status?.conditions ?? []), ...(backing?.volume.status?.conditions ?? [])]
        .filter(
          (condition) =>
            (condition.type === "Scheduled" && condition.status === "False") ||
            condition.type === "Resizing" ||
            condition.type === "FileSystemResizePending" ||
            (condition.status === "False" && condition.message),
        )
        .map((condition) => condition.message || condition.reason)
        .filter(Boolean)
        .join("; ") || null;
    return {
      name: claim.metadata.labels!["openship.io/volume"],
      resourceVersion: claim.metadata.resourceVersion!,
      sizeGiB: parseInt(claim.spec.resources.requests.storage, 10),
      phase: claim.metadata.deletionTimestamp ? "Deleting" : (claim.status?.phase ?? "Pending"),
      state: backing?.volume.status?.state ?? "provisioning",
      robustness: backing?.volume.status?.robustness ?? "unknown",
      volumeName: backing?.volume.metadata.name ?? null,
      message,
      copies,
      desiredCopies: backing?.volume.spec.numberOfReplicas ?? 0,
      backupSchedule: JSON.parse(
        claim.metadata.annotations?.["openship.io/backup-schedule"] ??
          JSON.stringify(defaultSchedule),
      ),
      backups: backups.filter((b) => b.volumeName === claim.metadata.labels!["openship.io/volume"]),
    };
  }
  async list(savedBackups?: ClusterVolumeBackup[]) {
    const namespace = await clusterObject(
      this.api,
      `/api/v1/namespaces/${this.namespace}`,
      this.signal,
    );
    if (!namespace) return [];
    this.owned(namespace);
    const result = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `${this.claims}?labelSelector=${encodeURIComponent(`openship.io/project=${this.labels["openship.io/project"]},openship.io/volume`)}`,
      undefined,
      this.signal,
    );
    const records = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `${this.records}?labelSelector=${encodeURIComponent(`openship.io/project=${this.labels["openship.io/project"]},openship.io/volume-deletion=true`)}`,
      undefined,
      this.signal,
    );
    const backups = savedBackups ?? (await this.archive.list());
    const volumes: ClusterVolume[] = [];
    for (let offset = 0; offset < result.items.length; offset += 4)
      volumes.push(
        ...(await Promise.all(
          result.items.slice(offset, offset + 4).map((c) => this.present(c, backups)),
        )),
      );
    for (const record of records.items) {
      this.owned(record);
      const deletion = JSON.parse(record.data.plan) as VolumeDeletion;
      const current = volumes.find((v) => v.name === deletion.name);
      if (current) {
        current.phase = "Deleting";
        current.resourceVersion = record.metadata.resourceVersion!;
      } else
        volumes.push({
          name: deletion.name,
          resourceVersion: record.metadata.resourceVersion!,
          sizeGiB: deletion.sizeGiB,
          phase: "Deleting",
          state: "deleting",
          robustness: "unknown",
          volumeName: deletion.volumeName ?? null,
          message: "File removal was requested. Resume cleanup if it was interrupted.",
          desiredCopies: 0,
          copies: [],
          backups: [],
          backupSchedule: defaultSchedule,
        });
    }
    return volumes;
  }
  async create(input: {
    name: string;
    sizeGiB: number;
    requestId: string;
    restoreFrom?: { volumeName: string; backupName: string };
  }) {
    await this.namespaceReady();
    if (await clusterObject(this.api, this.deletionPath(input.name), this.signal))
      throw conflict("Finish removing the previous volume with this name before reusing it.");
    const standard = await this.api.request(
      "GET",
      `/apis/storage.k8s.io/v1/storageclasses/${MANAGED_STORAGE_CLASS}`,
      undefined,
      this.signal,
    );
    if (
      standard.metadata.labels?.["openship.io/runtime"] !== this.runtimeId ||
      standard.provisioner !== "driver.longhorn.io"
    )
      throw conflict("Enable shared storage on this cluster before adding a volume.");
    const intent = hash(JSON.stringify(input));
    const metadata = {
      name: clusterVolumeClaim(input.name),
      namespace: this.namespace,
      labels: { ...this.labels, "openship.io/volume": input.name },
      annotations: { "openship.io/request": intent },
    };
    let storageClassName = MANAGED_STORAGE_CLASS;
    if (input.restoreFrom) {
      const backupUrl = await this.archive.restoreSource(
        input.restoreFrom.volumeName,
        input.restoreFrom.backupName,
        input.sizeGiB,
      );
      storageClassName = `openship-restore-${intent.slice(0, 24)}`;
      await this.createOnce("/apis/storage.k8s.io/v1/storageclasses", {
        ...standard,
        metadata: {
          name: storageClassName,
          labels: this.labels,
          annotations: {
            "openship.io/request": intent,
            "storageclass.kubernetes.io/is-default-class": "false",
          },
        },
        parameters: { ...standard.parameters, fromBackup: backupUrl },
      });
    }
    try {
      const claim = await this.createOnce(this.claims, {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata,
        spec: {
          accessModes: ["ReadWriteMany"],
          volumeMode: "Filesystem",
          storageClassName,
          resources: { requests: { storage: `${input.sizeGiB}Gi` } },
        },
      });
      return await this.present(claim);
    } catch (error) {
      // Only a definitive rejection can clean its unused recovery class. A
      // transport failure may still have created a claim; explicit retry adopts it.
      if (
        input.restoreFrom &&
        error instanceof KubernetesApiError &&
        [400, 403, 422].includes(error.statusCode)
      ) {
        const claims = await this.api.request<{ items: KubernetesObject[] }>(
          "GET",
          "/api/v1/persistentvolumeclaims",
          undefined,
          this.signal,
        );
        if (!claims.items.some((claim) => claim.spec.storageClassName === storageClassName)) {
          const path = `/apis/storage.k8s.io/v1/storageclasses/${storageClassName}`;
          const storageClass = await clusterObject(this.api, path, this.signal);
          if (storageClass) {
            this.owned(storageClass);
            await this.fence();
            await this.api.request(
              "DELETE",
              path,
              {
                preconditions: {
                  uid: storageClass.metadata.uid,
                  resourceVersion: storageClass.metadata.resourceVersion,
                },
              },
              this.signal,
            );
          }
        }
      }
      throw error;
    }
  }
  async resize(name: string, resourceVersion: string, sizeGiB: number) {
    const claim = await this.claim(name);
    if (claim.metadata.resourceVersion !== resourceVersion || claim.metadata.deletionTimestamp)
      throw conflict("The volume changed. Refresh before resizing.");
    const before = parseInt(claim.spec.resources.requests.storage, 10);
    if (sizeGiB < before) throw conflict("Volumes can grow, but cannot be shrunk.");
    const updated = await patchKubernetesObject(
      this.api,
      `${this.claims}/${claim.metadata.name}`,
      async (current) => {
        this.owned(current, name);
        await this.fence();
        if (
          current.metadata.uid !== claim.metadata.uid ||
          parseInt(current.spec.resources.requests.storage, 10) !== before
        )
          throw conflict("Another operation changed this volume's requested size.");
        return { spec: { resources: { requests: { storage: `${sizeGiB}Gi` } } } };
      },
      this.signal,
    );
    return this.present(updated);
  }
  async backup(name: string, requestId: string) {
    const claim = await this.claim(name);
    const backing = await this.longhornVolume(claim);
    if (!backing || backing.volume.status?.state !== "attached")
      throw conflict("Attach this volume to a running application before creating its backup.");
    const target = await this.api.request(
      "GET",
      `${longhornBase}/backuptargets/default`,
      undefined,
      this.signal,
    );
    if (
      target.metadata.labels?.["openship.io/runtime"] !== this.runtimeId ||
      !target.spec.backupTargetURL
    )
      throw conflict("Choose a backup destination in the cluster's storage settings first.");
    const operation = `backup-${hash(`${claim.metadata.uid}:${requestId}`).slice(0, 24)}`;
    const labels = {
      ...this.labels,
      "openship.io/volume": name,
      "backup-volume": backing.volume.metadata.name!,
      "backup-target": "default",
      longhornvolume: backing.volume.metadata.name!,
    };
    const metadata = {
      name: operation,
      namespace: LONGHORN_NAMESPACE,
      labels,
      annotations: { "openship.io/request": requestId },
    };
    await this.createOnce(`${longhornBase}/snapshots`, {
      apiVersion: "longhorn.io/v1beta2",
      kind: "Snapshot",
      metadata,
      spec: { volume: backing.volume.metadata.name, createSnapshot: true },
    });
    await this.archive.waitForSnapshot(operation);
    await this.createOnce(`${longhornBase}/backups`, {
      apiVersion: "longhorn.io/v1beta2",
      kind: "Backup",
      metadata,
      spec: { snapshotName: operation, labels: this.archive.labelsFor(name) },
    });
    return this.present(claim);
  }
  async schedule(name: string, resourceVersion: string, schedule: ClusterVolumeBackupSchedule) {
    const claim = await this.claim(name);
    if (claim.metadata.resourceVersion !== resourceVersion || claim.metadata.deletionTimestamp)
      throw conflict("The volume changed. Refresh before changing its backups.");
    const backing = await this.longhornVolume(claim);
    if (!backing) throw conflict("Wait for this volume to be ready before scheduling backups.");
    if (schedule.frequency !== "manual") {
      const target = await this.api.request(
        "GET",
        `${longhornBase}/backuptargets/default`,
        undefined,
        this.signal,
      );
      if (
        target.metadata.labels?.["openship.io/runtime"] !== this.runtimeId ||
        !target.spec.backupTargetURL
      )
        throw conflict("Choose a backup destination in cluster storage first.");
    }
    await this.archive.schedule(
      backing.volume,
      name,
      schedule,
      `files-${hash(claim.metadata.uid!).slice(0, 24)}`,
    );
    const next = await patchKubernetesObject(
      this.api,
      `${this.claims}/${claim.metadata.name}`,
      async (current) => {
        this.owned(current, name);
        if (current.metadata.uid !== claim.metadata.uid)
          throw conflict("The volume was replaced while saving its schedule.");
        await this.fence();
        return {
          metadata: { annotations: { "openship.io/backup-schedule": JSON.stringify(schedule) } },
        };
      },
      this.signal,
    );
    return this.present(next);
  }
  async remove(name: string, resourceVersion: string) {
    let record = await clusterObject(this.api, this.deletionPath(name), this.signal);
    let claim = await clusterObject(
      this.api,
      `${this.claims}/${clusterVolumeClaim(name)}`,
      this.signal,
    );
    if (record) this.owned(record, name);
    if (claim) this.owned(claim, name);
    if (!record && !claim) return { removed: true };
    if (
      record
        ? record.metadata.resourceVersion !== resourceVersion
        : claim!.metadata.resourceVersion !== resourceVersion
    )
      throw conflict("The volume changed. Refresh before deleting.");
    const pods = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `/api/v1/namespaces/${this.namespace}/pods`,
      undefined,
      this.signal,
    );
    if (
      pods.items.some(
        (p) =>
          !["Succeeded", "Failed"].includes(p.status?.phase) &&
          p.spec.volumes?.some(
            (v: any) => v.persistentVolumeClaim?.claimName === clusterVolumeClaim(name),
          ),
      )
    )
      throw conflict(
        "This volume is still mounted. Disconnect it and deploy the application before deleting its data.",
      );
    if (!record) {
      const backing = await this.longhornVolume(claim!);
      const plan: VolumeDeletion = {
        name,
        claimName: claim!.metadata.name!,
        claimUid: claim!.metadata.uid!,
        sizeGiB: parseInt(claim!.spec.resources.requests.storage),
        storageClassName: claim!.spec.storageClassName,
        ...(backing
          ? {
              pvName: backing.pv.metadata.name,
              pvUid: backing.pv.metadata.uid,
              volumeName: backing.volume.metadata.name,
              volumeUid: backing.volume.metadata.uid,
            }
          : {}),
      };
      // Keep the reviewed deletion identity after the PVC disappears, allowing
      // an explicit retry to finish disk/class cleanup after a lost response.
      record = await this.createOnce(this.records, {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: this.deletionPath(name).split("/").at(-1),
          namespace: this.namespace,
          labels: {
            ...this.labels,
            "openship.io/volume": name,
            "openship.io/volume-deletion": "true",
          },
          annotations: { "openship.io/request": plan.claimUid },
        },
        data: { plan: JSON.stringify(plan) },
      });
    }
    let plan = JSON.parse(record.data.plan) as VolumeDeletion;
    claim = await clusterObject(
      this.api,
      `${this.claims}/${clusterVolumeClaim(name)}`,
      this.signal,
    );
    if (claim && claim.metadata.uid !== plan.claimUid)
      throw conflict("The volume was replaced after its deletion was reviewed.");
    if (claim?.spec.volumeName && !plan.pvName) {
      const backing = await this.longhornVolume(claim);
      if (!backing)
        throw conflict(
          "The newly allocated disk could not be inspected. Retry removal after refreshing its status.",
        );
      plan = {
        ...plan,
        pvName: backing.pv.metadata.name,
        pvUid: backing.pv.metadata.uid,
        volumeName: backing.volume.metadata.name,
        volumeUid: backing.volume.metadata.uid,
      };
      record = await patchKubernetesObject(
        this.api,
        this.deletionPath(name),
        async (current) => {
          this.owned(current, name);
          if (current.metadata.uid !== record!.metadata.uid)
            throw conflict("The deletion request changed.");
          await this.fence();
          return { data: { plan: JSON.stringify(plan) } };
        },
        this.signal,
      );
    }
    if (plan.pvName) {
      const path = `/api/v1/persistentvolumes/${plan.pvName}`;
      const pv = await clusterObject(this.api, path, this.signal);
      if (
        pv &&
        (pv.metadata.uid !== plan.pvUid ||
          pv.spec.claimRef?.uid !== plan.claimUid ||
          pv.spec.csi?.volumeHandle !== plan.volumeName)
      )
        throw conflict("The backing volume changed before deletion.");
      if (pv && !pv.metadata.deletionTimestamp)
        await patchKubernetesObject(
          this.api,
          path,
          async (current) => {
            if (current.metadata.uid !== plan.pvUid || current.spec.claimRef?.uid !== plan.claimUid)
              throw conflict("The backing volume changed before deletion.");
            await this.fence();
            return { spec: { persistentVolumeReclaimPolicy: "Delete" } };
          },
          this.signal,
        );
    }
    if (plan.volumeName) {
      const volume = await clusterObject(
        this.api,
        `${longhornBase}/volumes/${plan.volumeName}`,
        this.signal,
      );
      if (volume && volume.metadata.uid !== plan.volumeUid)
        throw conflict("The backing disk was replaced after deletion was reviewed.");
      if (volume && !volume.metadata.deletionTimestamp)
        await this.archive.schedule(
          volume,
          name,
          defaultSchedule,
          `files-${hash(plan.claimUid).slice(0, 24)}`,
        );
    }
    if (claim && !claim.metadata.deletionTimestamp) {
      await this.fence();
      await this.api.request(
        "DELETE",
        `${this.claims}/${claim.metadata.name}`,
        { preconditions: { uid: plan.claimUid, resourceVersion: claim.metadata.resourceVersion } },
        this.signal,
      );
    }
    for (const path of [
      `${this.claims}/${plan.claimName}`,
      ...(plan.pvName ? [`/api/v1/persistentvolumes/${plan.pvName}`] : []),
      ...(plan.volumeName ? [`${longhornBase}/volumes/${plan.volumeName}`] : []),
    ])
      await waitForClusterResource(
        this.signal,
        async () => (!(await clusterObject(this.api, path, this.signal)) ? true : null),
        "volume and data-copy deletion",
        60_000,
      );
    if (plan.storageClassName.startsWith("openship-restore-")) {
      const path = `/apis/storage.k8s.io/v1/storageclasses/${plan.storageClassName}`;
      const storageClass = await clusterObject(this.api, path, this.signal);
      if (storageClass) {
        this.owned(storageClass);
        await this.fence();
        await this.api.request(
          "DELETE",
          path,
          { preconditions: { uid: storageClass.metadata.uid } },
          this.signal,
        );
      }
    }
    await this.fence();
    await this.api.request(
      "DELETE",
      this.deletionPath(name),
      { preconditions: { uid: record.metadata.uid } },
      this.signal,
    );
    return { removed: true };
  }
}
