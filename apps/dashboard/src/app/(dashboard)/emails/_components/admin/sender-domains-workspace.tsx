"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/Drawer";
import { interpolate, useI18n } from "@/components/i18n-provider";
import type { SendingDomainStatus } from "@repo/contracts/managed-mail";
import { SenderDomainForm, useSenderDomain, useSenderDomains } from "./sender-domain-form";
import { SenderDomainVerification } from "./sender-domain-verification";
import { DataTable, RowActionsMenu, type DataTableColumn } from "./_shared/data-table";
import { DomainCell } from "./_shared/domain-cell";
import { Skeleton } from "./_shared/skeleton";
import { StatusPill } from "./_shared/status-pill";
import { SenderDomainDetailSkeleton } from "./sender-domain-skeleton";
import { SendingLimitRow, SendingLimitSkeleton, useSendingLimits } from "./sending-limits";

export interface SenderDomainsSetupProps {
  configured: boolean;
  sendingHref(id?: string): string;
  onDomainConnected(nextHref: string): void;
}

export function SenderDomainsSummary({ configured, sendingHref, onDomainConnected }: SenderDomainsSetupProps) {
  const { t } = useI18n();
  const copy = t.emails.cloudClient;
  const domains = useSenderDomains(configured);
  const firstDomain = domains.data?.length === 0 && !domains.error;
  return (
    <section className="min-w-0 rounded-2xl bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon name="globe" className="size-4 text-muted-foreground" />
        <h2 className="text-base font-medium">{firstDomain ? copy.connectYourDomain : copy.senderDomains}</h2>
      </div>
      {domains.loading && <div role="status" aria-label={t.emailsAdmin.dns.loading} className="mt-2 flex h-9 items-center">
        <Skeleton className="h-3 w-40 max-w-full" />
      </div>}
      {domains.error && <p role="alert" className="mt-3 text-sm">
        {domains.error} <Button size="sm" variant="ghost" onClick={domains.refresh}>{t.actions.retry}</Button>
      </p>}
      {firstDomain && <>
        <p className="mt-2 text-sm text-muted-foreground">{copy.domainSetupHint}</p>
        <SenderDomainForm onConnected={domain => onDomainConnected(sendingHref(domain.id))} />
      </>}
      {!!domains.data?.length && <ul className="mt-2 divide-y divide-border/60">
        {domains.data.map(domain => <li key={domain.id}>
          <Link href={sendingHref(domain.id)} className="flex min-w-0 items-center justify-between gap-2 py-2 text-sm font-medium hover:underline">
            <bdi className="truncate">{domain.domain}</bdi><Icon name="chevron-right" className="size-4 shrink-0 rtl:rotate-180" />
          </Link>
        </li>)}
      </ul>}
      <Link href={sendingHref()} className="mt-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        {copy.manageSending}<Icon name="arrow-right" className="size-4 rtl:rotate-180" />
      </Link>
    </section>
  );
}

