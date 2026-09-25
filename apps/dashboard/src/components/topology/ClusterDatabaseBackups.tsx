"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ClusterDatabase } from "@repo/contracts";
import type { ClusterDatabaseConfig } from "@repo/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { backupDestinationsApi, type BackupDestinationSummary } from "@/lib/api/backups";
import { randomUUID } from "@/lib/random-uuid";
import { getApiErrorMessage } from "@/lib/api";

export function ClusterDatabaseBackupSettings({
  value,
  onChange,
  configured,
  disabled,
}: {
  value: ClusterDatabaseConfig["backup"];
  onChange: (value: ClusterDatabaseConfig["backup"]) => void;
  configured: boolean;
  disabled: boolean;
}) {
  const [destinations, setDestinations] = useState<BackupDestinationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void backupDestinationsApi
      .list()
      .then((response) => {
        if (active) setDestinations(response.data.filter((item) => item.kind === "s3_compatible"));
      })
      .catch((err) => {
        if (active) setError(getApiErrorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <details className="rounded-xl bg-muted/30 p-3 text-sm" open={!!value}>
      <summary className="cursor-pointer">
        Backups {value ? "· Configured" : "· Choose a destination"}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Save PostgreSQL data and recovery logs to an existing S3 destination. The database cluster
          runs the schedule even when OpenShip is offline.
        </p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <CustomSelect
          variant="filled"
          aria-label="Backup destination"
          value={value?.destinationId ?? ""}
          disabled={disabled || configured}
          placeholder="Choose backup destination"
          options={[
            ...(!configured ? [{ value: "", label: "Configure later" }] : []),
            ...destinations.map((item) => ({
              value: item.id,
              label: item.name,
              description: item.bucket ?? undefined,
            })),
          ]}
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
        {!destinations.length && !error && (
          <Link href="/backups" className="text-primary hover:underline">
            Add an S3 destination in Backups
          </Link>
        )}
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
              Setup verifies the first backup. Recovery logs continue to archive between backups.
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
    restoreFrom: { databaseId: string; backupName: string };
  }) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(`${database.name.slice(0, 54)}-restored`);
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
          {archive.healthy ? "Recovery logs are archiving successfully." : archive.message}
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
          No completed backup has been observed yet. Refresh the database status to check the
          operator.
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
              config: database.config,
              restoreFrom: { databaseId: database.id, backupName: selected },
            });
          }}
        >
          <p className="text-sm font-medium">Restore as a new database</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Restore to this backup's consistent recovery point. The application keeps its current
            connection. Verify the restored data before switching it.
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
          <div className="flex gap-2">
            <Button type="submit" disabled={disabled || !name.trim() || name === database.name}>
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
