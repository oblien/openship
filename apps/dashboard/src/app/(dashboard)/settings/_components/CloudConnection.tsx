"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  Database,
  Github,
  Globe,
  LogOut,
  Loader2,
  ExternalLink,
  Rocket,
} from "lucide-react";
import { cloudApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { CloudIllustration } from "./CloudIllustration";

/* ── Component ──────────────────────────────────────────────────── */

export function CloudConnection() {
  const { baseDomain } = usePlatform();
  const { t } = useI18n();
  const {
    connected: cloudConnected,
    cloudUser,
    loading: cloudLoading,
    connecting,
    startConnect,
    refresh,
  } = useCloud();
  const { showToast } = useToast();
  const [disconnecting, setDisconnecting] = useState(false);

  const pitch = t.settings.cloud.pitch;
  /* Lead with the free domain — it is the perk that lands without any commitment,
     and the one people actually hit first (a project's free domain routes through
     Cloud, see the `managed-project-domain` capability). */
  const perks = [
    { Icon: Globe, text: interpolate(pitch.perkDomain, { domain: baseDomain }) },
    { Icon: Rocket, text: pitch.perkDeploy },
    { Icon: Database, text: pitch.perkServices },
    { Icon: Github, text: pitch.perkGithub },
  ];

  async function handleDisconnect() {
    if (!confirm(t.settings.cloud.confirmDisconnect)) return;
    try {
      setDisconnecting(true);
      await cloudApi.disconnect();
      await refresh();
      showToast(t.settings.cloud.toast.disconnected, "success", t.settings.common.toast.cloud);
    } catch {
      showToast(t.settings.cloud.toast.disconnectFailed, "error", t.settings.common.toast.cloud);
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      {cloudLoading ? (
        <div className="py-4 flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{t.settings.cloud.checking}</p>
        </div>
      ) : cloudConnected ? (
        <div className="space-y-4">
          {/* Header + user info */}
          <div className="flex items-center gap-3">
            {cloudUser?.image ? (
              <img
                src={cloudUser.image}
                alt=""
                className="size-9 rounded-full ring-1 ring-border shrink-0"
              />
            ) : (
              <div className="size-9 rounded-full bg-muted flex items-center justify-center ring-1 ring-border shrink-0">
                <span className="text-xs font-medium text-muted-foreground">
                  {cloudUser?.name?.charAt(0)?.toUpperCase() || cloudUser?.email?.charAt(0)?.toUpperCase() || "?"}
                </span>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {cloudUser?.name || t.settings.cloud.fallbackName}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {cloudUser?.email || t.settings.cloud.connectedAccount}
              </p>
            </div>
          </div>

          {/* Status badge */}
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-success-bg text-success text-xs font-semibold rounded-full ring-1 ring-success-border">
              <Check className="size-3" />
              {t.settings.cloud.connected}
            </div>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors disabled:opacity-50"
            >
              {disconnecting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <LogOut className="size-3" />
              )}
              {t.settings.common.disconnect}
            </button>
          </div>

          <div className="h-px bg-border/60" />

          {/* Cloud features summary */}
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t.settings.cloud.featuresActive}
          </p>
        </div>
      ) : (
        /* Disconnected — this is a sales surface, not an error state. Illustration,
           what you actually get, then the two actions. Every perk below maps to a
           real CloudCapability (packages/core/src/cloud-capability.ts), so nothing
           here promises something `requireCloud` doesn't gate. */
        <div className="flex flex-col items-center px-1 pb-1 pt-3 text-center">
          <CloudIllustration className="relative mb-6 h-24 w-72 max-w-full" />

          <h4 className="text-lg font-medium text-foreground" style={{ letterSpacing: "-0.2px" }}>
            {pitch.title}
          </h4>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {interpolate(pitch.body, { domain: baseDomain })}
          </p>

          <ul className="mx-auto mt-5 grid w-full max-w-lg gap-2.5 text-start sm:grid-cols-2">
            {perks.map(({ Icon, text }) => (
              <li key={text} className="flex items-start gap-2.5">
                <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10">
                  <Icon className="size-3 text-primary" />
                </span>
                <span className="text-[13px] leading-snug text-muted-foreground">{text}</span>
              </li>
            ))}
          </ul>

          <div className="mt-6 flex w-full max-w-md flex-col gap-2 sm:flex-row">
            <button
              onClick={startConnect}
              disabled={connecting}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50"
            >
              {connecting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {t.settings.cloud.waitingSignIn}
                </>
              ) : (
                <>
                  <ExternalLink className="size-3.5" />
                  {t.settings.cloud.connectButton}
                </>
              )}
            </button>
            <a
              href="https://openship.io/pricing"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-muted/50 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:flex-none"
            >
              {pitch.viewPricing}
              <ArrowUpRight className="size-3.5" />
            </a>
          </div>

          <p className="mt-3.5 text-xs text-muted-foreground/70">{pitch.noLockIn}</p>
        </div>
      )}
    </div>
  );
}
