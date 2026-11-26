"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  getApiErrorMessage,
  isMailEngineUnavailable,
  mailAdminApi,
  type MailServerStats,
  type MailSetupStatus,
  type MailWebmailSummary,
} from "@/lib/api";
import { getMarketingOrigin } from "@/lib/api/urls";
import { webmailCta } from "../../_lib/webmail-cta";
import { MailStatsCard } from "./mail-stats-card";
import { useSendingLimits } from "./sending-limits";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { SendingQuotaCard, useSendingUsage } from "./sending-usage";
import { MailboxActivity, type MailActivitySidebar } from "./mailbox-activity";
import { FeatureIllustration } from "@repo/ui/illustrations";
import type { MailTabKey } from "@/lib/mail-tabs";
import type { ManagedMailSummary } from "@repo/contracts/managed-mail";
import { useI18n } from "@/components/i18n-provider";
import { mailHostname } from "@repo/core";

import { SenderDomainsSummary, type SenderDomainsSetupProps } from "./sender-domains-workspace";

export type MailSetupPanels = { hostingStatus: ReactNode; mailboxes: ReactNode; senderDomains: SenderDomainsSetupProps };

interface OverviewTabProps {
  managed?: boolean;
  sendingConfigured?: boolean;
  onSendingActivated?: () => void;
  limits?: ManagedMailSummary["limits"];
  sectionHref: (tab: MailTabKey, domain?: string | null) => string;
  status?: MailSetupStatus;
  serverId?: string;
  setup?: MailSetupPanels;
}

export function OverviewTab(props: OverviewTabProps) {
  const { managed, serverId, status, sectionHref, setup } = props;
  const mailHost = status?.domain ? mailHostname(status.domain) : "";
  const scope = useResourceScope();
  const renderSidebar: MailActivitySidebar = domainSwitch => (
    <aside className={`flex min-w-0 flex-col gap-4 @min-[44rem]/mail-overview:col-start-2 @min-[44rem]/mail-overview:row-start-2 ${managed ? "row-start-2" : ""}`}>
      {serverId ? <MailServerCard managed={managed} mailHost={mailHost} serverId={serverId} webmail={status?.webmail} /> : setup && <SenderDomainsSummary {...setup.senderDomains} />}
      {!managed && <QuickActionsCard sectionHref={sectionHref} />}
      {domainSwitch}
    </aside>
  );
  return (
    <div className="@container/mail-overview space-y-5">
      <div className="grid min-w-0 items-start gap-4 @min-[44rem]/mail-overview:grid-cols-[minmax(0,1fr)_clamp(16rem,32%,22rem)]">
        <LiveMailActivity key={scope + ":" + serverId} {...props} renderSidebar={renderSidebar} />
      </div>
      {!managed && <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(245px,1fr)]">
        <SetupGuidesBanner /><CalendarContactsCard />
      </div>}
    </div>
  );
}

type SectionHref = OverviewTabProps["sectionHref"];

function LiveMailActivity({ renderSidebar, managed, serverId, limits, sendingConfigured, onSendingActivated, sectionHref, setup }: OverviewTabProps & { renderSidebar: MailActivitySidebar }) {
  const { stats, loading, blocked, error, refresh } = useOverviewStats(serverId);
  const { t } = useI18n();
  const caps = useSendingLimits("senders", !!managed && !!serverId, limits?.recipients, onSendingActivated);
  const configured = !!sendingConfigured || caps.configured;
  const usage = useSendingUsage(!!managed && configured);
  function reload() {
    refresh();
    caps.refresh();
    usage.refresh();
  }
  return <>
    <MailStatsCard stats={stats} managed={managed} limits={limits} loading={loading}
      sending={managed && <SendingQuotaCard compact usage={usage.data} allowance={limits?.recipients} inactive={!configured && sendingConfigured === false}
        loading={configured && usage.loading} onRetry={usage.error ? usage.refresh : undefined} />} />
    <MailboxActivity renderSidebar={renderSidebar} setup={setup?.hostingStatus} inbox={stats?.inbox} loading={loading} refresh={reload}
      sending={managed ? caps.limits : undefined}
      mailboxHref={domain => sectionHref("mailboxes", domain)} domainsHref={sectionHref("domains", null)}
      error={blocked ? t.emailsAdmin.engine.cardBlocked : error || caps.error} />
    {caps.editor}
  </>;
}

function CalendarContactsCard() {
  const { t } = useI18n();
  const copy = t.emailsAdmin.overview;
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-2">
        <UiIcon name="calendar" className="size-4 text-muted-foreground" />
        <h3 className="font-semibold text-foreground text-sm">{copy.calendarContacts}</h3>
      </div>
      <p className="text-sm text-muted-foreground mb-3">{copy.calendarContactsDesc}</p>
      <Link
        href="/apps/new?app=radicale"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        {copy.calendarContactsSetup}
        <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
      </Link>
    </div>
  );
}

// ─── Mail server + webmail (combined hero card) ──────────────────────────────

