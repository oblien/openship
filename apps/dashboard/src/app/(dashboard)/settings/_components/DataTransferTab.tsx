"use client";

/**
 * Instance-tab section (self-hosted only, owner-only) — export the entire
 * instance database to a file and import one on another install: migrating
 * between installs, e.g. a desktop → a self-hosted server (PGlite → Postgres is
 * handled), or desktop ↔ desktop. Secrets travel re-encrypted under a passphrase the
 * user sets on export and re-enters on import; the API re-encrypts them under
 * the destination install's own key.
 *
 * Owner gating is enforced by the API (requireRole("owner")); this component
 * renders nothing for non-owners so the Instance tab stays clean.
 */

import { useCallback, useEffect, useState } from "react";
import { DatabaseBackup, Download, Upload, Loader2, TriangleAlert } from "lucide-react";

import { SettingsSection } from "./SettingsSection";
import { Modal } from "@/components/ui/Modal";
import { useSession, authClient } from "@/lib/auth-client";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import {
  dataTransferApi,
  getApiErrorMessage,
  type DataTransferFile,
  type ImportMode,
  type ImportResult,
} from "@/lib/api";

// Resolve the org client once (stable ref) — same guard TeamTab uses to avoid
// an effect-recreation loop.
const orgClient = (authClient as unknown as {
  organization: {
    listMembers: () => Promise<{ data?: { members?: Array<{ userId: string; role: string }> } }>;
  };
}).organization;

