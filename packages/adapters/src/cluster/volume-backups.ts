import { AppError, type ClusterVolumeBackup, type ClusterVolumeBackupSchedule } from "@repo/core";
import { clusterObject, waitForClusterResource } from "./database-addons";
import { patchKubernetesObject } from "./kubernetes-mutation";
import type { KubernetesApi, KubernetesObject } from "./kubernetes-api";
import { longhornBase, LONGHORN_NAMESPACE } from "./storage";

const conflict = (message: string) => new AppError(message, 409, "CLUSTER_VOLUME_BACKUP");
const GiB = 1024 ** 3;

/** Archive identities are stored inside the native backup as well as Kubernetes
 * metadata, so discovery continues after a source claim has been deleted. */
export class VolumeBackups {
  constructor(
    private api: KubernetesApi,
    private labels: Record<string, string>,
    private signal: AbortSignal,
    private fence: () => Promise<void>,
  ) {}

  labelsFor(name: string) {
    return {
      "openship-project": this.labels["openship.io/project"],
      "openship-runtime": this.labels["openship.io/runtime"],
      "openship-volume": name,
    };
  }

  present(backup: KubernetesObject): ClusterVolumeBackup | null {
    const labels = { ...backup.spec?.labels, ...backup.status?.labels };
    if (
      labels["openship-project"] !== this.labels["openship.io/project"] ||
      labels["openship-runtime"] !== this.labels["openship.io/runtime"] ||
      !labels["openship-volume"]
    )
      return null;
    return {
      name: backup.metadata.name!,
      volumeName: labels["openship-volume"],
      sizeGiB: Number(backup.status?.volumeSize ?? 0) / GiB,
      state: backup.metadata.deletionTimestamp ? "Deleting" : backup.status?.state || "Pending",
      progress: backup.status?.progress ?? 0,
      createdAt: backup.status?.backupCreatedAt || backup.metadata.creationTimestamp || null,
      error: backup.status?.error || null,
    };
  }

  async list() {
    const response = await clusterObject(this.api, `${longhornBase}/backups`, this.signal);
    return ((response?.items ?? []) as KubernetesObject[])
      .map((backup) => this.present(backup))
      .filter((backup): backup is ClusterVolumeBackup => !!backup)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }

  async restoreSource(volumeName: string, backupName: string, sizeGiB: number) {
    const backup = await this.api.request(
      "GET",
      `${longhornBase}/backups/${encodeURIComponent(backupName)}`,
      undefined,
      this.signal,
    );
    const view = this.present(backup);
    if (
      !view ||
      view.volumeName !== volumeName ||
      view.state !== "Completed" ||
      !backup.status?.url ||
      view.sizeGiB <= 0 ||
      sizeGiB < view.sizeGiB
    )
      throw conflict(
        "Choose a completed file backup from this project and enough space for its data.",
      );
    return String(backup.status.url);
  }

  async remove(name: string) {
    const path = `${longhornBase}/backups/${encodeURIComponent(name)}`;
    const backup = await clusterObject(this.api, path, this.signal);
    if (!backup) return;
    const view = this.present(backup);
    if (!view) throw conflict("This file backup belongs to another project or cluster.");
    if (!["Completed", "Error", "Deleting"].includes(view.state))
      throw conflict("Wait for the backup to finish before deleting its archive.");
    if (backup.status?.url) await this.assertNotRestoring(String(backup.status.url));
    await this.fence();
    if (!backup.metadata.deletionTimestamp)
      await this.api.request(
        "DELETE",
        path,
        { preconditions: { uid: backup.metadata.uid } },
        this.signal,
      );
    // The native backup controller owns deletion of the remote archive.
  }

