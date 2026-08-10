"use client";

/**
 * Top-level mail admin panel - shown on /emails once the server is fully
 * provisioned. Tab state lives in the URL so refreshes and back/forward
 * navigation preserve context.
 *
 * Tab bar: chunky horizontal nav with icon-above-label. Each tab gets a
 * proper hit area + clear active state so the admin reads as a flagship
 * surface, not a settings page. Built on a sticky <nav> with a single
 * bottom border, like Vercel's project header tabs.
 *
 * Tabs:
 *   - Overview:   credentials + setup-guide banners + webmail.
 *   - Domains:    vmail.domain CRUD.
 *   - Mailboxes:  vmail.mailbox CRUD per domain.
 *   - DNS:        reference of DNS records.
 *   - Components: live daemon health (separated from Overview by request).
 *   - Advanced:   destructive / power-user actions.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  Globe,
  UserRound,
  Forward,
  FileText,
  HeartPulse,
  Send,
  Settings,
  DatabaseBackup,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { MailSetupStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n-provider";
import { OverviewTab } from "./overview-tab";
import { DomainsTab } from "./domains-tab";
import { MailboxesTab } from "./mailboxes-tab";
import { AliasesTab } from "./aliases-tab";
import { DnsTab } from "./dns-tab";
import { HealthTab } from "./health-tab";
import { TestTab } from "./test-tab";
import { BackupTab } from "./backup-tab";
import { SendingTab } from "./sending-tab";
import { AdvancedTab } from "./advanced-tab";
import { WelcomeModal } from "./welcome-modal";
import { ReputationBanner } from "./reputation-banner";
import { MailEngineBanner } from "./engine-banner";

const WELCOME_SEEN_PREFIX = "openship:mail:welcome-seen:";

interface MailAdminPanelProps {
  status: MailSetupStatus;
  serverId: string;
  onRefresh: () => void;
  /** Called after the server is removed from the mail registry (DB-only). */
  onForgotten: () => void;
}

type TabKey =
  | "overview"
  | "domains"
  | "mailboxes"
  | "aliases"
  | "dns"
  | "health"
  | "test"
  | "backup"
  | "sending"
  | "advanced";

interface TabDef {
  key: TabKey;
  icon: LucideIcon;
}

const TABS: TabDef[] = [
  { key: "overview", icon: LayoutDashboard },
  { key: "domains", icon: Globe },
  { key: "mailboxes", icon: UserRound },
  { key: "aliases", icon: Forward },
  { key: "dns", icon: FileText },
  { key: "health", icon: HeartPulse },
  { key: "test", icon: Send },
  { key: "backup", icon: DatabaseBackup },
  { key: "sending", icon: Waypoints },
  { key: "advanced", icon: Settings },
];

const VALID_TABS: TabKey[] = TABS.map((t) => t.key);