export function DataTransferTab() {
  const { data: session } = useSession();
  const { showToast } = useToast();

  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    orgClient
      .listMembers()
      .then((res) => {
        if (cancelled) return;
        const me = res.data?.members?.find((m) => m.userId === session?.user?.id);
        setIsOwner(me?.role === "owner");
      })
      .catch(() => {
        if (!cancelled) setIsOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  // Non-owners (and the brief pre-resolution window) render nothing — the
  // section only appears for a confirmed owner, so the Instance tab shows just
  // instance info for everyone else instead of a "denied" card.
  if (isOwner !== true) return null;

  return (
    <div className="space-y-6">
      <ExportCard onToast={showToast} />
      <ImportCard onToast={showToast} />
    </div>
  );
}

type Toast = (message: string, type: "success" | "error", title?: string) => void;

/* ── Export ──────────────────────────────────────────────────────── */

function ExportCard({ onToast }: { onToast: Toast }) {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const passphraseMismatch = passphrase.length > 0 && confirm.length > 0 && passphrase !== confirm;

  const handleExport = useCallback(async () => {
    if (passphraseMismatch) return;
    setBusy(true);
    try {
      const file = (await dataTransferApi.export(passphrase || undefined)) as DataTransferFile;
      const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `openship-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      onToast(
        passphrase
          ? t.settings.dataTransfer.export.toastWithSecrets
          : t.settings.dataTransfer.export.toastNoSecrets,
        "success",
        t.settings.common.toast.export,
      );
    } catch (err) {
      onToast(getApiErrorMessage(err, t.settings.dataTransfer.export.toastFailed), "error", t.settings.common.toast.export);
    } finally {
      setBusy(false);
    }
  }, [passphrase, passphraseMismatch, onToast, t]);

  return (
    <SettingsSection
      icon={Download}
      title={t.settings.dataTransfer.export.title}
      description={t.settings.dataTransfer.export.description}
      iconBg="bg-primary/10"
      iconColor="text-primary"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t.settings.dataTransfer.export.intro}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t.settings.dataTransfer.export.passphraseLabel}
            </label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
              placeholder={t.settings.dataTransfer.export.passphrasePlaceholder}
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t.settings.dataTransfer.export.confirmLabel}
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              placeholder={t.settings.dataTransfer.export.confirmPlaceholder}
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
            />
          </div>
        </div>

        {passphraseMismatch && (
          <p className="text-xs text-danger">{t.settings.dataTransfer.export.mismatch}</p>
        )}

        <button
          type="button"
          onClick={handleExport}
          disabled={busy || passphraseMismatch}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {busy ? t.settings.dataTransfer.export.exporting : t.settings.dataTransfer.export.exportDownload}
        </button>
      </div>
    </SettingsSection>
  );
}

/* ── Import ──────────────────────────────────────────────────────── */

function ImportCard({ onToast }: { onToast: Toast }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <SettingsSection
      icon={Upload}
      title={t.settings.dataTransfer.import.title}
      description={t.settings.dataTransfer.import.description}
      iconBg="bg-primary/10"
      iconColor="text-primary"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t.settings.dataTransfer.import.intro}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
        >
          <Upload className="size-4" />
          {t.settings.dataTransfer.import.importFromFile}
        </button>
      </div>

      <ImportModal open={open} onClose={() => setOpen(false)} onToast={onToast} />
    </SettingsSection>
  );
}

function ImportModal({
  open,
  onClose,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  onToast: Toast;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState<DataTransferFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileHasSecrets, setFileHasSecrets] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [mode, setMode] = useState<ImportMode>("wipe");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-import warning: local-folder projects whose source path won't exist on
  // this install. Kept persistent (not a toast) so it survives the wipe reload.
  const [notice, setNotice] = useState<{ text: string; wipe: boolean } | null>(null);

  const reset = () => {
    setFile(null);
    setFileName("");
    setFileHasSecrets(false);
    setPassphrase("");
    setMode("wipe");
    setError(null);
    setNotice(null);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    try {
      const parsed = JSON.parse(await f.text()) as DataTransferFile;
      if (parsed?.kind !== "openship-instance-export") {
        setError(t.settings.dataTransfer.import.notExport);
        setFile(null);
        return;
      }
      setFile(parsed);
      setFileName(f.name);
      setFileHasSecrets(!!parsed.secrets);
    } catch {
      setError(t.settings.dataTransfer.import.cantRead);
      setFile(null);
    }
  };

  const handleImport = async () => {
    if (!file) return;
    if (mode === "wipe") {
      const ok = window.confirm(t.settings.dataTransfer.import.confirmWipe);
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = (await dataTransferApi.import(
        file,
        passphrase || undefined,
        mode,
      )) as ImportResult;

      const parts = [interpolate(t.settings.dataTransfer.import.rowsRestored, { count: String(result.rowsRestored) })];
      if (result.secretsRehydrated > 0) parts.push(interpolate(t.settings.dataTransfer.import.secretsRestored, { count: String(result.secretsRehydrated) }));
      if (result.secretsSkipped && fileHasSecrets) {
        parts.push(t.settings.dataTransfer.import.secretsNotRestored);
      }
      onToast(parts.join(" · "), "success", t.settings.common.toast.importComplete);

      // Local-folder projects reference a SOURCE-machine path that won't exist
      // here — hold the modal open on a persistent warning so it's read before
      // the wipe reload, instead of vanishing with the toast.
      const localPathProjects = result.localPathProjects ?? [];
      if (localPathProjects.length > 0) {
        const list = localPathProjects.map((p) => `• ${p.slug}  (${p.localPath})`).join("\n");
        setNotice({
          text:
            `${localPathProjects.length} imported project(s) deploy from a local folder on the source machine. ` +
            `That path doesn't exist on this install, so their next deploy can't find the source. ` +
            `Re-point localPath, or re-deploy each from a folder on THIS machine:\n${list}`,
          wipe: mode === "wipe",
        });
        return; // keep the modal open; the notice's action closes/reloads
      }

      onClose();
      reset();
      // A wipe replaces the current user/session — reload so the app
      // re-authenticates against the imported data.
      if (mode === "wipe" && typeof window !== "undefined") {
        setTimeout(() => window.location.reload(), 800);
      }
    } catch (err) {
      setError(getApiErrorMessage(err, t.settings.dataTransfer.import.importFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={() => {
        if (busy) return;
        onClose();
        reset();
      }}
      maxWidth="560px"
      closable={!busy}
    >
      <div className="p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <DatabaseBackup className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">{t.settings.dataTransfer.import.modalTitle}</h2>
            <p className="text-xs text-muted-foreground">{t.settings.dataTransfer.import.modalSubtitle}</p>
          </div>
        </div>

        {notice && (
          <div className="mb-4 rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-2.5 text-xs text-warning">
            <div className="mb-2 flex items-center gap-2 font-medium">
              <TriangleAlert className="size-4 shrink-0" /> Import complete — one thing to check
            </div>
            <pre className="whitespace-pre-wrap font-sans leading-relaxed">{notice.text}</pre>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  if (notice.wipe && typeof window !== "undefined") {
                    window.location.reload();
                  } else {
                    setNotice(null);
                    onClose();
                    reset();
                  }
                }}
                className="rounded-md bg-warning/20 px-3 py-1.5 font-medium text-warning hover:bg-warning/30"
              >
                {notice.wipe ? "Reload to finish" : "Done"}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t.settings.dataTransfer.import.exportFile}
            </label>
            <input
              type="file"
              accept="application/json,.json"
              onChange={handleFile}
              className="block w-full text-sm text-muted-foreground file:me-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70"
            />
            {fileName && (
              <p className="mt-1 text-xs text-muted-foreground">
                {fileName}
                {fileHasSecrets ? t.settings.dataTransfer.import.fileContainsSecrets : t.settings.dataTransfer.import.fileNoSecrets}
              </p>
            )}
          </div>

          {fileHasSecrets && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t.settings.dataTransfer.import.passphrase}
              </label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
                placeholder={t.settings.dataTransfer.import.passphrasePlaceholder}
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
              />
            </div>
          )}

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">{t.settings.dataTransfer.import.mode}</label>
            <div className="space-y-2">
              <ModeOption
                selected={mode === "wipe"}
                onSelect={() => setMode("wipe")}
                title={t.settings.dataTransfer.import.modeReplaceTitle}
                description={t.settings.dataTransfer.import.modeReplaceDesc}
              />
              <ModeOption
                selected={mode === "merge"}
                onSelect={() => setMode("merge")}
                title={t.settings.dataTransfer.import.modeMergeTitle}
                description={t.settings.dataTransfer.import.modeMergeDesc}
              />
            </div>
          </div>

          {mode === "wipe" && (
            <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg p-3">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-xs text-warning">
                {t.settings.dataTransfer.import.wipeWarn}
              </p>
            </div>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                if (busy) return;
                onClose();
                reset();
              }}
              disabled={busy}
              className="rounded-lg bg-foreground/[0.06] px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50"
            >
              {t.settings.common.cancel}
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={busy || !file}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? t.settings.dataTransfer.import.importing : t.settings.dataTransfer.import.import}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ModeOption({
  selected,
  onSelect,
  title,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border p-3 text-start transition-colors ${
        selected ? "border-primary/60 bg-primary/[0.05]" : "border-border/50 hover:bg-foreground/[0.03]"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex size-4 items-center justify-center rounded-full border ${
            selected ? "border-primary" : "border-border"
          }`}
        >
          {selected && <span className="size-2 rounded-full bg-primary" />}
        </span>
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <p className="mt-1 ps-6 text-xs text-muted-foreground">{description}</p>
    </button>
  );
}
