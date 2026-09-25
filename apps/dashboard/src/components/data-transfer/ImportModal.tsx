"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import {
  dataTransferApi,
  type ImportMode,
  type ImportPreview,
  type ImportResult,
  type ImportSelection,
} from "@/lib/api/data-transfer";
import { getApiErrorMessage } from "@/lib/api/client";
import { formatBytes } from "@/lib/formatBytes";
import {
  ALL_HISTORY,
  HISTORY_LABELS,
  TransferOption,
  TransferProjectPicker,
  TransferWarnings,
  transferButtonClass,
  transferInputClass,
} from "./TransferOptions";

export function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [archiveScope, setArchiveScope] = useState<"instance" | "projects">("projects");
  const [selection, setSelection] = useState<ImportSelection>({
    scope: "projects",
    conflictPolicy: "skip",
    includeSecrets: true,
  });
  const [reviewedKey, setReviewedKey] = useState("");
  const [mode, setMode] = useState<ImportMode>("merge");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const currentKey = JSON.stringify(selection);
  const reviewed = !!preview && reviewedKey === currentKey;
  const hasSelection = selection.scope === "instance" || !!selection.projectIds?.length;
  const canImport =
    reviewed &&
    hasSelection &&
    !preview.blockers.length &&
    (!preview.hasSecrets || selection.includeSecrets === false || !!passphrase);
  const patch = (value: Partial<ImportSelection>) =>
    setSelection((current) => ({ ...current, ...value }));
  const reportProgress = (done: number, total: number) => setProgress({ done, total });

  const inspect = async (chosen: File) => {
    setFile(chosen);
    setPreview(null);
    setReviewedKey("");
    setError("");
    setBusy(true);
    setProgress(null);
    setPassphrase("");
    setMode("merge");
    try {
      if (chosen.size > 500_000_000) throw new Error("Export files must be no larger than 500 MB.");
      const initial = await dataTransferApi.previewFile(chosen, undefined, reportProgress);
      setArchiveScope(initial.scope);
      // Project selection is the safe default, including when starting from a
      // full instance archive. Whole-instance restore remains an explicit choice.
      const next: ImportSelection = {
        scope: initial.projects.length ? "projects" : initial.scope,
        ...(initial.projects.length
          ? { projectIds: initial.projects.map((project) => project.id) }
          : {}),
        conflictPolicy: "skip",
        history: [...ALL_HISTORY],
        includeSecrets: true,
        includeDomains: true,
        includeBackups: true,
        includeIntegrations: true,
        overwriteDependencies: false,
      };
      setSelection(next);
      const review = await dataTransferApi.previewFile(chosen, next);
      setPreview(review);
      setReviewedKey(JSON.stringify(next));
    } catch (error) {
      setError(getApiErrorMessage(error, "Could not inspect this export."));
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (!file || !hasSelection) return;
    setBusy(true);
    setError("");
    setReviewedKey("");
    try {
      const next = await dataTransferApi.previewFile(file, selection, reportProgress);
      setPreview(next);
      setReviewedKey(currentKey);
    } catch (error) {
      setError(getApiErrorMessage(error, "Could not review this selection."));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!file || !canImport || busy) return;
    const effectiveMode = selection.scope === "projects" ? "merge" : mode;
    if (
      effectiveMode === "wipe" &&
      !window.confirm(
        "Replace this entire instance, including all projects, users, sessions, servers, and settings, with this export? This cannot be undone.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const imported = await dataTransferApi.importFile(
        file,
        selection.includeSecrets === false ? undefined : passphrase || undefined,
        effectiveMode,
        reportProgress,
        selection,
      );
      setResult(imported);
      setPassphrase("");
    } catch (error) {
      setError(getApiErrorMessage(error, "Import failed."));
      // Destination state may have changed since review; keep the uploaded file.
      setReviewedKey("");
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    if (result) window.location.reload();
    else onClose();
  };

  return (
    <Modal
      isOpen={open}
      onClose={close}
      maxWidth="760px"
      width="100%"
      closable={!busy}
      showCloseButton={!busy}
    >
      <div className="space-y-5 p-6">
        <div className="flex items-center gap-3 pe-8">
          <div className="rounded-xl bg-primary/10 p-3 text-primary">
            <UiIcon name="database-backup" className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {result ? "Import complete" : "Import from an export"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose the scope, review dependencies, then import into this control plane.
            </p>
          </div>
        </div>
        {result ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm text-foreground">
              <UiIcon name="check" className="size-4 text-success" />
              {result.rowsRestored.toLocaleString()} records and{" "}
              {result.secretsRehydrated.toLocaleString()} credential records restored.
            </p>
            {result.projectsCreated !== undefined && (
              <p className="text-sm text-muted-foreground">
                {result.projectsCreated} environments created · {result.projectsUpdated} updated ·{" "}
                {result.projectsSkipped} skipped.
              </p>
            )}
            <TransferWarnings
              warnings={[
                ...(result.warnings ?? []),
                ...result.localPathProjects.map(
                  (project) =>
                    `${project.slug}: reconnect or re-upload the source folder (${project.localPath}) before deploying.`,
                ),
              ]}
            />
            <button type="button" className={transferButtonClass} onClick={close}>
              {result.mode === "wipe" ? "Reload and sign in" : "Done"}
            </button>
          </div>
        ) : (
          <>
            <label className="block space-y-2 text-sm font-medium text-foreground">
              1. Choose an export file
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                className={transferInputClass}
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  if (chosen) void inspect(chosen);
                }}
              />
            </label>
            {file && (
              <p className="text-xs text-muted-foreground">
                {file.name} · {formatBytes(file.size)}
                {progress && busy ? ` · Uploaded ${progress.done}/${progress.total} parts` : ""}
              </p>
            )}
            {busy && (
              <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <UiIcon name="spinner" className="size-4 animate-spin" />
                {progress && progress.done < progress.total
                  ? "Uploading export…"
                  : reviewed
                    ? "Importing selected records…"
                    : "Reviewing export and destination…"}
              </p>
            )}
            {preview && (
              <>
                <label className="block space-y-2 text-sm font-medium text-foreground">
                  2. Choose what to import
                  <select
                    aria-label="Import scope"
                    value={selection.scope}
                    disabled={busy}
                    className={transferInputClass}
                    onChange={(event) => {
                      const scope = event.target.value as ImportSelection["scope"];
                      setSelection({
                        scope,
                        conflictPolicy: "skip",
                        includeSecrets: selection.includeSecrets,
                        ...(scope === "projects"
                          ? {
                              projectIds: preview.projects.map((project) => project.id),
                              history: [...ALL_HISTORY],
                            }
                          : {}),
                      });
                      setMode("merge");
                    }}
                  >
                    <option value="projects" disabled={!preview.projects.length}>
                      Selected projects into the current workspace
                    </option>
                    {archiveScope === "instance" && (
                      <option value="instance">
                        Entire instance, including accounts and settings
                      </option>
                    )}
                  </select>
                </label>
                {selection.scope === "projects" ? (
                  <div className="space-y-4">
                    <TransferProjectPicker
                      projects={preview.projects}
                      selected={selection.projectIds ?? []}
                      onChange={(projectIds) => patch({ projectIds })}
                      disabled={busy}
                    />
                    <label className="block space-y-1 text-xs font-medium text-foreground">
                      When a project already exists
                      <select
                        aria-label="Project conflict policy"
                        value={selection.conflictPolicy ?? "skip"}
                        disabled={busy}
                        className={transferInputClass}
                        onChange={(event) =>
                          patch({ conflictPolicy: event.target.value as "skip" | "overwrite" })
                        }
                      >
                        <option value="skip">
                          Keep destination project and skip its imported records
                        </option>
                        <option value="overwrite">Overwrite matching project records</option>
                      </select>
                      <span className="block pt-1 font-normal text-muted-foreground">
                        Overwrite updates matching configuration and history. Destination-only
                        records remain. Shared server connections are reused.
                      </span>
                    </label>
                    {preview.projects.some(
                      (project) =>
                        project.existingProjectId && selection.projectIds?.includes(project.id),
                    ) && (
                      <details className="rounded-lg border border-border p-3 text-xs">
                        <summary className="cursor-pointer font-medium text-foreground">
                          Override individual project conflicts
                        </summary>
                        <div className="mt-3 space-y-3">
                          {preview.projects
                            .filter(
                              (project) =>
                                project.existingProjectId &&
                                selection.projectIds?.includes(project.id),
                            )
                            .map((project) => (
                              <label
                                key={project.id}
                                className="flex items-center justify-between gap-3 text-muted-foreground"
                              >
                                <span>
                                  {project.name} · {project.environmentName}
                                </span>
                                <select
                                  aria-label={`Conflict action for ${project.name} ${project.environmentName}`}
                                  disabled={busy}
                                  className="rounded-md border border-border bg-background p-2 text-foreground"
                                  value={selection.projectActions?.[project.id] ?? "default"}
                                  onChange={(event) => {
                                    const actions = { ...selection.projectActions };
                                    if (event.target.value === "default")
                                      delete actions[project.id];
                                    else
                                      actions[project.id] = event.target.value as
                                        | "skip"
                                        | "overwrite";
                                    patch({ projectActions: actions });
                                  }}
                                >
                                  <option value="default">Use default</option>
                                  <option value="skip">Skip</option>
                                  <option value="overwrite">Overwrite</option>
                                </select>
                              </label>
                            ))}
                        </div>
                      </details>
                    )}
                    <div className="grid gap-2 sm:grid-cols-2">
                      <TransferOption
                        label="Domains and routing"
                        checked={selection.includeDomains !== false}
                        onChange={(includeDomains) => patch({ includeDomains })}
                        disabled={busy}
                      />
                      <TransferOption
                        label="Backup configuration"
                        checked={selection.includeBackups !== false}
                        onChange={(includeBackups) => patch({ includeBackups })}
                        disabled={busy}
                      />
                      <TransferOption
                        label="Shared integrations"
                        checked={selection.includeIntegrations !== false}
                        onChange={(includeIntegrations) => patch({ includeIntegrations })}
                        disabled={busy}
                      />
                      <TransferOption
                        label="Overwrite matching shared settings"
                        description="Also update shared integration credentials and backup destinations. This affects other projects using them."
                        checked={selection.overwriteDependencies === true}
                        onChange={(overwriteDependencies) => patch({ overwriteDependencies })}
                        disabled={busy}
                      />
                    </div>
                    <details className="rounded-lg border border-border p-3 text-xs">
                      <summary className="cursor-pointer font-medium text-foreground">
                        History to import
                      </summary>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {ALL_HISTORY.map((category) => (
                          <TransferOption
                            key={category}
                            label={HISTORY_LABELS[category]}
                            checked={(selection.history ?? ALL_HISTORY).includes(category)}
                            disabled={busy}
                            onChange={(checked) =>
                              patch({
                                history: checked
                                  ? [...(selection.history ?? ALL_HISTORY), category]
                                  : (selection.history ?? ALL_HISTORY).filter(
                                      (item) => item !== category,
                                    ),
                              })
                            }
                          />
                        ))}
                      </div>
                    </details>
                    {!!preview.servers.length && (
                      <div className="space-y-3 rounded-lg border border-border p-3">
                        <h3 className="text-sm font-medium text-foreground">
                          Deployment and backup servers
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Matching self-hosted servers are reused. Map missing or local targets to a
                          server already connected here.
                        </p>
                        {preview.servers.map((server) => (
                          <label
                            key={server.id}
                            className="block space-y-1 text-xs text-muted-foreground"
                          >
                            <span>
                              {server.name}
                              {server.host ? ` · ${server.host}:${server.port}` : ""}
                            </span>
                            <select
                              aria-label={`Destination server for ${server.name}`}
                              className={transferInputClass}
                              disabled={busy}
                              value={selection.serverMappings?.[server.id] ?? ""}
                              onChange={(event) => {
                                const serverMappings = { ...selection.serverMappings };
                                if (event.target.value)
                                  serverMappings[server.id] = event.target.value;
                                else delete serverMappings[server.id];
                                patch({ serverMappings });
                              }}
                            >
                              <option value="">
                                {server.action === "create"
                                  ? "Import the included server connection"
                                  : server.action === "reuse"
                                    ? `Reuse ${preview.availableServers.find((target) => target.id === server.targetId)?.name ?? "matching server"}`
                                    : "Choose a destination server"}
                              </option>
                              {preview.availableServers.map((target) => (
                                <option key={target.id} value={target.id}>
                                  {target.name} · {target.isLocal ? "This host" : target.host}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <label className="block space-y-1 text-xs font-medium text-foreground">
                    Instance import mode
                    <select
                      aria-label="Instance import mode"
                      disabled={busy}
                      value={mode}
                      onChange={(event) => setMode(event.target.value as ImportMode)}
                      className={transferInputClass}
                    >
                      <option value="merge">
                        Add new records; stop if project records conflict
                      </option>
                      <option value="wipe">Replace the entire destination instance</option>
                    </select>
                    {mode === "wipe" && (
                      <span className="block pt-2 text-danger">
                        This replaces every destination project, account, session, server, and
                        setting.
                      </span>
                    )}
                  </label>
                )}
                <TransferOption
                  label="Restore environment values, keys, and credentials"
                  checked={selection.includeSecrets !== false}
                  onChange={(includeSecrets) => patch({ includeSecrets })}
                  disabled={busy || !preview.hasSecrets}
                />
                {preview.hasSecrets && selection.includeSecrets !== false && (
                  <label className="block space-y-1 text-xs font-medium text-foreground">
                    Transfer password
                    <input
                      type="password"
                      autoComplete="off"
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      className={transferInputClass}
                      disabled={busy}
                    />
                  </label>
                )}
                <div className="space-y-3 border-t border-border pt-4">
                  <h3 className="text-sm font-medium text-foreground">3. Review and import</h3>
                  <p aria-live="polite" className="text-xs text-muted-foreground">
                    {reviewed
                      ? `${preview.rows.toLocaleString()} records selected. ${selection.scope === "projects" ? `${preview.projects.filter((project) => project.action === "create").length} environments to create, ${preview.projects.filter((project) => project.action === "overwrite").length} to update, ${preview.projects.filter((project) => project.action === "skip").length} to skip.` : "This import includes instance accounts and settings."}`
                      : "Selection changed. Review again to check conflicts and target mappings."}
                  </p>
                  <TransferWarnings
                    warnings={preview.warnings}
                    blockers={reviewed ? preview.blockers : []}
                  />
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      disabled={busy || !hasSelection}
                      onClick={() => void review()}
                      className="rounded-lg border border-border px-4 py-2 text-sm text-foreground disabled:opacity-50"
                    >
                      Review selection
                    </button>
                    <button
                      type="button"
                      disabled={busy || !canImport}
                      onClick={() => void apply()}
                      className={transferButtonClass}
                    >
                      <UiIcon name="upload" className="size-4" />
                      {selection.scope === "instance" && mode === "wipe"
                        ? "Replace instance"
                        : "Import selection"}
                    </button>
                  </div>
                </div>
              </>
            )}
            {error && (
              <p
                role="alert"
                className="whitespace-pre-wrap rounded-lg border border-danger-border bg-danger-bg p-3 text-xs text-danger"
              >
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
