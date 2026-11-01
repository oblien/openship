"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import {
  CLUSTER_DATABASE_TEMPLATES,
  CLUSTER_DATABASE_STEPS,
  MANAGED_STORAGE_CLASS,
  clusterDatabasePodCount,
  clusterDatabaseUnsupportedReason,
  clusterDatabaseRunning,
  validateClusterDatabase,
  type ClusterDatabaseConfig,
} from "@repo/core";
import type { ClusterDatabase, ComputeCluster } from "@repo/contracts";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { UseInProjectModal } from "@/app/(dashboard)/projects/[id]/components/UseInProjectModal";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Checkbox } from "@/components/ui/Checkbox";
import { ResourceIcon } from "@/components/scale/ResourceIcon";
import { NetworkSetupProgress } from "@/components/servers/clusters/NetworkSetupProgress";
import { clusterDatabasesApi } from "@/lib/api/cluster-databases";
import { clusterStorageApi } from "@/lib/api/cluster-storage";
import { getApiErrorMessage } from "@/lib/api";
import { randomUUID } from "@/lib/random-uuid";
import { ClusterDatabaseBackupSettings, ClusterDatabaseBackups } from "./ClusterDatabaseBackups";
import { ClusterDatabaseImport } from "./ClusterDatabaseImport";
import { ClusterDatabaseCopy } from "./ClusterDatabaseCopy";
import { ClusterDatabaseScaling } from "./ClusterDatabaseScaling";
import { computeClustersApi } from "@/lib/api/compute-clusters";
import { clusterScalingState } from "@/components/servers/clusters/ClusterScalingStatus";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { databaseInstanceStatus } from "./model";

const defaults = (engine: ClusterDatabaseConfig["engine"]): ClusterDatabaseConfig => ({
  engine,
  mode: "standalone",
  instances: 1,
  storageGiB: engine === "postgres" ? 20 : 5,
  storageClass: "openship-local",
  cpuMillis: 500,
  memoryMiB: 512,
  databaseName: "app",
});
const stepLabels = {
  connect: "Cluster connection",
  operators: "Database management",
  storage: "Persistent storage",
  database: "Database configuration",
  verify: "Connection and health checks",
  remove: "Database removal",
  backup: "Archive backup",
  restore: "Recover saved data",
};

export function ClusterDatabasePanel(props: ComponentProps<typeof ClusterDatabasePanelContent>) {
  const scope = useResourceScope();
  return (
    <ClusterDatabasePanelContent
      key={`${scope}:${props.projectId}:${props.database?.id ?? "new"}`}
      {...props}
    />
  );
}

