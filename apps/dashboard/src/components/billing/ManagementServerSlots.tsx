"use client";

import { useId } from "react";
import type { BillingOperations, ManagementState } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { managementMoney } from "./management-presentation";

type Quote = Awaited<ReturnType<BillingOperations["purchaseManagement"]>>;

/** Quantity-only view; the parent owns the same verified quote and confirmation as plan changes. */
export function ManagementServerSlots({
  data,
  additional,
  quote,
  checking,
  busy,
  error,
  onChange,
  onRetry,
  onCheckout,
}: {
  data: ManagementState;
  additional: number;
  quote: Quote | null;
  checking: boolean;
  busy: boolean;
  error: string | null;
  onChange: (count: number) => void;
  onRetry: () => void;
  onCheckout: () => void;
}) {
  const { t, locale } = useI18n();
  const quantityId = useId();
  const copy = t.billing.managementDetail;
  const saved = data.subscription!;
  const total = saved.servers + additional;
  const valid = Number.isInteger(additional) && additional > 0 && total <= data.pricing.maxServers;
  const money = (cents: number) => managementMoney(cents, locale);
  const monthly = quote?.monthlyCents ?? null;
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">{copy.slotHint}</p>
      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <label className="min-w-0 space-y-1" htmlFor={quantityId}>
          <span className="block text-sm font-medium">{copy.additionalServers}</span>
          <span className="block text-xs text-muted-foreground">
            {interpolate(copy.unitPrice, { price: money(data.pricing.extraServerMonthlyCents) })}
          </span>
        </label>
        <Input
          id={quantityId}
          type="number"
          variant="filled"
          min={1}
          max={data.pricing.maxServers - saved.servers}
          step={1}
          className="h-11 w-24 shrink-0 tabular-nums"
          value={additional}
          disabled={busy || checking}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {interpolate(copy.totalSlots, { count: String(total) })}
      </p>
      <dl className="space-y-3 rounded-xl bg-card p-4 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{copy.currentTotal}</dt>
          <dd className="font-medium tabular-nums">{money(saved.priceCents)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{copy.newTotal}</dt>
          <dd className="font-medium tabular-nums">{monthly === null ? "—" : money(monthly)}</dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-border/50 pt-3">
          <dt className="text-muted-foreground">{copy.dueNow}</dt>
          <dd className="font-medium tabular-nums">
            {quote?.amountDueNow == null ? "—" : money(quote.amountDueNow)}
          </dd>
        </div>
      </dl>
      {quote?.effectiveAt && (
        <p className="text-xs text-muted-foreground">
          {interpolate(copy.effective, {
            date: new Date(quote.effectiveAt).toLocaleString(locale),
          })}
        </p>
      )}
      {checking && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon name="spinner" className="size-4 animate-spin" />
          {copy.checkingPrice}
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-3 text-sm">
          <p className="text-danger">{error}</p>
          <Button variant="secondary" size="sm" disabled={busy || checking} onClick={onRetry}>
            {copy.refreshPrice}
          </Button>
        </div>
      )}
      <Button
        className="w-full"
        disabled={busy || checking || !valid || !quote?.quoteId}
        onClick={onCheckout}
      >
        {busy ? copy.processing : quote?.amountDueNow === 0 ? copy.confirmAddition : copy.checkout}
      </Button>
    </div>
  );
}
