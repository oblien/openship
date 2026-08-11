"use client";

/**
 * Overview tab - what an operator wants on day one.
 *
 * Order (top → bottom, left column):
 *   1. Mail server card   - combined identity + webmail CTA. Big hostname,
 *                            "Open webmail" primary action, "Protocol
 *                            details →" link to the Advanced tab. Webmail
 *                            is bundled with openship, so it's always
 *                            available - no deploy gate needed.
 *   2. Setup guides       - 4-up banner that deep-links to the public
 *                            walkthroughs on /mail/setup-guide/<client> in
 *                            a new tab. Server settings stay in this tab
 *                            (Postmaster credentials / Advanced); the
 *                            guides are pure content.
 *
 * Right column (340px, sticky):
 *   1. Mail stats         - domain/mailbox/alias/storage/message counts.
 *   2. Quick actions      - links into other tabs.
 *
 * The postmaster account is just another row in `vmail.mailbox`. The
 * operator manages its password the same way they manage every other
 * mailbox - Mailboxes tab → edit row → set password. There's no separate
 * credentials card here on purpose: one place for one operation.
 *
 * Protocol details (host:port + encryption) live in the Advanced tab -
 * useful when wiring a client by hand but noise on the overview.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  Code2,
  Copy,
  Globe,
  Inbox,
  Mail,
  Sparkles,
  Upload,
  UserPlus,
  UserRound,
  HardDrive,
  Apple,
  Smartphone,
} from "lucide-react";
import {
  mailAdminApi,
  type MailServerStats,
  type MailSetupStatus,
  type MailWebmailSummary,
} from "@/lib/api";
import { getMarketingOrigin } from "@/lib/api/urls";
import { Skeleton } from "./_shared/skeleton";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface OverviewTabProps {
  status: MailSetupStatus;
  serverId: string;
  onRefresh: () => void;
}

export function OverviewTab({ status, serverId }: OverviewTabProps) {
  const domain = status.domain ?? "";
  const mailHost = domain ? `mail.${domain}` : "";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
      <div className="space-y-5 min-w-0">
        <MailServerCard
          mailHost={mailHost}
          serverId={serverId}
          webmail={status.webmail}
        />
        <SetupGuidesBanner />
      </div>

      <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <MailStatsCard serverId={serverId} />
        <QuickActionsCard />
      </div>
    </div>
  );
}

// ─── Mail server + webmail (combined hero card) ──────────────────────────────

/**
 * Single editorial card at the top of the overview. Combines mail-server
 * identity (the hostname) with the webmail CTA.
 *
 * Webmail state is read from `status.webmail` - the openship API persists
 * the deploy record in the mail-state file on the VPS. If the record is
 * absent (or `installed=false`), the operator sees a Deploy webmail CTA
 * that opens a modal - domain + host picker + live SSE progress. Once
 * deployed, the same slot becomes an Open webmail link.
 */
