"use client";
import { AssistantSettings } from "@/components/assistant/AssistantSettings";
import { ChatAppsSettings } from "@/components/chat-apps/ChatAppsSettings";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Settings — tabbed layout with left sidebar (desktop) + horizontal
 * scroll tabs (mobile). Mirrors the project-detail page pattern.
 *
 * Tabs:
 *   - general        → appearance, build preferences, language, interface, preferences
 *   - security       → authenticator 2FA, recovery codes and passkeys
 *   - git            → repository provider connections and clone credentials
 *   - tokens         → API access tokens
 *   - mcp             → MCP connection (endpoint + client config)
 *   - team           → organization members + invitations (moved from /members)
 *   - connections    → registry, DNS and migration connections
 *   - audit          → audit log feed (moved from /audit), admin+ only
 *   - cloud          → cloud connection (self-hosted only)
 *   - infrastructure → edge/mail container versions + scan, untracked edge
 *                      routes (self-hosted/desktop)
 *   - instance       → instance info, updates, data export/import
 */

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { gitProviderDefinition, gitProviderSettingsHref } from "@repo/core";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";

import { BuildPreferences } from "./_components/BuildPreferences";
import { AppearanceSetting } from "./_components/AppearanceSetting";
import { ProfileSetting } from "./_components/ProfileSetting";
import { AppearanceEditor } from "@/components/appearance/AppearanceEditor";
import { RoutePreferences } from "./_components/RoutePreferences";
import { DeployDefaults } from "./_components/DeployDefaults";
import { CloudConnection } from "./_components/CloudConnection";
import { GitProviderSettings } from "./_components/GitProviderSettings";
import { PersonalAccessTokens } from "./_components/PersonalAccessTokens";
import { McpConnection } from "./_components/McpConnection";
import { InstanceInfo } from "./_components/InstanceInfo";
import { UntrackedEdgeRoutes } from "./_components/UntrackedEdgeRoutes";
import { LanguageSetting } from "./_components/LanguageSetting";
import { PreferencesSetting } from "./_components/PreferencesSetting";
import { PasskeysSetting } from "./_components/PasskeysSetting";
import { TwoFactorSetting } from "./_components/TwoFactorSetting";
import { ProductViewSetting } from "./_components/ProductViewSetting";
import { MailModeSetting } from "./_components/MailModeSetting";
import { UpdatesTab } from "./_components/UpdatesTab";
import { SecurityAdvisorySettings } from "./_components/SecurityAdvisorySettings";
import { InfrastructureTab } from "./_components/InfrastructureTab";
import { TeamTab } from "./_components/TeamTab";
import { NotificationsTab } from "./_components/NotificationsTab";
import { EmailSettings } from "./_components/EmailSettings";
import { Connections } from "./_components/Connections";
import { DataTransferTab } from "./_components/DataTransferTab";
import { InstanceLocation } from "@/components/instance/InstanceLocation";
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
          <UiIcon name="spinner" className="size-6 animate-spin text-muted-foreground" />
        </PageContainer>
      }
    >
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const { selfHosted, deployMode, productView, authMode } = usePlatform();
  const { refresh } = useCloud();
  const { showToast } = useToast();
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { activeTab } = useSettingsTabs();
  // Customization is a nested General view; retain the original preview URL too.
  const customizeAppearance = activeTab === "general" &&
    (searchParams.get("view") === "appearance" || searchParams.get("tab") === "appearance");

  /**
   * Openship Mail drops the cards that only a deploy platform has a use for —
   * GitHub, build preferences, clone credentials. An operator running this box as
   * a mail server has no repository in the picture.
   *
   * Presentation only, like the rail: Settings → General → "Full platform" brings
   * every card straight back, and nothing hidden here is load-bearing for mail.
   * Webmail installs from a published image (the `webmail` catalog app), so a
   * mail-only box needs no stored git credential to deploy or update it.
   */
  const mailOnly = productView === "mail";

  useEffect(() => {
    if (activeTab !== "connections" || mailOnly) return;
    const forwardGitBookmark = () => {
      const provider = gitProviderDefinition(window.location.hash.slice(1));
      if (provider) router.replace(gitProviderSettingsHref(provider.id), { scroll: false });
    };
    forwardGitBookmark();
    window.addEventListener("hashchange", forwardGitBookmark);
    return () => window.removeEventListener("hashchange", forwardGitBookmark);
  }, [activeTab, mailOnly, router]);

  // Build preferences: only self-hosted — SaaS manages builds.
  const showBuildPreferences = selfHosted && !mailOnly;
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
          <p className="text-sm text-muted-foreground/70 mt-1">{t.settings.page.subtitle}</p>
        </div>
        <HelpMenu className="shrink-0" />
      </div>

      <SettingsMobileTabs />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 mt-4 lg:mt-0">
        {/* ── ACTIVE TAB CONTENT (left, primary) ── */}
        <div className="space-y-6 min-w-0">
          {activeTab === "general" && !customizeAppearance && (
            <>
              <ProfileSetting />
              <AppearanceSetting />
              {/* Deploy Defaults + Routing hidden for now — advanced/rarely-needed,
                  reduces general-settings noise. The edge defaults to loopback-port
                  and both keep a per-project override; re-enable by uncommenting. */}
              {/* {showDeployDefaults && <DeployDefaults />} */}
              {showBuildPreferences && <BuildPreferences />}
              {/* {showBuildPreferences && <RoutePreferences />} */}
              <LanguageSetting />
              {/* Per-user shell: full platform vs Openship Mail's mail-only rail.
                  Renders nothing on the SaaS. */}
              <ProductViewSetting />
              <PreferencesSetting />
            </>
          )}

          {customizeAppearance && (
            <>
              <Link href="/settings" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" />
                {t.settings.appearance.backToGeneral}
              </Link>
              <AppearanceEditor />
            </>
          )}

          {activeTab === "security" && authMode === "local" && (
            <>
              <TwoFactorSetting />
              <PasskeysSetting />
            </>
          )}

          {/* API tokens authenticate callers to Openship. */}
          {activeTab === "tokens" && <PersonalAccessTokens />}

          {activeTab === "mcp" && <McpConnection />}
          {activeTab === "assistant" && !mailOnly && <AssistantSettings />}
          {activeTab === "chat-apps" && <ChatAppsSettings />}

          {activeTab === "team" && <TeamTab />}

          {activeTab === "notifications" && (
            <>
              <SecurityAdvisorySettings />
              <NotificationsTab />
            </>
          )}

          {activeTab === "email" && selfHosted && <EmailSettings />}

          {activeTab === "git" && !mailOnly && <GitProviderSettings />}

          {activeTab === "connections" && <Connections />}

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
              {selfHosted && (
                <InstanceLocation
                  moveRequested={searchParams.get("move") === "1"}
                  onMoveOpened={() => {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("move");
                    window.history.replaceState(
                      window.history.state,
                      "",
                      `${url.pathname}${url.search}${url.hash}`,
                    );
                  }}
                />
              )}
              <InstanceInfo />
              {/* Instance-wide default product mode (Openship Mail vs the full
                  platform). Owner-gated inside; self-hosted only. */}
              <MailModeSetting />
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
