"use client";

import { Info, MonitorSmartphone, Shield } from "lucide-react";
import { useGitHub } from "@/context/GitHubContext";
import { useAuth } from "@/context/AuthContext";
import { SettingsSection } from "./SettingsSection";

export function InstanceInfo() {
  const { user } = useAuth();
  const { authMode, deployMode } = useGitHub();
  const isDesktop = authMode === "none";
  const isCloudSaas = deployMode === "cloud";

  return (
    <SettingsSection
      icon={Info}
      title="Instance"
      description={isDesktop ? "Desktop app" : isCloudSaas ? "Cloud" : "Self-hosted"}
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
              {isDesktop ? "Desktop" : isCloudSaas ? "Openship Cloud" : "Self-Hosted"}
            </p>
            <p className="text-xs text-muted-foreground">Deploy mode: {deployMode}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border/50 p-4">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <Shield className="size-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {authMode === "none"
                ? "Zero Auth"
                : authMode === "cloud"
                  ? "Cloud Auth"
                  : "Local Auth"}
            </p>
            <p className="text-xs text-muted-foreground">
              {user?.email || (isDesktop ? "Local user" : "—")}
            </p>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
