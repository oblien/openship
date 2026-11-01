"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type { BillingState } from "@/lib/api/billing";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { formatBillingNumber } from "@/lib/billing-usage";

/** Paid coverage and transfer benefits come from the same provider
 * contract. Transfer exhaustion must never be presented as compute exhaustion. */
export function BillingComputeCoverage({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const compute = state.compute;
  if (!compute || compute.billingMode !== "monthly") return null;
  const copy = t.billing.compute;
  const money = (dollars: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(dollars);
  const periodEnd = compute.currentPeriod.end;
  const transfer = compute.network;
  const unlimited = compute.covered && transfer.unlimited === true && transfer.availableBytes === null
    && transfer.status !== "inactive" && transfer.status !== "blocked";
  const available = unlimited ? t.billing.capacity.unlimited
    : transfer.availableBytes === null ? copy.needsAttention
      : interpolate(copy.transferRemaining, { amount: formatBillingNumber(transfer.availableBytes / 1024 ** 3, locale) });
  const blocked = transfer.status === "blocked" || (transfer.status === undefined
    && transfer.purchasedBytes > 0 && transfer.availableBytes !== null && transfer.availableBytes <= 0);
  return (
    <section className="space-y-3 rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium">{copy.title}</h2>
        <span className={`flex items-center gap-2 text-sm ${compute.covered ? "text-success" : "text-warning"}`}>
          <span aria-hidden="true" className="size-2.5 rounded-full border-2 border-current" />
          {compute.covered ? copy.covered : copy.needsAttention}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{copy.included}</p>
      {periodEnd && <p className="text-sm font-medium">{interpolate(copy.paidThrough, {
        date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(periodEnd)),
      })}</p>}
      {!compute.covered && <p className="text-sm text-warning">{copy.recovery}</p>}
      {compute.retention.amountDue > 0 && <p role="status" className="text-sm text-warning">{interpolate(copy.storageDue, { amount: money(compute.retention.amountDue) })}</p>}
      <details className="group rounded-xl bg-muted/35 p-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          {copy.details}
          <Icon name="chevron-down" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="mt-3 space-y-3 text-sm text-muted-foreground">
          {compute.savings && <div>
            <p className="font-medium text-foreground">{copy.paygComparison}: <bdi>{money(compute.savings.usageBeforeCap)}</bdi></p>
            <p className="mt-1 text-xs">{copy.comparisonHint}</p>
          </div>}
          <div>
            <p className="font-medium text-foreground">{copy.proxyTransfer}: <bdi>{available}</bdi></p>
            {transfer.periodConsumedBytes !== undefined && <p className="mt-1 text-xs">
              {t.billing.overview.usedThisPeriod}: <bdi>{formatBillingNumber(transfer.periodConsumedBytes / 1024 ** 3, locale)} GiB</bdi>
            </p>}
            <p className="mt-1 text-xs">{copy.proxyHint}</p>
            {!unlimited && blocked && <p className="mt-1 text-warning">{copy.transferRecovery}</p>}
          </div>
          <p className="text-xs">{interpolate(copy.retention, { days: String(compute.retention.minimumDays), amount: money(compute.retention.storagePerGiBMonth) })}</p>
          <Link href="/support" className="inline-block font-medium text-foreground hover:underline">{t.billing.portal.supportButton}</Link>
        </div>
      </details>
    </section>
  );
}
