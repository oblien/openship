"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import Link from "next/link";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";
import { PlanResources } from "./PlanResources";
import { useCloudCheckout, useCloudPlans } from "./useCloudBilling";

/** The first useful action for a workspace with no paid Cloud subscription. */
export function CloudPlanOffer({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const copy = t.billing.onboarding;
  const { payload, loading, error, retry } = useCloudPlans();
  const enabled = state.billing?.enabled === true && (state.tier === "free" || state.capabilities?.subscriptionChange === true);
  const checkout = useCloudCheckout({ enabled });
  const plan = !loading && !error ? payload?.plans
    .filter((item) => item.id !== "free" && item.id !== "enterprise" && item.price.monthly != null && item.price.monthly > 0)
    .sort((a, b) => a.price.monthly! - b.price.monthly!)[0] : undefined;
  const price = plan?.price.monthly;
  const money = price == null ? null : new Intl.NumberFormat(locale, {
    style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: price % 100 === 0 ? 0 : 2,
  }).format(price / 100);

  return <section className="overflow-hidden rounded-2xl border border-primary/20 bg-card" aria-label={copy.offerTitle}>
    <div className="bg-primary/5 p-5 sm:p-6">
      <span className="mb-4 inline-flex items-center gap-2 text-xs font-medium text-primary"><UiIcon name="rocket" className="size-4" aria-hidden="true" />{copy.offerLabel}</span>
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{plan ? interpolate(copy.startingWith, { name: plan.name }) : copy.offerTitle}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.offerDescription}</p>
    </div>
    <div className="p-5 sm:p-6">
      {loading ? <div role="status" className="flex min-h-44 items-center justify-center gap-2 text-sm text-muted-foreground">
        <UiIcon name="spinner" className="size-4 animate-spin" aria-hidden="true" />{t.billing.usage.breakdown.loading}
      </div> : plan ? <>
        <p className="flex items-baseline gap-1.5">
          <span className="text-4xl font-semibold tracking-tight tabular-nums text-foreground">{money}</span>
          <span className="text-sm text-muted-foreground">{payload?.ui.perMonth}</span>
        </p>
        <p className="mb-4 mt-1 text-xs text-muted-foreground">{t.billing.subscription.billedMonthly}</p>
        <button type="button" disabled={!enabled || checkout.subscribing !== null} onClick={() => void checkout.startCheckout(plan.id, "monthly")}
          className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50">
          {checkout.subscribing ? <UiIcon name="spinner" className="size-4 animate-spin" aria-hidden="true" /> : <>{interpolate(copy.subscribe, { name: plan.name })}<UiIcon name="arrow-right" className="size-4 rtl:rotate-180" aria-hidden="true" /></>}
        </button>
        {!enabled && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{state.billing?.enabled ? t.billing.plansRoute.changeViaSupport : t.billing.plansRoute.billingUnavailable}</p>}
        {checkout.error && <p role="alert" className="mt-3 text-sm text-danger">{checkout.error}</p>}
        <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">{copy.checkoutNote}</p>
        <div className="mt-5"><PlanResources plan={plan} /></div>
      </> : error ? <div role="alert" className="mb-4 text-sm text-muted-foreground">
        <p>{error}</p><button type="button" onClick={retry} className="mt-2 font-medium text-primary hover:underline">{t.billing.plansRoute.tryAgain}</button>
      </div> : null}
      <Link href="/billing/plans" className="mt-4 flex min-h-10 items-center justify-center gap-2 rounded-xl border border-border/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/40">
        {copy.compare}<UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" aria-hidden="true" />
      </Link>
    </div>
  </section>;
}