/** The card's single CTA slot, in whichever of its three shapes applies. */
const CTA_CLASS =
  "inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0";

/**
 * Single editorial card at the top of the overview. Combines mail-server
 * identity (the hostname) with the webmail CTA.
 *
 * Webmail state is read from `status.webmail` - the openship API derives it
 * from the webmail project this mail server is linked to. If the record is
 * absent (or `installed=false`), the operator sees a Deploy webmail CTA that
 * opens /deploy/mail (host + domain picker, then the standard build screen).
 * Once deployed, the same slot becomes an Open webmail link.
 *
 * `routingUnknown` is the third state, and it is NOT the deploy one: webmail is
 * installed, its address just could not be read. Offering a deploy there reads as
 * "nothing is installed", so the slot links to the project instead.
 *
 * `legacy` is the one state the CTA slot can't express: that webmail works, so
 * the slot correctly says Open - but it predates the webmail app and can only be
 * replaced, which is offered as a line under the hostname.
 */
function MailServerCard({
  managed,
  mailHost,
  serverId,
  webmail,
}: {
  managed?: boolean;
  mailHost: string;
  serverId: string;
  webmail?: MailWebmailSummary;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!mailHost) return;
    try {
      await navigator.clipboard.writeText(mailHost);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/emails/_components/admin/overview-tab");
      /* noop */
    }
  };

  if (managed) return (
    <section className="rounded-2xl bg-card p-4">
      <div className="flex items-center gap-2.5">
        <FeatureIllustration name="mail" className="illustration-color w-10 shrink-0" />
        <h2 className="text-base font-medium">{t.emailsAdmin.overview.mailServer}</h2>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t.emailsAdmin.overview.hostname}</p>
      <button type="button" onClick={copy} className="mt-1 flex max-w-full items-center gap-2 text-start text-sm font-medium hover:underline">
        <bdi className="break-all">{mailHost}</bdi><UiIcon name={copied ? "check" : "copy"} className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-border/60 pt-3 text-sm">
        <div><dt className="font-medium">IMAP 993</dt><dd className="text-xs text-muted-foreground">TLS</dd></div>
        <div><dt className="font-medium">SMTP 587</dt><dd className="text-xs text-muted-foreground">STARTTLS</dd></div>
      </dl>
    </section>
  );

  const cta = webmailCta(webmail);

  return (
    <div className="@container/mail-server bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <UiIcon name="inbox" className="size-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground text-sm">{t.emailsAdmin.overview.mailServer}</h3>
        </div>
        <Link
          href="?tab=advanced"
          replace
          scroll={false}
          className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {t.emailsAdmin.overview.protocolDetails}
        </Link>
      </div>

      {/* Give the hostname and webmail action separate rows on phones. */}
      <div className="flex flex-col gap-3 @min-[28rem]/mail-server:flex-row @min-[28rem]/mail-server:items-center @min-[28rem]/mail-server:justify-between @min-[28rem]/mail-server:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground mb-1.5">
            {t.emailsAdmin.overview.hostname}
          </p>
          <button
            type="button"
            onClick={copy}
            className="group inline-flex items-center gap-2 -mx-1 px-1 py-0.5 rounded-md hover:bg-muted/40 transition-colors"
          >
            <span className="text-lg font-semibold text-foreground tracking-tight break-all">
              {mailHost || "-"}
            </span>
            {mailHost && (
              <span className="text-muted-foreground/70 group-hover:text-foreground transition-colors shrink-0">
                {copied ? (
                  <UiIcon name="check" className="size-3.5 text-success" />
                ) : (
                  <UiIcon name="copy" className="size-3.5" />
                )}
              </span>
            )}
          </button>
          {cta.kind === "open" && webmail && (
            <p className="text-xs text-muted-foreground mt-1.5 break-all">
              {t.emailsAdmin.overview.webmailAt}{" "}
              <a
                href={cta.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground font-medium hover:underline"
              >
                {webmail.hostname}
              </a>
            </p>
          )}
          {/* A pre-catalog webmail serves fine, so `installed` is true and the
              slot on the right stays Open-webmail. Without this line the only
              path onto the webmail app would be one the operator can't see. */}
          {webmail?.legacy && (
            <p className="text-xs text-muted-foreground mt-1.5">
              {t.emailsAdmin.overview.legacyWebmail}{" "}
              <Link
                href={`/deploy/mail?serverId=${encodeURIComponent(serverId)}`}
                className="text-warning font-medium hover:underline"
              >
                {t.emailsAdmin.overview.upgradeWebmail}
              </Link>
            </p>
          )}
        </div>

        {cta.kind === "open" ? (
          <a href={cta.url} target="_blank" rel="noopener noreferrer" className={CTA_CLASS}>
            {t.emailsAdmin.overview.openWebmail}
            <UiIcon name="arrow-up-right" className="size-3.5" />
          </a>
        ) : cta.kind === "project" ? (
          <Link href={`/projects/${cta.projectId}`} className={CTA_CLASS}>
            {t.projects.connections.usedByOpen}
            <UiIcon name="arrow-up-right" className="size-3.5" />
          </Link>
        ) : (
          <Link
            href={`/deploy/mail?serverId=${encodeURIComponent(serverId)}`}
            className={CTA_CLASS}
          >
            <UiIcon name="upload" className="size-3.5" />
            {t.emailsAdmin.overview.deployWebmail}
          </Link>
        )}
      </div>
    </div>
  );
}

