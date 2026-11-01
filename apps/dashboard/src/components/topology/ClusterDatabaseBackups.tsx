"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useRef, useState } from "react";
import type { ClusterDatabase } from "@repo/contracts";
import type { ClusterDatabaseConfig } from "@repo/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { BackupDestinationSelect } from "@/components/backup/BackupDestinationSelect";
import { randomUUID } from "@/lib/random-uuid";
import { useI18n } from "@/components/i18n-provider";

export function ClusterDatabaseBackupSettings({
  value,
  onChange,
  configured,
  disabled,
  engine = "postgres",
}: {
  value: ClusterDatabaseConfig["backup"];
  onChange: (value: ClusterDatabaseConfig["backup"]) => void;
  configured: boolean;
  disabled: boolean;
  engine?: ClusterDatabaseConfig["engine"];
}) {
  return (
    <details className="rounded-xl bg-muted/30 p-3 text-sm" open={!!value}>
      <summary className="cursor-pointer">
        Backups {value ? "· Configured" : "· Choose a destination"}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {engine === "postgres"
            ? "Save database data and recovery logs to your backup destination."
            : "Save Redis data snapshots to your backup destination. Each data partition has its own recovery point."}{" "}
          The cluster runs the schedule even when OpenShip is offline.
        </p>
        <BackupDestinationSelect
          value={value?.destinationId ?? ""}
          disabled={disabled || configured}
          optional={!configured}
          onChange={(destinationId) =>
            onChange(
              destinationId
                ? {
                    destinationId,
                    schedule: value?.schedule ?? "daily",
                    retentionDays: value?.retentionDays ?? 30,
                  }
                : undefined,
            )
          }
        />
        {value && (
          <>
            <CustomSelect
              variant="filled"
              aria-label="Backup schedule"
              value={value.schedule}
              disabled={disabled}
              options={[
                { value: "daily", label: "Daily at 03:00 UTC" },
                { value: "hourly", label: "Every hour" },
                { value: "manual", label: "Manual backups" },
              ]}
              onChange={(schedule) =>
                onChange({ ...value, schedule: schedule as NonNullable<typeof value>["schedule"] })
              }
            />
            <label className="block space-y-1.5">
              <span>Recovery window (days)</span>
              <Input
                variant="filled"
                type="number"
                min={7}
                max={365}
                step={1}
                value={value.retentionDays}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...value, retentionDays: Number(event.target.value) })
                }
              />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Setup verifies the first backup.{" "}
              {engine === "postgres"
                ? "Recovery logs continue to archive between backups."
                : "Redis snapshots preserve data and expiration times. A sharded backup does not provide one transaction across all partitions."}
              Restores create a separate database.
            </p>
          </>
        )}
      </div>
    </details>
  );
}

