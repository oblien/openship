"use client";

/**
 * DNS tab - per-domain reference of the records this mail server expects,
 * plus a live "are they published?" check.
 *
 * A mail server can host multiple domains, so the tab is scoped by a domain
 * picker:
 *   - primary install domain → records come from the install-time
 *     `status.dnsRecords` (A/AAAA/MX/SPF/DKIM/DMARC).
 *   - additional domains      → records come from
 *     `mailAdminApi.domains.getDns` (MX/SPF/DKIM?/DMARC).
 * The verification scan runs on demand against the selected domain.
 */

import { useCallback, useEffect, useState } from "react";
import {
  FileText,
  Globe,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  Check,
  AlertTriangle,
  CircleX,
  CircleDashed,
} from "lucide-react";
import {
  mailAdminApi,
  getApiErrorMessage,
  type AdminDomain,
  type DnsCheck,
  type DnsCheckStatus,
  type DnsRecords,
  type DnsScanResult,
  type MailSetupStatus,
} from "@/lib/api";
import { DnsRecordsView } from "@/components/shared/DnsRecordsView";
import { SectionCard } from "./_shared/section-card";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface DnsTabProps {
  status: MailSetupStatus;
  serverId: string;
  primaryDomain: string;
  selectedDomain: string;
  onSelectDomain: (domain: string) => void;
}