function MailServerCard({
  mailHost,
  serverId,
  webmail,
}: {
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
    } catch {
      /* noop */
    }
  };

  const isInstalled = Boolean(webmail?.installed && webmail.url);

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Inbox className="size-4 text-muted-foreground" strokeWidth={2} />
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

      <div className="flex items-center justify-between gap-4 flex-wrap">
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
                  <Check className="size-3.5 text-success" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </span>
            )}
          </button>
          {isInstalled && webmail && (
            <p className="text-xs text-muted-foreground mt-1.5 break-all">
              {t.emailsAdmin.overview.webmailAt}{" "}
              <a
                href={webmail.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground font-medium hover:underline"
              >
                {webmail.hostname}
              </a>
            </p>
          )}
        </div>

        {isInstalled && webmail ? (
          <a
            href={webmail.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
          >
            {t.emailsAdmin.overview.openWebmail}
            <ArrowUpRight className="size-3.5" strokeWidth={2.25} />
          </a>
        ) : (
          <Link
            href={`/deploy/mail?serverId=${encodeURIComponent(serverId)}`}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
          >
            <Upload className="size-3.5" strokeWidth={2.25} />
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
        <Sparkles className="size-4 text-primary" strokeWidth={2} />
        <h3 className="font-semibold text-foreground text-sm">{t.emailsAdmin.overview.setupGuides}</h3>
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
        {t.emailsAdmin.overview.setupGuidesDesc}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <GuideCard
          href={guideHref("ios")}
          icon={Apple}
          title={t.emailsAdmin.overview.guides.iosTitle}
          subtitle={t.emailsAdmin.overview.guides.iosSubtitle}
        />
        <GuideCard
          href={guideHref("android")}
          icon={Smartphone}
          title={t.emailsAdmin.overview.guides.androidTitle}
          subtitle={t.emailsAdmin.overview.guides.androidSubtitle}
        />
        <GuideCard
          href={guideHref("desktop")}
          icon={Mail}
          title={t.emailsAdmin.overview.guides.desktopTitle}
          subtitle={t.emailsAdmin.overview.guides.desktopSubtitle}
        />
        <GuideCard
          href={guideHref("nodemailer")}
          icon={Code2}
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
  icon: typeof Mail;
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
        <Icon className="size-[18px] text-muted-foreground" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate">{title}</p>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</p>
      </div>
      <ArrowUpRight className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors shrink-0" />
    </a>
  );
}

// ─── Right sidebar ───────────────────────────────────────────────────────────

function MailStatsCard({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const [stats, setStats] = useState<MailServerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    mailAdminApi.stats
      .get(serverId)
      .then((s) => {
        if (cancelled) return;
        setStats(s);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t.emailsAdmin.overview.statsFailed);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="size-4 text-muted-foreground" strokeWidth={2} />
        <h3 className="font-semibold text-foreground text-sm">{t.emailsAdmin.overview.mailStats}</h3>
      </div>

      {loading ? (
        <StatsSkeleton />
      ) : error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : stats ? (
        <div className="space-y-3">
          <StatRow
            icon={Globe}
            iconBg="bg-primary/10"
            iconColor="text-primary"
            label={t.emailsAdmin.overview.domains}
            value={stats.domains.active}
            sub={stats.domains.total !== stats.domains.active ? interpolate(t.emailsAdmin.overview.totalSuffix, { count: String(stats.domains.total) }) : undefined}
          />
          <StatRow
            icon={UserRound}
            iconBg="bg-orange-500/10"
            iconColor="text-orange-500"
            label={t.emailsAdmin.overview.mailboxes}
            value={stats.mailboxes.active}
            sub={stats.mailboxes.total !== stats.mailboxes.active ? interpolate(t.emailsAdmin.overview.totalSuffix, { count: String(stats.mailboxes.total) }) : undefined}
          />
          <StatRow
            icon={ArrowRight}
            iconBg="bg-muted"
            iconColor="text-muted-foreground"
            label={t.emailsAdmin.overview.aliases}
            value={stats.aliases.total}
          />

          <div className="h-px bg-border/60 my-2" />

          <StatRow
            icon={HardDrive}
            iconBg="bg-muted"
            iconColor="text-muted-foreground"
            label={t.emailsAdmin.overview.storage}
            value={formatBytes(stats.storageBytes)}
          />
          <StatRow
            icon={Inbox}
            iconBg="bg-muted"
            iconColor="text-muted-foreground"
            label={t.emailsAdmin.overview.messages}
            value={stats.messages.toLocaleString()}
          />
        </div>
      ) : null}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Skeleton className="w-8 h-8 rounded-lg" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  );
}

function StatRow({
  icon: Icon,
  iconBg,
  iconColor,
  label,
  value,
  sub,
}: {
  icon: typeof Globe;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string | number;
  sub?: string;
}) {
  const stringValue =
    typeof value === "number" ? value.toLocaleString() : value;
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div
          className={`w-8 h-8 rounded-lg ${iconBg} flex items-center justify-center`}
        >
          <Icon className={`size-4 ${iconColor}`} strokeWidth={2} />
        </div>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <div className="text-end">
        <p className="text-lg font-semibold text-foreground tabular-nums leading-none">
          {stringValue}
        </p>
        {sub && (
          <p className="text-[10.5px] text-muted-foreground/70 mt-0.5 leading-none">
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

function QuickActionsCard() {
  const { t } = useI18n();
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="size-4 text-muted-foreground" strokeWidth={2} />
        <h3 className="font-semibold text-foreground text-sm">{t.emailsAdmin.overview.quickActions}</h3>
      </div>
      <div className="space-y-2">
        <QuickActionLink
          href="?tab=mailboxes"
          icon={UserPlus}
          label={t.emailsAdmin.overview.addMailbox}
        />
        <QuickActionLink
          href="?tab=domains"
          icon={Globe}
          label={t.emailsAdmin.overview.addDomain}
        />
        <QuickActionLink
          href="?tab=dns"
          icon={Mail}
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
  icon: typeof UserPlus;
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
        <Icon className="size-4 text-muted-foreground" strokeWidth={2} />
      </div>
      <span className="text-sm text-foreground flex-1">{label}</span>
      <ArrowRight className="size-3.5 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors rtl:rotate-180" />
    </Link>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / KB).toFixed(0)} KB`;
}