function ClusterDatabasePanelContent({
  projectId,
  clusterId,
  database,
  onSaved,
  onClose,
  onMinimize,
  onDeploy,
  onChooseCluster,
  databases = [],
  disabled = false,
}: {
  projectId: string;
  clusterId?: string;
  database?: ClusterDatabase;
  onSaved: (row: ClusterDatabase) => void;
  onClose: () => void;
  onMinimize?: () => void;
  onDeploy: () => void;
  onChooseCluster?: () => void;
  databases?: ClusterDatabase[];
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const scaleText = t.projects.quickScale;
  const [tab, setTab] = useState<"overview" | "scaling">("overview");
  const [sharing, setSharing] = useState(false);
  const [config, setConfig] = useState<ClusterDatabaseConfig | null>(database?.config ?? null);
  const [name, setName] = useState(database?.name ?? "");
  const [editing, setEditing] = useState(!database);
  const [editingSequence, setEditingSequence] = useState(database?.sequence ?? null);
  const [envKey, setEnvKey] = useState(
    database?.envKey ?? (database?.config.engine === "redis" ? "REDIS_URL" : "DATABASE_URL"),
  );
  const [readEnvKey, setReadEnvKey] = useState(database?.readEnvKey ?? "DATABASE_READ_URL");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clusterClient, setClusterClient] = useState(false);
  const [selectedCluster, setSelectedCluster] = useState(database?.clusterId ?? "");
  const [clusters, setClusters] = useState<ComputeCluster[]>([]);
  const [clustersLoading, setClustersLoading] = useState(!clusterId && !database);
  const [importFrom, setImportFrom] = useState<{ runId: string; artifactName: string }>();
  const [switchReviewed, setSwitchReviewed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeName, setRemoveName] = useState("");
  const [deleteData, setDeleteData] = useState(false);
  const request = useRef(randomUUID());
  const lock = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [sharedStorage, setSharedStorage] = useState(false);
  const [storageLoading, setStorageLoading] = useState(!!clusterId && !database);
  const [customStorage, setCustomStorage] = useState(
    !!database && !["openship-local", MANAGED_STORAGE_CLASS].includes(database.config.storageClass),
  );
  useEffect(() => {
    if (database) return;
    let active = true;
    setClustersLoading(true);
    const load = clusterId
      ? computeClustersApi.get(clusterId).then((row) => [row])
      : computeClustersApi.list();
    void load
      .then((rows) => {
        if (!active) return;
        const ready = rows.filter(
          (row) =>
            clusterScalingState(row) === "ready" &&
            !clusterDatabaseUnsupportedReason(row.scaling?.provider),
        );
        setClusters(ready);
        if (clusterId) {
          setSelectedCluster(ready[0]?.id ?? "");
          const unavailable = clusterDatabaseUnsupportedReason(rows[0]?.scaling?.provider);
          if (unavailable) setError(unavailable);
          else if (!ready.length)
            setError("Finish preparing this Kubernetes cluster before adding a database.");
        } else if (ready.length === 1) setSelectedCluster(ready[0].id);
      })
      .catch((reason) => {
        if (active) {
          setSelectedCluster("");
          setError(getApiErrorMessage(reason));
        }
      })
      .finally(() => {
        if (active) setClustersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clusterId, database]);
  useEffect(() => {
    if (!selectedCluster || database) {
      setStorageLoading(false);
      return;
    }
    let active = true;
    setStorageLoading(true);
    setSharedStorage(false);
    void clusterStorageApi
      .get(selectedCluster)
      .then((storage) => {
        if (active) setSharedStorage(storage?.status === "ready");
      })
      .catch((reason) => {
        if (active) setError(getApiErrorMessage(reason));
      })
      .finally(() => {
        if (active) setStorageLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedCluster, database]);
  const running = !!database && clusterDatabaseRunning(database.status);
  const databaseReady = !!database && databaseInstanceStatus(database).settled;
  const locked = disabled || busy || running || storageLoading || clustersLoading;
  const previousConnection = databases.find(
    (row) => row.id !== database?.id && row.envKey === envKey.trim(),
  );
  const applicationOnCluster = !!database && database.clusterId === clusterId;
  const template = CLUSTER_DATABASE_TEMPLATES.find((item) => item.id === config?.engine);
  const staleSettings = !!database && editingSequence !== database.sequence;
  const change = <K extends keyof ClusterDatabaseConfig>(key: K, value: ClusterDatabaseConfig[K]) =>
    setConfig((old) => (old ? { ...old, [key]: value } : old));
  const run = async (work: () => Promise<ClusterDatabase>, message?: string) => {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const row = await work();
      if (!active.current) return;
      onSaved(row);
      if (message) setNotice(message);
      return row;
    } catch (err) {
      if (!active.current) return;
      setError(
        getApiErrorMessage(
          err,
          "The database operation failed. Refresh its saved progress before retrying.",
        ),
      );
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  };
  const submit = async () => {
    if (!config || locked || (database && staleSettings) || (!database && !selectedCluster)) return;
    if (!database && config.engine === "redis" && config.mode === "cluster" && !clusterClient)
      return;
    try {
      validateClusterDatabase(config);
    } catch (err) {
      setError(getApiErrorMessage(err));
      return;
    }
    const row = await run(() =>
      database
        ? clusterDatabasesApi.update(projectId, {
            databaseId: database.id,
            expectedSequence: editingSequence!,
            config,
          })
        : clusterDatabasesApi.create(projectId, {
            requestId: request.current,
            name,
            config,
            clusterId: selectedCluster,
            ...(importFrom ? { importFrom } : {}),
            ...(clusterClient ? { clusterAwareClient: true } : {}),
          }),
    );
    if (row) setEditing(false);
  };
  return (
    <aside className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 py-3">
        <span
          className="scale-resource-tone scale-resource-icon flex size-9 items-center justify-center rounded-xl"
          data-kind={config?.engine ?? "postgres"}
        >
          <ResourceIcon kind={config?.engine ?? "postgres"} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{database?.name ?? "Add database"}</h2>
          <p className="text-xs text-muted-foreground">
            {template?.name ?? "Choose a database for this project"}
          </p>
        </div>
        {onMinimize && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Minimize database settings"
            onClick={onMinimize}
          >
            <UiIcon name="chevron-up" />
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label="Close database settings" onClick={onClose}>
          <UiIcon name="close" />
        </Button>
      </div>
      {database && !editing && (
        <div
          role="tablist"
          aria-label={scaleText.databaseControls}
          className="flex shrink-0 gap-1 border-b border-border/50 px-3 py-2"
        >
          {(["overview", "scaling"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={`flex-1 rounded-lg px-2 py-2 text-xs ${tab === item ? "bg-muted/60 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/30"}`}
              onClick={() => setTab(item)}
            >
              {item === "scaling" ? scaleText.scale : scaleText.overview}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        {notice && (
          <div role="status" className="space-y-2 rounded-xl bg-success/10 p-3 text-sm">
            <p>{notice}</p>
            <Button size="sm" onClick={onDeploy} disabled={locked}>
              Review application deployment <UiIcon name="arrow-right" />
            </Button>
          </div>
        )}
        {!config && (
          <div className="space-y-3">
            {CLUSTER_DATABASE_TEMPLATES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-3 rounded-xl bg-muted/30 p-4 text-start transition-colors hover:bg-muted/50"
                onClick={() => {
                  setConfig({
                    ...defaults(item.id),
                    ...(sharedStorage ? { storageClass: MANAGED_STORAGE_CLASS } : {}),
                  });
                  setName(item.id);
                  setImportFrom(undefined);
                }}
              >
                <span
                  className="scale-resource-tone scale-resource-icon flex size-10 shrink-0 items-center justify-center rounded-xl"
                  data-kind={item.id}
                >
                  <ResourceIcon kind={item.id} className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.name}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {item.id === "postgres"
                      ? "Relational data with standalone or replicated deployment."
                      : "Caching and data structures, with optional sharding."}
                  </span>
                </span>
                <UiIcon name="arrow-right" className="size-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
        {config && editing && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {!database && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfig(null)}
                disabled={locked}
              >
                <UiIcon name="arrow-left" /> Databases
              </Button>
            )}
            {!database && !clusterId && (
              <label className="block space-y-1.5 text-sm">
                <span>Run this database on</span>
                <CustomSelect
                  variant="filled"
                  aria-label="Database server cluster"
                  value={selectedCluster}
                  disabled={locked}
                  options={[
                    {
                      value: "",
                      label: clustersLoading
                        ? "Loading server clusters…"
                        : "Choose a server cluster",
                    },
                    ...clusters.map((row) => ({
                      value: row.id,
                      label: row.name,
                      description: `${row.serverIds.length} servers`,
                    })),
                  ]}
                  onChange={(value) => {
                    setSelectedCluster(value);
                    setCustomStorage(false);
                    change("storageClass", "openship-local");
                  }}
                />
                {!clustersLoading && !clusters.length && (
                  <p className="text-xs text-muted-foreground">
                    Enable scaling on a server cluster first, then return to add your database.
                  </p>
                )}
              </label>
            )}
            <label className="block space-y-1.5 text-sm">
              <span>Name</span>
              <Input
                variant="filled"
                value={name}
                disabled={!!database || locked}
                onChange={(event) => setName(event.target.value)}
                required
                pattern="[a-z][a-z0-9-]*[a-z0-9]|[a-z]"
                maxLength={63}
              />
            </label>
            {!database && (
              <div className="space-y-1.5 text-sm">
                <span>Deployment</span>
                <CustomSelect
                  variant="filled"
                  aria-label="Database deployment"
                  value={config.mode}
                  disabled={!!database || locked}
                  options={[
                    {
                      value: "standalone",
                      label: "Standalone",
                      description: "One database instance with persistent storage.",
                    },
                    ...(config.engine === "redis"
                      ? [
                          {
                            value: "replication",
                            label: scaleText.replication,
                            description: scaleText.redisHint,
                          },
                        ]
                      : []),
                    {
                      value: "cluster",
                      label:
                        config.engine === "postgres" ? scaleText.replication : scaleText.sharding,
                      description: template?.clusterDescription,
                    },
                  ]}
                  onChange={(value) =>
                    setConfig({
                      ...config,
                      mode: value as ClusterDatabaseConfig["mode"],
                      instances: value === "standalone" ? 1 : 3,
                    })
                  }
                />
              </div>
            )}
            {!database && config.mode !== "standalone" && (
              <label className="block space-y-1.5 text-sm">
                <span>
                  {config.engine === "postgres" || config.mode === "replication"
                    ? scaleText.instancesIncludingPrimary
                    : scaleText.shardsWithReplica}
                </span>
                <Input
                  variant="filled"
                  type="number"
                  min={config.engine === "postgres" ? 2 : 3}
                  max={9}
                  step={1}
                  value={config.instances}
                  disabled={locked}
                  onChange={(event) => {
                    change("instances", Number(event.target.value));
                  }}
                />
              </label>
            )}
            {config.engine === "postgres" && (
              <label className="block space-y-1.5 text-sm">
                <span>Database name</span>
                <Input
                  variant="filled"
                  value={config.databaseName}
                  disabled={!!database || locked}
                  onChange={(event) => change("databaseName", event.target.value)}
                  required
                />
              </label>
            )}
            {!database && (
              <ClusterDatabaseImport
                projectId={projectId}
                engine={config.engine}
                value={importFrom}
                onChange={setImportFrom}
                disabled={locked}
              />
            )}
            {!database && config.engine === "postgres" && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Database version</summary>
                <div className="mt-3">
                  <CustomSelect
                    variant="filled"
                    aria-label="PostgreSQL version"
                    disabled={locked}
                    value={config.version ?? "17"}
                    options={[
                      { value: "17", label: "PostgreSQL 17" },
                      { value: "18", label: "PostgreSQL 18" },
                    ]}
                    onChange={(value) => change("version", value as "17" | "18")}
                  />
                </div>
              </details>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5 text-sm">
                <span>CPU per instance</span>
                <Input
                  variant="filled"
                  type="number"
                  min={0.1}
                  max={64}
                  step={0.1}
                  value={config.cpuMillis / 1000}
                  disabled={locked}
                  onChange={(event) =>
                    change("cpuMillis", Math.round(Number(event.target.value) * 1000))
                  }
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span>Memory (MiB)</span>
                <Input
                  variant="filled"
                  type="number"
                  min={256}
                  step={256}
                  value={config.memoryMiB}
                  disabled={locked}
                  onChange={(event) => change("memoryMiB", Number(event.target.value))}
                />
              </label>
            </div>
            <label className="block space-y-1.5 text-sm">
              <span>Storage per instance (GiB)</span>
              <Input
                variant="filled"
                type="number"
                min={database?.config.storageGiB ?? 1}
                step={1}
                value={config.storageGiB}
                disabled={
                  locked ||
                  (!!database &&
                    (config.storageClass === "openship-local" || config.engine === "redis"))
                }
                onChange={(event) => change("storageGiB", Number(event.target.value))}
              />
              {!!database && config.engine === "redis" && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  To increase disk space, restore a backup into a larger database, verify it, then
                  switch the application connection.
                </p>
              )}
            </label>
            <div className="space-y-2 text-sm">
              <span>Keep database files on</span>
              <CustomSelect
                variant="filled"
                aria-label="Database storage"
                disabled={!!database || locked}
                value={customStorage ? "custom" : config.storageClass}
                options={[
                  ...(sharedStorage || config.storageClass === MANAGED_STORAGE_CLASS
                    ? [
                        {
                          value: MANAGED_STORAGE_CLASS,
                          label: "Replicated disks",
                          description: "Each instance's disk has copies on other servers.",
                        },
                      ]
                    : []),
                  {
                    value: "openship-local",
                    label: "Each server's local disk",
                    description: "Database replicas keep separate copies of the data.",
                  },
                  {
                    value: "custom",
                    label: "Custom storage",
                    description: "Use storage already configured for this cluster.",
                  },
                ]}
                onChange={(value) => {
                  setCustomStorage(value === "custom");
                  change("storageClass", value === "custom" ? "" : value);
                }}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Each database instance keeps its own disk. Database replicas never share a writable
                data folder.
              </p>
              {config.storageClass === "openship-local" && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Local disk sizes are reservations. If a server is lost, recovery uses another
                  database replica or a backup.
                </p>
              )}
              {customStorage && (
                <div className="space-y-2 rounded-xl bg-muted/30 p-3">
                  <label className="block space-y-1.5">
                    <span>Storage class</span>
                    <Input
                      variant="filled"
                      value={config.storageClass}
                      disabled={!!database || locked}
                      onChange={(event) => change("storageClass", event.target.value)}
                    />
                  </label>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Enter the name of a storage class already installed by your infrastructure
                    administrator.
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-2 rounded-xl bg-muted/30 p-3 text-sm">
              <p>
                {clusterDatabasePodCount(config)} separate{" "}
                {clusterDatabasePodCount(config) === 1 ? "server" : "servers"} required.
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {config.mode === "standalone"
                  ? "A standalone database has no replica to take over if its server fails."
                  : config.engine === "postgres"
                    ? "PostgreSQL synchronously replicates to at least one standby before acknowledging writes. Writes wait if no standby is available."
                    : "Redis replicates asynchronously. A failover can lose recently acknowledged writes. Each shard and replica uses a different server."}
              </p>
              {config.mode === "replication" && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {scaleText.sentinelHint}
                </p>
              )}
            </div>
            {!database && config.engine === "redis" && config.mode === "cluster" && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={clusterClient}
                  onCheckedChange={setClusterClient}
                  disabled={locked}
                />
                <span>My application uses a Redis Cluster client.</span>
              </label>
            )}
            <ClusterDatabaseBackupSettings
              engine={config.engine}
              value={config.backup}
              configured={!!database?.config.backup}
              disabled={locked}
              onChange={(value) => change("backup", value)}
            />
            {config.engine === "redis" && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {config.mode === "cluster"
                  ? "Replicas provide failover and do not replace a backup."
                  : config.mode === "replication"
                    ? scaleText.redisHint
                    : "Standalone Redis has no failover replica."}{" "}
                Save backups to recover older data or move it into a new database.
              </p>
            )}
            {database && staleSettings && (
              <p role="alert" className="text-xs text-warning">
                {scaleText.settingsChanged}
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={
                locked ||
                (!!database && staleSettings) ||
                (!database && !selectedCluster) ||
                (!database &&
                  config.engine === "redis" &&
                  config.mode === "cluster" &&
                  !clusterClient)
              }
            >
              {busy ? (
                <UiIcon name="spinner" className="animate-spin" />
              ) : (
                <UiIcon name="database" />
              )}
              {database ? "Apply database settings" : "Create database"}
            </Button>
            {database && (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setConfig(database.config);
                  setEditing(false);
                }}
                disabled={locked}
              >
                Cancel changes
              </Button>
            )}
          </form>
        )}
        {database && !editing && tab === "scaling" && (
          <ClusterDatabaseScaling
            database={database}
            disabled={locked || database.status !== "ready"}
            onRecovery={() => {
              setTab("overview");
              if (!database.config.backup) {
                setConfig(database.config);
                setEditingSequence(database.sequence);
                setEditing(true);
              }
            }}
            onApply={async (nextConfig, expectedSequence, confirmRedisRebalance) => {
              const row = await run(() =>
                clusterDatabasesApi.update(projectId, {
                  databaseId: database.id,
                  expectedSequence,
                  config: nextConfig,
                  ...(confirmRedisRebalance ? { confirmRedisRebalance } : {}),
                }),
              );
              if (row) setTab("overview");
              return row;
            }}
          />
        )}
        {database && !editing && tab === "overview" && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1 font-medium">
                {running
                  ? database.intent === "remove"
                    ? "Removing database"
                    : database.intent === "backup"
                      ? "Saving backup"
                      : "Setting up database"
                  : database.status === "ready"
                    ? databaseReady
                      ? "Database ready"
                      : "Database needs attention"
                    : database.status === "retained"
                      ? "Database stopped"
                      : database.intent === "backup"
                        ? "Backup needs attention"
                        : database.intent === "remove"
                          ? "Removal needs attention"
                          : "Setup needs attention"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label="Refresh database status"
                onClick={() => void run(() => clusterDatabasesApi.inspect(projectId, database.id))}
              >
                {busy ? (
                  <UiIcon name="spinner" className="animate-spin" />
                ) : (
                  <UiIcon name="refresh" />
                )}
              </Button>
            </div>
            {database.error && (
              <p role="alert" className="text-sm text-danger">
                {database.error}
              </p>
            )}
            {database.observation && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Checked {new Date(database.observation.observedAt).toLocaleString()}
                </p>
                {database.observation.pods.map((pod) => (
                  <div
                    key={pod.name}
                    className="flex items-center gap-3 rounded-xl bg-muted/30 p-3"
                  >
                    <UiIcon
                      name="check-circle"
                      className={`size-4 ${pod.ready ? "text-success" : "text-warning"}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm capitalize">{pod.role}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {pod.serverName ?? "Waiting for a server"}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {pod.ready ? "Ready" : pod.phase}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {(running || database.status === "failed" || database.status === "interrupted") && (
              <NetworkSetupProgress
                hosts={[
                  {
                    serverId: database.id,
                    name: database.name,
                    address: "",
                    steps: (database.intent === "remove"
                      ? (["connect", "remove"] as const)
                      : database.intent === "backup"
                        ? (["connect", "backup"] as const)
                        : [
                            ...CLUSTER_DATABASE_STEPS,
                            ...(database.progress.steps.some((step) => step.id === "restore")
                              ? ["restore" as const]
                              : []),
                            ...(database.config.backup ? ["backup" as const] : []),
                          ]
                    ).map(
                      (id) =>
                        database.progress.steps.find((step) => step.id === id) ?? {
                          id,
                          status: "pending",
                          message: null,
                          startedAt: null,
                          finishedAt: null,
                        },
                    ),
                    logs: database.progress.logs,
                  },
                ]}
                running={running}
                stepLabels={stepLabels}
                logsInitiallyCollapsed={false}
              />
            )}
            {(database.status === "failed" || database.status === "interrupted") && (
              <Button
                disabled={locked}
                className="w-full"
                onClick={() => void run(() => clusterDatabasesApi.retry(projectId, database))}
              >
                <UiIcon name="rotate-left" />{" "}
                {database.intent === "remove"
                  ? "Retry removal"
                  : database.intent === "backup"
                    ? "Retry backup"
                    : "Retry from saved setup"}
              </Button>
            )}
            {database.status === "ready" && (
              <>
                <Button
                  variant="secondary"
                  className="w-full justify-between"
                  disabled={locked}
                  onClick={() => setTab("scaling")}
                >
                  <span className="flex items-center gap-2">
                    <UiIcon name="layers" />
                    {scaleText.scale}
                  </span>
                  <UiIcon name="arrow-right" />
                </Button>
                <div className="space-y-3 rounded-xl bg-muted/30 p-3">
                  <p className="text-sm font-medium">Application connection</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Credentials stay encrypted. Connecting adds a private URL to this project's
                    environment; redeploy the application to use it.
                  </p>
                  {!applicationOnCluster ? (
                    <div className="space-y-2 text-sm">
                      <p>
                        This database is ready for your move. Choose its server cluster in the
                        application's scaling settings, then connect and deploy.
                      </p>
                      {onChooseCluster && (
                        <Button variant="secondary" size="sm" onClick={onChooseCluster}>
                          Application scaling settings
                        </Button>
                      )}
                    </div>
                  ) : database.envKey ? (
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all text-sm">{database.envKey}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Disconnect database"
                        disabled={locked}
                        onClick={() =>
                          void run(
                            () => clusterDatabasesApi.connect(projectId, database, null),
                            "Connection removed. Redeploy the application to apply it.",
                          )
                        }
                      >
                        <UiIcon name="unplug" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <label className="block space-y-1.5 text-sm">
                        <span>Environment variable</span>
                        <Input
                          variant="filled"
                          value={envKey}
                          onChange={(event) => {
                            setEnvKey(event.target.value);
                            setSwitchReviewed(false);
                          }}
                          disabled={locked}
                        />
                      </label>
                      {previousConnection && (
                        <label className="flex items-start gap-2 text-sm">
                          <Checkbox
                            checked={switchReviewed}
                            onCheckedChange={setSwitchReviewed}
                            disabled={locked}
                          />
                          <span>
                            Use {database.name} instead of {previousConnection.name} for{" "}
                            {envKey.trim()}. I have verified the copied data and paused writes for
                            this switch.
                          </span>
                        </label>
                      )}
                      <Button
                        className="w-full"
                        disabled={
                          locked || !envKey.trim() || (!!previousConnection && !switchReviewed)
                        }
                        onClick={() =>
                          void run(
                            () =>
                              clusterDatabasesApi.connect(
                                projectId,
                                database,
                                envKey.trim(),
                                previousConnection
                                  ? {
                                      databaseId: previousConnection.id,
                                      expectedSequence: previousConnection.sequence,
                                    }
                                  : undefined,
                              ),
                            "Connection saved. Redeploy the application to use it.",
                          )
                        }
                      >
                        Connect application
                      </Button>
                    </>
                  )}
                  {applicationOnCluster &&
                    database.config.engine === "postgres" &&
                    database.config.instances > 1 && (
                      <div className="space-y-3 border-t border-border/50 pt-3">
                        <p className="text-sm font-medium">{scaleText.readerConnection}</p>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {scaleText.readerHint}
                        </p>
                        {database.readEnvKey ? (
                          <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 break-all text-sm">
                              {database.readEnvKey}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={scaleText.disconnectReader}
                              disabled={locked}
                              onClick={() =>
                                void run(
                                  () =>
                                    clusterDatabasesApi.connect(
                                      projectId,
                                      database,
                                      database.envKey,
                                      undefined,
                                      null,
                                    ),
                                  scaleText.connectionSaved,
                                )
                              }
                            >
                              <UiIcon name="unplug" />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <label className="block space-y-1.5 text-sm">
                              <span>{scaleText.readerVariable}</span>
                              <Input
                                variant="filled"
                                value={readEnvKey}
                                disabled={locked}
                                onChange={(event) => setReadEnvKey(event.target.value)}
                              />
                            </label>
                            <Button
                              className="w-full"
                              variant="secondary"
                              disabled={
                                locked ||
                                !readEnvKey.trim() ||
                                readEnvKey.trim() === database.envKey
                              }
                              onClick={() =>
                                void run(
                                  () =>
                                    clusterDatabasesApi.connect(
                                      projectId,
                                      database,
                                      database.envKey,
                                      undefined,
                                      readEnvKey.trim(),
                                    ),
                                  scaleText.connectionSaved,
                                )
                              }
                            >
                              {scaleText.connectReader}
                            </Button>
                            {readEnvKey.trim() === database.envKey && (
                              <p role="alert" className="text-xs text-danger">
                                {scaleText.distinctVariables}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={locked}
                  onClick={() => {
                    setConfig(database.config);
                    setEditingSequence(database.sequence);
                    setEditing(true);
                  }}
                >
                  Database settings
                </Button>
              </>
            )}
            {database.config.backup &&
              (database.status === "ready" || database.status === "retained") && (
                <ClusterDatabaseBackups
                  database={database}
                  disabled={locked}
                  onBackup={() => void run(() => clusterDatabasesApi.backup(projectId, database))}
                  onRestore={(input) =>
                    void run(() => clusterDatabasesApi.create(projectId, input))
                  }
                />
              )}
            {database.status === "ready" && database.config.engine === "postgres" && (
              <ClusterDatabaseCopy
                database={database}
                disabled={locked}
                onCopy={(input) => void run(() => clusterDatabasesApi.create(projectId, input))}
              />
            )}
            <Button
              variant="secondary"
              disabled={locked || database.status !== "ready"}
              onClick={() => setSharing(true)}
            >
              <UiIcon name="plug" /> {t.projects.connections.useInProject}
            </Button>
            <UseInProjectModal
              open={sharing}
              onClose={() => setSharing(false)}
              sourceProjectId={projectId}
              sourceDatabaseId={database.id}
            />
            <details className="rounded-xl bg-muted/30 p-3 text-sm">
              <summary className="cursor-pointer">Connection and storage details</summary>
              <dl className="mt-3 space-y-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">Private host</dt>
                  <dd className="mt-1 break-all">{database.internalHost}</dd>
                </div>
                {database.readOnlyHost && (
                  <div>
                    <dt className="text-muted-foreground">Read-only host</dt>
                    <dd className="mt-1 break-all">{database.readOnlyHost}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">Database management</dt>
                  <dd className="mt-1">{template?.operator}</dd>
                </div>
                {database.observation?.volumes.map((volume) => (
                  <div key={volume.name}>
                    <dt className="break-all text-muted-foreground">{volume.name}</dt>
                    <dd>
                      {volume.capacity ?? "Allocating"} · {volume.phase}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Setup history</summary>
              <div className="mt-3 max-h-64 space-y-2 overflow-y-auto text-xs">
                {database.progress.logs.map((entry, index) => (
                  <p
                    key={index}
                    className={entry.level === "error" ? "text-danger" : "text-muted-foreground"}
                  >
                    {entry.message}
                  </p>
                ))}
              </div>
            </details>
            {!(
              database.intent === "remove" && ["failed", "interrupted"].includes(database.status)
            ) && (
              <div className="pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={() => setRemoving(!removing)}
                >
                  <UiIcon name="trash" /> Remove database
                </Button>
                {removing && (
                  <div className="mt-3 space-y-3 rounded-xl bg-muted/30 p-3 text-sm">
                    {database.envKey || database.readEnvKey ? (
                      <p>Disconnect the application before removing this database.</p>
                    ) : (
                      <>
                        <p>Stop the database and keep its disks, or explicitly delete its data.</p>
                        <label className="flex items-start gap-2">
                          <Checkbox
                            checked={deleteData}
                            onCheckedChange={setDeleteData}
                            disabled={locked}
                          />
                          <span>Permanently delete the database data.</span>
                        </label>
                        <label className="block space-y-1.5">
                          <span>Type {database.name} to confirm</span>
                          <Input
                            variant="filled"
                            value={removeName}
                            onChange={(event) => setRemoveName(event.target.value)}
                            disabled={locked}
                          />
                        </label>
                        <Button
                          variant={deleteData ? "destructive" : "secondary"}
                          disabled={locked || removeName !== database.name}
                          onClick={() =>
                            void run(() =>
                              clusterDatabasesApi.remove(
                                projectId,
                                database,
                                removeName,
                                deleteData,
                              ),
                            )
                          }
                        >
                          {deleteData ? "Delete database and data" : "Stop and keep data"}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
