"use client";

/**
 * Settings sidebar — left-column nav for the tabbed settings page.
 *
 * Tabs are URL-driven via the `tab` query param so deep-linking works:
 *   /settings              → general (default)
 *   /settings?tab=team     → team / workspace management
 *   /settings?tab=audit    → audit log
 *   /settings?tab=cloud    → cloud connection (self-hosted only)
 *   /settings?tab=instance → instance info
 *
 * Mirror of the project sidebar pattern at
 * /projects/[id]/components/ProjectSidebar.tsx — same visual language so
 * the dashboard feels consistent.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Settings as SettingsIcon, Users, ClipboardList, Cloud, Server, Bell, KeyRound, Boxes, Mail } from "lucide-react";
import { usePlatform } from "@/context/PlatformContext";
import { useSession, authClient } from "@/lib/auth-client";
import { useI18n } from "@/components/i18n-provider";

export type SettingsTabId = "general" | "tokens" | "mcp" | "team" | "notifications" | "email" | "audit" | "cloud" | "instance";

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  icon: typeof SettingsIcon;
  /** Hidden when false (e.g. cloud tab is self-hosted only). */
  visible: boolean;
  /** Disabled when the user lacks the required role within the active org. */
  requiresRole?: "owner" | "admin" | "member";
}

export function useSettingsTabs(): { tabs: SettingsTab[]; activeTab: SettingsTabId } {
  const { selfHosted } = usePlatform();
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const raw = (searchParams.get("tab") ?? "general") as SettingsTabId;
  const allowedTabs: SettingsTabId[] = ["general", "tokens", "mcp", "team", "notifications", "email", "audit", "cloud", "instance"];
  const activeTab: SettingsTabId = allowedTabs.includes(raw) ? raw : "general";

  const tabs: SettingsTab[] = [
    { id: "general", label: t.settings.sidebar.tabs.general, icon: SettingsIcon, visible: true },
    { id: "tokens", label: t.settings.sidebar.tabs.tokens, icon: KeyRound, visible: true },
    { id: "mcp", label: t.settings.sidebar.tabs.mcp, icon: Boxes, visible: true },
    { id: "team", label: t.settings.sidebar.tabs.team, icon: Users, visible: true },
    { id: "notifications", label: t.settings.sidebar.tabs.notifications, icon: Bell, visible: true },
    // Instance SMTP transport — self-hosted only (the SaaS uses its own mailer).
    { id: "email", label: t.settings.sidebar.tabs.email, icon: Mail, visible: selfHosted, requiresRole: "admin" },
    { id: "audit", label: t.settings.sidebar.tabs.audit, icon: ClipboardList, visible: true, requiresRole: "admin" },
    { id: "cloud", label: t.settings.sidebar.tabs.cloud, icon: Cloud, visible: selfHosted },
    // Updates live INSIDE the Instance tab (the "this install" home), not as
    // their own tab — see settings/page.tsx.
    { id: "instance", label: t.settings.sidebar.tabs.instance, icon: Server, visible: true },
  ];

  return { tabs: tabs.filter((t) => t.visible), activeTab };
}

export function SettingsSidebar() {
  const router = useRouter();
  const { data: session } = useSession();
  const { t } = useI18n();
  const { tabs, activeTab } = useSettingsTabs();

  const handleTabChange = (tabId: SettingsTabId) => {
    const url = tabId === "general" ? "/settings" : `/settings?tab=${tabId}`;
    router.replace(url, { scroll: false });
  };

  // Resolve active org name for the header card.
  const orgClient = (authClient as unknown as {
    organization: {
      getFullOrganization: () => Promise<{ data?: { id: string; name: string } | null }>;
    };
  }).organization;
  // Note: simple sync read — we just use the session.user email/name in the header.
  // The full org name is shown in the AccountSwitcher dropdown elsewhere.

  return (
    <div className="space-y-3">
      <div className="bg-card rounded-2xl border border-border/50 p-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center">
            <SettingsIcon className="size-4 text-foreground" strokeWidth={1.7} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate">{t.settings.sidebar.title}</p>
            {session?.user?.email && (
              <p className="text-xs text-muted-foreground truncate">{session.user.email}</p>
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
                <Icon className="size-[17px] shrink-0" strokeWidth={1.7} />
                {tab.label}
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
              <Icon className="size-[15px]" strokeWidth={1.7} />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