export function MailAdminPanel({ status, serverId, onRefresh, onForgotten }: MailAdminPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const primaryDomain = status.domain ?? "";
  const [showWelcome, setShowWelcome] = useState(false);

  // One-shot welcome modal: first time the admin panel mounts for this
  // serverId, show the celebratory test-email modal. The flag is keyed by
  // serverId so each new mail server gets its own welcome moment.
  useEffect(() => {
    if (!serverId || typeof window === "undefined") return;
    const key = `${WELCOME_SEEN_PREFIX}${serverId}`;
    if (window.localStorage.getItem(key)) return;
    setShowWelcome(true);
  }, [serverId]);

  const dismissWelcome = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`${WELCOME_SEEN_PREFIX}${serverId}`, "1");
    }
    setShowWelcome(false);
  }, [serverId]);

  const tab = useMemo<TabKey>(() => {
    const raw = searchParams.get("tab") as TabKey | null;
    if (raw && VALID_TABS.includes(raw)) return raw;
    return "overview";
  }, [searchParams]);

  const selectedDomain = searchParams.get("domain") || primaryDomain;

  const setQuery = useCallback(
    (patch: { tab?: TabKey; domain?: string | null }) => {
      const next = new URLSearchParams(searchParams.toString());
      if (patch.tab !== undefined) next.set("tab", patch.tab);
      if (patch.domain !== undefined) {
        if (patch.domain) next.set("domain", patch.domain);
        else next.delete("domain");
      }
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  return (
    <div className="space-y-6">
      {/* Engine state first: when it isn't serving, every tab below fails, so the
          one condition and the one fix belong above the tab bar rather than
          rediscovered as an error inside whichever tab the operator opened. */}
      <MailEngineBanner serverId={serverId} engine={status.engine} onRepaired={onRefresh} />

      {primaryDomain && (
        <ReputationBanner serverId={serverId} domain={primaryDomain} />
      )}

      <TabBar
        tabs={TABS}
        active={tab}
        onChange={(k) => setQuery({ tab: k })}
      />

      <div>
        {tab === "overview" && (
          <OverviewTab status={status} serverId={serverId} onRefresh={onRefresh} />
        )}
        {tab === "domains" && (
          <DomainsTab
            serverId={serverId}
            primaryDomain={primaryDomain}
            onDomainDeleted={(deleted) => {
              // If the URL's `?domain=` matched the just-deleted domain,
              // strip it so subsequent navigation to the Mailboxes tab
              // doesn't try to fetch from a domain that's gone.
              if (searchParams.get("domain") === deleted) {
                setQuery({ domain: null });
              }
            }}
          />
        )}
        {tab === "mailboxes" && (
          <MailboxesTab
            serverId={serverId}
            primaryDomain={primaryDomain}
            selectedDomain={selectedDomain}
            onSelectDomain={(d) => setQuery({ domain: d })}
          />
        )}
        {tab === "aliases" && (
          <AliasesTab
            serverId={serverId}
            primaryDomain={primaryDomain}
            selectedDomain={selectedDomain}
            onSelectDomain={(d) => setQuery({ domain: d })}
          />
        )}
        {tab === "dns" && (
          <DnsTab
            status={status}
            serverId={serverId}
            primaryDomain={primaryDomain}
            selectedDomain={selectedDomain}
            onSelectDomain={(d) => setQuery({ domain: d })}
          />
        )}
        {tab === "health" && <HealthTab serverId={serverId} />}
        {tab === "test" && <TestTab serverId={serverId} />}
        {tab === "backup" && <BackupTab serverId={serverId} domain={primaryDomain} />}
        {tab === "sending" && <SendingTab serverId={serverId} primaryDomain={primaryDomain} />}
        {tab === "advanced" && (
          <AdvancedTab
            status={status}
            serverId={serverId}
            onChanged={onRefresh}
            onForgotten={onForgotten}
          />
        )}
      </div>

      {showWelcome && primaryDomain && (
        <WelcomeModal
          serverId={serverId}
          domain={primaryDomain}
          onClose={dismissWelcome}
        />
      )}
    </div>
  );
}

// ─── Tab bar ─────────────────────────────────────────────────────────────────

/**
 * Tab bar - matches the pattern used on the server-detail page
 * (servers/[serverId]/page.tsx): horizontal flex with icon-left-of-label,
 * thin bottom-border on the bar, primary-coloured underline indicator
 * sitting under the active tab. Scrolls horizontally on narrow screens.
 */
function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: TabKey;
  onChange: (key: TabKey) => void;
}) {
  const { t } = useI18n();
  return (
    <nav
      className="flex items-center gap-1 border-b border-border/50 overflow-x-auto"
      aria-label={t.emailsAdmin.panel.ariaLabel}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = active === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative whitespace-nowrap",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/70",
            )}
          >
            <Icon className="size-4" strokeWidth={2} />
            {t.emailsAdmin.panel.tabs[tab.key]}
            {isActive && (
              <span className="absolute bottom-0 start-0 end-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
