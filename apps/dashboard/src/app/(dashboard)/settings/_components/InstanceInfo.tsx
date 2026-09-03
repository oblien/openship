"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Cpu,
  HardDrive,
  Info,
  MonitorSmartphone,
  Shield,
} from "lucide-react";
import { usePlatform } from "@/context/PlatformContext";
import { useAuth } from "@/context/AuthContext";
import { systemApi } from "@/lib/api/system";
import { SettingsSection } from "./SettingsSection";
import { UpgradeAuthModal } from "./UpgradeAuthModal";
import { useI18n, interpolate } from "@/components/i18n-provider";

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

interface TelemetryData {
  uptimeSeconds: number;
  hostUptimeSeconds: number;
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    systemTotalMb: number;
    systemFreeMb: number;
  };
  cpu: {
    cores: number;
    model: string;
    loadAvg: number[];
  };
  process: {
    nodeVersion: string;
    platform: string;
    arch: string;
    pid: number;
  };
}

export function InstanceInfo() {
  const { user } = useAuth();
  const { authMode, deployMode, version: serverVersion } = usePlatform();
  const { t } = useI18n();
  const isDesktop = authMode === "none";
  const isCloudSaas = deployMode === "cloud";
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);

  useEffect(() => {
    systemApi
      .getTelemetry()
      .then((res) => {
        if (res.ok && res.telemetry) {
          setTelemetry(res.telemetry);
        }
      })
      .catch(() => {});
  }, []);

  // Running version: the native app version on desktop (from the bridge), else
  // the server release already resolved by the dashboard's SSR shell.
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  useEffect(() => {
    if (deployMode !== "desktop") return;
    const bridge = (window as { desktop?: { app?: { version: () => Promise<string> } } }).desktop
      ?.app;
    bridge
      ?.version()
      .then(setDesktopVersion)
      .catch(() => {});
  }, [deployMode]);
  const version = (deployMode === "desktop" ? desktopVersion : serverVersion) ?? null;

  return (
    <SettingsSection
      icon={Info}
      title={t.settings.instance.title}
      description={
        isDesktop
          ? t.settings.instance.descDesktop
          : isCloudSaas
            ? t.settings.instance.descCloud
            : t.settings.instance.descSelfHosted
      }
      iconBg="bg-violet-500/10"
      iconColor="text-violet-500"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex items-center gap-3 rounded-xl border border-border/50 p-4">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <MonitorSmartphone className="size-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {isDesktop
                ? t.settings.instance.typeDesktop
                : isCloudSaas
                  ? t.settings.instance.typeCloud
                  : t.settings.instance.typeSelfHosted}
            </p>
            <p className="text-xs text-muted-foreground">
              {interpolate(t.settings.instance.deployMode, { mode: deployMode })}
              {version ? ` · v${version}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border/50 p-4">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <Shield className="size-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              {authMode === "none"
                ? t.settings.instance.authNone
                : authMode === "cloud"
                  ? t.settings.instance.authCloud
                  : t.settings.instance.authLocal}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {user?.email || (isDesktop ? t.settings.instance.localUser : "-")}
            </p>
          </div>
          {/* "Change" only shows in zero-auth — once promoted there's
              no in-place downgrade. Cloud-mode swaps go through the
              cloud-disconnect flow elsewhere. */}
          {isDesktop && (
            <button
              type="button"
              onClick={() => setUpgradeOpen(true)}
              className="shrink-0 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
            >
              {t.settings.instance.change}
            </button>
          )}
        </div>
      </div>

      {telemetry && (
        <div className="mt-4 pt-4 border-t border-border/40">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-emerald-500" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Control Plane Health & Telemetry
              </span>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 text-xs font-medium">
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Operational
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Cpu className="size-3.5" />
                <span className="text-xs font-medium">CPU & Load</span>
              </div>
              <p className="text-sm font-semibold text-foreground">
                {telemetry.cpu.cores} Core{telemetry.cpu.cores > 1 ? "s" : ""}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                Load: {telemetry.cpu.loadAvg.map((l) => l.toFixed(2)).join(", ")}
              </p>
            </div>

            <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <HardDrive className="size-3.5" />
                <span className="text-xs font-medium">Process Memory</span>
              </div>
              <p className="text-sm font-semibold text-foreground">
                {telemetry.memory.rssMb} MB RSS
              </p>
              <p className="text-[11px] text-muted-foreground">
                Heap: {telemetry.memory.heapUsedMb} / {telemetry.memory.heapTotalMb} MB
              </p>
            </div>

            <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                <span className="text-xs font-medium">Uptime</span>
              </div>
              <p className="text-sm font-semibold text-foreground">
                {formatUptime(telemetry.uptimeSeconds)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Node {telemetry.process.nodeVersion} ({telemetry.process.platform})
              </p>
            </div>
          </div>
        </div>
      )}

      <UpgradeAuthModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        onSuccess={() => {
          // Hard reload so PlatformContext re-reads the new authMode
          // and AuthContext picks up the updated user row.
          if (typeof window !== "undefined") {
            window.location.reload();
          }
        }}
      />
    </SettingsSection>
  );
}
