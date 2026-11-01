"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useMemo, useRef, useState } from "react";
import { dataTransferApi, type ExportPreview, type ExportSelection, type TransferManifest } from "@/lib/api/data-transfer";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { TransferRequirements } from "./TransferRequirements";
import {
  ALL_HISTORY,
  HISTORY_LABELS,
  TransferOption,
  TransferProjectPicker,
  TransferWarnings,
  transferButtonClass,
  transferInputClass,
} from "./TransferOptions";

/** Shared by Project → Advanced and Settings → Instance. */
export function ExportPanel({
  projectId,
  projectName,
}: {
  projectId?: string;
  projectName?: string;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const d = t.settings.dataTransfer;
  const [selection, setSelection] = useState<ExportSelection>({
    scope: projectId ? "projects" : "instance",
    projectIds: projectId ? [projectId] : undefined,
    history: [...ALL_HISTORY],
    includeEnvironments: !!projectId,
    includeLinkedProjects: true,
    includeServers: true,
    includeSecrets: true,
    includeDomains: true,
    includeBackups: true,
    includeIntegrations: true,
  });
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [catalogue, setCatalogue] = useState<NonNullable<ExportPreview["projects"]>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState<{ filename: string; manifest?: TransferManifest } | null>(null);
  const downloadLock = useRef(false);
  const selectionKey = JSON.stringify({ ...selection, history: ALL_HISTORY, includeSecrets: true });
  const validSelection = selection.scope !== "projects" || !!selection.projectIds?.length;
  const selectedRows = preview
    ? preview.core + selection.history.reduce((sum, category) => sum + preview.history[category], 0)
    : null;
  const cloudProjects = useMemo(
    () => (preview?.manifest?.projects ?? []).filter((project) => project.workspaceId),
    [preview],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      const requested = JSON.parse(selectionKey) as ExportSelection;
      const request =
        requested.scope === "projects" && requested.projectIds?.length
          ? dataTransferApi.preview(requested)
          : dataTransferApi.preview();
      request
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setCatalogue(result.projects ?? []);
        })
        .catch((error) => {
          if (!cancelled) {
            setPreview(null);
            setError(getApiErrorMessage(error, "Could not preview the export."));
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectionKey]);

  const patch = (value: Partial<ExportSelection>) =>
    setSelection((current) => ({ ...current, ...value }));
  const download = async () => {
    if (downloadLock.current || loading || !preview || !validSelection) return;
    downloadLock.current = true;
    setBusy(true);
    setError("");
    try {
      const file = await dataTransferApi.export(undefined, selection);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(file)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      const label = (
        projectName ?? (selection.scope === "projects" ? "projects" : "instance")
      ).replace(/[^a-z0-9_-]+/gi, "-");
      const filename = `openship-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloaded({ filename, manifest: file.manifest });
      showToast(
        d.exportCompleteToast,
        "success",
        d.exportDownloaded,
      );
    } catch (error) {
      setError(getApiErrorMessage(error, "Export failed."));
    } finally {
      downloadLock.current = false;
      setBusy(false);
    }
  };

  const downloadButton = (
    <button
      type="button"
      className={transferButtonClass}
      disabled={busy || loading || !preview || !validSelection}
      onClick={() => void download()}
    >
      {busy ? <UiIcon name="spinner" className="size-4 animate-spin" /> : <UiIcon name="download" className="size-4" />}
      {busy ? d.exporting : downloaded ? d.downloadAgain : d.downloadExport}
    </button>
  );
  const downloadResult = downloaded && (
    <div className="space-y-3">
      <div role="status" className="flex items-start gap-2.5 rounded-xl bg-success-bg p-3">
        <UiIcon name="check" className="mt-0.5 size-4 shrink-0 text-success" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{d.exportDownloaded}</p>
          <p className="mt-0.5 break-all text-xs text-muted-foreground">{downloaded.filename}</p>
        </div>
      </div>
      <TransferRequirements manifest={downloaded.manifest} />
      <TransferWarnings warnings={downloaded.manifest?.warnings ?? []} />
    </div>
  );
  const errorMessage = error && (
    <p role="alert" className="whitespace-pre-wrap text-xs text-danger">{error}</p>
  );

  if (projectId) {
    return (
      <div className="space-y-4">
        {downloadResult || (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {d.exportProjectIntro}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {d.exportProjectReconnection}
            </p>
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {loading ? d.checkingExport : preview
                ? interpolate(d.recordsAcrossEnvsIncluded, {
                    count: selectedRows?.toLocaleString() ?? "0",
                    envs: String(preview.manifest?.projects.length ?? 1),
                  })
                : ""}
            </p>
          </>
        )}
        {errorMessage}
        {downloadButton}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {d.exportInstanceIntro}
      </p>
      <label className="block space-y-1 text-sm font-medium text-foreground">
        {d.scopeLabel}
        <select
          aria-label={d.scopeLabel}
          disabled={busy}
          value={selection.scope}
          className={transferInputClass}
          onChange={(event) =>
            patch({
              scope: event.target.value as "instance" | "projects",
              projectIds: event.target.value === "projects" ? [] : undefined,
              includeServers: true,
              includeDomains: true,
              includeBackups: true,
              includeIntegrations: true,
            })
          }
        >
          <option value="instance">{d.scopeInstance}</option>
          <option value="projects">{d.scopeProjects}</option>
        </select>
      </label>
      {selection.scope === "projects" && (
        <TransferProjectPicker
          projects={catalogue}
          selected={selection.projectIds ?? []}
          onChange={(projectIds) => patch({ projectIds })}
          disabled={busy}
        />
      )}
      {selection.scope === "projects" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <TransferOption
            label={d.optLinkedAppsLabel}
            description={d.optLinkedAppsDesc}
            checked={selection.includeLinkedProjects !== false}
            onChange={(includeLinkedProjects) => patch({ includeLinkedProjects })}
            disabled={busy}
          />
          <TransferOption
            label={d.optServersLabel}
            description={d.optServersDesc}
            checked={selection.includeServers !== false}
            onChange={(includeServers) => patch({ includeServers })}
            disabled={busy}
          />
          <TransferOption
            label={d.optDomainsLabel}
            checked={selection.includeDomains !== false}
            onChange={(includeDomains) => patch({ includeDomains })}
            disabled={busy}
          />
          <TransferOption
            label={d.optBackupsLabel}
            description={d.optBackupsDesc}
            checked={selection.includeBackups !== false}
            onChange={(includeBackups) => patch({ includeBackups })}
            disabled={busy}
          />
          <TransferOption
            label={d.optIntegrationsLabel}
            description={d.optIntegrationsDesc}
            checked={selection.includeIntegrations !== false}
            onChange={(includeIntegrations) => patch({ includeIntegrations })}
            disabled={busy}
          />
        </div>
      )}
      <TransferOption
        label={d.optSecretsLabel}
        description={d.optSecretsDesc}
        checked={selection.includeSecrets !== false}
        onChange={(includeSecrets) => patch({ includeSecrets })}
        disabled={busy}
      />
      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          {interpolate(d.historyOptionsSummary, {
            count: String(selection.history.length),
            total: String(ALL_HISTORY.length),
          })}
        </summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {ALL_HISTORY.map((category) => (
            <TransferOption
              key={category}
              label={HISTORY_LABELS[category]}
              description={
                preview ? `${preview.history[category].toLocaleString()} records` : undefined
              }
              checked={selection.history.includes(category)}
              disabled={busy || (category === "backups" && selection.includeBackups === false)}
              onChange={(checked) =>
                patch({
                  history: checked
                    ? [...selection.history, category]
                    : selection.history.filter((item) => item !== category),
                })
              }
            />
          ))}
        </div>
      </details>
      <div aria-live="polite" className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
        {loading
          ? d.checkingExport
          : !validSelection
            ? d.selectAtLeastOne
            : preview?.manifest
              ? interpolate(d.recordsAcrossEnvsSelected, {
                  count: selectedRows?.toLocaleString() ?? "—",
                  envs: String(preview.manifest.projects.length),
                })
              : interpolate(d.recordsSelected, {
                  count: selectedRows?.toLocaleString() ?? "—",
                })}
        {!!preview?.manifest && validSelection && (
          <p className="mt-1">
            {preview.manifest.projects
              .map((project) => `${project.name} (${project.environmentName})`)
              .join(", ")}
          </p>
        )}
      </div>
      {cloudProjects.length > 0 && (
        <p className="rounded-lg border border-warning-border bg-warning-bg p-3 text-xs leading-relaxed text-warning">
          {d.cloudNotice}
        </p>
      )}
      {validSelection && <TransferWarnings warnings={preview?.manifest?.warnings ?? []} />}
      {downloadResult}
      {errorMessage}
      {downloadButton}
    </div>
  );
}
