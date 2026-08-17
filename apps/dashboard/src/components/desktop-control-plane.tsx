"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  Check,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Wrench,
  DatabaseBackup,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/app/(dashboard)/settings/_components/SettingsSection";

function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}

export function useDesktopControlPlane(): DesktopControlPlaneInfo | null {
  const [info, setInfo] = useState<DesktopControlPlaneInfo | null>(null);

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop?.isDesktop) return;
    const read = () => {
      const fromInstance = desktop.instance?.info();
      const fromUrls = desktop.app?.localUrls?.();
      void (fromInstance ?? fromUrls)
        ?.then(setInfo)
        .catch(() => {});
    };
    read();
    const off = desktop.instance?.onChange(setInfo);
    return () => off?.();
  }, []);

  return info;
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title="Copy"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/50 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">
        {label}
      </p>
      <div className="mt-1 flex items-start gap-2">
        <p className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{value}</p>
        <CopyValue value={value} />
      </div>
    </div>
  );
}

/**
 * Settings → Instance panel for the desktop control plane.
 * Browser-only no-op: `window.desktop` is absent on the web/SaaS build.
 */
export function DesktopControlPlanePanel() {
  const info = useDesktopControlPlane();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(async (id: string, action: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    setNote(null);
    try {
      const result = await action();
      if (result === false) {
        setNote("Failed");
        return;
      }
      if (result === null) {
        setNote("Cancelled");
        return;
      }
      setNote(typeof result === "string" ? `${ok} → ${result}` : ok);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }, []);

  if (!info) return null;

  const originMoved =
    info.switched.api ||
    (!!info.previousAdvertisedOrigin && info.previousAdvertisedOrigin !== info.advertisedOrigin);

  return (
    <SettingsSection
      icon={HardDrive}
      title="Control plane"
      description="This desktop app is the local control plane. Closing the window hides it; it stays running in the tray."
      iconBg="bg-emerald-500/10"
      iconColor="text-emerald-500"
    >
      {originMoved && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
          <p className="font-medium">Gateway port moved</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The API is now {info.advertisedOrigin}
            {info.previousAdvertisedOrigin ? ` (was ${info.previousAdvertisedOrigin})` : ""}.
            MCP OAuth clients must use this origin as the audience — the previous port is no longer valid.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Fingerprint" value={info.fingerprint} />
        <Field label="API endpoint" value={info.api} />
        <Field label="MCP origin" value={info.advertisedOrigin} />
        <Field label="Data path" value={info.dataPath} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => void run("browser", () => window.desktop!.instance!.openBrowser(), "Opened in browser")}
        >
          <ExternalLink className="size-3.5" />
          Open in browser
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => void run("restart", () => window.desktop!.instance!.restartEngine(), "Engine restarted")}
        >
          {busy === "restart" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Restart engine
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => void run("repair", () => window.desktop!.instance!.repairEndpoint(), "Endpoint rebound")}
        >
          {busy === "repair" ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
          Repair endpoint
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => void run("backup", () => window.desktop!.instance!.backup(), "Backed up")}
        >
          {busy === "backup" ? <Loader2 className="size-3.5 animate-spin" /> : <DatabaseBackup className="size-3.5" />}
          Back up control plane
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => void run("folder", () => window.desktop!.instance!.openDataFolder(), "Opened data folder")}
        >
          <FolderOpen className="size-3.5" />
          Open data folder
        </Button>
      </div>

      {note && <p className="mt-3 text-xs text-muted-foreground">{note}</p>}
    </SettingsSection>
  );
}

/** Compact titlebar chip: API host plus a warning when the gateway moved. */
export function DesktopControlPlaneChrome() {
  const info = useDesktopControlPlane();
  if (!info) return null;
  const originMoved =
    info.switched.api ||
    (!!info.previousAdvertisedOrigin && info.previousAdvertisedOrigin !== info.advertisedOrigin);
  return (
    <div className="app-titlebar-instance" title={`${info.fingerprint} · ${info.dataPath}`}>
      {originMoved && <span className="app-titlebar-instance-warn">Port moved</span>}
      <span className="app-titlebar-instance-host">{hostLabel(info.api)}</span>
    </div>
  );
}
