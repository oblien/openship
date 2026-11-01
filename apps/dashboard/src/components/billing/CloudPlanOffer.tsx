"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { BillingLink as Link } from "@/components/billing/BillingWorkspaceContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import type { BillingState } from "@/lib/api/billing";
import { PlanIcon } from "./PlanIcon";
import { PlanCapacity } from "./PlanResources";
import { useCloudCheckout, useCloudPlans } from "./useCloudBilling";
import { isNewCloudCustomer } from "@/lib/billing-presentation";
import { CloudCheckoutFeedback } from "./CloudCheckoutFeedback";
import { CheckoutRecoveryDialog } from "./CheckoutRecovery";

/** A compact starting offer; the plans tab holds the full comparison. */
export function CloudPlanOffer({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const copy = t.billing.onboarding;
  const workspaceScoped = Boolean(state.workspace) || isNewCloudCustomer(state);
  const { payload, loading, error, retry } = useCloudPlans();
  const enabled =
    state.billing?.enabled === true &&
    (state.tier === "free" || state.capabilities?.subscriptionChange === true);
  const checkout = useCloudCheckout({ enabled });
  const plan =
    !loading && !error
      ? payload?.plans
          .filter(
            (item) =>
              item.id !== "free" &&
              item.id !== "enterprise" &&
              item.price.monthly != null &&
              item.price.monthly > 0,
          )
          .sort((a, b) => a.price.monthly! - b.price.monthly!)[0]
      : undefined;
  const price = plan?.price.monthly;
  const money =
    price == null
      ? null
      : new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
          minimumFractionDigits: price % 100 === 0 ? 0 : 2,
        }).format(price / 100);

  return (
    <section
      className="space-y-4 rounded-2xl bg-card p-5"
      aria-label={copy.offerTitle}
      aria-busy={loading}
    >
      <p className="text-xs font-medium text-muted-foreground">{copy.offerLabel}</p>
      <div>
        <div className="flex items-center gap-3">
          {plan && (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-foreground/80">
              <PlanIcon planId={plan.id} />
            </span>
          )}
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            {plan ? interpolate(copy.startingWith, { name: plan.name }) : copy.offerTitle}
          </h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{workspaceScoped ? t.billing.workspaces.description : copy.offerDescription}</p>
      </div>
      {loading ? (
        <div role="status" aria-label={t.billing.usage.breakdown.loading} className="space-y-3">
          <div className="h-8 w-24 animate-pulse rounded-lg bg-muted" />
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
          <div className="h-10 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : plan ? (
        <>
          <p className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-2xl font-medium tracking-tight text-foreground">{money}</span>
            <span className="text-sm text-muted-foreground">{payload?.ui.perMonth}</span>
          </p>
          <PlanCapacity plan={plan} workspaceScoped={workspaceScoped} />
          <div className="space-y-2">
            <Button
              type="button"
              disabled={!enabled || checkout.subscribing !== null}
              onClick={() => void checkout.startCheckout(plan.id, "monthly")}
              className="w-full"
            >
              {checkout.subscribing && (
                <UiIcon name="spinner" className="size-4 animate-spin" aria-hidden="true" />
              )}
              {interpolate(copy.subscribe, { name: plan.name })}
            </Button>
            {!enabled && (
              <p className="text-xs text-muted-foreground">
                {state.billing?.enabled
                  ? t.billing.plansRoute.changeViaSupport
                  : t.billing.plansRoute.billingUnavailable}
              </p>
            )}
            {checkout.error && (
              <p role="alert" className="text-sm text-danger">
                {checkout.error}
              </p>
            )}
          </div>
        </>
      ) : error ? (
        <div role="alert" className="space-y-2 text-sm text-muted-foreground">
          <p>{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={retry}>
            {t.billing.plansRoute.tryAgain}
          </Button>
        </div>
      ) : null}
      <Button asChild variant="secondary" className="w-full">
        <Link href="/billing/plans">
          {copy.compare}
          <UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" aria-hidden="true" />
        </Link>
      </Button>
      <CloudCheckoutFeedback failure={checkout.unavailable} plans={payload?.plans} onClose={checkout.dismissUnavailable}
        onRetry={failure => void checkout.startCheckout(failure.planTierId, failure.interval, failure.custom)} />
      <CheckoutRecoveryDialog {...checkout.recovery} />
    </section>
  );
}