  private async assertNotRestoring(url: string) {
    const [volumes, classes, claims] = await Promise.all([
      this.api.request<{ items: KubernetesObject[] }>(
        "GET",
        `${longhornBase}/volumes`,
        undefined,
        this.signal,
      ),
      this.api.request<{ items: KubernetesObject[] }>(
        "GET",
        "/apis/storage.k8s.io/v1/storageclasses",
        undefined,
        this.signal,
      ),
      this.api.request<{ items: KubernetesObject[] }>(
        "GET",
        "/api/v1/persistentvolumeclaims",
        undefined,
        this.signal,
      ),
    ]);
    const restored = (volume: KubernetesObject) =>
      volume.status?.restoreInitiated === true &&
      volume.status?.restoreRequired === false &&
      !volume.spec.standby;
    if (volumes.items.some((volume) => volume.spec.fromBackup === url && !restored(volume)))
      throw conflict(
        "This backup is being restored. Wait for the recovered files to be ready before deleting it.",
      );
    // A claim may still be waiting for its native volume to exist. The shared
    // cluster mutation lock also prevents racing a newly submitted restore.
    const restoringClasses = new Set(
      classes.items
        .filter((item) => item.parameters?.fromBackup === url)
        .map((item) => item.metadata.name),
    );
    for (const claim of claims.items.filter((item) =>
      restoringClasses.has(item.spec.storageClassName),
    )) {
      const pv =
        claim.spec.volumeName &&
        (await clusterObject(
          this.api,
          `/api/v1/persistentvolumes/${claim.spec.volumeName}`,
          this.signal,
        ));
      const volume =
        pv && volumes.items.find((item) => item.metadata.name === pv.spec.csi?.volumeHandle);
      if (!volume || !restored(volume))
        throw conflict(
          "This backup is being restored. Wait for the recovered files to be ready before deleting it.",
        );
    }
  }

  async schedule(
    volume: KubernetesObject,
    name: string,
    schedule: ClusterVolumeBackupSchedule,
    jobName: string,
  ) {
    const path = `${longhornBase}/recurringjobs/${jobName}`;
    const label = `recurring-job.longhorn.io/${jobName}`;
    const existing = await clusterObject(this.api, path, this.signal);
    if (
      existing &&
      Object.entries(this.labels).some(([key, value]) => existing.metadata.labels?.[key] !== value)
    )
      throw conflict("A file backup schedule has different ownership.");
    if (schedule.frequency === "manual") {
      await patchKubernetesObject(
        this.api,
        `${longhornBase}/volumes/${volume.metadata.name}`,
        async (current) => {
          if (current.metadata.uid !== volume.metadata.uid)
            throw conflict("The volume changed while updating its backup schedule.");
          await this.fence();
          return { metadata: { labels: { [label]: null } } };
        },
        this.signal,
      );
      if (existing) {
        await this.fence();
        await this.api.request(
          "DELETE",
          path,
          { preconditions: { uid: existing.metadata.uid } },
          this.signal,
        );
      }
      return;
    }
    const spec = {
      name: jobName,
      task: "backup",
      cron: schedule.frequency === "daily" ? "0 3 * * *" : "0 * * * *",
      retain: schedule.retain,
      concurrency: 1,
      groups: [],
      labels: this.labelsFor(name),
    };
    if (existing)
      await patchKubernetesObject(
        this.api,
        path,
        async (current) => {
          if (
            Object.entries(this.labels).some(
              ([key, value]) => current.metadata.labels?.[key] !== value,
            )
          )
            throw conflict("The backup schedule changed ownership.");
          await this.fence();
          return { spec };
        },
        this.signal,
      );
    else {
      await this.fence();
      await this.api.request(
        "POST",
        `${longhornBase}/recurringjobs`,
        {
          apiVersion: "longhorn.io/v1beta2",
          kind: "RecurringJob",
          metadata: { name: jobName, namespace: LONGHORN_NAMESPACE, labels: this.labels },
          spec,
        },
        this.signal,
      );
    }
    await patchKubernetesObject(
      this.api,
      `${longhornBase}/volumes/${volume.metadata.name}`,
      async (current) => {
        if (current.metadata.uid !== volume.metadata.uid)
          throw conflict("The volume changed while updating its backup schedule.");
        await this.fence();
        return { metadata: { labels: { [label]: "enabled" } } };
      },
      this.signal,
    );
  }

  async waitForSnapshot(name: string) {
    await waitForClusterResource(
      this.signal,
      async () => {
        const snapshot = await this.api.request(
          "GET",
          `${longhornBase}/snapshots/${name}`,
          undefined,
          this.signal,
        );
        if (
          Object.entries(this.labels).some(
            ([key, value]) => snapshot.metadata.labels?.[key] !== value,
          )
        )
          throw conflict("The file snapshot changed ownership.");
        if (snapshot.status?.error)
          throw conflict(`File snapshot failed: ${String(snapshot.status.error).slice(0, 2000)}`);
        return snapshot.status?.readyToUse ? snapshot : null;
      },
      "the file snapshot",
      60_000,
    );
  }
}
