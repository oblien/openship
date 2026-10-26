"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/PageContainer";
import { Logo } from "@/components/logo";
import { Icon } from "@repo/ui/icons";
import { PricingCards } from "@/components/billing/PricingCards";
import { BillingIntervalPicker } from "@/components/billing/BillingIntervalPicker";
import { BillingPlansSkeleton } from "@/app/(dashboard)/billing/_components/BillingTabSkeleton";
import { useCloudPlans } from "@/components/billing/useCloudBilling";
import { newServerBillingHref } from "@/lib/billing-links";
import { getReferralOffer } from "@/lib/api/affiliates";
import { getApiErrorMessage } from "@/lib/api/client";
import type { AffiliatePublicOffer } from "@repo/contracts";
import { referralPlans } from "./referral-plans";

export function ReferralLanding({ code }: { code: string }) {
  const { t } = useI18n(),
    copy = t.affiliates;
  const router = useRouter();
  const catalog = useCloudPlans();
  const [selectedInterval, setInterval] = useState<"monthly" | "annual">("annual");
  const [state, setState] = useState<{ offer?: AffiliatePublicOffer; error?: string }>({});
  const load = useCallback(async () => {
    try {
      return { offer: await getReferralOffer(code) };
    } catch (e) {
      return { error: getApiErrorMessage(e) };
    }
  }, [code]);
  useEffect(() => {
    let active = true;
    setState({});
    void load().then((result) => {
      if (active) setState(result);
    });
    return () => {
      active = false;
    };
  }, [load]);
  const offeredIntervals = (["monthly", "annual"] as const).filter(
    (value) =>
      (value === "monthly" || catalog.payload?.annual.enabled) &&
      referralPlans(catalog.payload?.plans ?? [], state.offer, value).length > 0,
  );
  const preferredInterval = catalog.payload?.annual.enabled ? selectedInterval : "monthly";
  const interval = offeredIntervals.includes(preferredInterval)
    ? preferredInterval
    : (offeredIntervals[0] ?? preferredInterval);
  const plans = referralPlans(catalog.payload?.plans ?? [], state.offer, interval);
  const ready = Boolean(state.offer || state.error);
  // Keep an unavailable referral attached until the buyer explicitly removes it
  // in checkout. A failed lookup must never become a full-price auto-checkout.
  const destination = newServerBillingHref(undefined, { referralCode: code });
  return (
    <PageContainer className="space-y-10">
      <header className="flex items-center justify-between gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-3 text-lg font-medium text-foreground"
        >
          <Logo size={32} /> OpenShip
        </Link>
        {ready ? (
          <Button variant="secondary" asChild>
            <Link href={`/login?${new URLSearchParams({ returnTo: destination })}`}>
              {t.auth.login.submit}
            </Link>
          </Button>
        ) : (
          <Button variant="secondary" disabled>
            {t.auth.login.submit}
          </Button>
        )}
      </header>
      <main className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="max-w-2xl space-y-3">
            <h1 className="text-3xl font-medium tracking-tight text-foreground sm:text-4xl">
              {copy.continue}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground sm:text-base">
              {copy.referralIntro}
            </p>
          </div>
          {offeredIntervals.length > 1 ? (
            <BillingIntervalPicker value={interval} onChange={setInterval} />
          ) : (
            offeredIntervals.length === 1 && (
              <span className="rounded-xl bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {interval === "annual" ? t.billing.pricing.annual : t.billing.pricing.monthly}
              </span>
            )
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card px-5 py-4">
          {state.offer ? (
            <>
              <div className="flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
                  <Icon name="check" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {state.offer.discountBps > 0
                      ? interpolate(copy.referralDiscount, {
                          percent: String(state.offer.discountBps / 100),
                          months: String(state.offer.durationMonths),
                        })
                      : copy.referralTitle}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{copy.referralApplied}</p>
                </div>
              </div>
              <span className="break-all rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs text-muted-foreground">
                {state.offer.code}
              </span>
            </>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {state.error ? copy.referralUnavailable : copy.verifying}
            </p>
          )}
        </div>
        {catalog.loading || !ready ? (
          <BillingPlansSkeleton />
        ) : catalog.error || !catalog.payload ? (
          <div role="alert" className="space-y-3 rounded-2xl bg-card p-5">
            <p className="text-sm text-muted-foreground">{catalog.error}</p>
            <Button variant="secondary" onClick={catalog.retry}>
              {copy.retry}
            </Button>
          </div>
        ) : plans.length ? (
          <PricingCards
            plans={plans}
            ui={catalog.payload.ui}
            currentPlan={null}
            interval={interval}
            workspaceScoped
            onSelectPlan={(planId) => {
              if (!plans.some((plan) => plan.id === planId)) return;
              router.push(
                newServerBillingHref(undefined, {
                  planId,
                  interval,
                  startCheckout: true,
                  referralCode: code,
                }),
              );
            }}
          />
        ) : (
          <p className="rounded-2xl bg-card p-5 text-sm text-muted-foreground">
            {copy.referralNoPlans}
          </p>
        )}
        <p className="text-xs leading-5 text-muted-foreground">{copy.referralHint}</p>
      </main>
    </PageContainer>
  );
}
