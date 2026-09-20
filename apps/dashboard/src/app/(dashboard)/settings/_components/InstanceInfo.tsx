"use client";

import { useEffect, useState } from "react";
import { Info, MonitorSmartphone, Shield } from "lucide-react";
import { usePlatform } from "@/context/PlatformContext";
import { useAuth } from "@/context/AuthContext";
import { SettingsSection } from "./SettingsSection";
import { UpgradeAuthModal } from "./UpgradeAuthModal";
import { useI18n, interpolate } from "@/components/i18n-provider";

export function InstanceInfo() {
  const { user } = useAuth();
  const { authMode, deployMode, version: serverVersion } = usePlatform();
  const { t } = useI18n();
  const isDesktop = authMode === "none";
  const isCloudSaas = deployMode === "cloud";
  const [upgradeOpen, setUpgradeOpen] = useState(false);

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
