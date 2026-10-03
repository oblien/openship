"use client";

import { Button } from "@/components/ui/button";
import { BillingPlansSkeleton } from "@/app/(dashboard)/billing/_components/BillingTabSkeleton";

import { useState } from "react";
import { PricingCards } from "@/components/billing/PricingCards";
import type { PlanTierId } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import type { BillingSubscription } from "@repo/contracts";
import type { BillingState } from "@/lib/api/billing";
import { needsCloudPlan } from "@/lib/billing-presentation";
import { useCloudCheckout, useCloudPlans } from "./useCloudBilling";
import { useBillingWorkspace } from "./BillingWorkspaceContext";
import { CustomPlanConfigurator } from "./CustomPlanConfigurator";
import type { ApiPlan } from "./PricingCards";

export function CloudPlanPicker({
  currentPlan,
  subscription,
  complimentary,
  billingEnabled = false,
  canChangeSubscription = false,
  preserveProject = false,
  onCheckoutStarted,
  workspaceId,
  currentOffer,
  allocatedDiskGb,
}: {
  workspaceId?: string;
  currentPlan: PlanTierId;
  currentOffer?: ApiPlan | null;
  allocatedDiskGb?: number | null;
  billingEnabled?: boolean;
  canChangeSubscription?: boolean;
  subscription?: BillingSubscription | null;
  complimentary?: BillingState["complimentary"];
  preserveProject?: boolean;
  onCheckoutStarted?: () => void;
}) {
  const { t } = useI18n();
  const billingWorkspaceId = useBillingWorkspace();
  const workspaceScoped = Boolean(workspaceId ?? billingWorkspaceId) ||
    (currentPlan === "free" && !subscription && !complimentary);
  const { payload, loading, error, retry } = useCloudPlans();
  const [interval, setInterval] = useState<"monthly" | "annual">(
    subscription?.interval ?? "monthly",
  );
  const [configuration, setConfiguration] = useState<"plans" | "custom">(
    subscription?.configuration === "custom" ? "custom" : "plans",
  );
  const canPurchase =
    !complimentary && billingEnabled && needsCloudPlan({ tier: currentPlan, subscription, complimentary })
      && (currentPlan === "free" || canChangeSubscription);
  const {
    startCheckout,
    subscribing,
    error: checkoutError,
    checkoutUrl,
    quoteRevision,
  } = useCloudCheckout({
    enabled: canPurchase,
    preserveProject,
    onCheckoutStarted,
    workspaceId,
  });
  const selectedCurrentPlan =
    subscription?.configuration === "custom" ||
    needsCloudPlan({ tier: currentPlan, subscription, complimentary }) ||
    (!complimentary && subscription && subscription.interval !== interval)
      ? null
      : currentPlan;

  const handleSelectPlan = (planTierId: PlanTierId) => {
    if (planTierId !== selectedCurrentPlan) void startCheckout(planTierId, interval);
  };

  if (loading) return <BillingPlansSkeleton />;

  if (error || !payload) {
    return (
      <div className="rounded-2xl bg-card p-5">
        <p className="text-sm text-muted-foreground">
          {error || t.billing.plansRoute.genericError}
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={retry} className="mt-3">
          {t.billing.plansRoute.tryAgain}
        </Button>
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
      <div className="flex flex-wrap items-center justify-between gap-4">
        {!preserveProject && (
          <div>
            <h2 className="text-base font-medium text-foreground">
              {subscription && subscription.status !== "canceled" ? t.billing.workspaces.changePlan : t.billing.onboarding.compareTitle}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {subscription && subscription.status !== "canceled" ? t.billing.plansRoute.currentServerPlans
                : workspaceScoped ? t.billing.workspaces.description : t.billing.onboarding.compareDescription}
            </p>
          </div>
        )}
        {payload.custom && (
          <div role="group" aria-label={t.billing.custom.configuration} className="inline-flex gap-1 rounded-xl bg-muted/40 p-1">
            {(["plans", "custom"] as const).map(value => (
              <Button
                key={value} type="button" size="sm" variant={configuration === value ? "secondary" : "ghost"}
                aria-pressed={configuration === value} disabled={subscribing !== null}
                onClick={() => setConfiguration(value)}
              >
                {value === "plans" ? t.billing.custom.presets : t.billing.custom.name}
              </Button>
            ))}
          </div>
        )}
        {configuration === "plans" && payload.annual.enabled && (
          <div
            className="inline-flex gap-1 rounded-xl bg-muted/40 p-1"
            role="group"
            aria-label={t.billing.pricing.billingInterval}
          >
            {(["monthly", "annual"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                aria-pressed={interval === value}
                onClick={() => setInterval(value)}
                disabled={subscribing !== null}
                variant={interval === value ? "secondary" : "ghost"}
              >
                {value === "monthly" ? t.billing.pricing.monthly : t.billing.pricing.annual}
              </Button>
            ))}
          </div>
        )}
      </div>
      {checkoutUrl && (
        <div role="status" className="rounded-xl bg-muted/40 p-3 text-sm">
          <p>{t.billing.deployGate.checkoutOpened}</p>
          <a
            href={checkoutUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex font-medium text-primary hover:underline"
          >
            {t.billing.deployGate.continueCheckout}
          </a>
        </div>
      )}
      {checkoutError && (
        <p role="alert" className="text-sm text-danger">
          {checkoutError}
        </p>
      )}
      {!canPurchase && (
        <p className="text-sm text-muted-foreground">
          {complimentary
            ? t.billing.complimentary.changeViaSupport
            : billingEnabled
              ? t.billing.plansRoute.changeViaSupport
              : t.billing.plansRoute.billingUnavailable}{" "}
          <a href="mailto:support@openship.io" className="text-primary hover:underline">
            {t.billing.portal.supportButton}
          </a>
        </p>
      )}
      {configuration === "custom" && payload.custom ? (
        <CustomPlanConfigurator
          catalog={payload.custom} plans={purchasable} ui={payload.ui}
          currentOffer={currentOffer} subscription={subscription}
          allocatedDiskGb={allocatedDiskGb}
          disabled={!canPurchase} busy={subscribing !== null}
          quoteRevision={quoteRevision}
          onSelect={quote => void startCheckout(quote.basePlanTierId, "monthly", {
            resources: quote.resources, quoteReference: quote.reference,
          })}
        />
      ) : (
        <PricingCards
          plans={purchasable}
          ui={payload.ui}
          currentPlan={selectedCurrentPlan}
          onSelectPlan={handleSelectPlan}
          subscribingPlan={subscribing}
          purchasesDisabled={!canPurchase}
          interval={interval}
          workspaceScoped={workspaceScoped}
        />
      )}
    </div>
  );
}
