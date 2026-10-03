"use client";

import { useEffect, useId, useState } from "react";
import type { BillingCustomQuote, BillingPlans, BillingSubscription } from "@repo/contracts";
import type { CustomServerResources } from "@repo/core";
import { Icon, type IconName } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { billingApi } from "@/lib/api/billing";
import { getApiErrorMessage } from "@/lib/api/client";
import { needsCloudPlan } from "@/lib/billing-presentation";
import { PlanUsageNote } from "./PlanUsageNote";
import type { ApiPlan, ApiPricingUi } from "./PricingCards";

export function CustomPlanConfigurator({ catalog, plans, ui, currentOffer, subscription, disabled, busy, onSelect, quoteRevision = 0, allocatedDiskGb }: {
  catalog: NonNullable<BillingPlans["custom"]>;
  plans: ApiPlan[];
  ui: ApiPricingUi;
  currentOffer?: ApiPlan | null;
  subscription?: BillingSubscription | null;
  disabled: boolean;
  busy: boolean;
  quoteRevision?: number;
  allocatedDiskGb?: number | null;
  onSelect: (quote: BillingCustomQuote) => void;
}) {
  const { t } = useI18n();
  const copy = t.billing.custom;
  const id = useId();
  const ranges = {
    ...catalog.resources,
    diskGb: { ...catalog.resources.diskGb, min: Math.max(catalog.resources.diskGb.min, Math.ceil(allocatedDiskGb ?? 0)) },
  };
  const saved = currentOffer?.resourceLimits;
  const [values, setValues] = useState(() => ({
    cpuCores: String(saved?.max_total_vcpus ?? ranges.cpuCores.min),
    memoryMb: String((saved?.max_total_ram_mb ?? ranges.memoryMb.min) / 1024),
    diskGb: String(Math.max(saved?.max_total_disk_gb ?? 0, ranges.diskGb.min)),
  }));
  const resources: CustomServerResources = {
    cpuCores: Number(values.cpuCores),
    memoryMb: Number(values.memoryMb) * 1024,
    diskGb: Number(values.diskGb),
  };
  const valid = (Object.keys(resources) as Array<keyof CustomServerResources>).every(key => {
    const value = resources[key], range = ranges[key];
    return values[key] !== "" && Number.isSafeInteger(value) && value >= range.min && value <= range.max && value % range.step === 0;
  });
  const resourceKey = JSON.stringify(resources);
  const requestKey = `${resourceKey}:${quoteRevision}`;
  const [result, setResult] = useState<{ key: string; quote: BillingCustomQuote } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let disposed = false;
    setError(null);
    setPending(valid);
    if (!valid) return;
    const timer = setTimeout(() => {
      void billingApi.quoteCustomPlan(JSON.parse(resourceKey) as CustomServerResources)
        .then(quote => { if (!disposed) setResult({ key: requestKey, quote }); })
        .catch(failure => { if (!disposed) setError(getApiErrorMessage(failure, copy.quoteError)); })
        .finally(() => { if (!disposed) setPending(false); });
    }, 200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [resourceKey, requestKey, valid, attempt, copy.quoteError]);

  // A response for an earlier input can never enable the purchase button.
  const quote = valid && !pending && !error && result?.key === requestKey ? result.quote : null;
  const current = Boolean(quote && subscription?.configuration === "custom" &&
    !needsCloudPlan({ tier: subscription.tier, subscription }) && subscription.offerReference === quote.reference);
  const bundle = plans.find(plan => plan.id === quote?.basePlanTierId);
  const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  const fields: Array<{ key: keyof CustomServerResources; label: string; unit: string; icon: IconName; divisor: number }> = [
    { key: "cpuCores", label: copy.cpu, unit: "vCPU", icon: "cpu", divisor: 1 },
    { key: "memoryMb", label: copy.memory, unit: "GB", icon: "memory", divisor: 1024 },
    { key: "diskGb", label: copy.disk, unit: "GB", icon: "hard-drive", divisor: 1 },
  ];

  return (
    <div className="@container/custom-plan space-y-4">
      <form
        aria-label={copy.title}
        onSubmit={event => { event.preventDefault(); if (quote && !disabled && !busy && !current) onSelect(quote); }}
        className="grid items-start gap-4 @min-[48rem]/custom-plan:grid-cols-[minmax(0,1fr)_300px]"
      >
        <section className="min-w-0 rounded-2xl bg-card p-5">
          <h3 className="text-lg font-semibold tracking-tight">{copy.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
          <div className="mt-5 space-y-5">
            {fields.map(({ key, label, unit, icon, divisor }) => {
              const range = ranges[key];
              const min = range.min / divisor, max = range.max / divisor, step = range.step / divisor;
              const value = Number(values[key]);
              const invalid = values[key] === "" || !Number.isFinite(value) || value < min || value > max || value % step !== 0;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between gap-4">
                    <label htmlFor={`${id}-${key}`} className="flex items-center gap-2.5 text-sm font-medium">
                      <Icon name={icon} className="size-4 text-muted-foreground" />
                      {label}
                    </label>
                    <div className="relative w-36 shrink-0">
                      <Input
                        id={`${id}-${key}`} type="number" variant="filled" min={min} max={max} step={step}
                        value={values[key]} disabled={busy} required aria-invalid={invalid}
                        aria-describedby={`${id}-${key}-range`}
                        onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))}
                        className="pe-12 tabular-nums"
                      />
                      <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{unit}</span>
                    </div>
                  </div>
                  <input
                    type="range" min={min} max={max} step={step} value={invalid ? min : value}
                    aria-label={label} disabled={busy}
                    onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))}
                    className="mt-4 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:cursor-wait [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary"
                  />
                  <p id={`${id}-${key}-range`} className={`mt-1 text-xs ${invalid ? "text-danger" : "text-muted-foreground"}`}>
                    {interpolate(copy.range, { min: String(min), max: String(max), unit })}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="mt-5 rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">{copy.shared}</p>
          {(allocatedDiskGb ?? 0) > 0 && <p className="mt-3 text-xs text-muted-foreground">{copy.diskGrowth}</p>}
        </section>

        <aside className="min-w-0 space-y-4 rounded-2xl bg-card p-5">
          <div>
            <p className="text-sm font-medium">{copy.monthlyTotal}</p>
            <div aria-live="polite" aria-busy={!quote && valid && !error} className="mt-2 flex min-h-9 items-baseline gap-2">
              {quote ? <span className="text-3xl font-semibold tracking-tight tabular-nums">{money(quote.priceCents)}</span>
                : <span className={`inline-block h-8 w-24 rounded-lg bg-muted ${pending ? "animate-pulse" : ""}`} aria-label={valid ? copy.updating : copy.invalid} />}
              <span className="text-sm text-muted-foreground">{ui.perMonth}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{ui.billedMonthly}</p>
          </div>
          <Button type="submit" className="w-full" disabled={!quote || disabled || busy || current}>
            {busy ? <Icon name="spinner" className="size-4 animate-spin" /> : current ? t.billing.pricing.currentPlan : copy.choose}
          </Button>
          {!valid && <p role="alert" className="text-sm text-danger">{copy.invalid}</p>}
          {error && (
            <div role="alert" className="space-y-2 text-sm text-danger">
              <p>{error}</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt(value => value + 1)}>{t.billing.plansRoute.tryAgain}</Button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{copy.bestPrice}</p>
          <details className="group rounded-xl bg-muted/40 p-3" aria-busy={pending}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              {copy.breakdown}
              <Icon name="chevron-down" className="size-3.5 transition-transform group-open:rotate-180" />
            </summary>
            {quote && bundle ? <dl className="mt-3 space-y-2 text-sm">
              {[
                [interpolate(copy.bundle, { name: bundle.name }), quote.breakdown.basePriceCents],
                [copy.extraCpu, quote.breakdown.cpuCents],
                [copy.extraMemory, quote.breakdown.memoryCents],
                [copy.extraDisk, quote.breakdown.diskCents],
              ].map(([label, cents]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="shrink-0 tabular-nums">{money(Number(cents))}</dd>
                </div>
              ))}
            </dl> : <div className="mt-3 space-y-2" aria-label={valid ? copy.updating : copy.invalid}>
              {[0, 1, 2, 3].map(row => <div key={row} className={`h-5 rounded bg-muted ${pending ? "animate-pulse" : ""}`} />)}
            </div>}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{interpolate(copy.rates, {
              cpu: money(catalog.extraMonthlyCents.cpuCore), memory: money(catalog.extraMonthlyCents.memoryGb), disk: money(catalog.extraMonthlyCents.diskGb),
            })}</p>
          </details>
          {subscription && <p className="text-xs text-muted-foreground">{copy.applyNotice}</p>}
        </aside>
      </form>
      {quote && bundle && <PlanUsageNote plans={[{ ...bundle, name: copy.name, monthlyCredits: quote.monthlyCredits }]} workspaceScoped showCapacityNote={false} />}
    </div>
  );
}
