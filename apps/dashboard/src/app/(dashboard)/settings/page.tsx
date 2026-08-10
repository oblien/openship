"use client";

/**
 * Settings — tabbed layout with left sidebar (desktop) + horizontal
 * scroll tabs (mobile). Mirrors the project-detail page pattern.
 *
 * Tabs:
 *   - general        → GitHub connection, deploy defaults, build preferences
 *   - tokens         → clone credentials, API access tokens
 *   - mcp             → MCP connection (endpoint + client config)
 *   - team           → organization members + invitations (moved from /members)
 *   - audit          → audit log feed (moved from /audit), admin+ only
 *   - cloud          → cloud connection (self-hosted only)
 *   - infrastructure → edge/mail container versions + scan, untracked edge
 *                      routes (self-hosted/desktop)
 *   - instance       → instance info, updates, data export/import
 */

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";

import { BuildPreferences } from "./_components/BuildPreferences";
import { RoutePreferences } from "./_components/RoutePreferences";
import { DeployDefaults } from "./_components/DeployDefaults";
import { CloudConnection } from "./_components/CloudConnection";
import { GitHubConnection } from "./_components/GitHubConnection";
import { CloneCredentials } from "./_components/CloneCredentials";
import { PersonalAccessTokens } from "./_components/PersonalAccessTokens";
import { McpConnection } from "./_components/McpConnection";
import { InstanceInfo } from "./_components/InstanceInfo";
import { UntrackedEdgeRoutes } from "./_components/UntrackedEdgeRoutes";
import { LanguageSetting } from "./_components/LanguageSetting";
import { PreferencesSetting } from "./_components/PreferencesSetting";
import { UpdatesTab } from "./_components/UpdatesTab";
import { InfrastructureTab } from "./_components/InfrastructureTab";
import { TeamTab } from "./_components/TeamTab";
import { NotificationsTab } from "./_components/NotificationsTab";
import { EmailSettings } from "./_components/EmailSettings";
import { AuditTab } from "./_components/AuditTab";
import { DataTransferTab } from "./_components/DataTransferTab";
import {
  SettingsSidebar,
  SettingsMobileTabs,
  useSettingsTabs,
} from "./_components/SettingsSidebar";
import { PageContainer } from "@/components/ui/PageContainer";
import { HelpMenu } from "@/components/HelpMenu";

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <PageContainer>
          <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </PageContainer>
      }
    >
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const { selfHosted, deployMode } = usePlatform();
  const { refresh } = useCloud();
  const { showToast } = useToast();
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const { activeTab } = useSettingsTabs();

  // Build preferences: only self-hosted — SaaS manages builds.
  const showBuildPreferences = selfHosted;
  // Deploy defaults: only meaningful where the picker exists (desktop / self-hosted)
  const showDeployDefaults = selfHosted;

  /* ── Cloud callback (redirect after connect) ── */
  useEffect(() => {
    if (searchParams.get("cloud") === "connected") {
      refresh();
      showToast(t.settings.page.cloudConnectedToast, "success", t.settings.common.toast.cloud);
      window.history.replaceState({}, "", "/settings?tab=cloud");
    }
  }, [searchParams, showToast, refresh, t]);

  return (
    <PageContainer>
      {/* Settings is where people land when something needs explaining, so the
          shared ⋮ (support / report issue / feedback / docs / community) sits at
          the page title's trailing edge. A section inside a tab may carry its own
          ⋮ for its own actions (e.g. Team's workspace menu) — different level,
          different scope. */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="text-2xl font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
            {t.settings.page.title}
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">
            {t.settings.page.subtitle}
          </p>
        </div>
        <HelpMenu className="shrink-0" />
      </div>

      <SettingsMobileTabs />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 mt-4 lg:mt-0">
        {/* ── ACTIVE TAB CONTENT (left, primary) ── */}
        <div className="space-y-6 min-w-0">
          {activeTab === "general" && (
            <>
              <GitHubConnection />
              {/* Deploy Defaults + Routing hidden for now — advanced/rarely-needed,
                  reduces general-settings noise. The edge defaults to loopback-port
                  and both keep a per-project override; re-enable by uncommenting. */}
              {/* {showDeployDefaults && <DeployDefaults />} */}
              {showBuildPreferences && <BuildPreferences />}
              {/* {showBuildPreferences && <RoutePreferences />} */}
              <LanguageSetting />
              <PreferencesSetting />
            </>
          )}

          {activeTab === "tokens" && (
            <>
              <PersonalAccessTokens />
              <CloneCredentials />
            </>
          )}

          {activeTab === "mcp" && <McpConnection />}

          {activeTab === "team" && <TeamTab />}

          {activeTab === "notifications" && <NotificationsTab />}

          {activeTab === "email" && selfHosted && <EmailSettings />}

          {activeTab === "audit" && <AuditTab />}

          {activeTab === "cloud" && selfHosted && <CloudConnection />}

          {/* Infrastructure — the servers this install runs: edge/mail container
              versions across the fleet + scan + auto-update toggle, and the
              leftover edge routes. Self-hosted/desktop only. */}
          {activeTab === "infrastructure" && (selfHosted || deployMode === "desktop") && (
            <>
              <InfrastructureTab />
              {/* Hostnames the local edge still serves with no Openship record —
                  the leftovers a record-only delete deliberately keeps running.
                  Owner-gated inside the component, renders nothing when clean.
                  Self-hosted only: on the SaaS the edge isn't the operator's. */}
              {selfHosted && <UntrackedEdgeRoutes />}
            </>
          )}

          {activeTab === "instance" && (
            <>
              <InstanceInfo />
              {/* Updates to this install — not on the SaaS, where the managed
                  cloud has nothing for the user to update. */}
              {(selfHosted || deployMode === "desktop") && <UpdatesTab />}
              {/* Full-DB export/import (owner-gated inside the component);
                  self-hosted only — SaaS has no portable DB. */}
              {selfHosted && <DataTransferTab />}
            </>
          )}
        </div>

        {/* ── NAV (right, sticky on desktop) ── */}
        <aside className="hidden lg:block lg:sticky lg:top-6 lg:self-start">
          <SettingsSidebar />
        </aside>
      </div>
    </PageContainer>
  );
}
