"use client";

/**
 * Settings → DNS. Connect the provider token that lets Openship write a domain's
 * DNS records instead of printing them for the operator to paste.
 *
 * The token is write-only from here on: the list shows the same `••••••••` mask
 * the env-var views use, and there is no endpoint that reveals it. "Is it still
 * working" is answered by the credential's status (flipped to `invalid` the first
 * time the provider rejects it during provisioning) and by the zone check below,
 * which is a read — running it can't disable anything.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { SettingsSection } from "./SettingsSection";
import {
  dnsApi,
  getApiErrorMessage,
  type DnsProviderDescriptor,
  type SanitizedDnsCredential,
  type VerifyZoneResult,
} from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function DnsProviders() {
  const { showToast } = useToast();
  const { t } = useI18n();
  const copy = t.settings.dns;
  const toastTitle = t.settings.common.toast.dns;

  const [providers, setProviders] = useState<DnsProviderDescriptor[]>([]);
  const [credentials, setCredentials] = useState<SanitizedDnsCredential[]>([]);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [connecting, setConnecting] = useState(false);

  const [zoneHost, setZoneHost] = useState("");
  const [zoneChecking, setZoneChecking] = useState(false);
  const [zoneResult, setZoneResult] = useState<VerifyZoneResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [provRes, credRes] = await Promise.all([
        dnsApi.listProviders(),
        dnsApi.listCredentials(),
      ]);
      setProviders(provRes?.data ?? []);
      setCredentials(credRes?.data ?? []);
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.toast.loadFailed), "error", toastTitle);
    } finally {
      setLoading(false);
    }
  }, [showToast, copy.toast.loadFailed, toastTitle]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cloudflare = providers.find((p) => p.name === "cloudflare");

  const handleConnect = async () => {
    if (!name.trim() || !apiToken.trim()) {
      showToast(copy.toast.needBoth, "error", toastTitle);
      return;
    }
    setConnecting(true);
    try {
      // The API preflights the token against Cloudflare before storing it, so a
      // success here means it actually works — not just that it was saved.
      await dnsApi.addCredential({
        provider: "cloudflare",
        name: name.trim(),
        apiToken: apiToken.trim(),
      });
      showToast(interpolate(copy.toast.connected, { name: name.trim() }), "success", toastTitle);
      setShowForm(false);
      setName("");
      setApiToken("");
      await refresh();
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.toast.connectFailed), "error", toastTitle);
    } finally {
      setConnecting(false);
    }
  };

  const handleRemove = async (cred: SanitizedDnsCredential) => {
    try {
      await dnsApi.removeCredential(cred.id);
      showToast(interpolate(copy.toast.disconnected, { name: cred.name }), "success", toastTitle);
      await refresh();
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.toast.disconnectFailed), "error", toastTitle);
    }
  };

  const handleZoneCheck = async () => {
    if (!zoneHost.trim()) return;
    setZoneChecking(true);
    setZoneResult(null);
    try {
      setZoneResult(await dnsApi.verifyZone(zoneHost.trim()));
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.toast.checkFailed), "error", toastTitle);
    } finally {
      setZoneChecking(false);
    }
  };

  /** Zone-check verdicts read differently on purpose — see VerifyZoneResult. */
  const zoneMessage = (result: VerifyZoneResult): { text: string; tone: "success" | "warning" | "muted" } => {
    switch (result.status) {
      case "matched":
        return {
          text: interpolate(copy.zoneCheck.matched, { zone: result.zoneName ?? "" }),
          tone: "success",
        };
      case "unauthorized":
        return { text: result.message ?? copy.zoneCheck.unauthorized, tone: "warning" };
      case "unavailable":
        return { text: result.message ?? copy.zoneCheck.unavailable, tone: "warning" };
      default:
        return { text: copy.zoneCheck.none, tone: "muted" };
    }
  };

  return (
    <SettingsSection icon={Globe} title={copy.title} description={copy.description}>
      {/* What connecting actually buys, and what it costs in authority. */}
      <div className="mb-4 flex gap-2.5 rounded-xl border border-border/50 bg-muted/30 p-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="text-xs leading-relaxed text-muted-foreground">
          {copy.explainer}{" "}
          <span className="font-medium text-foreground">{copy.explainerOwnership}</span>
        </div>
      </div>

      {/* Connect form */}
      {showForm ? (
        <div className="mb-4 space-y-3 rounded-xl border border-border/50 p-4">
          {cloudflare && (
            <p className="text-xs text-muted-foreground">
              {interpolate(copy.scopesHint, { scopes: cloudflare.requiredScopes.join(", ") })}{" "}
              {cloudflare.tokenUrl && (
                <a
                  href={cloudflare.tokenUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  {copy.createTokenLink}
                  <ExternalLink className="size-3" />
                </a>
              )}
            </p>
          )}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={copy.namePlaceholder}
            className="w-full rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <input
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder={copy.tokenPlaceholder}
            autoComplete="off"
            className="w-full rounded-lg border border-border/50 bg-muted/30 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleConnect()}
              disabled={connecting}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {connecting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {copy.connect}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {t.settings.common.cancel}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="mb-4 inline-flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Plus className="size-4" />
          {copy.addProvider}
        </button>
      )}

      {/* Connected credentials */}
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t.settings.common.loading}
        </div>
      ) : credentials.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{copy.noneConnected}</p>
      ) : (
        <div className="divide-y divide-border/50">
          {credentials.map((cred) => (
            <div key={cred.id} className="flex items-center gap-3 py-3">
              <Globe className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-foreground">{cred.name}</p>
                  {cred.status === "invalid" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                      <AlertTriangle className="size-3" /> {copy.badgeInvalid}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <CheckCircle2 className="size-3" /> {copy.badgeActive}
                    </span>
                  )}
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  {cred.tokenMasked}
                  <span className="font-sans">
                    {interpolate(copy.metaLine, {
                      provider: cred.provider,
                      verified: fmtDate(cred.lastVerifiedAt),
                    })}
                  </span>
                </p>
                {cred.status === "invalid" && (
                  <p className="mt-1 text-xs text-warning">{copy.invalidHint}</p>
                )}
              </div>
              <button
                onClick={() => void handleRemove(cred)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-danger-border hover:text-danger"
              >
                <Trash2 className="size-3.5" />
                {t.settings.common.disconnect}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Zone check — "will this domain be automated?" answered before adding it. */}
      {credentials.length > 0 && (
        <div className="mt-5 border-t border-border/50 pt-4">
          <p className="mb-2 text-[13px] font-medium text-foreground">{copy.zoneCheck.title}</p>
          <p className="mb-3 text-xs text-muted-foreground">{copy.zoneCheck.description}</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={zoneHost}
              onChange={(e) => setZoneHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleZoneCheck();
              }}
              placeholder={copy.zoneCheck.placeholder}
              className="min-w-0 flex-1 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              onClick={() => void handleZoneCheck()}
              disabled={zoneChecking || !zoneHost.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {zoneChecking ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Search className="size-3.5" />
              )}
              {copy.zoneCheck.check}
            </button>
          </div>
          {zoneResult &&
            (() => {
              const { text, tone } = zoneMessage(zoneResult);
              const toneClass =
                tone === "success"
                  ? "text-success"
                  : tone === "warning"
                    ? "text-warning"
                    : "text-muted-foreground";
              return (
                <p className={`mt-2 inline-flex items-start gap-1.5 text-xs ${toneClass}`}>
                  {tone === "success" ? (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                  ) : tone === "warning" ? (
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  ) : null}
                  {text}
                </p>
              );
            })()}
        </div>
      )}
    </SettingsSection>
  );
}
