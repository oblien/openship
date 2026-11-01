"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

/**
 * Settings sidebar — left-column nav for the tabbed settings page.
 *
 * Tabs are URL-driven via the `tab` query param so deep-linking works:
 *   /settings              → general (default)
 *   /settings?tab=team     → team / workspace management
 *   /settings?tab=cloud    → cloud connection (self-hosted only)
 *   /settings?tab=instance → instance info
 *
 * Mirror of the project sidebar pattern at
 * /projects/[id]/components/ProjectSidebar.tsx — same visual language so
 * the dashboard feels consistent.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePlatform } from "@/context/PlatformContext";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/components/i18n-provider";
import { systemApi } from "@/lib/api/system";

/**
 * Count of actionable infrastructure issues (edge down / absent-with-projects) —
 * drives the attention dot on the Infrastructure tab, mirroring the project
 * sidebar's routing dot. Only fetched where the tab exists (self-hosted/desktop);
 * cheap (reads the drift cache), best-effort (a failed read shows no dot).
 */
function useInfraIssuesCount(): number {
  const { selfHosted, deployMode } = usePlatform();
  const enabled = selfHosted || deployMode === "desktop";
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    systemApi
      .containerIssues()
      .then((r) => {
        if (!cancelled) setCount(r.total);
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/settings/_components/SettingsSidebar");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? count : 0;
}

export type SettingsTabId = "general" | "security" | "git" | "tokens" | "mcp" | "team" | "notifications" | "email" | "credentials" | "dns" | "cloud" | "infrastructure" | "instance";

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  icon: IconName;
  /** Hidden when false (e.g. cloud tab is self-hosted only). */
  visible: boolean;
  /** Disabled when the user lacks the required role within the active org. */
  requiresRole?: "owner" | "admin" | "member";
}

export function useSettingsTabs(): { tabs: SettingsTab[]; activeTab: SettingsTabId } {
  const { selfHosted, deployMode, productView, authMode } = usePlatform();
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const raw = (searchParams.get("tab") ?? "general") as SettingsTabId;
  // Keep old DNS bookmarks working now that tokens live in Credentials.
  const allowedTabs: SettingsTabId[] = ["general", "security", "git", "tokens", "mcp", "team", "notifications", "email", "credentials", "dns", "cloud", "infrastructure", "instance"];
  const requested: SettingsTabId = allowedTabs.includes(raw) ? raw : "general";
  // DNS credentials moved into Credentials — one screen for every third-party secret
  // instead of three. The old link lands on the screen that now owns them.
  const activeTab: SettingsTabId = requested === "dns" ? "credentials"
    : requested === "security" && authMode !== "local" ? "general" : requested;

  const tabs: SettingsTab[] = [
    { id: "general", label: t.settings.sidebar.tabs.general, icon: "settings", visible: true },
    { id: "security", label: t.settings.sidebar.tabs.security, icon: "shield-check", visible: authMode === "local" },
    // Git sources, as their own domain rather than a card on General: the App install, the
    // clone PAT and per-server auth are one subject with several shapes, and more providers
    // (GitLab, Bitbucket) land here rather than widening anything else. Hidden in the
    // mail-only shell, which deploys nothing from source.
    { id: "git", label: t.settings.sidebar.tabs.git, icon: "git-branch", visible: productView !== "mail" },
    { id: "credentials", label: t.settings.sidebar.tabs.credentials, icon: "key", visible: true, requiresRole: "admin" },
    { id: "tokens", label: t.settings.sidebar.tabs.tokens, icon: "terminal", visible: true },
    { id: "mcp", label: t.settings.sidebar.tabs.mcp, icon: "mcp", visible: true },
    { id: "team", label: t.settings.sidebar.tabs.team, icon: "users", visible: true },
    { id: "notifications", label: t.settings.sidebar.tabs.notifications, icon: "bell", visible: true },
    // Instance SMTP transport — self-hosted only (the SaaS uses its own mailer).
    // In Openship Mail it sits next to a whole rail of mail-server surfaces, where
    // "Email" would read as the mail server's own config; "System sender" says
    // what it actually is (where invites and alerts are sent FROM).
    {
      id: "email",
      label: productView === "mail"
        ? t.settings.sidebar.tabs.systemSender
        : t.settings.sidebar.tabs.email,
      icon: "mail",
      visible: selfHosted,
      requiresRole: "admin",
    },
    { id: "cloud", label: t.settings.sidebar.tabs.cloud, icon: "cloud", visible: selfHosted },
    // The servers this install runs — edge/mail container versions + global scan
    // + untracked edge routes. Self-hosted/desktop only (the SaaS has no
    // operator-managed infra). See settings/page.tsx.
    { id: "infrastructure", label: t.settings.sidebar.tabs.infrastructure, icon: "server-settings", visible: selfHosted || deployMode === "desktop", requiresRole: "admin" },
    { id: "instance", label: t.settings.sidebar.tabs.instance, icon: "server", visible: true },
  ];

  return { tabs: tabs.filter((t) => t.visible), activeTab };
}

export function SettingsSidebar() {
  const router = useRouter();
  // The dashboard layout seeds AuthContext with the server-validated user.
  // Reading Better Auth's client store directly here made the first render
  // depend on whether its session request won the race with hydration: SSR
  // omitted the email while a fast client cache included it, producing React
  // hydration error #418. The seeded context is identical on both sides and
  // still reconciles to the live session after mount.
  const { user } = useAuth();
  const { t } = useI18n();
  const { tabs, activeTab } = useSettingsTabs();
  const infraIssues = useInfraIssuesCount();

  const handleTabChange = (tabId: SettingsTabId) => {
    const url = tabId === "general" ? "/settings" : `/settings?tab=${tabId}`;
    router.replace(url, { scroll: false });
  };

  return (
    <div className="space-y-3">
      <div className="bg-card rounded-2xl border border-border/50 p-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center">
            <UiIcon name="settings" className="size-4 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate">{t.settings.sidebar.title}</p>
            {user?.email && (
              <p className="text-xs text-muted-foreground truncate">{user.email}</p>
            )}
          </div>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border/50 p-3">
        <div className="space-y-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleTabChange(tab.id)}
                className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-colors ${
                  isActive
                    ? "bg-foreground/[0.07] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                }`}
              >
                <UiIcon name={Icon} className="size-[17px] shrink-0" />
                {tab.label}
                {tab.id === "infrastructure" && infraIssues > 0 && (
                  <span
                    className="ms-auto size-1.5 rounded-full bg-warning-solid"
                    aria-label="Infrastructure needs attention"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Mobile horizontal scroll tabs — rendered above content on small screens. */
export function SettingsMobileTabs() {
  const router = useRouter();
  const { tabs, activeTab } = useSettingsTabs();
  const infraIssues = useInfraIssuesCount();

  const handleTabChange = (tabId: SettingsTabId) => {
    const url = tabId === "general" ? "/settings" : `/settings?tab=${tabId}`;
    router.replace(url, { scroll: false });
  };

  return (
    <div className="lg:hidden -mx-4 px-4 overflow-x-auto">
      <div className="inline-flex items-center gap-1 bg-card rounded-xl border border-border/50 p-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabChange(tab.id)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? "bg-foreground/[0.07] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
              }`}
            >
              <UiIcon name={Icon} className="size-[15px]" />
              {tab.label}
              {tab.id === "infrastructure" && infraIssues > 0 && (
                <span
                  className="size-1.5 rounded-full bg-warning-solid"
                  aria-label="Infrastructure needs attention"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
