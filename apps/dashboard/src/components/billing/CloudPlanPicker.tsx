"use client";

import { useState } from "react";
import { PricingCards } from "@/components/billing/PricingCards";
import type { PlanTierId } from "@repo/core";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import type { BillingSubscription } from "@repo/contracts";
import { useCloudCheckout, useCloudPlans } from "./useCloudBilling";
import { CloudUsageGuide } from "./CloudUsageGuide";

export function CloudPlanPicker({ currentPlan, subscription, billingEnabled = false, canChangeSubscription = false, preserveProject = false, onCheckoutStarted }: {
  currentPlan: PlanTierId; billingEnabled?: boolean; canChangeSubscription?: boolean;
  subscription?: BillingSubscription | null;
  preserveProject?: boolean;
  onCheckoutStarted?: () => void;
}) {
  const { t } = useI18n();
  const { payload, loading, error, retry } = useCloudPlans();
  const [interval, setInterval] = useState<"monthly" | "annual">(subscription?.interval ?? "monthly");
  const canPurchase = billingEnabled && (currentPlan === "free" || canChangeSubscription);
  const { startCheckout, subscribing, error: checkoutError, checkoutUrl } = useCloudCheckout({
    enabled: canPurchase, preserveProject, onCheckoutStarted,
  });
  const selectedCurrentPlan = subscription === null || subscription?.status === "canceled"
    || (subscription && subscription.interval !== interval) ? null : currentPlan;

  const handleSelectPlan = (planTierId: PlanTierId) => {
    if (planTierId !== selectedCurrentPlan) void startCheckout(planTierId, interval);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">{error || t.billing.plansRoute.genericError}</p>
        <button
          onClick={retry}
          className="mt-4 text-sm font-medium text-primary hover:underline"
        >
          {t.billing.plansRoute.tryAgain}
        </button>
      </div>
    );
  }

  // The Plans tab is where you BUY something, so the $0 tier has no place in it:
  // it is nothing to buy, and for the overwhelming majority of viewers it is the
  // plan they are already on — a card whose only button says "Current plan".
  // Where you stand is stated on Overview and in the allowance cards above.
  // Filtered on price rather than the id `free` so any future $0 tier is covered
  // by the same rule. Customers can stop renewal from Overview or the portal.
  const purchasable = payload.plans.filter((p) => p.price.monthly !== 0);

  return (
    <div className="space-y-5">
      {!preserveProject && <div>
        <h2 className="text-lg font-semibold text-foreground">{t.billing.onboarding.compareTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.billing.onboarding.compareDescription}</p>
      </div>}
      {payload.annual.enabled && (
        <div className="flex gap-2" role="group" aria-label={t.billing.pricing.billingInterval}>
          {(["monthly", "annual"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={interval === value} onClick={() => setInterval(value)} disabled={subscribing !== null}
              className={`rounded-lg border px-3 py-2 text-sm ${interval === value ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
              {value === "monthly" ? t.billing.pricing.monthly : t.billing.pricing.annual}
            </button>
          ))}
        </div>
      )}
      {canPurchase && subscription && subscription.status !== "canceled" && (
        <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          {t.billing.plansRoute.replacementNotice}
        </p>
      )}
      {checkoutUrl && (
        <div role="status" className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm">
          <p>{t.billing.deployGate.checkoutOpened}</p>
          <a href={checkoutUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex font-medium text-primary hover:underline">
            {t.billing.deployGate.continueCheckout}
          </a>
        </div>
      )}
      {checkoutError && <p role="alert" className="text-sm text-danger">{checkoutError}</p>}
      {!canPurchase && (
        <p className="text-sm text-muted-foreground">
          {billingEnabled ? t.billing.plansRoute.changeViaSupport : t.billing.plansRoute.billingUnavailable}{" "}
          <a href="mailto:support@openship.io" className="text-primary hover:underline">{t.billing.portal.supportButton}</a>
        </p>
      )}
    <PricingCards
      plans={purchasable}
      ui={payload.ui}
      currentPlan={selectedCurrentPlan}
      onSelectPlan={handleSelectPlan}
      subscribingPlan={subscribing}
      purchasesDisabled={!canPurchase}
      interval={interval}
    />
      {!preserveProject && <CloudUsageGuide collapsible />}
    </div>
  );
}
