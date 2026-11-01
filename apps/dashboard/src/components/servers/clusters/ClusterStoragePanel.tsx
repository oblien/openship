"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type { ClusterStorage, ComputeCluster } from "@repo/contracts";
import {
  CLUSTER_STORAGE_STEPS,
  clusterStorageRunning,
  validateClusterStorage,
  type ClusterStorageConfig,
} from "@repo/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { BackupDestinationSelect } from "@/components/backup/BackupDestinationSelect";
import { BlurIp } from "@/components/BlurIp";
import { useRunEvents } from "@/hooks/useRunEvents";
import { clusterStorageApi } from "@/lib/api/cluster-storage";
import { getApiErrorMessage } from "@/lib/api";
import { randomUUID } from "@/lib/random-uuid";
import { NetworkSetupProgress, NetworkDiagnosticText } from "./NetworkSetupProgress";
import { NetworkSetupConfirmation } from "./NetworkSetupConfirmation";
import { NetworkStreamNotice } from "./NetworkStreamNotice";

const steps = {
  prerequisites: "Prepare the servers",
  install: "Enable shared storage",
  disks: "Set up data copies",
  verify: "Test files across servers",
  remove: "Remove empty storage",
};
const status = {
  setting_up: "Setting up shared storage",
  ready: "Shared storage ready",
  failed: "Storage needs attention",
  interrupted: "Storage setup stopped",
  removing: "Removing shared storage",
  removed: "Shared storage removed",
};
const initial = (cluster: ComputeCluster): ClusterStorageConfig => ({
  replicas: Math.max(2, Math.min(3, cluster.serverIds.length)),
  disks: cluster.serverIds.map((serverId) => ({
    serverId,
    path: "/var/lib/openship/storage",
    reservedGiB: 5,
  })),
});

export function ClusterStoragePanel(props: { cluster: ComputeCluster; canManage: boolean; scalingReady: boolean; }) {
  if (!props.cluster.network) return null;
  return <NativeClusterStoragePanel {...props} cluster={{...props.cluster, network: props.cluster.network}} />;
}

