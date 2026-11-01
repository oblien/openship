"use client";

import { useState } from "react";
import { Icon } from "@repo/ui/icons";
import type { ClusterVolumeBackup } from "@repo/core";
import { Button } from "@/components/ui/button";

export function ClusterVolumeBackups({
  backups,
  disabled,
  onRestore,
  onDelete,
}: {
  backups: ClusterVolumeBackup[];
  disabled: boolean;
  onRestore(backup: ClusterVolumeBackup): void;
  onDelete(backup: ClusterVolumeBackup): void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  if (!backups.length) return <p className="text-xs text-muted-foreground">No file backups yet.</p>;
  return (
    <div className="space-y-3">
      {backups.map((backup) => (
        <div key={backup.name} className="space-y-2">
          <div className="flex items-center gap-2">
            <Icon
              name={
                backup.state === "Completed" ? "archive" : backup.error ? "alert-circle" : "refresh"
              }
              className={`size-4 shrink-0 ${backup.error ? "text-danger" : "text-info"}`}
            />
            <div className="min-w-0 flex-1 text-xs">
              <p className="truncate font-medium">
                {backup.volumeName} ·{" "}
                {backup.createdAt
                  ? new Date(backup.createdAt).toLocaleString()
                  : "Backup requested"}
              </p>
              <p className={backup.error ? "text-danger" : "text-muted-foreground"}>
                {backup.error ||
                  (backup.state === "Completed"
                    ? `${Math.ceil(backup.sizeGiB)} GiB · Ready to restore`
                    : backup.state === "Deleting"
                      ? "Deleting archive"
                      : `${backup.state} · ${backup.progress}%`)}
              </p>
            </div>
            {backup.state === "Completed" && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Restore ${backup.volumeName} backup`}
                disabled={disabled}
                onClick={() => onRestore(backup)}
              >
                <Icon name="rotate-left" className="size-4" />
              </Button>
            )}
            {["Completed", "Error"].includes(backup.state) && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${backup.volumeName} backup`}
                disabled={disabled}
                onClick={() => setDeleting(deleting === backup.name ? null : backup.name)}
              >
                <Icon name="trash" className="size-4" />
              </Button>
            )}
          </div>
          {deleting === backup.name && (
            <div className="space-y-2 rounded-lg bg-danger/5 p-3">
              <p className="text-xs">
                Permanently delete this saved backup? Files in the current volume are kept.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={disabled}
                  onClick={() => onDelete(backup)}
                >
                  Delete backup
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