export function SenderDomainsWorkspace({ configured, sendingHref, onDomainConnected, dnsDomain, allowance, listHref, dnsHref }: SenderDomainsSetupProps & {
  dnsDomain?: string;
  allowance?: number;
  listHref: string;
  dnsHref(name: string): string;
}) {
  const { t } = useI18n();
  const copy = t.emails.cloudClient;
  const domains = useSenderDomains(configured);
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const rows = domains.data ?? [];
  const showInventory = domains.loading || rows.length > 0;
  const selected = dnsDomain && rows.find(row => row.domain === dnsDomain);
  const caps = useSendingLimits("domains", configured && !selected && rows.length > 0, allowance);

  function connected(domain: SendingDomainStatus) {
    setAdding(false);
    domains.refresh();
    onDomainConnected(domain.state === "ready" ? sendingHref(domain.id) : dnsHref(domain.domain));
  }

  type Domain = (typeof rows)[number];
  const status = (row: Domain) => {
    if (row.ownership === "verified") return <StatusPill tone="success">{copy.ownershipVerified}</StatusPill>;
    if (row.ownership === "pending") return (
      <Link href={dnsHref(row.domain)} scroll={false} className="inline-flex rounded-full hover:underline">
        <StatusPill tone="warning">{copy.awaitingDns}<Icon name="chevron-right" className="size-3 rtl:rotate-180" /></StatusPill>
      </Link>
    );
    return <StatusPill tone="neutral">{t.emailsAdmin.dns.unknown}</StatusPill>;
  };
  const usage = (row: Domain, showLabel: boolean) =>
    <SendingLimitRow kind="domains" identity={row.domain} limits={caps.limits} showLabel={showLabel} />;
  const columns: DataTableColumn<Domain>[] = [
    {
      key: "domain", header: t.emailsAdmin.domains.colDomain, width: "1fr",
      skeleton: <div className="flex min-w-0 items-center gap-3">
        <Skeleton className="size-9 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center"><Skeleton className="h-3 w-40 max-w-full" /></div>
          <Skeleton className="mt-1 h-5 w-24 max-w-full rounded-full @min-[44rem]/table:hidden" />
          <div className="mt-2 @min-[32rem]/table:hidden"><SendingLimitSkeleton /></div>
        </div>
      </div>,
      cell: row => <DomainCell domain={row.domain} href={row.ownership === "pending" ? dnsHref(row.domain) : sendingHref(row.id)}>
        <div className="mt-1 @min-[44rem]/table:hidden">{status(row)}</div>
        <div className="mt-2 @min-[32rem]/table:hidden">{usage(row, true)}</div>
      </DomainCell>,
    },
    {
      key: "sending", header: copy.monthlySending, width: "208px", hideBelow: "table-sm",
      skeleton: <SendingLimitSkeleton showLabel={false} />,
      cell: row => usage(row, false),
    },
    {
      key: "status", header: t.emailsAdmin.domains.colStatus, width: "146px", hideBelow: "table-md",
      skeleton: <Skeleton className="h-5 w-24 max-w-full rounded-full" />,
      cell: status,
    },
  ];

  if (selected || (dnsDomain && domains.loading)) return (
    <div className="max-w-3xl space-y-4">
      <Link href={listHref} scroll={false} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <Icon name="arrow-left" className="size-4 rtl:rotate-180" />{copy.senderDomains}
      </Link>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="break-all text-lg font-semibold"><bdi>{dnsDomain}</bdi></h2>
        {selected && <Button asChild size="sm" variant="secondary"><Link href={sendingHref(selected.id)} scroll={false}>{copy.manageSending}<Icon name="arrow-right" className="rtl:rotate-180" /></Link></Button>}
      </header>
      <div className="min-w-0 rounded-2xl bg-card p-5 sm:p-6">
        {selected ? <DomainRecords key={selected.id} id={selected.id} onVerified={domains.refresh}
          onReady={() => router.replace(sendingHref(selected.id), { scroll: false })} /> : <SenderDomainDetailSkeleton dns />}
      </div>
    </div>
  );

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{copy.senderDomains}</h2>
          {showInventory && <p className="mt-1 text-sm text-muted-foreground">{copy.senderDomainsHint}</p>}
        </div>
        {showInventory && <Button size="sm" disabled={domains.loading} onClick={() => setAdding(true)}><Icon name="plus" />{copy.connectSender}</Button>}
      </header>

      {domains.error && <p role="alert" className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">
        {domains.error} <Button size="sm" variant="ghost" onClick={domains.refresh}>{t.actions.retry}</Button>
      </p>}
      {domains.data?.length === 0 && !domains.error && (
        <div className="max-w-2xl rounded-2xl bg-card p-6 sm:p-8">
          <FeatureIllustration name="domains-ssl" className="illustration-color mb-4 h-auto w-16" />
          <h3 className="text-xl font-medium">{copy.connectYourDomain}</h3>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{copy.domainSetupHint}</p>
          <SenderDomainForm onConnected={connected} />
        </div>
      )}
      {showInventory && <DataTable columns={columns} rows={rows} rowKey={row => row.id}
        loading={domains.loading} skeletonRows={2}
        rowActions={row => <RowActionsMenu label={interpolate(t.emailsAdmin.shared.rowActions, { name: row.domain })} actions={[
          { id: "sending", label: copy.manageSending, icon: <Icon name="send" className="size-4" />,
            onClick: () => router.push(sendingHref(row.id), { scroll: false }) },
          { id: "dns", label: t.emailsAdmin.overview.reviewDns, icon: <Icon name="file-text" className="size-4" />,
            onClick: () => router.push(dnsHref(row.domain), { scroll: false }) },
        ]} />} />}
      {caps.error && <p role="alert" className="text-sm text-danger">
        {caps.error} <Button size="sm" variant="ghost" onClick={caps.refresh}>{t.actions.retry}</Button>
      </p>}
      {caps.editor}

      {adding && <Drawer isOpen onClose={() => setAdding(false)} label={copy.connectSender} closeLabel={t.emailsAdmin.shared.close} width="440px">
        <div className="overflow-y-auto px-6 py-7">
          <h2 className="pe-10 text-lg font-semibold">{copy.connectSender}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.domainSetupHint}</p>
          <SenderDomainForm onConnected={connected} />
        </div>
      </Drawer>}
    </section>
  );
}

function DomainRecords({ id, onVerified, onReady }: { id: string; onVerified(): void; onReady(): void }) {
  const { t } = useI18n();
  const sender = useSenderDomain(id);
  return (
    <>
      {sender.loading && <SenderDomainDetailSkeleton dns />}
      {sender.error && <p role="alert" className="text-sm text-danger">
        {sender.error} <Button size="sm" variant="ghost" onClick={sender.refresh}>{t.actions.retry}</Button>
      </p>}
      {sender.data && <SenderDomainVerification sender={sender.data} view="dns" onVerified={result => {
        sender.update(result);
        onVerified();
        if (result.state === "ready" && sender.data?.state !== "ready") onReady();
      }} />}
    </>
  );
}