// ─── Setup guides banner ─────────────────────────────────────────────────────

function SetupGuidesBanner() {
  const { t } = useI18n();
  const guideHref = (client: string) =>
    `${getMarketingOrigin()}/mail/setup-guide/${client}`;

  return (
    <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/15 p-5">
      <div className="flex items-center gap-2 mb-1">
        <UiIcon name="sparkles" className="size-4 text-primary" />
        <h3 className="font-semibold text-foreground text-sm">{t.emailsAdmin.overview.setupGuides}</h3>
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
        {t.emailsAdmin.overview.setupGuidesDesc}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <GuideCard
          href={guideHref("ios")}
          icon={"apple"}
          title={t.emailsAdmin.overview.guides.iosTitle}
          subtitle={t.emailsAdmin.overview.guides.iosSubtitle}
        />
        <GuideCard
          href={guideHref("android")}
          icon={"smartphone"}
          title={t.emailsAdmin.overview.guides.androidTitle}
          subtitle={t.emailsAdmin.overview.guides.androidSubtitle}
        />
        <GuideCard
          href={guideHref("desktop")}
          icon={"mail"}
          title={t.emailsAdmin.overview.guides.desktopTitle}
          subtitle={t.emailsAdmin.overview.guides.desktopSubtitle}
        />
        <GuideCard
          href={guideHref("nodemailer")}
          icon={"code"}
          title={t.emailsAdmin.overview.guides.codeTitle}
          subtitle={t.emailsAdmin.overview.guides.codeSubtitle}
        />
      </div>
    </div>
  );
}

function GuideCard({
  href,
  icon: Icon,
  title,
  subtitle,
}: {
  href: string;
  icon: IconName;
  title: string;
  subtitle: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 px-4 py-3 rounded-xl bg-card border border-border/50 hover:bg-muted/40 hover:border-border transition-all group"
    >
      <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
        <UiIcon name={Icon} className="size-[18px] text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate">{title}</p>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</p>
      </div>
      <UiIcon name="arrow-up-right" className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors shrink-0" />
    </a>
  );
}

// ─── Right sidebar ───────────────────────────────────────────────────────────

function useOverviewStats(serverId?: string) {
  const { t } = useI18n();
  const [revision, setRevision] = useState(0);
  const [stats, setStats] = useState<MailServerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The failure was "the engine isn't serving" — stated, not alarmed about. */
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    setLoading(true);
    mailAdminApi.stats
      .get(serverId, { inbox: true })
      .then((s) => {
        if (cancelled) return;
        setStats(s);
        setBlocked(false);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // The engine being down is a PANEL-level condition that already carries
        // its fix (MailEngineBanner, above the tab bar). Repeating it as a red
        // line in every card that failed for that one reason buries the remedy —
        // so this card states it quietly and points nowhere.
        setBlocked(isMailEngineUnavailable(err));
        setError(getApiErrorMessage(err, t.emailsAdmin.overview.statsFailed));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, revision, t.emailsAdmin.overview.statsFailed]);
  return { stats, loading: !!serverId && loading, error, blocked, refresh: () => setRevision(n => n + 1) };
}

function QuickActionsCard({ sectionHref }: { sectionHref: SectionHref }) {
  const { t } = useI18n();
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <UiIcon name="sparkles" className="size-4 text-muted-foreground" />
        <h3 className="font-semibold text-foreground text-sm">{t.emailsAdmin.overview.quickActions}</h3>
      </div>
      <div className="space-y-2">
        <QuickActionLink
          href={sectionHref("mailboxes")}
          icon={"user-plus"}
          label={t.emailsAdmin.overview.addMailbox}
        />
        <QuickActionLink
          href={sectionHref("domains")}
          icon={"globe"}
          label={t.emailsAdmin.overview.addDomain}
        />
        <QuickActionLink
          href={sectionHref("dns")}
          icon={"mail"}
          label={t.emailsAdmin.overview.reviewDns}
        />
      </div>
    </div>
  );
}

function QuickActionLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: IconName;
  label: string;
}) {
  return (
    <Link
      href={href}
      replace
      scroll={false}
      className="flex items-center gap-2.5 -mx-2 px-2.5 py-2 rounded-lg hover:bg-muted/40 transition-colors group"
    >
      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
        <UiIcon name={Icon} className="size-4 text-muted-foreground" />
      </div>
      <span className="text-sm text-foreground flex-1">{label}</span>
      <UiIcon name="arrow-right" className="size-3.5 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors rtl:rotate-180" />
    </Link>
  );
}
