"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useToast } from "@/context/ToastContext";

import { BuildPreferences } from "./_components/BuildPreferences";
import { ServerConnection } from "./_components/ServerConnection";
import { CloudConnection } from "./_components/CloudConnection";
import { GitHubConnection } from "./_components/GitHubConnection";
import { InstanceInfo } from "./_components/InstanceInfo";
import { PageContainer } from "@/components/ui/PageContainer";

export default function SettingsPage() {
  return (
    <Suspense fallback={
      <PageContainer>
          <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </PageContainer>
    }>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const { selfHosted, authMode } = usePlatform();
  const { refresh } = useCloud();
  const { showToast } = useToast();
  const searchParams = useSearchParams();

  // Build preferences: only self-hosted — SaaS manages builds.
  const showBuildPreferences = selfHosted;
  // Server connection (SSH / tunnel) only when self-hosted with local infra
  const showServerConnection = selfHosted && authMode !== "cloud";
  // Cloud connection available for self-hosted instances (connect/disconnect)
  const showCloudConnection = selfHosted;

  /* ── Cloud callback (redirect after connect) ── */
  useEffect(() => {
    if (searchParams.get("cloud") === "connected") {
      refresh();
      showToast("Connected to Openship Cloud", "success", "Cloud");
      window.history.replaceState({}, "", "/settings");
    }
  }, [searchParams, showToast, refresh]);

  return (
    <PageContainer>
        <div className="mb-6">
          <h1
            className="text-2xl font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
            Settings
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">
            Manage your preferences, connections, and instance configuration
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          {/* ── LEFT COLUMN ── */}
          <div className="space-y-6 min-w-0">
            <GitHubConnection />
            {showBuildPreferences && <BuildPreferences />}
            {showServerConnection && <ServerConnection />}
            <InstanceInfo />
          </div>

          {/* ── RIGHT COLUMN (Sticky) ── */}
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            {showCloudConnection && <CloudConnection />}
          </div>
        </div>
    </PageContainer>
  );
}
