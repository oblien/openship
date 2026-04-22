"use client";

import { useState } from "react";
import {
  Check,
  LogOut,
  Loader2,
  ExternalLink,
  Globe,
} from "lucide-react";
import { cloudApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";

/* ── Component ──────────────────────────────────────────────────── */

export function CloudConnection() {
  const { authMode, deployMode } = usePlatform();
  const {
    connected: cloudConnected,
    cloudUser,
    loading: cloudLoading,
    connecting,
    startConnect,
    refresh,
  } = useCloud();
  const { showToast } = useToast();
  const isDesktop = deployMode === "desktop";
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect from Openship Cloud? Cloud deployments will stop working until you reconnect.",
      )
    )
      return;
    try {
      setDisconnecting(true);
      await cloudApi.disconnect();
      await refresh();
      showToast("Disconnected from Openship Cloud", "success", "Cloud");
    } catch {
      showToast("Failed to disconnect", "error", "Cloud");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      {cloudLoading ? (
        <div className="py-4 flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Checking…</p>
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
                {cloudUser?.name || "Openship Cloud"}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {cloudUser?.email || "Connected cloud account"}
              </p>
            </div>
          </div>

          {/* Status badge */}
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold rounded-full ring-1 ring-emerald-500/20">
              <Check className="size-3" />
              Connected
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
              Disconnect
            </button>
          </div>

          <div className="h-px bg-border/60" />

          {/* Cloud features summary */}
          <p className="text-xs text-muted-foreground leading-relaxed">
            Cloud deployments, managed SSL, and global CDN are active for your instance.
          </p>
        </div>
      ) : (
        <div className="text-center">
          {/* Cloud icon */}
          <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Globe className="size-6 text-primary" />
          </div>

          <h4 className="text-sm font-medium text-foreground mb-1">Connect to Cloud</h4>
          <p className="text-xs text-muted-foreground leading-relaxed mb-4">
            {isDesktop
              ? "Unlock cloud deployments, managed SSL, and global CDN."
              : "Deploy to cloud directly from your local instance."}
          </p>

          <button
            onClick={startConnect}
            disabled={connecting}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50"
          >
            {connecting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Waiting for sign in…
              </>
            ) : (
              <>
                <ExternalLink className="size-3.5" />
                Connect to Openship Cloud
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
