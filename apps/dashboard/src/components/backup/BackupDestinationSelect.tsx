"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { backupDestinationsApi, type BackupDestinationSummary } from "@/lib/api/backups";
import { getApiErrorMessage } from "@/lib/api";
const DEFAULT_KINDS = ["s3_compatible"] as const;

export function BackupDestinationSelect({
  value,
  onChange,
  disabled = false,
  optional = true,
  kinds = DEFAULT_KINDS,
  label = "Backup destination",
}: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  optional?: boolean;
  kinds?: readonly string[];
  label?: string;
}) {
  const [destinations, setDestinations] = useState<BackupDestinationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void backupDestinationsApi
      .list()
      .then((result) => {
        if (active) setDestinations(result.data.filter((item) => kinds.includes(item.kind)));
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
  }, [kinds]);
  return (
    <div className="space-y-2">
      <CustomSelect
        variant="filled"
        aria-label={label}
        placeholder={loading ? "Loading destinations…" : "Choose backup destination"}
        value={value}
        onChange={onChange}
        disabled={disabled || loading || !!error}
        options={[
          ...(optional ? [{ value: "", label: "Configure later" }] : []),
          ...destinations.map((item) => ({
            value: item.id,
            label: item.name,
            description: item.bucket ?? undefined,
          })),
        ]}
      />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {!loading && !destinations.length && !error && (
        <Link href="/backups" className="text-sm text-primary hover:underline">
          Add a backup destination
        </Link>
      )}
    </div>
  );
}
