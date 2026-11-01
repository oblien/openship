"use client";

import { useId, useState } from "react";
import type { BillingPlans } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { optionCardSurface } from "@/components/shared/OptionCard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  estimatePrepaidUsage,
  hasPrepaidRates,
  previewPaygPool,
  previewPaygTier,
  type ComputePricing,
} from "@/lib/prepaid-estimate";
import { useCloudPurchase } from "./CloudPurchaseContext";
import { readServerResources, ServerResourceInputs } from "./ServerResourceInputs";
import { PaygResourceTiers } from "./PaygResourceTiers";

/** Preview only. Selecting resources or credits never authorizes a purchase. */
export function PayAsYouGoPlan({
  pricing,
  catalog,
  payg,
}: {
  pricing?: BillingPlans["computePricing"];
  catalog?: BillingPlans["custom"];
  payg?: BillingPlans["payg"];
}) {
  const { t } = useI18n();
  const purchase = useCloudPurchase();
  if (!hasPrepaidRates(pricing) || !catalog || !payg?.tiers.length || !payg.creditPackagesCents.length)
    return (
      <section className="rounded-2xl bg-card p-5">
        <h3 className="text-base font-semibold">{t.billing.purchase.preview}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{t.billing.purchase.ratesUnavailable}</p>
        <Button
          type="button"
          variant="secondary"
          className="mt-4"
          onClick={() => purchase.selectMode("monthly")}
        >
          {t.billing.purchase.compareMonthly}
        </Button>
      </section>
    );
  return <PrepaidCalculator pricing={pricing} catalog={catalog} payg={payg} />;
}