export function DnsTab({
  status,
  serverId,
  primaryDomain,
  selectedDomain,
  onSelectDomain,
}: DnsTabProps) {
  const { t } = useI18n();
  const activeDomain = selectedDomain || primaryDomain;
  const isPrimary = activeDomain === primaryDomain;

  const [domains, setDomains] = useState<AdminDomain[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingDomains(true);
    mailAdminApi.domains
      .list(serverId)
      .then((res) => {
        if (cancelled) return;
        setDomains(res.domains);
        // URL points at a domain that no longer exists → fall back to primary.
        if (
          selectedDomain &&
          selectedDomain !== primaryDomain &&
          !res.domains.some((d) => d.domain === selectedDomain)
        ) {
          onSelectDomain(primaryDomain);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingDomains(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, selectedDomain, primaryDomain, onSelectDomain]);

  // ── Records for the active domain ──
  const [records, setRecords] = useState<DnsRecords | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsMsg, setRecordsMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRecordsMsg(null);
    if (!activeDomain) {
      setRecords(null);
      return;
    }
    if (isPrimary) {
      setRecords((status.dnsRecords as unknown as DnsRecords) ?? null);
      return;
    }
    setRecordsLoading(true);
    mailAdminApi.domains
      .getDns(serverId, activeDomain)
      .then((res) => {
        if (!cancelled) setRecords(res.records as unknown as DnsRecords);
      })
      .catch(() => {
        // 404 = no records generated for this domain → empty, not an error.
        if (!cancelled) {
          setRecords(null);
          setRecordsMsg(interpolate(t.emailsAdmin.dns.noRecordsFor, { domain: activeDomain }));
        }
      })
      .finally(() => {
        if (!cancelled) setRecordsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, activeDomain, isPrimary, status.dnsRecords]);

  // ── On-demand verification scan ──
  const [scan, setScan] = useState<DnsScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);

  useEffect(() => {
    setScan(null);
    setScanErr(null);
  }, [activeDomain]);

  const runScan = useCallback(async () => {
    if (!activeDomain) return;
    setScanning(true);
    setScanErr(null);
    try {
      setScan(await mailAdminApi.dns.scan(serverId, activeDomain));
    } catch (err) {
      setScanErr(getApiErrorMessage(err, t.emailsAdmin.dns.scanFailed));
    } finally {
      setScanning(false);
    }
  }, [serverId, activeDomain]);

  return (
    <div className="space-y-5">
      <Header />

      {/* Domain picker */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground">{t.emailsAdmin.dns.domainLabel}</span>
        {loadingDomains ? (
          <div className="px-3 py-2 rounded-xl border border-border bg-muted/30 flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t.emailsAdmin.dns.loading}</span>
          </div>
        ) : (
          <select
            value={activeDomain}
            onChange={(e) => onSelectDomain(e.target.value)}
            className="px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors min-w-[200px]"
          >
            {domains.length === 0 && primaryDomain && (
              <option value={primaryDomain}>{primaryDomain}</option>
            )}
            {domains.map((d) => (
              <option key={d.domain} value={d.domain}>
                {d.domain}
              </option>
            ))}
          </select>
        )}
        {isPrimary && (
          <span className="text-xs text-muted-foreground/70">{t.emailsAdmin.dns.primary}</span>
        )}
      </div>

      {/* Records for publishing */}
      <SectionCard
        title={t.emailsAdmin.dns.recordsTitle}
        description={interpolate(t.emailsAdmin.dns.recordsDesc, { domain: activeDomain })}
        icon={FileText}
        density="split"
      >
        {recordsLoading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : records ? (
          <div className="p-5">
            <DnsRecordsView records={records} domain={activeDomain} columns={2} />
          </div>
        ) : (
          <div className="px-5 py-10 text-center">
            <Globe
              className="size-7 text-muted-foreground/60 mx-auto mb-3"
              strokeWidth={1.5}
            />
            <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              {recordsMsg ?? t.emailsAdmin.dns.recordsEmpty}
            </p>
          </div>
        )}
      </SectionCard>

      {/* Published-records verification */}
      <SectionCard
        title={t.emailsAdmin.dns.checkTitle}
        description={interpolate(t.emailsAdmin.dns.checkDesc, { domain: activeDomain })}
        icon={ShieldCheck}
        density="split"
        action={
          <button
            onClick={runScan}
            disabled={scanning || !activeDomain}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors disabled:opacity-50"
          >
            <RefreshCcw className={`size-3 ${scanning ? "animate-spin" : ""}`} />
            {scan ? t.emailsAdmin.dns.rescan : t.emailsAdmin.dns.verify}
          </button>
        }
      >
        {scanErr && (
          <div className="px-5 py-3 text-sm text-danger border-b border-border/40 bg-danger-bg">
            {scanErr}
          </div>
        )}
        {scanning && scan === null ? (
          <div className="px-5 py-10 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : scan === null ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {t.emailsAdmin.dns.runLookupBefore}
              <span className="font-medium text-foreground">{activeDomain}</span>
              {t.emailsAdmin.dns.runLookupAfter}
            </p>
          </div>
        ) : scan.checks.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Globe
              className="size-7 text-muted-foreground/60 mx-auto mb-3"
              strokeWidth={1.5}
            />
            <p className="text-sm text-muted-foreground">
              {interpolate(t.emailsAdmin.dns.noRecordsVerify, { domain: activeDomain })}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {scan.checks.map((c) => (
              <DnsCheckRow key={c.key} check={c} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function Header() {
  const { t } = useI18n();
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">{t.emailsAdmin.dns.heading}</h2>
      <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
        {t.emailsAdmin.dns.description}
      </p>
    </div>
  );
}

// ─── Verification row ──────────────────────────────────────────────────────

function DnsCheckRow({ check }: { check: DnsCheck }) {
  const { t } = useI18n();
  const pres = presentation(check.status);
  const statusLabel =
    check.status === "pass"
      ? t.emailsAdmin.dns.pass
      : check.status === "warn"
        ? t.emailsAdmin.dns.warning
        : check.status === "fail"
          ? t.emailsAdmin.dns.fail
          : t.emailsAdmin.dns.unknown;
  const showExpectedActual =
    (check.status === "warn" || check.status === "fail") && check.expected;
  return (
    <div className="flex items-start gap-4 px-5 py-4">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${pres.iconBg}`}
      >
        <pres.Icon className={`size-5 ${pres.iconColor}`} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-foreground">{check.label}</p>
          <span className="font-mono text-[11px] text-muted-foreground/80">
            {check.recordType} · {check.queriedName}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          {check.message}
        </p>
        {showExpectedActual && (
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11.5px]">
            <KV label={t.emailsAdmin.dns.expected} value={check.expected} />
            <KV
              label={t.emailsAdmin.dns.actual}
              value={check.actual || t.emailsAdmin.dns.noRecord}
              muted={!check.actual}
            />
          </div>
        )}
      </div>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold shrink-0 ${pres.pill}`}
      >
        {statusLabel}
      </span>
    </div>
  );
}

function KV({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 px-2.5 py-1.5 min-w-0">
      <p className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-0.5">
        {label}
      </p>
      <p
        className={`font-mono break-all ${
          muted ? "text-muted-foreground/70 italic" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function presentation(status: DnsCheckStatus) {
  switch (status) {
    case "pass":
      return {
        Icon: Check,
        iconBg: "bg-success-bg",
        iconColor: "text-success",
        pill: "bg-success-bg text-success",
        label: "Pass",
      };
    case "warn":
      return {
        Icon: AlertTriangle,
        iconBg: "bg-warning-bg",
        iconColor: "text-warning",
        pill: "bg-warning-bg text-warning",
        label: "Warning",
      };
    case "fail":
      return {
        Icon: CircleX,
        iconBg: "bg-danger-bg",
        iconColor: "text-danger",
        pill: "bg-danger-bg text-danger",
        label: "Fail",
      };
    default:
      return {
        Icon: CircleDashed,
        iconBg: "bg-muted",
        iconColor: "text-muted-foreground",
        pill: "bg-muted text-muted-foreground",
        label: "Unknown",
      };
  }
}
