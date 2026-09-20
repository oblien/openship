"use client";

import { useMemo, useState } from "react";
import type { ExportHistoryCategory, TransferProject } from "@/lib/api/data-transfer";

export const ALL_HISTORY: ExportHistoryCategory[] = [
  "analytics",
  "activity",
  "backups",
  "incidents",
  "migrations",
];
export const HISTORY_LABELS: Record<ExportHistoryCategory, string> = {
  analytics: "Analytics and resource usage",
  activity: "Audit activity",
  backups: "Backup and restore history",
  incidents: "Service incidents",
  migrations: "Migration history",
};
export const transferInputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
export const transferButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50";

export function TransferOption({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="mt-0.5 size-4 accent-primary"
      />
      <span>
        <span className="font-medium text-foreground">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export function TransferProjectPicker({
  projects,
  selected,
  onChange,
  disabled,
}: {
  projects: TransferProject[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const visible = useMemo(
    () =>
      projects.filter((project) =>
        `${project.name} ${project.slug} ${project.environmentName}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      ),
    [projects, search],
  );
  const groups = useMemo(() => {
    const result = new Map<string, TransferProject[]>();
    for (const project of visible) {
      const list = result.get(project.groupId) ?? [];
      list.push(project);
      result.set(project.groupId, list);
    }
    return [...result.values()];
  }, [visible]);
  const toggle = (ids: string[], checked: boolean) =>
    onChange(
      checked ? [...new Set([...selected, ...ids])] : selected.filter((id) => !ids.includes(id)),
    );
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {selected.length} of {projects.length} environments selected
        </span>
        <span className="flex gap-3">
          <button
            type="button"
            disabled={disabled}
            className="text-primary"
            onClick={() =>
              toggle(
                visible.map((project) => project.id),
                true,
              )
            }
          >
            Select all{search ? " matches" : ""}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              toggle(
                visible.map((project) => project.id),
                false,
              )
            }
          >
            Clear{search ? " matches" : ""}
          </button>
        </span>
      </div>
      <input
        type="search"
        aria-label="Search projects"
        placeholder="Search projects or environments"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className={transferInputClass}
      />
      <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
        {groups.map((group) => (
          <div key={group[0]!.groupId} className="rounded-md bg-muted/30 p-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                aria-label={`All environments of ${group[0]!.name}`}
                disabled={disabled}
                checked={group.every((project) => selected.includes(project.id))}
                onChange={(event) =>
                  toggle(
                    group.map((project) => project.id),
                    event.target.checked,
                  )
                }
                className="size-4 accent-primary"
              />
              {group[0]!.name}
            </label>
            <div className="ms-6 mt-2 space-y-2">
              {group.map((project) => (
                <label
                  key={project.id}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(project.id)}
                    disabled={disabled}
                    onChange={(event) => toggle([project.id], event.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  <span className="flex-1">{project.environmentName}</span>
                  <span>
                    {project.cloudWorkspaceId
                      ? "Cloud"
                      : project.serverId
                        ? "Self-hosted"
                        : "Local host"}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
        {!visible.length && (
          <p className="p-3 text-xs text-muted-foreground">No matching projects.</p>
        )}
      </div>
    </div>
  );
}

export function TransferWarnings({
  warnings,
  blockers = [],
}: {
  warnings: string[];
  blockers?: string[];
}) {
  return (
    <div className="space-y-3">
      {blockers.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-bg p-3 text-xs leading-relaxed text-danger"
        >
          <p className="mb-2 font-semibold">Resolve before importing</p>
          <ul className="list-disc space-y-1 ps-4">
            {blockers.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <details className="rounded-lg border border-warning-border bg-warning-bg p-3 text-xs leading-relaxed text-warning">
          <summary className="cursor-pointer font-medium">
            What to check after transfer ({warnings.length})
          </summary>
          <ul className="mt-2 list-disc space-y-2 ps-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
