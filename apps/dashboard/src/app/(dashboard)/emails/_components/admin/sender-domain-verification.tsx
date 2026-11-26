"use client";

import { useState, type ReactNode } from "react";
import type { SendingDomainStatus } from "@repo/contracts/managed-mail";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { displayDnsName, DnsRecordCard, DnsRecordFields } from "@/components/shared/DnsRecordsView";
import { Button } from "@/components/ui/button";
import { DisclosureSummary } from "@/components/ui/DisclosureSummary";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { managedMailApi } from "@/lib/api/managed-mail";
import { StatusPill, type PillTone } from "./_shared/status-pill";

const stateTone: Record<SendingDomainStatus["state"], PillTone> = {
  pending_dns: "warning",
  verifying: "info",
  ready: "success",
  verification_failed: "danger",
  disabled: "neutral",
};

const recordTone: Record<SendingDomainStatus["records"][number]["status"], PillTone> = {
  pending: "warning",
  verified: "success",
  lookup_error: "danger",
};

export function SenderDomainVerification({ sender, disabled = false, onVerified, limit, children, view = "sending" }: {
  sender: SendingDomainStatus;
  view?: "sending" | "dns";
  disabled?: boolean;
  onVerified(sender: SendingDomainStatus): void;
  limit?: ReactNode;
  children?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const copy = t.emails.cloudClient.verification;
  const { busy, error, execute } = useScopedMutation();
  const [checkedAt, setCheckedAt] = useState<Date>();
  const stateLabel = {
    pending_dns: t.emails.cloudClient.awaitingDns,
    verifying: copy.verifying,
    ready: copy.ready,
    verification_failed: copy.failed,
    disabled: t.emailsAdmin.domains.disabled,
  }[sender.state];
  const confirmed = sender.records.filter(record => record.status === "verified").length;
  const pending = sender.state === "pending_dns" || sender.state === "verifying";
  const awaitingActivation = sender.state === "verifying" && confirmed > 0 && confirmed === sender.records.length;
  const dnsHint = awaitingActivation ? t.emails.cloudClient.testDelivery.activating
    : sender.state === "pending_dns" ? copy.ownershipHint : copy.propagationHint;

  async function verify() {
    const result = await execute(() => managedMailApi.verify(sender.id));
    if (!result) return;
    const timestamp = Date.parse(result.checkedAt);
    setCheckedAt(new Date(Number.isFinite(timestamp) ? timestamp : Date.now()));
    onVerified(result);
  }

  const dns = view === "dns";
  const verifyAction = (
    <Button type="button" variant="secondary" size="sm" disabled={busy || disabled} onClick={verify}>
      {busy && <Icon name="refresh" className="motion-safe:animate-spin" />}
      {busy ? copy.checking : t.emailsAdmin.dns.verify}
    </Button>
  );

  const records = !dns && sender.records.map(record => <DnsRecordCard key={record.type + record.name + record.value} rec={record}
    status={<StatusPill tone={recordTone[record.status]}>{copy.records[record.status]}</StatusPill>} />);

  return (
    <section className={dns ? "space-y-4" : "mt-4 space-y-4"}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 break-words text-lg font-medium">{dns ? t.emailsAdmin.dns.heading : sender.state === "pending_dns"
          ? interpolate(t.emailsAdmin.domains.pendingTitle, { domain: sender.domain })
          : sender.domain}</h2>
        <StatusPill tone={stateTone[sender.state]}>{stateLabel}</StatusPill>
        <div className="ms-auto">{dns ? verifyAction : limit}</div>
      </div>
      {!dns && <fieldset disabled={busy || disabled} className="flex flex-wrap gap-2">
        {sender.state !== "ready" && verifyAction}
        {children}
      </fieldset>}
      {pending && !checkedAt && <p className="text-sm text-muted-foreground">
        {dns || awaitingActivation ? dnsHint : t.emails.cloudClient.testDelivery.verifyFirst}
      </p>}
      <div role="status" aria-atomic="true" className={busy || error || !checkedAt ? "sr-only" : "text-sm"}>
        {busy ? copy.checking : !error && checkedAt && <>
          <p className="font-medium">{stateLabel}{pending && sender.records.length > 0 && <> · {interpolate(copy.progress, {
            confirmed: confirmed.toLocaleString(locale), total: sender.records.length.toLocaleString(locale),
          })}</>}</p>
          <p className="mt-1 text-muted-foreground">
            {pending && <>{dnsHint} </>}
            <time dateTime={checkedAt.toISOString()}>{interpolate(copy.checkedAt, {
              time: checkedAt.toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" }),
            })}</time>
          </p>
        </>}
      </div>
      {sender.reason && !busy && !error && <p className="text-sm text-muted-foreground">{sender.reason}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {dns ? (
        <DomainDnsRecords sender={sender} />
      ) : sender.state === "ready" ? (
        <details>
          <DisclosureSummary className="text-sm text-muted-foreground">{t.emailsAdmin.dns.heading}</DisclosureSummary>
          <div className="mt-3 space-y-3">{verifyAction}{records}</div>
        </details>
      ) : records}
    </section>
  );
}

function DomainDnsRecords({ sender }: { sender: SendingDomainStatus }) {
  const { t } = useI18n();
  if (!sender.records.length) return <p className="text-sm text-muted-foreground">
    {interpolate(t.emailsAdmin.dns.noRecordsFor, { domain: sender.domain })}
  </p>;

  return (
    <div className="divide-y divide-border/60 border-y border-border/60">
      {sender.records.map(record => (
        <details className="group/record" key={record.type + record.name + record.value} open={record.status !== "verified"}>
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-sm py-3.5 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{record.type}</span>
            <bdi className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" dir="ltr" title={record.name}>{displayDnsName(record.name, sender.domain)}</bdi>
            <StatusPill tone={recordTone[record.status]}>{t.emails.cloudClient.verification.records[record.status]}</StatusPill>
            <Icon name="chevron-down" className="size-4 shrink-0 text-muted-foreground group-open/record:rotate-180" />
          </summary>
          <div className="pb-4"><DnsRecordFields rec={record} /></div>
        </details>
      ))}
    </div>
  );
}
