"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useRef, useState } from "react";
import {
  CLUSTER_DATABASE_TEMPLATES,
  CLUSTER_DATABASE_STEPS,
  clusterDatabasePodCount,
  clusterDatabaseRunning,
  validateClusterDatabase,
  type ClusterDatabaseConfig,
} from "@repo/core";
import type { ClusterDatabase } from "@repo/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Checkbox } from "@/components/ui/Checkbox";
import { ResourceIcon } from "@/components/scale/ResourceIcon";
import { NetworkSetupProgress } from "@/components/servers/clusters/NetworkSetupProgress";
import { clusterDatabasesApi } from "@/lib/api/cluster-databases";
import { getApiErrorMessage } from "@/lib/api";
import { randomUUID } from "@/lib/random-uuid";
import { ClusterDatabaseBackupSettings, ClusterDatabaseBackups } from "./ClusterDatabaseBackups";

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
};

export function ClusterDatabasePanel({
  projectId,
  database,
  onSaved,
  onClose,
  onMinimize,
  onDeploy,
  disabled = false,
}: {
  projectId: string;
  database?: ClusterDatabase;
  onSaved: (row: ClusterDatabase) => void;
  onClose: () => void;
  onMinimize?: () => void;
  onDeploy: () => void;
  disabled?: boolean;
}) {
  const [config, setConfig] = useState<ClusterDatabaseConfig | null>(database?.config ?? null);
  const [name, setName] = useState(database?.name ?? "");
  const [editing, setEditing] = useState(!database);
  const [envKey, setEnvKey] = useState(
    database?.envKey ?? (database?.config.engine === "redis" ? "REDIS_URL" : "DATABASE_URL"),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clusterClient, setClusterClient] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeName, setRemoveName] = useState("");
  const [deleteData, setDeleteData] = useState(false);
  const request = useRef(randomUUID());
  const lock = useRef(false);
  const running = !!database && clusterDatabaseRunning(database.status);
  const locked = disabled || busy || running;
  const template = CLUSTER_DATABASE_TEMPLATES.find((item) => item.id === config?.engine);
  const change = <K extends keyof ClusterDatabaseConfig>(key: K, value: ClusterDatabaseConfig[K]) =>
    setConfig((old) => (old ? { ...old, [key]: value } : old));
  const run = async (work: () => Promise<ClusterDatabase>, message?: string) => {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const row = await work();
      onSaved(row);
      if (message) setNotice(message);
      return row;
    } catch (err) {
      setError(
        getApiErrorMessage(
          err,
          "The database operation failed. Refresh its saved progress before retrying.",
        ),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!config || locked) return;
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
            expectedSequence: database.sequence,
            config,
          })
        : clusterDatabasesApi.create(projectId, {
            requestId: request.current,
            name,
            config,
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
                  setConfig(defaults(item.id));
                  setName(item.id);
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
                  { value: "cluster", label: "Cluster", description: template?.clusterDescription },
                ]}
                onChange={(value) =>
                  setConfig({
                    ...config,
                    mode: value as "standalone" | "cluster",
                    instances: value === "cluster" ? 3 : 1,
                  })
                }
              />
            </div>
            {config.mode === "cluster" && (
              <label className="block space-y-1.5 text-sm">
                <span>
                  {config.engine === "postgres"
                    ? "Instances, including the primary"
                    : "Shards, each with one replica"}
                </span>
                <Input
                  variant="filled"
                  type="number"
                  min={3}
                  max={9}
                  step={1}
                  value={config.instances}
                  disabled={locked || (!!database && config.engine === "redis")}
                  onChange={(event) => change("instances", Number(event.target.value))}
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
                  Redis storage size is fixed after creation. CPU and memory can still be changed.
                </p>
              )}
            </label>
            <details className="rounded-xl bg-muted/30 p-3 text-sm">
              <summary className="cursor-pointer">Storage options</summary>
              <div className="mt-3 space-y-2">
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
                  OpenShip prepares local disks automatically. Local disk sizes are reservations,
                  not enforced quotas; a lost server loses its local copy. Use an installed CSI
                  storage class for external durable volumes.
                </p>
              </div>
            </details>
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
            {config.engine === "postgres" && (
              <ClusterDatabaseBackupSettings
                value={config.backup}
                configured={!!database?.config.backup}
                disabled={locked}
                onChange={(value) => change("backup", value)}
              />
            )}
            {config.engine === "redis" && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {config.mode === "cluster"
                  ? "Replicas provide failover and do not replace a backup."
                  : "Standalone Redis has no failover replica."}{" "}
                Automated Redis archive backup and restore are not available in this template yet.
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={
                locked ||
                (!database &&
                  config.engine === "redis" &&
                  config.mode === "cluster" &&
                  !clusterClient)
              }
            >
              {busy ? <UiIcon name="spinner" className="animate-spin" /> : <UiIcon name="database" />}
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
        {database && !editing && (
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
                    ? database.observation?.ready
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
                {busy ? <UiIcon name="spinner" className="animate-spin" /> : <UiIcon name="refresh" />}
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
                    <UiIcon name="check-circle"
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
                <div className="space-y-3 rounded-xl bg-muted/30 p-3">
                  <p className="text-sm font-medium">Application connection</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Credentials stay encrypted. Connecting adds a private URL to this project's
                    environment; redeploy the application to use it.
                  </p>
                  {database.envKey ? (
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
                          onChange={(event) => setEnvKey(event.target.value)}
                          disabled={locked}
                        />
                      </label>
                      <Button
                        className="w-full"
                        disabled={locked || !envKey.trim()}
                        onClick={() =>
                          void run(
                            () => clusterDatabasesApi.connect(projectId, database, envKey.trim()),
                            "Connection saved. Redeploy the application to use it.",
                          )
                        }
                      >
                        Connect application
                      </Button>
                    </>
                  )}
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={locked}
                  onClick={() => {
                    setConfig(database.config);
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
                    {database.envKey ? (
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
