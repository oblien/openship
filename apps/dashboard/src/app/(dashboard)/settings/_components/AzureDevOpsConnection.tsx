"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Unplug } from "lucide-react";
import { azureApi, getApiErrorMessage } from "@/lib/api";
import type { AzureStatus } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { SettingsSection } from "./SettingsSection";
import { useI18n } from "@/components/i18n-provider";

/**
 * Self-hosted Azure DevOps connections: one PAT per (tenant, Azure DevOps
 * organization). Connections are scoped to the signed-in organization and
 * rotatable independently. Hidden on SaaS — Azure routes are localOnly.
 */
export function AzureDevOpsConnection() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { selfHosted } = usePlatform();
  const [status, setStatus] = useState<AzureStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingPat, setSavingPat] = useState(false);
  const [pat, setPat] = useState("");
  const [org, setOrg] = useState("");

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

  if (!selfHosted) return null;

  const copy = t.settings.azureDevops;
  const toastTitle = copy.toastTitle;

  const savePat = async () => {
    const trimmed = pat.trim();
    if (!trimmed) return;
    setSavingPat(true);
    try {
      await azureApi.saveToken(trimmed, org.trim());
      setPat("");
      setOrg("");
      await loadStatus();
      showToast(copy.saved, "success", toastTitle);
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.saveFailed), "error", toastTitle);
    } finally {
      setSavingPat(false);
    }
  };

  const disconnect = async (adoOrg: string) => {
    try {
      await azureApi.deleteConnection(adoOrg);
      await loadStatus();
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.disconnectFailed), "error", toastTitle);
    }
  };

  const connected = (status?.connections.length ?? 0) > 0;

  return (
    <SettingsSection
      icon={"cloud"}
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
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">
                {connected ? copy.connectedPat : copy.notConnected}
              </p>
            </div>
            {connected ? (
              <ul className="space-y-1.5">
                {status?.connections.map((conn) => (
                  <li
                    key={conn.adoOrg}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">{conn.adoOrg}</span>
                    <button
                      type="button"
                      onClick={() => void disconnect(conn.adoOrg)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/50"
                    >
                      <Unplug className="size-3.5" />
                      {copy.disconnect}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{copy.connectPrompt}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <KeyRound className="size-3.5" />
              {copy.patLabel}
            </label>
            <p className="text-xs text-muted-foreground leading-relaxed">{copy.patHint}</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                placeholder={copy.orgPlaceholder}
                autoComplete="off"
                className="w-48 shrink-0 rounded-xl border border-border/50 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
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
                disabled={savingPat || !pat.trim() || !org.trim()}
                className="rounded-xl bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-40"
              >
                {savingPat ? <Loader2 className="size-4 animate-spin" /> : copy.patSave}
              </button>
            </div>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
