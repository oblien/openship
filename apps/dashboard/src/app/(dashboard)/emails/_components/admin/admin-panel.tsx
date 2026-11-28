"use client";

import type { IconName } from "@repo/ui/icons";
import type { ManagedMailSummary } from "@repo/contracts/managed-mail";
import { Tabs } from "@/components/ui/Tabs";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { MailSetupStatus } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";
import { useMailRailOwnsTabs } from "../../_lib/mail-section";
import { canonicalMailTab, MAIL_TAB_KEYS, type MailTabKey } from "@/lib/mail-tabs";
import { OverviewTab, type MailSetupPanels } from "./overview-tab";
import { DomainsTab } from "./domains-tab";
import { SenderDomainsWorkspace } from "./sender-domains-workspace";
import { MailboxesTab } from "./mailboxes-tab";
import { AliasesTab } from "./aliases-tab";
import { NotificationsTab } from "./notifications-tab";
import { DnsTab } from "./dns-tab";
import { HealthTab } from "./health-tab";
import { BackupTab } from "./backup-tab";
import { AdvancedTab } from "./advanced-tab";
import { WelcomeModal } from "./welcome-modal";
import { ReputationBanner } from "./reputation-banner";
import { MailEngineBanner } from "./engine-banner";

import { ManagedSending } from "./managed-sending";
import { InstanceSending } from "./instance-sending";

const WELCOME_SEEN_PREFIX = "openship:mail:welcome-seen:";

type MailAdminPanelProps = {
  limits?: ManagedMailSummary["limits"];
  sendingConfigured?: boolean;
  onRefresh: () => void;
} & ({
  managed?: boolean;
  status: MailSetupStatus;
  serverId: string;
  setup?: never;
  onForgotten: () => void;
} | {
  managed: true;
  setup: MailSetupPanels | { sendingOnly: true; mailboxes: ReactNode };
  serverId?: never;
  status?: never;
  onForgotten?: never;
});

const TAB_ICONS: Record<MailTabKey, IconName> = {
  overview: "dashboard",
  domains: "globe",
  mailboxes: "user",
  aliases: "forward",
  notifications: "bell",
  sending: "network",
  dns: "file-text",
  health: "activity",
  backup: "database-backup",
  advanced: "settings",
};

const cloudTabs: MailTabKey[] = ["overview", "mailboxes", "domains", "sending"];
const sendingTabs: MailTabKey[] = ["sending", "mailboxes"];

