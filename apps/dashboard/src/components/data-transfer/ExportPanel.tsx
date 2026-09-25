"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useMemo, useState } from "react";
import { dataTransferApi, type ExportPreview, type ExportSelection } from "@/lib/api/data-transfer";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
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
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const selectionKey = JSON.stringify({ ...selection, history: ALL_HISTORY, includeSecrets: true });
  const validSelection = selection.scope !== "projects" || !!selection.projectIds?.length;
  const needsPassword = selection.includeSecrets !== false;
  const mismatch = !!passphrase && passphrase !== confirm;
  const selectedRows = preview
    ? preview.core + selection.history.reduce((sum, category) => sum + preview.history[category], 0)
    : null;
  const cloudProjects = useMemo(
    () => (preview?.manifest?.projects ?? []).filter((project) => project.cloudWorkspaceId),
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
  const generatePassword = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    setPassphrase(value);
    setConfirm(value);
  };
  const download = async () => {
    if (!validSelection || mismatch || (needsPassword && !passphrase)) return;
    setBusy(true);
    setError("");
    try {
      const file = await dataTransferApi.export(needsPassword ? passphrase : undefined, selection);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(file)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      const label = (
        projectName ?? (selection.scope === "projects" ? "projects" : "instance")
      ).replace(/[^a-z0-9_-]+/gi, "-");
      anchor.download = `openship-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(
        "Export downloaded. Import it from Settings → Instance on the destination control plane.",
        "success",
        "Export complete",
      );
    } catch (error) {
      setError(getApiErrorMessage(error, "Export failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Export project configuration, environments, deployments, service connections, and
        credentials for another control plane. Workloads on the same server can keep their existing
        target bindings.
      </p>
      {!projectId && (
        <label className="block space-y-1 text-sm font-medium text-foreground">
          Export scope
          <select
            aria-label="Export scope"
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
            <option value="instance">Entire instance</option>
            <option value="projects">Selected projects and environments</option>
          </select>
        </label>
      )}
      {!projectId && selection.scope === "projects" && (
        <TransferProjectPicker
          projects={catalogue}
          selected={selection.projectIds ?? []}
          onChange={(projectIds) => patch({ projectIds })}
          disabled={busy}
        />
      )}
      {selection.scope === "projects" && (
        <div className="grid gap-2 sm:grid-cols-2">
          {projectId && (
            <TransferOption
              label="All project environments"
              description="Include production, preview, and other environments belonging to this project."
              checked={selection.includeEnvironments !== false}
              onChange={(includeEnvironments) => patch({ includeEnvironments })}
              disabled={busy}
            />
          )}
          <TransferOption
            label="Linked apps"
            description="Include database and storage projects required by the selection."
            checked={selection.includeLinkedProjects !== false}
            onChange={(includeLinkedProjects) => patch({ includeLinkedProjects })}
            disabled={busy}
          />
          <TransferOption
            label="Related self-hosted servers (recommended)"
            description="Include server connections and their Git keys. Existing matching servers can be reused during import."
            checked={selection.includeServers !== false}
            onChange={(includeServers) => patch({ includeServers })}
            disabled={busy}
          />
          <TransferOption
            label="Domains and routing"
            checked={selection.includeDomains !== false}
            onChange={(includeDomains) => patch({ includeDomains })}
            disabled={busy}
          />
          <TransferOption
            label="Backup configuration"
            description="Policies and destinations; backup payloads remain in their storage."
            checked={selection.includeBackups !== false}
            onChange={(includeBackups) => patch({ includeBackups })}
            disabled={busy}
          />
          <TransferOption
            label="Shared integrations"
            description="Git provider apps, registry logins, and workspace DNS credentials."
            checked={selection.includeIntegrations !== false}
            onChange={(includeIntegrations) => patch({ includeIntegrations })}
            disabled={busy}
          />
        </div>
      )}
      <TransferOption
        label="Environment values, keys, and credentials"
        description="Includes inline Compose configuration and secret files stored in metadata. Protected with the transfer password below."
        checked={needsPassword}
        onChange={(includeSecrets) => patch({ includeSecrets })}
        disabled={busy}
      />
      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          History options · {selection.history.length} of {ALL_HISTORY.length} included
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
          ? "Checking export contents…"
          : !validSelection
            ? "Select at least one project or environment."
            : `${selectedRows?.toLocaleString() ?? "—"} records${preview?.manifest ? ` across ${preview.manifest.projects.length} environments` : ""} selected.`}
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
          Cloud projects will not work until the destination workspace is connected to the same
          Openship Cloud account. This export preserves cloud workspace references; it cannot
          transfer a cloud server between accounts.
        </p>
      )}
      {validSelection && <TransferWarnings warnings={preview?.manifest?.warnings ?? []} />}
      {needsPassword && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Save this password separately. The destination needs it to restore environment values
            and credentials.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-medium text-foreground">
              Transfer password
              <input
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                className={transferInputClass}
                disabled={busy}
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-foreground">
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                className={transferInputClass}
                disabled={busy}
              />
            </label>
          </div>
          {mismatch && <p className="text-xs text-danger">The passwords do not match.</p>}
          <div className="flex gap-4 text-xs">
            <button
              type="button"
              disabled={busy}
              onClick={generatePassword}
              className="text-primary"
            >
              Generate password
            </button>
            <button
              type="button"
              disabled={!passphrase || busy}
              className="inline-flex items-center gap-1 text-primary disabled:opacity-50"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(passphrase);
                  showToast("Transfer password copied.", "success");
                } catch {
                  setError("Could not copy the password. Copy it manually before exporting.");
                }
              }}
            >
              <UiIcon name="clipboard" className="size-3" />
              Copy password
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-xs text-danger">
          {error}
        </p>
      )}
      <button
        type="button"
        className={transferButtonClass}
        disabled={
          busy ||
          loading ||
          !preview ||
          !validSelection ||
          (needsPassword && (!passphrase || mismatch))
        }
        onClick={() => void download()}
      >
        {busy ? <UiIcon name="spinner" className="size-4 animate-spin" /> : <UiIcon name="download" className="size-4" />}
        {busy ? "Exporting…" : "Download export"}
      </button>
    </div>
  );
}
