"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type { ClusterStorage, ProjectCluster } from "@repo/contracts";
import {
  validateClusterVolumeMounts,
  type ClusterVolume,
  type ClusterVolumeBackup,
  type ClusterVolumeBackupSchedule,
} from "@repo/core";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { ClusterVolumeBackups } from "./ClusterVolumeBackups";
import { clusterStorageApi, clusterVolumesApi } from "@/lib/api/cluster-storage";
import { projectClusterApi } from "@/lib/api/project-cluster";
import { randomUUID } from "@/lib/random-uuid";
import { getApiErrorMessage } from "@/lib/api";

export function ClusterVolumePanel({
  projectId,
  clusterId,
  volume,
  backups = [],
  disabled,
  onSaved,
  onRemoved,
  onDeploy,
  onRefresh,
}: {
  projectId: string;
  clusterId: string;
  volume?: ClusterVolume;
  disabled: boolean;
  backups?: ClusterVolumeBackup[];
  onSaved(volume: ClusterVolume): void;
  onRemoved(): void;
  onDeploy(): void;
  onRefresh(): Promise<void>;
}) {
  const { updateProjectData } = useProjectSettings();
  const [storage, setStorage] = useState<ClusterStorage | null>();
  const [project, setProject] = useState<ProjectCluster | null>(null);
  const [name, setName] = useState(volume?.name ?? "uploads");
  const [size, setSize] = useState(volume?.sizeGiB ?? 5);
  const [mountPath, setMountPath] = useState(`/app/${volume?.name ?? "uploads"}`);
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoredName, setRestoredName] = useState(`${volume?.name ?? "files"}-restored`);
  const [restoreSource, setRestoreSource] = useState<ClusterVolumeBackup | null>(null);
  const [schedule, setSchedule] = useState<ClusterVolumeBackupSchedule>(
    volume?.backupSchedule ?? { frequency: "manual", retain: 7 },
  );
  const request = useRef(randomUUID());
  const backupRequest = useRef<string | null>(null);
  const lock = useRef(false);
  useEffect(() => {
    setName(volume?.name ?? "uploads");
    setSize(volume?.sizeGiB ?? 5);
    setMountPath(`/app/${volume?.name ?? "uploads"}`);
    setReadOnly(false);
    setSchedule(volume?.backupSchedule ?? { frequency: "manual", retain: 7 });
    setRestoredName(`${(volume?.name ?? "files").slice(0, 54)}-restored`);
    setRemoving(false);
    setConfirmName("");
    setRestoring(null);
    setRestoreSource(null);
    setNotice(null);
    setError(null);
    request.current = randomUUID();
    backupRequest.current = null;
  }, [projectId, volume?.name]);
  useEffect(() => {
    let active = true;
    void Promise.all([clusterStorageApi.get(clusterId), projectClusterApi.get(projectId)])
      .then(([nextStorage, nextProject]) => {
        if (!active) return;
        setStorage(nextStorage);
        setProject(nextProject);
        const mount = nextProject.config?.mounts?.find((item) => item.name === volume?.name);
        if (mount) {
          setMountPath(mount.mountPath);
          setReadOnly(!!mount.readOnly);
        }
      })
      .catch((reason) => {
        if (active) setError(getApiErrorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [clusterId, projectId, volume?.name]);
  const attached = project?.config?.mounts?.some((mount) => mount.name === volume?.name);
  const locked = busy || disabled || !project || storage?.status !== "ready";
  const run = async (work: () => Promise<void>) => {
    if (lock.current || locked) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (reason) {
      setError(getApiErrorMessage(reason));
      // Read after a lost response; never replay a create/delete automatically.
      await onRefresh().catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/topology/ClusterVolumePanel");
      });
      await projectClusterApi
        .get(projectId)
        .then(setProject)
        .catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "dashboard/components/topology/ClusterVolumePanel");
        });
      await clusterStorageApi
        .get(clusterId)
        .then(setStorage)
        .catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "dashboard/components/topology/ClusterVolumePanel");
        });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const attach = (disconnect = false) =>
    run(async () => {
      if (!project?.config || !volume) return;
      const mounts = (project.config.mounts ?? []).filter((mount) => mount.name !== volume.name);
      if (!disconnect) mounts.push({ name: volume.name, mountPath, readOnly });
      validateClusterVolumeMounts(mounts);
      const next = await projectClusterApi.set(projectId, {
        clusterId,
        config: { ...project.config, mounts },
        expectedUpdatedAt: project.updatedAt,
        stateless: true,
      });
      setProject(next);
      updateProjectData({ clusterConfig: next.config });
      setNotice("Connection saved. Deploy the application to apply it.");
      onDeploy();
    });
  const removeBackup = (backup: ClusterVolumeBackup) => {
    void run(async () => {
      await clusterVolumesApi.removeBackup(projectId, {
        backupName: backup.name,
        confirmName: backup.name,
      });
      await onRefresh();
    });
  };
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {volume
          ? "Files on this volume are available to every instance of your application."
          : "Give your application a shared folder for uploads and other files that need to survive a restart or server change."}
      </p>
      {storage !== undefined && storage?.status !== "ready" && (
        <div className="space-y-3 rounded-xl bg-muted/40 p-4">
          <p className="text-sm">
            Enable shared storage on this cluster first. OpenShip prepares the disks and checks file
            access between servers.
          </p>
          <Link
            href={`/servers/clusters/${encodeURIComponent(clusterId)}`}
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            Open cluster storage
            <Icon name="arrow-right" className="size-4" />
          </Link>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      {!volume ? (
        <>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () =>
                onSaved(
                  await clusterVolumesApi.create(projectId, {
                    name,
                    sizeGiB: size,
                    requestId: request.current,
                    ...(restoreSource
                      ? {
                          restoreFrom: {
                            volumeName: restoreSource.volumeName,
                            backupName: restoreSource.name,
                          },
                        }
                      : {}),
                  }),
                ),
              );
            }}
          >
            {restoreSource && (
              <div className="rounded-lg bg-info/5 p-3 text-sm">
                Restore files from {restoreSource.volumeName} into a new volume.
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRestoreSource(null);
                    request.current = randomUUID();
                  }}
                >
                  Cancel restore
                </Button>
              </div>
            )}
            <label className="block space-y-2 text-sm">
              <span>Volume name</span>
              <Input
                variant="filled"
                value={name}
                required
                pattern="[a-z][a-z0-9-]*[a-z0-9]|[a-z]"
                maxLength={63}
                disabled={locked}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span>Space (GiB)</span>
              <Input
                variant="filled"
                type="number"
                min={1}
                max={16384}
                step={1}
                value={size}
                disabled={locked}
                onChange={(event) => setSize(Number(event.target.value))}
              />
            </label>
            {storage?.status === "ready" && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Keeps {storage.config.replicas} copies on different servers. {size} GiB of files
                reserves up to {size * storage.config.replicas} GiB across the selected disks. Space
                can be increased later.
              </p>
            )}
            <Button type="submit" className="w-full" disabled={locked}>
              {busy && <Icon name="spinner" className="size-4 animate-spin" />}
              {restoreSource ? "Restore files" : "Create shared volume"}
            </Button>
          </form>
          {backups.length > 0 && (
            <details className="space-y-3 text-sm" open={!!restoreSource}>
              <summary className="cursor-pointer text-muted-foreground">
                Restore saved files
              </summary>
              <p className="text-xs text-muted-foreground">
                Backups remain available after their original volume is deleted.
              </p>
              <ClusterVolumeBackups
                backups={backups}
                disabled={locked}
                onDelete={removeBackup}
                onRestore={(backup) => {
                  setRestoreSource(backup);
                  setName(`${backup.volumeName.slice(0, 52)}-restored`);
                  setSize(Math.max(1, Math.ceil(backup.sizeGiB)));
                  request.current = randomUUID();
                }}
              />
            </details>
          )}
        </>
      ) : volume.phase === "Deleting" ? (
        <div className="space-y-3 rounded-xl bg-muted/30 p-4">
          <p className="text-sm">Removing this volume and its data copies.</p>
          <p className="text-xs text-muted-foreground">
            If cleanup was interrupted, continue from the saved deletion request.
          </p>
          <Button
            disabled={locked}
            onClick={() =>
              void run(async () => {
                await clusterVolumesApi.remove(projectId, {
                  name: volume.name,
                  resourceVersion: volume.resourceVersion,
                  confirmName: volume.name,
                  deleteData: true,
                });
                onRemoved();
              })
            }
          >
            {busy ? "Removing…" : "Resume cleanup"}
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-3 rounded-xl bg-muted/30 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {volume.robustness === "faulted"
                  ? "Needs attention"
                  : volume.robustness === "degraded"
                    ? "Rebuilding data copies"
                    : volume.phase === "Bound" && volume.robustness === "healthy"
                      ? volume.state === "attached"
                        ? "Storage connected"
                        : "Ready to connect"
                      : "Preparing storage"}
              </span>
              <span className="tabular-nums text-muted-foreground">{volume.sizeGiB} GiB</span>
            </div>
            {volume.message && (
              <p className="text-xs leading-relaxed text-warning">{volume.message}</p>
            )}
            {volume.copies.map((copy) => (
              <div key={copy.name} className="flex items-center gap-2 text-xs">
                <Icon
                  name={
                    copy.state === "ready"
                      ? "check-circle"
                      : copy.state === "failed"
                        ? "alert-circle"
                        : "refresh"
                  }
                  className={`size-3.5 ${copy.state === "ready" ? "text-success" : copy.state === "failed" ? "text-danger" : "text-info"}`}
                />
                <span className="min-w-0 flex-1 truncate">{copy.serverName}</span>
                <span className="text-muted-foreground">
                  {copy.state === "ready"
                    ? "Copy ready"
                    : copy.state === "rebuilding"
                      ? `Rebuilding${copy.progress !== null ? ` ${copy.progress}%` : ""}`
                      : copy.state === "failed"
                        ? "Needs attention"
                        : "Preparing copy"}
                </span>
              </div>
            ))}
          </div>
          <section className="space-y-3">
            <h3 className="text-sm font-medium">Use in this application</h3>
            <label className="block space-y-2 text-sm">
              <span>Folder inside the app</span>
              <Input
                variant="filled"
                value={mountPath}
                placeholder="/app/uploads"
                disabled={locked}
                onChange={(event) => setMountPath(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={readOnly} onCheckedChange={setReadOnly} disabled={locked} />
              Read only
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Your app can use its normal file APIs at this path. Existing files in the
              application's image at this path will be hidden while the volume is connected.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={locked || volume.phase !== "Bound"}
                onClick={() => void attach()}
              >
                {attached ? "Save & review deployment" : "Attach & review deployment"}
              </Button>
              {attached && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={locked}
                  onClick={() => void attach(true)}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </section>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Increase space</summary>
            <form
              className="mt-3 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  onSaved(
                    await clusterVolumesApi.resize(projectId, {
                      name: volume.name,
                      resourceVersion: volume.resourceVersion,
                      sizeGiB: size,
                    }),
                  );
                  setNotice("More space requested. Watch the volume status while it grows.");
                });
              }}
            >
              <Input
                aria-label="New volume size in GiB"
                variant="filled"
                type="number"
                min={volume.sizeGiB}
                max={16384}
                step={1}
                value={size}
                onChange={(event) => setSize(Number(event.target.value))}
                disabled={locked}
              />
              <p className="text-xs text-muted-foreground">
                Volumes can grow while attached. They cannot be shrunk.
              </p>
              <Button size="sm" type="submit" disabled={locked || size <= volume.sizeGiB}>
                Increase space
              </Button>
            </form>
          </details>
          <section className="space-y-3 rounded-xl bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Backups and recovery</h3>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  locked || !storage?.config.backupDestinationId || volume.state !== "attached"
                }
                onClick={() =>
                  void run(async () => {
                    backupRequest.current ??= randomUUID();
                    onSaved(
                      await clusterVolumesApi.backup(projectId, {
                        name: volume.name,
                        requestId: backupRequest.current,
                      }),
                    );
                    backupRequest.current = null;
                    setNotice("Backup started. You can leave this page while it completes.");
                  })
                }
              >
                Back up now
              </Button>
            </div>
            {!storage?.config.backupDestinationId && (
              <Link
                href={`/servers/clusters/${encodeURIComponent(clusterId)}`}
                className="text-xs text-primary hover:underline"
              >
                Choose a backup destination in cluster storage
              </Link>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Saves a point-in-time copy of the files. Pause app writes when files need to be saved
              together. Databases use their own backup tools.
            </p>
            <details className="space-y-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Automatic backups</summary>
              <CustomSelect
                variant="filled"
                aria-label="File backup frequency"
                value={schedule.frequency}
                disabled={locked || !storage?.config.backupDestinationId}
                options={[
                  { value: "daily", label: "Every day", description: "03:00 UTC" },
                  { value: "hourly", label: "Every hour" },
                  { value: "manual", label: "Only when requested" },
                ]}
                onChange={(frequency) =>
                  setSchedule((value) => ({
                    ...value,
                    frequency: frequency as ClusterVolumeBackupSchedule["frequency"],
                  }))
                }
              />
              {schedule.frequency !== "manual" && (
                <label className="block space-y-2 text-xs">
                  <span>Backups to keep</span>
                  <Input
                    variant="filled"
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={schedule.retain}
                    disabled={locked}
                    onChange={(event) =>
                      setSchedule((value) => ({ ...value, retain: Number(event.target.value) }))
                    }
                  />
                </label>
              )}
              <p className="text-xs text-muted-foreground">
                Backups run while this volume is attached. Older scheduled backups are removed after
                reaching this limit.
              </p>
              <Button
                size="sm"
                disabled={locked || !storage?.config.backupDestinationId}
                onClick={() =>
                  void run(async () => {
                    onSaved(
                      await clusterVolumesApi.schedule(projectId, {
                        name: volume.name,
                        resourceVersion: volume.resourceVersion,
                        schedule,
                      }),
                    );
                    setNotice("Backup schedule saved.");
                  })
                }
              >
                Save schedule
              </Button>
            </details>
            <ClusterVolumeBackups
              backups={volume.backups}
              disabled={locked}
              onDelete={removeBackup}
              onRestore={(backup) => {
                request.current = randomUUID();
                setRestoring(backup.name);
              }}
            />
            {restoring && (
              <form
                className="space-y-3 pt-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () =>
                    onSaved(
                      await clusterVolumesApi.create(projectId, {
                        name: restoredName,
                        sizeGiB: volume.sizeGiB,
                        requestId: request.current,
                        restoreFrom: { volumeName: volume.name, backupName: restoring },
                      }),
                    ),
                  );
                }}
              >
                <p className="text-sm font-medium">Restore into a new volume</p>
                <Input
                  variant="filled"
                  aria-label="Restored volume name"
                  value={restoredName}
                  maxLength={63}
                  disabled={locked}
                  onChange={(event) => setRestoredName(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Check the recovered files before attaching them to your application.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" type="submit" disabled={locked || restoredName === volume.name}>
                    Restore files
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setRestoring(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </section>
          <div className="space-y-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => setRemoving(!removing)}
            >
              <Icon name="trash" className="size-4" />
              Delete volume
            </Button>
            {removing && (
              <form
                className="space-y-3 rounded-xl bg-danger/5 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await clusterVolumesApi.remove(projectId, {
                      name: volume.name,
                      resourceVersion: volume.resourceVersion,
                      confirmName,
                      deleteData: true,
                    });
                    onRemoved();
                  });
                }}
              >
                <p className="text-sm">Permanently delete these files and all their data copies.</p>
                <p className="text-xs text-muted-foreground">
                  Disconnect the volume and deploy the app first. Saved backups stay in their
                  destination.
                </p>
                <Input
                  variant="filled"
                  aria-label="Volume name to confirm deletion"
                  placeholder={volume.name}
                  value={confirmName}
                  disabled={locked || attached}
                  onChange={(event) => setConfirmName(event.target.value)}
                />
                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  disabled={locked || attached || confirmName !== volume.name}
                >
                  Delete files permanently
                </Button>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
