"use client";

/**
 * Top-level mail admin panel - shown on /emails once the server is fully
 * provisioned. Tab state lives in the URL so refreshes and back/forward
 * navigation preserve context.
 *
 * Which sections exist, and their order, come from `MAIL_TAB_KEYS`
 * (@/lib/mail-tabs) — the same list the mail rail renders from, so the bar and the
 * rail cannot disagree. `TAB_ICONS` below is only the glyph for each, and the
 * component rendered for each is the `tab === "…"` run further down. A prose list
 * of the tabs used to live here; it went stale twice, which is the drift that let
 * `inbound` and `test` survive in three readers at once.
 *
 * Tab bar: chunky horizontal nav with icon beside label. Each tab gets a proper hit
 * area + clear active state so the admin reads as a flagship surface, not a settings
 * page. Built on a <nav> with a single bottom border, like Vercel's project header
 * tabs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  Globe,
  UserRound,
  Forward,
  Bell,
  FileText,
  HeartPulse,
  Settings,
  DatabaseBackup,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { MailSetupStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n-provider";
import { useMailRailOwnsTabs } from "../../_lib/mail-section";
import { canonicalMailTab, MAIL_TAB_KEYS, type MailTabKey } from "@/lib/mail-tabs";
import { OverviewTab } from "./overview-tab";
import { DomainsTab } from "./domains-tab";
import { MailboxesTab } from "./mailboxes-tab";
import { AliasesTab } from "./aliases-tab";
import { NotificationsTab } from "./notifications-tab";
import { DnsTab } from "./dns-tab";
import { HealthTab } from "./health-tab";
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

interface TabDef {
  key: MailTabKey;
  icon: LucideIcon;
}

/**
 * Sending sits at the head of the delivery run (Sending → DNS → Health), matching
 * the rail's Delivery group in `lib/sidebar-nav.ts` — the two are one ordering, and
 * it exists in both places only because platform view renders this bar while mail
 * view renders the rail. Sending is the decision (direct vs relay); DNS and Health
 * check what it decided, so they can't come before it. Sending a test email is a
 * check too, which is why it's an action inside Sending and not a tab of its own.
 *
 * Order comes from `MAIL_TAB_KEYS`; this map only says which glyph each section
 * gets, so a new section is a type error here rather than a tab that silently
 * never renders.
 */
const TAB_ICONS: Record<MailTabKey, LucideIcon> = {
  overview: LayoutDashboard,
  domains: Globe,
  mailboxes: UserRound,
  aliases: Forward,
  notifications: Bell,
  sending: Waypoints,
  dns: FileText,
  health: HeartPulse,
  backup: DatabaseBackup,
  advanced: Settings,
};

const TABS: TabDef[] = MAIL_TAB_KEYS.map((key) => ({ key, icon: TAB_ICONS[key] }));

export function MailAdminPanel({ status, serverId, onRefresh, onForgotten }: MailAdminPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // In Openship Mail the sidebar IS this tab bar — same ten keys, same order
  // (`MAIL_TAB_KEYS` in lib/mail-tabs.ts, which both render from) — so showing both
  // is one row of navigation twice. See the hook for why it depends on the rail's
  // state and not just on the view.
  const railHasTabs = useMailRailOwnsTabs(serverId);
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

  // Resolved through the shared alias table, not a bare validity check: the page
  // header reads the same URL through the same function, so a retired `?tab=test`
  // shows Sending under Sending's heading rather than under "Email Server".
  const tab = useMemo<MailTabKey>(() => canonicalMailTab(searchParams.get("tab")), [searchParams]);

  const selectedDomain = searchParams.get("domain") || primaryDomain;

  const setQuery = useCallback(
    (patch: { tab?: MailTabKey; domain?: string | null }) => {
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

      {!railHasTabs && (
        <TabBar
          tabs={TABS}
          active={tab}
          onChange={(k) => setQuery({ tab: k })}
        />
      )}

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
        {tab === "notifications" && (
          <NotificationsTab serverId={serverId} primaryDomain={primaryDomain} />
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
  active: MailTabKey;
  onChange: (key: MailTabKey) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="relative">
      <nav
        className="flex items-center gap-1 border-b border-border/50 overflow-x-auto scrollbar-hide"
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
                "inline-flex shrink-0 items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative whitespace-nowrap",
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
      {/* Fade edges hint that the strip scrolls, same treatment as the
          project detail mobile tab bar. */}
      <div className="pointer-events-none absolute inset-y-0 start-0 w-6 bg-gradient-to-r from-background to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 end-0 w-6 bg-gradient-to-l from-background to-transparent" />
    </div>
  );
}