export function MailAdminPanel({ status, serverId, onRefresh, onForgotten, managed = false, limits, sendingConfigured, setup }: MailAdminPanelProps) {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  // In Openship Mail the sidebar IS this tab bar — same ten keys, same order
  // (`MAIL_TAB_KEYS` in lib/mail-tabs.ts, which both render from) — so showing both
  // is one row of navigation twice. See the hook for why it depends on the rail's
  // state and not just on the view.
  const railHasTabs = useMailRailOwnsTabs(serverId ?? null);
  const primaryDomain = managed ? "" : status?.domain ?? "";
  const [showWelcome, setShowWelcome] = useState(false);

  // One-shot welcome modal: first time the admin panel mounts for this
  // serverId, show the celebratory test-email modal. The flag is keyed by
  // serverId so each new mail server gets its own welcome moment.
  useEffect(() => {
    if (!primaryDomain || !serverId || typeof window === "undefined") return;
    const key = `${WELCOME_SEEN_PREFIX}${serverId}`;
    if (window.localStorage.getItem(key)) return;
    setShowWelcome(true);
  }, [primaryDomain, serverId]);

  const dismissWelcome = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`${WELCOME_SEEN_PREFIX}${serverId}`, "1");
    }
    setShowWelcome(false);
  }, [serverId]);

  // Resolved through the shared alias table, not a bare validity check: the page
  // header reads the same URL through the same function, so a retired `?tab=test`
  // shows Sending under Sending's heading rather than under "Email Server".
  const requestedTab = useMemo<MailTabKey>(() => {
    const fallback = managed && (searchParams.get("mailView") === "sending" || searchParams.has("senderId") || searchParams.has("senderView")) ? "sending" : null;
    return canonicalMailTab(searchParams.get("tab") ?? fallback);
  }, [managed, searchParams]);

  const sendingOnly = setup && "sendingOnly" in setup;
  const tabs = sendingOnly ? sendingTabs : managed ? cloudTabs : MAIL_TAB_KEYS;
  const tab = managed && !sendingOnly && requestedTab === "dns" ? "dns" : tabs.includes(requestedTab) ? requestedTab : tabs[0]!;
  const selectedDomain = searchParams.get("domain") || primaryDomain;
  const search = searchParams.toString();
  const sectionHref = useCallback((section: MailTabKey, domain?: string | null) => {
    const next = new URLSearchParams(search);
    next.set("tab", section);
    if (next.get("mailView") === "sending") next.delete("mailView");
    if (section !== "sending") {
      next.delete("senderId");
      next.delete("senderView");
    }
    if (domain) next.set("domain", domain);
    else if (domain === null) next.delete("domain");
    return "?" + next.toString();
  }, [search]);
  function go(section: MailTabKey, domain?: string | null) {
    router.push(sectionHref(section, domain), { scroll: false });
  }
  const selectDomain = useCallback((domain: string) => {
    router.replace(sectionHref(tab, domain || null), { scroll: false });
  }, [router, sectionHref, tab]);

  return (
    <div className="space-y-6">
      {/* Engine state first: when it isn't serving, every tab below fails, so the
          one condition and the one fix belong above the tab bar rather than
          rediscovered as an error inside whichever tab the operator opened. */}
      {!managed && status && <MailEngineBanner serverId={serverId} engine={status.engine} observationError={status.observationError} onRepaired={onRefresh} />}

      {serverId && primaryDomain && (
        <ReputationBanner serverId={serverId} domain={primaryDomain} />
      )}

      {!railHasTabs && (
        <Tabs<MailTabKey>
          tabs={tabs.map(key => ({
            key, label: t.emailsAdmin.panel.tabs[key], icon: TAB_ICONS[key], href: sectionHref(key),
          }))}
          value={managed && tab === "dns" ? "domains" : tab}
          ariaLabel={t.emailsAdmin.panel.ariaLabel}
          onChange={key => go(key)}
        />
      )}

      <div>
        {tab === "overview" && !sendingOnly && (
          <OverviewTab managed={managed} setup={setup} sendingConfigured={sendingConfigured} onSendingActivated={onRefresh} limits={limits} status={status} serverId={serverId} sectionHref={sectionHref} />
        )}
        {tab === "sending" && <div className="space-y-5">
          {!managed && serverId
            ? <InstanceSending serverId={serverId} primaryDomain={primaryDomain}
                webmailReady={!!(status?.webmail?.projectId && status.webmail.installed && status.webmail.url)} />
            : <ManagedSending initialDomain={primaryDomain} serviceId={serverId}
                configured={sendingConfigured} allowance={limits?.recipients} onConfigured={onRefresh} />}
        </div>}
        {setup && tab === "mailboxes" && setup.mailboxes}
        {setup && !sendingOnly && (tab === "domains" || tab === "dns") && (
          <SenderDomainsWorkspace {...setup.senderDomains} dnsDomain={tab === "dns" ? selectedDomain : undefined}
            allowance={limits?.recipients} listHref={sectionHref("domains", null)} dnsHref={domain => sectionHref("dns", domain)} />
        )}
        {status && <>
          {tab === "domains" && (
            <DomainsTab managed={managed} sectionHref={sectionHref}
              serverId={serverId}
              primaryDomain={primaryDomain}
              onDomainDeleted={(deleted) => {
                // If the URL's `?domain=` matched the just-deleted domain,
                // strip it so subsequent navigation to the Mailboxes tab
                // doesn't try to fetch from a domain that's gone.
                if (searchParams.get("domain") === deleted) {
                  selectDomain("");
                }
              }}
            />
          )}
          {tab === "mailboxes" && (
            <MailboxesTab
              domainsHref={sectionHref("domains", null)}
              serverId={serverId}
              primaryDomain={primaryDomain}
              selectedDomain={selectedDomain}
              onSelectDomain={selectDomain}
            />
          )}
          {tab === "aliases" && (
            <AliasesTab
              serverId={serverId}
              primaryDomain={primaryDomain}
              selectedDomain={selectedDomain}
              onSelectDomain={selectDomain}
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
              onSelectDomain={selectDomain}
            />
          )}
          {tab === "health" && <HealthTab serverId={serverId} />}
          {tab === "backup" && <BackupTab serverId={serverId} domain={primaryDomain} />}
          {tab === "advanced" && (
            <AdvancedTab
              status={status}
              serverId={serverId}
              onChanged={onRefresh}
              onForgotten={onForgotten}
            />
          )}
        </>}
      </div>

      {serverId && showWelcome && primaryDomain && (
        <WelcomeModal
          serverId={serverId}
          domain={primaryDomain}
          onClose={dismissWelcome}
        />
      )}
    </div>
  );
}
