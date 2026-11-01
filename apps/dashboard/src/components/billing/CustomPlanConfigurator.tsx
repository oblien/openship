"use client";

import { useState } from "react";
import type { BillingCustomQuote, BillingPlans, BillingSubscription } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { needsCloudPlan } from "@/lib/billing-presentation";
import { PlanUsageNote } from "./PlanUsageNote";
import type { ApiPlan, ApiPricingUi } from "./PricingCards";
import { readServerResources, ServerResourceInputs } from "./ServerResourceInputs";
import { useCustomPlanQuote } from "./useCustomPlanQuote";

export function CustomPlanConfigurator({
  catalog,
  plans,
  ui,
  currentOffer,
  subscription,
  disabled,
  busy,
  onSelect,
  quoteRevision = 0,
  allocatedDiskGb,
  actionLabel,
  interval = "monthly",
}: {
  catalog: NonNullable<BillingPlans["custom"]>;
  plans: ApiPlan[];
  ui: ApiPricingUi;
  currentOffer?: ApiPlan | null;
  subscription?: BillingSubscription | null;
  disabled: boolean;
  busy: boolean;
  quoteRevision?: number;
  allocatedDiskGb?: number | null;
  actionLabel?: string;
  interval?: "monthly" | "annual";
  onSelect: (quote: BillingCustomQuote) => void;
}) {
  const { t } = useI18n();
  const copy = t.billing.custom;
  const ranges = {
    ...catalog.resources,
    diskGb: {
      ...catalog.resources.diskGb,
      min: Math.max(catalog.resources.diskGb.min, Math.ceil(allocatedDiskGb ?? 0)),
    },
  };
  const saved = currentOffer?.resourceLimits;
  const [values, setValues] = useState(() => ({
    cpuCores: String(saved?.max_total_vcpus ?? ranges.cpuCores.min),
    memoryMb: String((saved?.max_total_ram_mb ?? ranges.memoryMb.min) / 1024),
    diskGb: String(Math.max(saved?.max_total_disk_gb ?? 0, ranges.diskGb.min)),
  }));
  const resources = readServerResources(values, ranges);
  const valid = resources !== null;
  const { quote, pending, error, retry } = useCustomPlanQuote(resources, quoteRevision, interval);
  const current = Boolean(
    quote &&
    subscription &&
    !needsCloudPlan({ tier: subscription.tier, subscription }) &&
    (subscription.offerReference === quote.reference ||
      (saved &&
        saved.max_total_vcpus === quote.resources.cpuCores &&
        saved.max_total_ram_mb === quote.resources.memoryMb &&
        saved.max_total_disk_gb === quote.resources.diskGb &&
        currentOffer?.price[interval] === quote.priceCents &&
        currentOffer.monthlyCredits === quote.monthlyCredits)),
  );
  const annualRates = interval === "annual" ? catalog.extraAnnualCents : undefined;
  const rates = annualRates ?? catalog.extraMonthlyCents;
  const rateMonths = annualRates ? 12 : 1;
  const bundle = plans.find((plan) => plan.id === quote?.basePlanTierId);
  const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

  return (
    <div className="@container/custom-plan space-y-4">
      <form
        aria-label={copy.title}
        onSubmit={(event) => {
          event.preventDefault();
          if (quote && !disabled && !busy && !current) onSelect(quote);
        }}
        className="grid items-start gap-4 @min-[48rem]/custom-plan:grid-cols-[minmax(0,1fr)_300px]"
      >
        <section className="min-w-0 rounded-2xl bg-card p-5">
          <h3 className="text-lg font-semibold tracking-tight">{copy.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
          <div className="mt-5">
            <ServerResourceInputs
              ranges={ranges}
              values={values}
              onChange={setValues}
              disabled={busy}
            />
          </div>
          {(allocatedDiskGb ?? 0) > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">{copy.diskGrowth}</p>
          )}
        </section>

        <aside className="min-w-0 space-y-4 rounded-2xl bg-card p-5">
          <div>
            <p className="text-sm font-medium">{copy.monthlyTotal}</p>
            <div
              aria-live="polite"
              aria-busy={!quote && valid && !error}
              className="mt-2 flex min-h-9 items-baseline gap-2"
            >
              {quote ? (
                <span className="text-3xl font-semibold tracking-tight tabular-nums">
                  {money(interval === "annual" ? quote.priceCents / 12 : quote.priceCents)}
                </span>
              ) : (
                <span
                  className={`inline-block h-8 w-24 rounded-lg bg-muted ${pending ? "animate-pulse" : ""}`}
                  aria-label={valid ? copy.updating : copy.invalid}
                />
              )}
              <span className="text-sm text-muted-foreground">{ui.perMonth}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{interval === "annual" && quote
              ? interpolate(t.billing.pricing.annualTotal, { price: money(quote.priceCents) })
              : ui.billedMonthly}</p>
          </div>
          <Button type="submit" className="w-full" disabled={!quote || disabled || busy || current}>
            {busy ? (
              <Icon name="spinner" className="size-4 animate-spin" />
            ) : current ? (
              t.billing.pricing.currentPlan
            ) : (
              (actionLabel ?? copy.choose)
            )}
          </Button>
          {!valid && (
            <p role="alert" className="text-sm text-danger">
              {copy.invalid}
            </p>
          )}
          {error && (
            <div role="alert" className="space-y-2 text-sm text-danger">
              <p>{error}</p>
              <Button type="button" variant="secondary" size="sm" onClick={retry}>
                {t.billing.plansRoute.tryAgain}
              </Button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{copy.bestPrice}</p>
          <details className="group rounded-xl bg-muted/40 p-3" aria-busy={pending}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              {copy.breakdown}
              <Icon
                name="chevron-down"
                className="size-3.5 transition-transform group-open:rotate-180"
              />
            </summary>
            {quote && bundle ? (
              <dl className="mt-3 space-y-2 text-sm">
                {[
                  [interpolate(copy.bundle, { name: bundle.name }), quote.breakdown.basePriceCents],
                  [copy.extraCpu, quote.breakdown.cpuCents],
                  [copy.extraMemory, quote.breakdown.memoryCents],
                  [copy.extraDisk, quote.breakdown.diskCents],
                ].map(([label, cents]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="shrink-0 tabular-nums">{money(Number(cents) / (interval === "annual" ? 12 : 1))}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="mt-3 space-y-2" aria-label={valid ? copy.updating : copy.invalid}>
                {[0, 1, 2, 3].map((row) => (
                  <div
                    key={row}
                    className={`h-5 rounded bg-muted ${pending ? "animate-pulse" : ""}`}
                  />
                ))}
              </div>
            )}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              {interpolate(copy.rates, {
                cpu: money(rates.cpuCore / rateMonths),
                memory: money(rates.memoryGb / rateMonths),
                disk: money(rates.diskGb / rateMonths),
              })}
            </p>
          </details>
          {subscription && <p className="text-xs text-muted-foreground">{copy.applyNotice}</p>}
        </aside>
      </form>
      {quote && bundle && (
        <PlanUsageNote
          plans={[
            {
              ...bundle,
              name: copy.name,
              billingMode: quote.billingMode,
              monthlyCredits: quote.monthlyCredits,
            },
          ]}
          workspaceScoped
          showCapacityNote={false}
        />
      )}
    </div>
  );
}
