"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Button } from "@/components/ui/button";
import {
  dataTransferApi,
  type ImportMode,
  type ImportPreview,
  type ImportResult,
  type ImportSelection,
} from "@/lib/api/data-transfer";
import { getApiErrorMessage, setActiveOrganizationId } from "@/lib/api/client";
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
  const importLock = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentKey = JSON.stringify({ selection, mode });
  const reviewed = !!preview && reviewedKey === currentKey;
  const hasSelection = selection.scope === "instance" || !!selection.projectIds?.length;
  const requiresPassphrase = preview?.requiresPassphrase ?? preview?.hasSecrets ?? false;
  const canImport =
    reviewed &&
    hasSelection &&
    !preview.blockers.length &&
    (!requiresPassphrase || selection.includeSecrets === false || !!passphrase);
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
      // Preserve what the user exported. Replacing an instance is reviewed here
      // and confirmed at apply; it must not silently become a project-only merge.
      const nextMode: ImportMode = initial.scope === "instance" ? "wipe" : "merge";
      const next: ImportSelection = {
        scope: initial.scope,
        ...(initial.scope === "projects" && initial.projects.length
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
      setMode(nextMode);
      const review = await dataTransferApi.previewFile(chosen, next);
      setPreview(review);
      setReviewedKey(JSON.stringify({ selection: next, mode: nextMode }));
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
    if (!file || !canImport || busy || importLock.current) return;
    const effectiveMode = selection.scope === "projects" ? "merge" : mode;
    if (
      effectiveMode === "wipe" &&
      !window.confirm(
        "Replace this entire instance, including all projects, users, sessions, servers, and settings, with this export? This cannot be undone.",
      )
    )
      return;
    importLock.current = true;
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
      // The replaced database owns its workspace identities. Drop the browser's
      // previous selection so reload resolves an imported membership normally.
      if (imported.mode === "wipe") setActiveOrganizationId(null);
      setResult(imported);
      setPassphrase("");
    } catch (error) {
      setError(getApiErrorMessage(error, "Import failed."));
      // Destination state may have changed since review; keep the uploaded file.
      setReviewedKey("");
    } finally {
      importLock.current = false;
      setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    if (result?.mode === "wipe") window.location.assign("/select-organization");
    else if (result) window.location.reload();
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
              {result.mode === "wipe" ? "Continue to restored workspaces" : "Done"}
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">1. Choose an export file</p>
              <input
                ref={fileInputRef}
                type="file"
                aria-label="Export file"
                accept=".json,application/json"
                disabled={busy}
                className="hidden"
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  event.target.value = "";
                  if (chosen) void inspect(chosen);
                }}
              />
              <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/40 p-3">
                <Button type="button" variant="secondary" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                  <UiIcon name="upload" className="size-4" />
                  {file ? "Change file" : "Choose file"}
                </Button>
                <p className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
                  {file ? `${file.name} · ${formatBytes(file.size)}` : "OpenShip export · JSON · Up to 500 MB"}
                  {progress && busy ? ` · Uploaded ${progress.done}/${progress.total} parts` : ""}
                </p>
              </div>
            </div>
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
                  <CustomSelect<ImportSelection["scope"]>
                    aria-label="Import scope"
                    value={selection.scope}
                    disabled={busy}
                    variant="filled"
                    triggerClassName="bg-muted/60 hover:bg-muted"
                    options={[
                      ...(preview.projects.length || archiveScope === "projects"
                        ? [{ value: "projects" as const, label: "Selected projects into the current workspace" }]
                        : []),
                      ...(archiveScope === "instance"
                        ? [{ value: "instance" as const, label: "Entire instance, including accounts and settings" }]
                        : []),
                    ]}
                    onChange={(scope) => {
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
                      setMode(scope === "instance" ? "wipe" : "merge");
                    }}
                  />
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
                      <CustomSelect<"skip" | "overwrite">
                        aria-label="Project conflict policy"
                        value={selection.conflictPolicy ?? "skip"}
                        disabled={busy}
                        variant="filled"
                        triggerClassName="bg-muted/60 hover:bg-muted"
                        options={[
                          { value: "skip", label: "Keep destination project and skip its imported records" },
                          { value: "overwrite", label: "Overwrite matching project records" },
                        ]}
                        onChange={(conflictPolicy) =>
                          patch({ conflictPolicy })
                        }
                      />
                      <span className="block pt-1 font-normal text-muted-foreground">
                        Overwrite replaces the selected projects with the exported records,
                        including removing destination-only records in the selected categories.
                        Other projects and shared server connections are kept.
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
                                <CustomSelect<"default" | "skip" | "overwrite">
                                  aria-label={`Conflict action for ${project.name} ${project.environmentName}`}
                                  disabled={busy}
                                  className="w-40 shrink-0"
                                  variant="filled"
                                  triggerClassName="bg-muted/60 hover:bg-muted"
                                  value={selection.projectActions?.[project.id] ?? "default"}
                                  options={[
                                    { value: "default", label: "Use default" },
                                    { value: "skip", label: "Skip" },
                                    { value: "overwrite", label: "Overwrite" },
                                  ]}
                                  onChange={(action) => {
                                    const actions = { ...selection.projectActions };
                                    if (action === "default")
                                      delete actions[project.id];
                                    else
                                      actions[project.id] = action;
                                    patch({ projectActions: actions });
                                  }}
                                />
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
                            <CustomSelect
                              aria-label={`Destination server for ${server.name}`}
                              variant="filled"
                              triggerClassName="bg-muted/60 hover:bg-muted"
                              disabled={busy}
                              value={selection.serverMappings?.[server.id] ?? ""}
                              options={[
                                { value: "", label: server.action === "create"
                                  ? "Import the included server connection"
                                  : server.action === "reuse"
                                    ? `Reuse ${preview.availableServers.find((target) => target.id === server.targetId)?.name ?? "matching server"}`
                                    : "Choose a destination server" },
                                ...preview.availableServers.map((target) => ({
                                  value: target.id,
                                  label: `${target.name} · ${target.isLocal ? "This host" : target.host}`,
                                })),
                              ]}
                              onChange={(targetId) => {
                                const serverMappings = { ...selection.serverMappings };
                                if (targetId)
                                  serverMappings[server.id] = targetId;
                                else delete serverMappings[server.id];
                                patch({ serverMappings });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <label className="block space-y-1 text-xs font-medium text-foreground">
                    Instance import mode
                    <CustomSelect
                      aria-label="Instance import mode"
                      disabled={busy}
                      value={mode}
                      onChange={setMode}
                      variant="filled"
                      triggerClassName="bg-muted/60 hover:bg-muted"
                      options={[
                        { value: "merge", label: "Add new records; stop if project records conflict" },
                        { value: "wipe", label: "Replace the entire destination instance" },
                      ]}
                    />
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
                {!preview.hasSecrets && (
                  <p className="text-xs text-warning">
                    This file contains no environment values or credentials. Export it again
                    from the source to move those values.
                  </p>
                )}
                {requiresPassphrase && selection.includeSecrets !== false && (
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
                  {reviewed && !!preview.rowsRemoved && (
                    <p className="text-xs text-muted-foreground">
                      {preview.rowsRemoved.toLocaleString()} destination-only records will be
                      removed from the selected projects.
                    </p>
                  )}
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