function PrepaidCalculator({
  pricing,
  catalog,
  payg,
}: {
  pricing: ComputePricing;
  catalog: NonNullable<BillingPlans["custom"]>;
  payg: NonNullable<BillingPlans["payg"]>;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.purchase;
  const id = useId();
  const [packageCents, setPackageCents] = useState<number>(payg.creditPackagesCents[1] ?? payg.creditPackagesCents[0]!);
  const [tierId, setTierId] = useState(() => previewPaygTier(payg.tiers, packageCents)?.id ?? payg.tiers[0]!.id);
  const selectedTier = payg.tiers.find(tier => tier.id === tierId) ?? payg.tiers[0]!;
  const packageTier = previewPaygTier(payg.tiers, packageCents);
  const [values, setValues] = useState(() => ({
    cpuCores: String(catalog.resources.cpuCores.min),
    memoryMb: String(catalog.resources.memoryMb.min / 1024),
    diskGb: String(catalog.resources.diskGb.min),
  }));
  const resources = readServerResources(values, catalog.resources);
  const pool = resources ? previewPaygPool(selectedTier, resources, 1) : null;
  const largerTier = resources && pool && !pool.fits
    ? payg.tiers.find(tier => previewPaygPool(tier, resources, 1)?.fits)
    : null;
  const ranges = Object.fromEntries(
    (Object.keys(catalog.resources) as Array<keyof typeof catalog.resources>).map(key => [key, {
      ...catalog.resources[key], max: Math.min(catalog.resources[key].max, selectedTier.pool[key]),
    }]),
  ) as typeof catalog.resources;
  const estimate =
    resources && pool?.fits
      ? estimatePrepaidUsage({
          pricing,
          resources,
          packageCents,
          serverCount: 1,
          cpuPercent: 100,
        })
      : null;
  const number = (value: number, digits = 2) =>
    new Intl.NumberFormat(
      locale,
      value !== 0 && Math.abs(value) < 1
        ? { maximumSignificantDigits: 3 }
        : { maximumFractionDigits: digits },
    ).format(value);
  const money = (cents: number, digits = 2) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      ...(cents !== 0 && Math.abs(cents) < 1
        ? { maximumSignificantDigits: 3 }
        : { maximumFractionDigits: digits }),
    }).format(cents / 100);
  const credits = (value: number) => interpolate(copy.credits, { amount: number(value) });
  const balanceCredits = (packageCents / 100) * pricing.creditsPerDollar;
  const duration = (elapsedHours: number) => {
    const unit = elapsedHours >= 24 ? "day" : elapsedHours >= 1 ? "hour" : "minute";
    const value = unit === "day" ? elapsedHours / 24 : unit === "hour" ? elapsedHours : elapsedHours * 60;
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "long",
      maximumFractionDigits: 1,
    }).format(value);
  };
  const rates = [
    {
      label: t.billing.usage.resources.cpu.label,
      unit: copy.cpuUnit,
      cents: pricing.usage.activeVcpuHourCents,
      hourly: estimate?.hourlyCents.cpu,
      quantity: estimate?.hourlyUsage.cpuVcpuHours,
      quantityLabel: copy.cpuHours,
    },
    {
      label: t.billing.custom.memory,
      unit: copy.memoryUnit,
      cents: pricing.usage.reservedGiBHourCents,
      hourly: estimate?.hourlyCents.memory,
      quantity: estimate?.hourlyUsage.memoryGiBHours,
      quantityLabel: copy.gibHours,
    },
    {
      label: t.billing.custom.disk,
      unit: copy.diskUnit,
      cents: pricing.usage.retainedGiBMonthCents,
      hourly: estimate?.hourlyCents.disk,
      quantity: estimate?.hourlyUsage.storageGiBHours,
      quantityLabel: copy.gibHours,
    },
  ];

  return (
    <div className="@container/payg space-y-5">
      <div className="grid items-start gap-5 @min-[52rem]/payg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 items-start gap-5 @min-[64rem]/payg:grid-cols-[minmax(0,1fr)_280px] @min-[80rem]/payg:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-labelledby={`${id}-resources`} className="min-w-0 rounded-2xl bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${id}-resources`} className="text-base font-semibold">
                {copy.sizeHosts}
              </h3>
              <span className="rounded-lg bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {copy.preview}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{copy.sizeHint}</p>
            <div className="mt-4 border-b border-border/50 pb-5">
              <PaygResourceTiers tiers={payg.tiers} selected={selectedTier} onChange={setTierId}
                money={money} />
            </div>
            <div className="mt-5">
              <ServerResourceInputs
                ranges={ranges}
                values={values}
                onChange={setValues}
                columns={2}
              />
            </div>
            {pool && !pool.fits && (
              <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warning/10 px-3 py-2.5">
                <p className="text-sm">
                  {interpolate(copy.tiers.exceeded, {
                    tier: interpolate(copy.tiers.name, { level: number(selectedTier.level) }),
                  })}
                </p>
                {largerTier && (
                  <Button type="button" size="sm" variant="secondary" onClick={() => setTierId(largerTier.id)}>
                    {interpolate(copy.tiers.choose, {
                      tier: interpolate(copy.tiers.name, { level: number(largerTier.level) }),
                    })}
                  </Button>
                )}
              </div>
            )}
            {(!resources || !pool) && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {copy.invalid}
              </p>
            )}
          </section>

          <section aria-labelledby={`${id}-packages`} className="min-w-0 rounded-2xl bg-card p-5">
            <div className="space-y-3">
              <div>
                <h3 id={`${id}-packages`} className="text-base font-semibold">
                  {copy.packages}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">{copy.packagesHint}</p>
              </div>
              <p className="rounded-lg bg-muted/50 px-3 py-1.5 text-xs font-medium tabular-nums">
                {interpolate(copy.conversion, {
                  credits: number(pricing.creditsPerDollar),
                  amount: money(100),
                })}
              </p>
            </div>
            <div
              className="mt-4 grid gap-2"
              role="group"
              aria-labelledby={`${id}-packages`}
            >
              {payg.creditPackagesCents.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  value={amount}
                  aria-pressed={packageCents === amount}
                  aria-label={interpolate(copy.packageSummary, {
                    amount: money(amount),
                    credits: number((amount / 100) * pricing.creditsPerDollar),
                  })}
                  onClick={() => setPackageCents(amount)}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-xl border px-4 py-4 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    optionCardSurface(packageCents === amount),
                  )}
                >
                  <span className="text-xl font-semibold tracking-tight tabular-nums">
                    {money(amount, 0)}
                  </span>
                  <span className="ms-auto text-end text-sm text-muted-foreground">
                    {credits((amount / 100) * pricing.creditsPerDollar)}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full",
                      packageCents === amount ? "bg-primary" : "border border-border",
                    )}
                  >
                    {packageCents === amount && <span className="size-1.5 rounded-full bg-primary-foreground" />}
                  </span>
                </button>
              ))}
            </div>
            {packageTier && (
              <p className="mt-4 text-sm font-medium">
                {interpolate(copy.tiers.packageUnlock, {
                  tier: interpolate(copy.tiers.name, { level: number(packageTier.level) }),
                })}
              </p>
            )}
            {packageCents < selectedTier.minimumFundingCents && (
              <p className="mt-2 text-xs text-warning">
                {interpolate(copy.tiers.packageTooSmall, {
                  tier: interpolate(copy.tiers.name, { level: number(selectedTier.level) }),
                  amount: money(selectedTier.minimumFundingCents),
                })}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{copy.tiers.fundingHint}</p>
          </section>
        </div>
        <aside aria-labelledby={`${id}-estimate`} className="min-w-0 rounded-2xl bg-card p-5">
          <h3 id={`${id}-estimate`} className="text-base font-semibold">
            {copy.estimate}
          </h3>
          <div aria-live="polite" aria-atomic="true">
            <p className="mt-3 flex flex-wrap items-baseline gap-x-2">
              <span className="text-2xl font-semibold tracking-tight tabular-nums">
                {estimate ? money(estimate.totalHourlyCents, 4) : "—"}
              </span>
              <span className="text-sm text-muted-foreground">{copy.perHour}</span>
            </p>
            <p className="mt-1 text-sm tabular-nums text-muted-foreground">
              {estimate
                ? interpolate(copy.creditsPerHour, { amount: number(estimate.hourlyCredits) })
                : "—"}
            </p>
            {estimate && (
              <p className="mt-2 text-xs text-muted-foreground">
                {copy.hourlyHint}
              </p>
            )}
            <dl className="mt-5 space-y-4 border-t border-border/50 pt-4 text-sm">
              {rates.map((rate) => (
                <div key={rate.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">
                    <span className="block">{rate.label}</span>
                    <span className="mt-0.5 block text-xs">
                      {rate.quantity !== undefined
                        ? interpolate(rate.quantityLabel, { amount: number(rate.quantity) })
                        : "—"}
                    </span>
                  </dt>
                  <dd className="text-end tabular-nums">
                    <span className="block font-medium">
                      {rate.hourly !== undefined ? money(rate.hourly, 4) : "—"}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {rate.hourly !== undefined
                        ? credits((rate.hourly / 100) * pricing.creditsPerDollar)
                        : "—"}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            {estimate && resources && (
              <div className="mt-4 rounded-xl bg-muted/40 p-3">
                <p className="text-xs font-medium text-muted-foreground">{copy.hourlyBasis}</p>
                <bdi dir="ltr" className="mt-1 block text-sm font-medium tabular-nums">
                  {interpolate(copy.cpuFormula, {
                    cpu: number(resources.cpuCores),
                    percent: number(100),
                    hours: number(estimate.hourlyUsage.cpuVcpuHours),
                  })}
                </bdi>
              </div>
            )}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {copy.activityHint}
          </p>
          <details className="group mt-5 border-t border-border/50 pt-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              {copy.runtime}
              <Icon
                name="chevron-down"
                className="size-4 shrink-0 transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <dl className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <dt className="text-xs text-muted-foreground">{copy.rangeMinimum}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">
                  {estimate ? duration(estimate.durationRange.minElapsedHours) : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{copy.rangeMaximum}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">
                  {estimate ? duration(estimate.durationRange.maxElapsedHours) : "—"}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{copy.rangeHint}</p>
          </details>
          <details className="group mt-4 border-t border-border/50 pt-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              {copy.ratesDetails}
              <Icon
                name="chevron-down"
                className="size-4 shrink-0 transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <dl className="mt-2 divide-y divide-border/50">
              {rates.map((rate) => (
                <div
                  key={rate.label}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-sm"
                >
                  <dt>
                    {rate.label}
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {rate.unit}
                    </span>
                  </dt>
                  <dd className="text-end tabular-nums">
                    {credits((rate.cents / 100) * pricing.creditsPerDollar)}
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {money(rate.cents, 4)}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t.billing.compute.paygMetering}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {interpolate(copy.extras, {
                amount: money(pricing.network.managedProxyGiBCents, 4),
              })}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {copy.retentionHint}
            </p>
          </details>
        </aside>
      </div>
      <div className="sticky bottom-3 z-20 mt-5 rounded-2xl bg-popover/80 p-3 text-popover-foreground shadow-lg ring-1 ring-border/50 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-semibold tabular-nums">{money(packageCents)}</p>
            <p className="text-sm text-muted-foreground">{credits(balanceCredits)}</p>
          </div>
          <Button
            type="button"
            disabled
            className="shrink-0"
            aria-describedby={`${id}-availability`}
          >
            {interpolate(copy.addCredits, { amount: number(balanceCredits) })}
          </Button>
        </div>
        <p id={`${id}-availability`} className="mt-1 text-xs text-muted-foreground">
          {copy.previewHint}
        </p>
      </div>
    </div>
  );
}