function NativeClusterStoragePanel({
  cluster,
  canManage,
  scalingReady,
}: {
  cluster: ComputeCluster & {network: NonNullable<ComputeCluster["network"]>};
  canManage: boolean;
  scalingReady: boolean;
}) {
  const [storage, setStorage] = useState<ClusterStorage | null>();
  const [config, setConfig] = useState(() => initial(cluster));
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [backup, setBackup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const currentCluster = useRef(cluster.id);
  currentCluster.current = cluster.id;
  const pending = useRef(false);
  const request = useRef(randomUUID());
  const removalSequence = useRef<number | null>(null);
  const receive = useCallback(
    (next: ClusterStorage | null) => {
      if (currentCluster.current !== cluster.id) return;
      if (next && next.clusterId !== cluster.id) throw new Error("Invalid shared storage status");
      setStorage((previous) =>
        previous &&
        next &&
        previous.id === next.id &&
        (previous.sequence > next.sequence ||
          (previous.sequence === next.sequence &&
            previous.observation &&
            (!next.observation ||
              Date.parse(previous.observation.observedAt) >
                Date.parse(next.observation.observedAt))))
          ? previous
          : next,
      );
    },
    [cluster.id],
  );
  useEffect(() => {
    let active = true;
    setStorage(undefined);
    setEditing(false);
    setRemoving(false);
    setError(null);
    request.current = randomUUID();
    void clusterStorageApi
      .get(cluster.id)
      .then((next) => {
        if (active) receive(next);
      })
      .catch((reason) => {
        if (active) setError(getApiErrorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [cluster.id, receive]);
  const stream = useRunEvents<ClusterStorage>(
    storage && storage.status !== "removed"
      ? `system/compute-clusters/${encodeURIComponent(cluster.id)}/storage/stream`
      : null,
    receive,
  );
  const running = !!storage && clusterStorageRunning(storage.status);
  const available = storage === null || storage?.status === "removed";
  const locked = busy || running || !canManage || storage === undefined;
  const refresh = async () => {
    if (checking || busy || running) return;
    setChecking(true);
    setError(null);
    try {
      receive(await clusterStorageApi.get(cluster.id, true));
    } catch (reason) {
      if (currentCluster.current === cluster.id) setError(getApiErrorMessage(reason));
    } finally {
      setChecking(false);
    }
  };
  const change = async (action: "setup" | "retry" | "remove" | "backup") => {
    if (pending.current || locked) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action === "setup") validateClusterStorage(config);
      const next =
        action === "setup"
          ? await clusterStorageApi.setup(cluster.id, { requestId: request.current, config })
          : action === "retry"
            ? await clusterStorageApi.retry(cluster.id, storage!.sequence)
            : action === "backup"
              ? await clusterStorageApi.backup(cluster.id, storage!.sequence, backup)
              : await clusterStorageApi.remove(cluster.id, removalSequence.current!);
      if (currentCluster.current !== cluster.id) return;
      receive(next);
      setEditing(false);
      setRemoving(false);
      if (action === "remove") request.current = randomUUID();
    } catch (reason) {
      if (currentCluster.current !== cluster.id) return;
      setError(getApiErrorMessage(reason));
      try {
        receive(await clusterStorageApi.get(cluster.id));
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/components/servers/clusters/ClusterStoragePanel");
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const observation = storage?.observation;
  return (
    <section className="mb-6 min-w-0 space-y-4" aria-labelledby="shared-storage-title">
      <div className="rounded-2xl bg-card p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-info/10 text-info">
              <Icon
                name={running ? "spinner" : "hard-drive"}
                className={`size-5 ${running ? "animate-spin" : ""}`}
              />
            </span>
            <div>
              <h2 id="shared-storage-title" className="text-base font-semibold">
                Shared storage
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {available
                  ? "Keep files available to your applications across servers."
                  : storage
                    ? status[storage.status]
                    : "Loading storage status…"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              disabled={checking || busy || running}
              aria-label="Refresh storage status"
              onClick={() => void refresh()}
            >
              <Icon
                name={checking ? "spinner" : "refresh"}
                className={`size-4 ${checking ? "animate-spin" : ""}`}
              />
            </Button>
            {available && canManage && !editing && (
              <Button
                disabled={!scalingReady || cluster.serverIds.length < 2}
                onClick={() => {
                  setConfig(initial(cluster));
                  setEditing(true);
                }}
              >
                Share storage
              </Button>
            )}
            {storage && ["failed", "interrupted"].includes(storage.status) && canManage && (
              <Button disabled={locked} onClick={() => void change("retry")}>
                <Icon name="rotate-left" className="size-4" />
                Retry
              </Button>
            )}
            {storage && !available && !running && canManage && (
              <Button
                variant="ghost"
                size="icon"
                disabled={locked}
                aria-label="Remove shared storage"
                onClick={() => {
                  removalSequence.current = storage.sequence;
                  setError(null);
                  setRemoving(true);
                }}
              >
                <Icon name="trash" className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {available && !scalingReady && (
          <p className="mt-4 text-sm text-muted-foreground">
            Enable scaling on this cluster above to share files between its servers.
          </p>
        )}
        {available && cluster.serverIds.length < 2 && (
          <p className="mt-4 text-sm text-muted-foreground">
            Shared storage needs at least two servers so each file has an independent copy.
          </p>
        )}
        {error && !removing && (
          <p role="alert" className="mt-4 text-sm text-danger">
            <NetworkDiagnosticText value={error} />
          </p>
        )}
        {storage?.error && (
          <p role="alert" className="mt-4 rounded-xl bg-danger/10 p-4 text-sm text-danger">
            <NetworkDiagnosticText value={storage.error} />
          </p>
        )}
        <NetworkStreamNotice stream={stream} />
        {editing && available && (
          <form
            className="mt-6 space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void change("setup");
            }}
          >
            <div className="grid items-start gap-6 md:grid-cols-2">
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Servers that keep your data</h3>
                <div className="divide-y divide-border/50">
                  {cluster.network.members
                    .filter((member) => cluster.serverIds.includes(member.serverId))
                    .map((member) => (
                      <label
                        key={member.serverId}
                        className="flex cursor-pointer items-center gap-3 py-3 text-sm"
                      >
                        <Checkbox
                          disabled={locked}
                          aria-label={`Store data on ${member.name}`}
                          checked={config.disks.some((disk) => disk.serverId === member.serverId)}
                          onCheckedChange={(checked) =>
                            setConfig((current) => ({
                              ...current,
                              disks: checked
                                ? [
                                    ...current.disks,
                                    {
                                      serverId: member.serverId,
                                      path: "/var/lib/openship/storage",
                                      reservedGiB: 5,
                                    },
                                  ]
                                : current.disks.filter((disk) => disk.serverId !== member.serverId),
                            }))
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <NetworkDiagnosticText value={member.name} />
                        </span>
                        <span aria-hidden className="h-3 w-px bg-border" />
                        <span className="font-mono text-xs text-muted-foreground">
                          <BlurIp>{member.privateIp}</BlurIp>
                        </span>
                      </label>
                    ))}
                </div>
              </div>
              <div className="space-y-4">
                <label className="block space-y-2 text-sm">
                  <span>Copies of each file</span>
                  <CustomSelect
                    variant="filled"
                    value={String(config.replicas)}
                    aria-label="Data copies"
                    disabled={locked}
                    onChange={(value) =>
                      setConfig((current) => ({ ...current, replicas: Number(value) }))
                    }
                    options={[
                      {
                        value: "3",
                        label: "3 copies · Recommended",
                        description: "Stored on three different servers",
                      },
                      {
                        value: "2",
                        label: "2 copies",
                        description: "Stored on two different servers",
                      },
                    ]}
                  />
                </label>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Files stay on independent disks. Applications can use the same files from any
                  server in this cluster. Each copy uses disk space.
                </p>
                <label className="block space-y-2 text-sm">
                  <span>Backup destination</span>
                  <BackupDestinationSelect
                    value={config.backupDestinationId ?? ""}
                    disabled={locked}
                    onChange={(value) =>
                      setConfig((current) => ({
                        ...current,
                        backupDestinationId: value || undefined,
                      }))
                    }
                  />
                </label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Backups let you recover older files. Data copies protect against a failed disk;
                  they also copy accidental changes.
                </p>
              </div>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Disk options</summary>
              <div className="mt-4 space-y-4">
                <p className="text-sm text-muted-foreground">
                  OpenShip uses a dedicated folder on each selected server. A mounted data disk can
                  be used here. Disks are never formatted during setup.
                </p>
                {config.disks.map((disk) => (
                  <div
                    key={disk.serverId}
                    className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_160px]"
                  >
                    <label className="block space-y-2">
                      <span>
                        {
                          cluster.network.members.find(
                            (member) => member.serverId === disk.serverId,
                          )?.name
                        }{" "}
                        · Folder
                      </span>
                      <Input
                        variant="filled"
                        value={disk.path}
                        disabled={locked}
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            disks: current.disks.map((item) =>
                              item.serverId === disk.serverId
                                ? { ...item, path: event.target.value }
                                : item,
                            ),
                          }))
                        }
                      />
                    </label>
                    <label className="block space-y-2">
                      <span>Keep free (GiB)</span>
                      <Input
                        variant="filled"
                        type="number"
                        min={1}
                        step={1}
                        value={disk.reservedGiB}
                        disabled={locked}
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            disks: current.disks.map((item) =>
                              item.serverId === disk.serverId
                                ? { ...item, reservedGiB: Number(event.target.value) }
                                : item,
                            ),
                          }))
                        }
                      />
                    </label>
                  </div>
                ))}
              </div>
            </details>
            {config.disks.length < config.replicas && (
              <p role="status" className="text-sm text-warning">
                Choose at least {config.replicas} servers for {config.replicas} independent copies.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={locked || !scalingReady || config.disks.length < config.replicas}
              >
                {busy && <Icon name="spinner" className="size-4 animate-spin" />}Enable shared
                storage
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={locked}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <p className="text-xs text-muted-foreground">
                Setup checks the disks, prepares the servers and tests file access.
              </p>
            </div>
          </form>
        )}
        {storage?.status === "ready" && observation && (
          <div className="mt-5 space-y-5">
            <p className="text-xs text-muted-foreground">
              Checked {new Date(observation.observedAt).toLocaleString()}
            </p>
            <div className="flex flex-wrap gap-6 text-sm">
              <span>
                <strong className="font-medium">{storage.config.replicas}</strong> data copies
              </span>
              <span>
                <strong className="font-medium">
                  {observation.nodes.filter((node) => node.ready).length} /{" "}
                  {observation.nodes.length}
                </strong>{" "}
                storage servers ready
              </span>
              <span>
                <strong className="font-medium">{observation.volumes.length}</strong> volumes
              </span>
            </div>
            <div className="divide-y divide-border/50">
              {observation.nodes.map((node) => (
                <div key={node.serverId} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <Icon
                    name={node.ready ? "check-circle" : "alert-circle"}
                    className={`size-4 ${node.ready ? "text-success" : "text-warning"}`}
                  />
                  <span className="flex-1">
                    <NetworkDiagnosticText value={node.name} />
                    {!node.ready && (
                      <span className="mt-1 block text-xs text-warning">{node.message}</span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {Math.floor(node.availableGiB)} GiB free
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {Math.ceil(node.scheduledGiB)} GiB allocated
                  </span>
                </div>
              ))}
            </div>
            {observation.volumes.some(
              (volume) => volume.robustness === "degraded" || volume.robustness === "faulted",
            ) && (
              <p role="status" className="rounded-xl bg-warning/10 p-3 text-sm text-warning">
                Some data copies need attention. Open the volume in its project's topology to check
                recovery.
              </p>
            )}
            <Link
              href="/projects"
              className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
            >
              Add shared files from a project's topology
              <Icon name="arrow-right" className="size-4" />
            </Link>
            {!storage.config.backupDestinationId && canManage && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Set up file backups
                </summary>
                <div className="mt-3 max-w-md space-y-3">
                  <BackupDestinationSelect
                    value={backup}
                    onChange={setBackup}
                    disabled={locked}
                    optional={false}
                  />
                  <Button
                    size="sm"
                    disabled={locked || !backup}
                    onClick={() => void change("backup")}
                  >
                    Save backup destination
                  </Button>
                </div>
              </details>
            )}
          </div>
        )}
        {storage && !available && (
          <details className="mt-5 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
            <div className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>
                Longhorn provides replicated disks and shared file access inside this cluster.
                OpenShip manages the installation, disk selection and checks.
              </p>
              <p>
                File volumes use shared access. Each database instance keeps its own separate disk.
              </p>
              <p>
                Recovery depends on healthy servers, network connectivity and enough free disk space
                for rebuilding copies.
              </p>
            </div>
          </details>
        )}
      </div>
      {storage && !available && (
        <details open={storage.status !== "ready"} className="rounded-2xl bg-card p-5">
          <summary className="cursor-pointer text-sm font-medium">Setup progress</summary>
          <div className="mt-4">
            <NetworkSetupProgress
              running={running}
              stepLabels={steps}
              hosts={[
                {
                  serverId: storage.id,
                  name: "Shared storage",
                  address: "",
                  logs: storage.progress.logs,
                  steps: (storage.intent === "remove"
                    ? (["remove"] as const)
                    : CLUSTER_STORAGE_STEPS
                  ).map(
                    (id) =>
                      storage.progress.steps.find((step) => step.id === id) ?? {
                        id,
                        status: "pending",
                        message: null,
                        startedAt: null,
                        finishedAt: null,
                      },
                  ),
                },
              ]}
            />
          </div>
        </details>
      )}
      {removing && (
        <NetworkSetupConfirmation
          title="Remove shared storage?"
          description="Remove the empty storage installation from this cluster. Volumes must be moved or deleted first. Saved backups stay in their backup destination."
          confirmLabel="Remove shared storage"
          busy={busy}
          error={error}
          onClose={() => {
            if (!busy) setRemoving(false);
          }}
          onConfirm={() => void change("remove")}
        />
      )}
    </section>
  );
}
