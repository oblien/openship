"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Instance-tab section (self-hosted, instance administrators) — export the
 * instance or selected projects and import them on another install: migrating
 * between installs, e.g. a desktop → a self-hosted server (PGlite → Postgres is
 * handled), or desktop ↔ desktop. Secrets travel re-encrypted under a passphrase the
 * user sets on export and re-enters on import; the API re-encrypts them under
 * the destination install's own key.
 *
 * Instance-admin gating is enforced by the API; this component renders nothing
 * for users without the instance-admin role.
 */

import { useEffect, useMemo, useState } from "react";

import { SettingsSection } from "./SettingsSection";
import { ExportPanel } from "@/components/data-transfer/ExportPanel";
import { ImportModal as DataTransferImportModal } from "@/components/data-transfer/ImportModal";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import {
  dataTransferApi,
  getApiErrorMessage,
  inspectDirectTransferCode,
  type ExportPreview,
  type ImportMode,
} from "@/lib/api";

export function DataTransferTab() {
  const { user } = useAuth();
  const { showToast } = useToast();
  if (user?.role !== "admin") return null;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5 text-xs leading-relaxed text-warning">
        These tools move the Openship database and credentials. Persistent Docker volume contents
        are not included; move service data with project/server migration or restore it from a
        backup.
      </div>
      <ExportCard onToast={showToast} />
      <ImportCard onToast={showToast} />
      <DirectTransferCard onToast={showToast} />
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
    dataTransferApi
      .preview()
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const createCode = async () => {
    setCreating(true);
    try {
      const result = await dataTransferApi.createDirectReceiveSession(receiveMode);
      setReceiveCode(result.code);
      setExpiresAt(result.expiresAt);
      onToast("Receive code created.", "success", "Direct transfer");
    } catch (err) {
      onToast(
        getApiErrorMessage(err, "Could not create a receive code."),
        "error",
        "Direct transfer",
      );
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
      onToast(
        getApiErrorMessage(err, "Could not copy the receive code."),
        "error",
        "Direct transfer",
      );
    }
  };

  const sendNow = async () => {
    const code = sendCode.trim();
    if (!code) return;
    const rowText = preview
      ? ` ${preview.total.toLocaleString()} rows and all credentials will be sent.`
      : " All data and credentials will be sent.";
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
      icon={"arrows-left-right"}
      title="Move directly to another instance"
      description="Transfer the Openship database and credentials securely without downloading a file or managing an encryption password."
      iconBg="bg-primary/10"
      iconColor="text-primary"
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-primary/25 bg-primary/[0.04] px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          Start on the destination and generate a one-time receive code. Paste that code on the
          source instance. The code expires after 10 minutes, works once, and credentials are
          re-encrypted automatically for the destination.
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <div>
              <p className="text-sm font-semibold text-foreground">1. Receive on this instance</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose how incoming data should be restored, then copy the generated code.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ModeOption
                selected={receiveMode === "wipe"}
                onSelect={() => {
                  setReceiveMode("wipe");
                  setReceiveCode("");
                }}
                title="Replace everything"
                description="Best for a new destination."
              />
              <ModeOption
                selected={receiveMode === "merge"}
                onSelect={() => {
                  setReceiveMode("merge");
                  setReceiveCode("");
                }}
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
              {creating && <UiIcon name="spinner" className="size-3.5 animate-spin" />}
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
                    Expires {new Date(expiresAt).toLocaleTimeString()}. Do not share it with anyone
                    except the source instance.
                  </span>
                  <button
                    type="button"
                    onClick={() => void copyReceiveCode()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    <UiIcon name="clipboard" className="size-3.5" /> Copy code
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <div>
              <p className="text-sm font-semibold text-foreground">2. Send from this instance</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Paste the destination code.{" "}
                {preview
                  ? `${preview.total.toLocaleString()} rows plus all credentials will move.`
                  : "All rows and credentials will move."}
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
            {sendCode.trim() &&
              (destinationInfo ? (
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Destination:{" "}
                  <span className="font-medium text-foreground">{destinationInfo.destination}</span>
                  {" · "}
                  {destinationInfo.mode === "wipe"
                    ? "Replace everything"
                    : "Merge with existing data"}
                  {" · "}expires {new Date(destinationInfo.expiresAt).toLocaleTimeString()}
                </div>
              ) : (
                <p className="text-xs text-danger">This does not look like a valid receive code.</p>
              ))}
            <button
              type="button"
              onClick={() => void sendNow()}
              disabled={sending || !destinationInfo}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {sending ? <UiIcon name="spinner" className="size-4 animate-spin" /> : <UiIcon name="send" className="size-4" />}
              {sending ? "Encrypting and moving…" : "Move to destination"}
            </button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

/* ── Export ──────────────────────────────────────────────────────── */

function ExportCard(_props: { onToast: Toast }) {
  return (
    <SettingsSection
      icon={"download"}
      title="Export instance or projects"
      description="Choose a complete instance or selected projects, with their environments and dependencies."
    >
      <ExportPanel />
    </SettingsSection>
  );
}

function ImportCard({ onToast }: { onToast: Toast }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <SettingsSection
      icon={"upload"}
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
          <UiIcon name="upload" className="size-4" />
          {t.settings.dataTransfer.import.importFromFile}
        </button>
      </div>

      <ImportModal open={open} onClose={() => setOpen(false)} onToast={onToast} />
    </SettingsSection>
  );
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void; onToast: Toast }) {
  return open ? <DataTransferImportModal open={open} onClose={onClose} /> : null;
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
        selected
          ? "border-primary/60 bg-primary/[0.05]"
          : "border-border/50 hover:bg-foreground/[0.03]"
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
