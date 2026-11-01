"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { clusterDatabasesApi } from "@/lib/api/cluster-databases";
import { getApiErrorMessage } from "@/lib/api";

export function ClusterDatabaseImport({
  projectId,
  engine,
  value,
  onChange,
  disabled,
}: {
  projectId: string;
  engine: "postgres" | "redis";
  value?: { runId: string; artifactName: string };
  onChange: (value?: { runId: string; artifactName: string }) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(!!value);
  const [options, setOptions] = useState<Awaited<ReturnType<typeof clusterDatabasesApi.imports>>>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    void clusterDatabasesApi
      .imports(projectId)
      .then((rows) => {
        if (active) setOptions(rows.filter((row) => row.engine === engine));
      })
      .catch((reason) => {
        if (active) setError(getApiErrorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, engine, open]);
  const identity = (row: { runId: string; artifactName: string }) =>
    JSON.stringify([row.runId, row.artifactName]);
  return (
    <details
      className="rounded-xl bg-muted/30 p-3 text-sm"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">
        Import existing data{value ? " · Backup selected" : ""}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Recover a backup into this new database. Pause writes and take a fresh backup before your
          final move; changes made after the backup will stay on the original database.
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <CustomSelect
          variant="filled"
          aria-label="Database backup to import"
          value={value ? identity(value) : ""}
          disabled={disabled || loading}
          options={[
            { value: "", label: loading ? "Loading backups…" : "Start with an empty database" },
            ...options.map((row) => ({
              value: identity(row),
              label: row.sourceName,
              description: `${row.completedAt ? new Date(row.completedAt).toLocaleString() : "Completed backup"} · ${Math.max(1, Math.round(row.sizeBytes / 1024 / 1024))} MiB`,
            })),
          ]}
          onChange={(selected) => {
            const row = options.find((row) => identity(row) === selected);
            onChange(row ? { runId: row.runId, artifactName: row.artifactName } : undefined);
          }}
        />
        {!loading && !error && !options.length && (
          <p className="text-xs text-muted-foreground">
            Take a PostgreSQL or Redis backup to an S3-compatible destination from this project's
            backup settings. Completed backups with verified integrity appear here.
          </p>
        )}
        <Link
          href={`/projects/${projectId}/backup`}
          className="text-xs text-primary hover:underline"
        >
          Project backup settings
        </Link>
      </div>
    </details>
  );
}
