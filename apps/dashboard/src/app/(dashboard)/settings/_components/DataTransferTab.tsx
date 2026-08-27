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

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Clipboard, DatabaseBackup, Download, Upload, Loader2, Send, TriangleAlert } from "lucide-react";

import { SettingsSection } from "./SettingsSection";
import { Modal } from "@/components/ui/Modal";
import { useSession, authClient } from "@/lib/auth-client";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import {
  dataTransferApi,
  getApiErrorMessage,
  inspectDirectTransferCode,
  type DataTransferFile,
  type ExportHistoryCategory,
  type ExportPreview,
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
      <DirectTransferCard onToast={showToast} />
      <ExportCard onToast={showToast} />
      <ImportCard onToast={showToast} />
    </div>
  );
}

type Toast = (message: string, type: "success" | "error", title?: string) => void;

/* ── Direct transfer ─────────────────────────────────────────────── */

export function DirectTransferCard({ onToast }: { onToast: Toast }) {
  const [receiveMode, setReceiveMode] = useState<ImportMode>("wipe");
  const [receiveCode, setReceiveCode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [sendCode, setSendCode] = useState("");
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const destinationInfo = useMemo(() => inspectDirectTransferCode(sendCode), [sendCode]);

  useEffect(() => {
    let cancelled = false;
    dataTransferApi.preview()
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const createCode = async () => {
    setCreating(true);
    try {
      const result = await dataTransferApi.createDirectReceiveSession(receiveMode);
      setReceiveCode(result.code);
      setExpiresAt(result.expiresAt);
      onToast("Receive code created.", "success", "Direct transfer");
    } catch (err) {
      onToast(getApiErrorMessage(err, "Could not create a receive code."), "error", "Direct transfer");
    } finally {
      setCreating(false);
    }
  };

  const copyReceiveCode = async () => {
    if (!receiveCode) return;
    try {
      await navigator.clipboard.writeText(receiveCode);
      onToast("Receive code copied.", "success", "Direct transfer");
    } catch (err) {
      onToast(getApiErrorMessage(err, "Could not copy the receive code."), "error", "Direct transfer");
    }
  };

  const sendNow = async () => {
    const code = sendCode.trim();
    if (!code) return;
    const rowText = preview ? ` ${preview.total.toLocaleString()} rows and all credentials will be sent.` : " All data and credentials will be sent.";
    const destinationText = destinationInfo
      ? `${destinationInfo.destination} (${destinationInfo.mode === "wipe" ? "replace everything" : "merge"})`
      : "the destination in the receive code";
    if (!window.confirm(`Move this instance to ${destinationText}?${rowText}`)) return;
    setSending(true);
    try {
      const result = await dataTransferApi.sendDirect(code, [
        "analytics",
        "activity",
        "backups",
        "incidents",
        "migrations",
      ]);
      onToast(
        `${result.rowsRestored.toLocaleString()} rows and ${result.secretsRehydrated.toLocaleString()} credentials moved to ${result.destination}.`,
        "success",
        "Direct transfer complete",
      );
      setSendCode("");
    } catch (err) {
      onToast(getApiErrorMessage(err, "Direct transfer failed."), "error", "Direct transfer");
    } finally {
      setSending(false);
    }
  };

  return (
    <SettingsSection
      icon={ArrowRightLeft}
      title="Move directly to another instance"
      description="Transfer everything securely without downloading a file or managing an encryption password."
      iconBg="bg-primary/10"
      iconColor="text-primary"
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-primary/25 bg-primary/[0.04] px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          Start on the destination and generate a one-time receive code. Paste that code on the source instance. The code expires after 10 minutes, works once, and credentials are re-encrypted automatically for the destination.
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <div>
              <p className="text-sm font-semibold text-foreground">1. Receive on this instance</p>
              <p className="mt-1 text-xs text-muted-foreground">Choose how incoming data should be restored, then copy the generated code.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ModeOption
                selected={receiveMode === "wipe"}
                onSelect={() => { setReceiveMode("wipe"); setReceiveCode(""); }}
                title="Replace everything"
                description="Best for a new destination."
              />
              <ModeOption
                selected={receiveMode === "merge"}
                onSelect={() => { setReceiveMode("merge"); setReceiveCode(""); }}
                title="Merge"
                description="Keep existing destination data."
              />
            </div>
            <button
              type="button"
              onClick={() => void createCode()}
              disabled={creating}
              className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/50 disabled:opacity-50"
            >
              {creating && <Loader2 className="size-3.5 animate-spin" />}
              {creating ? "Creating…" : "Generate receive code"}
            </button>
            {receiveCode && (
              <div className="space-y-2">
                <textarea
                  readOnly
                  value={receiveCode}
                  aria-label="One-time receive code"
                  className="h-24 w-full resize-none rounded-lg border border-border/60 bg-muted/20 p-2 font-mono text-[10px] leading-relaxed text-foreground outline-none"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    Expires {new Date(expiresAt).toLocaleTimeString()}. Do not share it with anyone except the source instance.
                  </span>
                  <button
                    type="button"
                    onClick={() => void copyReceiveCode()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    <Clipboard className="size-3.5" /> Copy code
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <div>
              <p className="text-sm font-semibold text-foreground">2. Send from this instance</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Paste the destination code. {preview ? `${preview.total.toLocaleString()} rows plus all credentials will move.` : "All rows and credentials will move."}
              </p>
            </div>
            <textarea
              value={sendCode}
              onChange={(event) => setSendCode(event.target.value)}
              spellCheck={false}
              placeholder="Paste the one-time receive code"
              aria-label="Destination receive code"
              className="h-32 w-full resize-none rounded-lg border border-border/60 bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-primary/60"
            />
            {sendCode.trim() && (
              destinationInfo ? (
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Destination: <span className="font-medium text-foreground">{destinationInfo.destination}</span>
                  {" · "}{destinationInfo.mode === "wipe" ? "Replace everything" : "Merge with existing data"}
                  {" · "}expires {new Date(destinationInfo.expiresAt).toLocaleTimeString()}
                </div>
              ) : (
                <p className="text-xs text-danger">This does not look like a valid receive code.</p>
              )
            )}
            <button
              type="button"
              onClick={() => void sendNow()}
              disabled={sending || !destinationInfo}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {sending ? "Encrypting and moving…" : "Move to destination"}
            </button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

/* ── Export ──────────────────────────────────────────────────────── */

function ExportCard({ onToast }: { onToast: Toast }) {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  // Preserve restorable backup records and open-incident memory by default.
  // High-volume analytics/activity and completed migration logs are opt-in.
  const [history, setHistory] = useState<ExportHistoryCategory[]>([
    "backups",
    "incidents",
  ]);

  // A non-empty passphrase must be confirmed; otherwise a typo (or a blank
  // confirmation) can create a secret bundle the operator can never reopen.
  const passphraseMismatch = passphrase.length > 0 && passphrase !== confirm;

  useEffect(() => {
    let cancelled = false;
    dataTransferApi.preview()
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true);
      });
    return () => { cancelled = true; };
  }, []);

  const selectedRows = preview
    ? preview.core + history.reduce((sum, category) => sum + preview.history[category], 0)
    : null;

  const handleExport = useCallback(async () => {
    if (passphraseMismatch) return;
    setBusy(true);
    try {
      const file = (await dataTransferApi.export(passphrase || undefined, history)) as DataTransferFile;
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
  }, [passphrase, passphraseMismatch, history, onToast, t]);

  const toggleHistory = (category: ExportHistoryCategory) => {
    setHistory((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );
  };

  const generateTransferSecret = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    setPassphrase(value);
    setConfirm(value);
  };

  const copyTransferSecret = async () => {
    if (!passphrase) return;
    try {
      await navigator.clipboard.writeText(passphrase);
      onToast(t.settings.dataTransfer.export.copiedTransferSecret, "success", t.settings.common.toast.export);
    } catch (err) {
      onToast(getApiErrorMessage(err, t.settings.dataTransfer.export.toastFailed), "error", t.settings.common.toast.export);
    }
  };

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

        <div>
          <div className="mb-2">
            <p className="text-xs font-medium text-foreground">{t.settings.dataTransfer.export.filterTitle}</p>
            <p className="text-xs text-muted-foreground">{t.settings.dataTransfer.export.filterDescription}</p>
          </div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              {t.settings.dataTransfer.export.coreRows}: {preview ? preview.core.toLocaleString() : previewFailed ? t.settings.dataTransfer.export.countUnavailable : "…"}
            </span>
            <span className="font-medium text-foreground">
              {t.settings.dataTransfer.export.selectedRows}: {selectedRows === null ? previewFailed ? t.settings.dataTransfer.export.countUnavailable : "…" : selectedRows.toLocaleString()}
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              ["analytics", t.settings.dataTransfer.export.filterAnalytics],
              ["activity", t.settings.dataTransfer.export.filterActivity],
              ["backups", t.settings.dataTransfer.export.filterBackups],
              ["incidents", t.settings.dataTransfer.export.filterIncidents],
              ["migrations", t.settings.dataTransfer.export.filterMigrations],
            ] as const).map(([category, label]) => (
              <label
                key={category}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs text-foreground"
              >
                <input
                  type="checkbox"
                  checked={history.includes(category)}
                  onChange={() => toggleHistory(category)}
                  className="size-4 rounded border-border accent-primary"
                />
                <span className="flex-1">{label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {preview ? preview.history[category].toLocaleString() : previewFailed ? "—" : "…"}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-primary/25 bg-primary/[0.04] px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          {t.settings.dataTransfer.export.transferSecretNotice}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t.settings.dataTransfer.export.passphraseLabel}
            </label>
            <input
              type="text"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={t.settings.dataTransfer.export.passphrasePlaceholder}
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary/60"
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

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={generateTransferSecret}
            className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/50"
          >
            {t.settings.dataTransfer.export.generateTransferSecret}
          </button>
          <button
            type="button"
            onClick={() => void copyTransferSecret()}
            disabled={!passphrase || passphraseMismatch}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/50 disabled:opacity-40"
          >
            <Clipboard className="size-3.5" />
            {t.settings.dataTransfer.export.copyTransferSecret}
          </button>
        </div>

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
              disabled={busy || !file || (fileHasSecrets && !passphrase)}
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
