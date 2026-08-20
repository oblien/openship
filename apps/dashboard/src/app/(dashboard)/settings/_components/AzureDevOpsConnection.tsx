"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Unplug } from "lucide-react";
import { azureApi, endpoints, getApiBaseUrl, getApiErrorMessage } from "@/lib/api";
import type { AzureStatus } from "@/lib/api";
import { openAuthWindow } from "@/utils/authWindow";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { SettingsSection } from "./SettingsSection";
import { useI18n } from "@/components/i18n-provider";

function AzureMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M15 3.62 8.68.28 7.16 2.16 2.34 3.84.5 8.47l1.84 1.6L.5 12.35 4.84 16l8.41-2.72V3.41L15 3.62zM5.28 12.28 2.62 10l2.62-1.1.04 3.38zm7.41.13-6.22 2.03V8.72l6.22-3.19v6.88z"
      />
    </svg>
  );
}

/**
 * Self-hosted Azure DevOps connection: Entra ID OAuth and/or an instance PAT.
 * Hidden on SaaS — Azure routes are localOnly.
 */
export function AzureDevOpsConnection() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { selfHosted } = usePlatform();
  const [status, setStatus] = useState<AzureStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [savingPat, setSavingPat] = useState(false);
  const [pat, setPat] = useState("");
  const pendingConnectRef = useRef(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await azureApi.getStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selfHosted) void loadStatus();
  }, [selfHosted, loadStatus]);

  useEffect(() => {
    const repullIfPending = () => {
      if (!pendingConnectRef.current) return;
      pendingConnectRef.current = false;
      void loadStatus();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") repullIfPending();
    };
    window.addEventListener("focus", repullIfPending);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", repullIfPending);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadStatus]);

  if (!selfHosted) return null;

  const copy = t.settings.azureDevops;
  const toastTitle = copy.toastTitle;

  const connect = async () => {
    setConnecting(true);
    pendingConnectRef.current = true;
    try {
      const res = await azureApi.connect();
      if (res.flow === "redirect") {
        const handle = openAuthWindow(`${getApiBaseUrl()}${endpoints.azure.connectRedirect}`);
        handle.onClose(() => {
          void loadStatus();
          setConnecting(false);
        });
        return;
      }
      showToast(res.error || copy.connectFailed, "error", toastTitle);
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.connectFailed), "error", toastTitle);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      await azureApi.disconnect();
      setPat("");
      await loadStatus();
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.disconnectFailed), "error", toastTitle);
    }
  };

  const savePat = async () => {
    const trimmed = pat.trim();
    if (!trimmed) return;
    setSavingPat(true);
    try {
      await azureApi.setInstanceToken(trimmed);
      setPat("");
      await loadStatus();
      showToast(copy.saved, "success", toastTitle);
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.saveFailed), "error", toastTitle);
    } finally {
      setSavingPat(false);
    }
  };

  const clearPat = async () => {
    setSavingPat(true);
    try {
      await azureApi.setInstanceToken(null);
      await loadStatus();
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.saveFailed), "error", toastTitle);
    } finally {
      setSavingPat(false);
    }
  };

  const connectedLabel = status?.oauth
    ? copy.connectedOauth
    : status?.pat
      ? copy.connectedPat
      : copy.notConnected;

  return (
    <SettingsSection
      icon={AzureMark}
      title={copy.title}
      description={copy.description}
      iconBg="bg-sky-500/10"
      iconColor="text-sky-600"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {copy.checking}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">{connectedLabel}</p>
              {status?.orgs?.length ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{status.orgs.join(" · ")}</p>
              ) : (
                <p className="mt-0.5 text-xs text-muted-foreground">{copy.connectPrompt}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {status?.connected ? (
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/50"
                >
                  <Unplug className="size-3.5" />
                  {copy.disconnect}
                </button>
              ) : status?.oauthConfigured ? (
                <button
                  type="button"
                  onClick={() => void connect()}
                  disabled={connecting}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                >
                  {connecting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {connecting ? copy.connecting : copy.connect}
                </button>
              ) : (
                <p className="text-xs text-muted-foreground">{copy.oauthNotConfigured}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <KeyRound className="size-3.5" />
              {copy.patLabel}
            </label>
            <p className="text-xs text-muted-foreground leading-relaxed">{copy.patHint}</p>
            <div className="flex gap-2">
              <input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder={copy.patPlaceholder}
                autoComplete="off"
                className="flex-1 rounded-xl border border-border/50 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="button"
                onClick={() => void savePat()}
                disabled={savingPat || !pat.trim()}
                className="rounded-xl bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-40"
              >
                {savingPat ? <Loader2 className="size-4 animate-spin" /> : copy.patSave}
              </button>
              {status?.pat ? (
                <button
                  type="button"
                  onClick={() => void clearPat()}
                  disabled={savingPat}
                  className="rounded-xl border border-border/60 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/50 disabled:opacity-40"
                >
                  {copy.patClear}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