export function ClusterDatabaseBackups({
  database,
  disabled,
  onBackup,
  onRestore,
}: {
  database: ClusterDatabase;
  disabled: boolean;
  onBackup: () => void;
  onRestore: (input: {
    requestId: string;
    name: string;
    config: ClusterDatabaseConfig;
    clusterId?: string;
    restoreFrom: { databaseId: string; backupName: string };
    clusterAwareClient?: true;
  }) => void;
}) {
  const { t } = useI18n();
  const text = t.projects.quickScale;
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(`${database.name.slice(0, 54)}-restored`);
  const [storageGiB, setStorageGiB] = useState(database.config.storageGiB);
  const [restoreMode, setRestoreMode] = useState(database.config.mode);
  const [restoreInstances, setRestoreInstances] = useState(database.config.instances);
  const canChooseReplication =
    database.config.engine === "redis" && database.config.mode !== "cluster";
  const validInstances =
    !canChooseReplication ||
    restoreMode === "standalone" ||
    (Number.isInteger(restoreInstances) && restoreInstances >= 3 && restoreInstances <= 9);
  const request = useRef(randomUUID());
  const backups = database.observation?.backups ?? [];
  const archive = database.observation?.archive;
  return (
    <div className="space-y-3 rounded-xl bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <UiIcon name="archive" className="size-4 text-primary" />
        <h3 className="flex-1 text-sm font-medium">Backups and recovery</h3>
        {database.status === "ready" && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onBackup}>
            Back up now
          </Button>
        )}
      </div>
      {archive && (
        <p
          className={`text-xs leading-relaxed ${archive.healthy === false ? "text-warning" : "text-muted-foreground"}`}
        >
          {archive.healthy && database.config.engine === "postgres"
            ? "Recovery logs are archiving successfully."
            : archive.message}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {database.config.backup?.schedule === "daily"
          ? "Daily at 03:00 UTC"
          : database.config.backup?.schedule === "hourly"
            ? "Every hour"
            : "Manual backups"}{" "}
        · {database.config.backup?.retentionDays} day recovery window
      </p>
      {!backups.length && (
        <p className="text-xs text-muted-foreground">
          No completed backup has been observed yet. Refresh the database status to check its
          progress.
        </p>
      )}
      {backups.slice(0, 10).map((backup) => (
        <div key={backup.name} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className="block">
              {backup.completedAt || backup.startedAt
                ? new Date(backup.completedAt ?? backup.startedAt!).toLocaleString()
                : "Backup requested"}
            </span>
            <span
              className={`block text-xs ${backup.phase === "failed" ? "text-danger" : "text-muted-foreground"}`}
            >
              {backup.error ?? backup.phase}
            </span>
          </span>
          {backup.phase === "completed" && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Restore backup ${backup.name}`}
              disabled={disabled}
              onClick={() => {
                request.current = randomUUID();
                setSelected(backup.name);
              }}
            >
              <UiIcon name="rotate-left" />
            </Button>
          )}
        </div>
      ))}
      {selected && (
        <form
          className="space-y-3 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            onRestore({
              requestId: request.current,
              name,
              clusterId: database.clusterId,
              config: {
                ...database.config,
                storageGiB,
                ...(canChooseReplication
                  ? {
                      mode: restoreMode,
                      instances: restoreMode === "standalone" ? 1 : restoreInstances,
                    }
                  : {}),
              },
              restoreFrom: { databaseId: database.id, backupName: selected },
              ...(database.config.engine === "redis" && database.config.mode === "cluster"
                ? { clusterAwareClient: true }
                : {}),
            });
          }}
        >
          <p className="text-sm font-medium">Restore as a new database</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {database.config.engine === "postgres"
              ? "Restore to this backup's consistent recovery point."
              : "Recover the saved Redis snapshots, keeping each key's expiration time."}{" "}
            The application keeps its current connection. Verify the restored data before switching
            it.
          </p>
          <label className="block space-y-1.5 text-sm">
            <span>New database name</span>
            <Input
              variant="filled"
              value={name}
              required
              pattern="[a-z][a-z0-9-]*[a-z0-9]|[a-z]"
              maxLength={63}
              disabled={disabled}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {canChooseReplication && (
            <div className="space-y-3">
              <label className="block space-y-1.5 text-sm">
                <span>{text.restoreDeployment}</span>
                <CustomSelect
                  variant="filled"
                  aria-label={text.restoreDeployment}
                  value={restoreMode}
                  disabled={disabled}
                  options={[
                    { value: "standalone", label: text.singleInstance },
                    { value: "replication", label: text.replication, description: text.redisHint },
                  ]}
                  onChange={(value) => {
                    setRestoreMode(value as "standalone" | "replication");
                    setRestoreInstances(
                      value === "standalone" ? 1 : Math.max(3, database.config.instances),
                    );
                  }}
                />
              </label>
              {restoreMode === "replication" && (
                <label className="block space-y-1.5 text-sm">
                  <span>{text.instancesIncludingPrimary}</span>
                  <Input
                    variant="filled"
                    type="number"
                    min={3}
                    max={9}
                    step={1}
                    required
                    value={restoreInstances}
                    disabled={disabled}
                    onChange={(event) => setRestoreInstances(Number(event.target.value))}
                  />
                </label>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                {text.restoreReplicationHint}
              </p>
              {!validInstances && (
                <p role="alert" className="text-xs text-danger">
                  {text.invalidCount}
                </p>
              )}
            </div>
          )}
          <label className="block space-y-1.5 text-sm">
            <span>Storage per instance (GiB)</span>
            <Input
              variant="filled"
              type="number"
              min={database.config.storageGiB}
              max={16384}
              step={1}
              value={storageGiB}
              disabled={disabled}
              onChange={(event) => setStorageGiB(Number(event.target.value))}
              required
            />
            <span className="block text-xs text-muted-foreground">
              Use a larger disk when the database needs more room.
            </span>
          </label>
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={disabled || !name.trim() || name === database.name || !validInstances}
            >
              Restore database
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => setSelected(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
