"use client";

import type { ReactNode } from "react";
import { Icon as UiIcon } from "@repo/ui/icons";
import { BillingLink as Link } from "@/components/billing/BillingWorkspaceContext";
import { PendingCheckoutsPanel } from "@/components/billing/CheckoutRecovery";
import { PLANS } from "@repo/core";
import type { BillingState } from "@/lib/api/billing";
import { isNewCloudCustomer, needsCloudPlan } from "@/lib/billing-presentation";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CloudPlanOffer } from "@/components/billing/CloudPlanOffer";
import { PlanIcon } from "@/components/billing/PlanIcon";
import { PlanCapacity } from "@/components/billing/PlanResources";
import { BillingEmptyState } from "@/components/billing/BillingEmptyState";
import { BillingSubscriptionControls } from "@/components/billing/BillingSubscriptionControls";
import { OpenStripePortalButton } from "./OpenStripePortalButton";

export type { BillingState };

/** Keep subscription actions together; resource details live in the main panel. */
export function BillingSidebar({
  state,
  showSubscriptionControls = false,
  showPlanAction = true,
}: {
  state: BillingState;
  showSubscriptionControls?: boolean;
  showPlanAction?: boolean;
}) {
  const controls = showSubscriptionControls && state.subscription && (
    <BillingSubscriptionControls state={state} />
  );
  if (isNewCloudCustomer(state)) {
    return (
      <div className="space-y-4">
        <CloudPlanOffer state={state} />
        {controls}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <BillingPlanSummary state={state} showPlanAction={showPlanAction} />
      {controls}
    </div>
  );
}

/** The saved subscription appears in both the billing sidebar and Plans. */
export function BillingPlanSummary({
  state,
  compact = false,
  showPlanAction = false,
  notice,
}: {
  state: BillingState;
  compact?: boolean;
  showPlanAction?: boolean;
  notice?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const hasPlan = !needsCloudPlan(state);
  const plan = state.plan;
  const interval = state.subscription?.interval ?? "monthly";
  const price = plan?.price[interval];
  const status = state.compute?.billingMode === "monthly"
    ? state.compute.covered ? t.billing.compute.covered : t.billing.compute.needsAttention
    : hasPlan
    ? ((t.billing.sidebar.statuses as Record<string, string>)[state.status] ??
      state.status.replace(/_/g, " "))
    : t.billing.sidebar.statusInactive;
  const healthy = state.compute ? state.compute.covered : hasPlan && (state.status === "active" || state.status === "trialing");
  const complimentary = state.complimentary;
  const renewal = state.subscription?.currentPeriod.end ?? state.currentPeriod?.end;
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));

  if (compact && !hasPlan)
    return (
      <div
        role="status"
        className="inline-flex max-w-full items-center gap-2.5 rounded-xl bg-card px-3 py-2 text-sm"
      >
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full border-2 border-warning"
        />
        <p className="text-muted-foreground">{t.billing.sidebar.inactiveServer}</p>
      </div>
    );

  return (
    <section
      className={`rounded-2xl bg-card ${compact ? "flex flex-wrap items-center justify-between gap-x-6 gap-y-3 p-4" : "space-y-4 p-5"}`}
      aria-label={t.billing.pricing.currentPlan}
    >
      <div className={compact ? "min-w-0" : "space-y-4"}>
        <div
          className={`flex flex-wrap items-center gap-2 ${compact ? "mb-1" : "justify-between"}`}
        >
          <p className="text-xs font-medium text-muted-foreground">
            {state.workspace ? t.billing.workspaces.plan : t.billing.pricing.currentPlan}
          </p>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${healthy ? "bg-success-bg text-success" : "bg-warning-bg text-warning"}`}
          >
            {status}
          </span>
        </div>
        <div>
          <div className="flex items-center gap-3">
            <span
              className={`flex shrink-0 items-center justify-center rounded-xl bg-muted/60 text-foreground/80 ${compact ? "size-8" : "size-10"}`}
            >
              {hasPlan ? (
                <PlanIcon planId={state.subscription?.tier ?? state.tier} />
              ) : (
                <UiIcon name="server" className="size-4" />
              )}
            </span>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {hasPlan
                ? (plan?.name ?? PLANS[state.subscription?.tier ?? state.tier].name)
                : t.billing.sidebar.noActivePlan}
            </h2>
          </div>
        </div>
      </div>
      <div className={compact ? "min-w-0" : ""}>
        {!hasPlan ? (
          <p className="text-sm text-muted-foreground">{t.billing.sidebar.inactiveServer}</p>
        ) : complimentary ? (
          <div className="mt-2 space-y-1">
            <p className="text-sm text-foreground">{t.billing.complimentary.label}</p>
            <p className="text-xs text-muted-foreground">
              {complimentary.expiresAt
                ? interpolate(t.billing.complimentary.expiresOn, {
                    date: formatDate(complimentary.expiresAt),
                  })
                : t.billing.complimentary.untilRevoked}
            </p>
            {renewal &&
              (!complimentary.expiresAt ||
                new Date(renewal) < new Date(complimentary.expiresAt)) && (
                <p className="text-xs text-muted-foreground">
                  {interpolate(t.billing.complimentary.creditsRenewOn, {
                    date: formatDate(renewal),
                  })}
                </p>
              )}
          </div>
        ) : (
          price != null && (
            <div className={compact ? "flex flex-wrap items-baseline gap-2" : "mt-2"}>
              <p
                className={`${compact ? "text-lg" : "text-2xl"} font-medium tracking-tight tabular-nums text-foreground`}
              >
                {new Intl.NumberFormat(locale, {
                  style: "currency",
                  currency: "USD",
                  minimumFractionDigits: price % 100 === 0 ? 0 : 2,
                }).format(price / 100)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {interval === "annual"
                  ? t.billing.pricing.billedAnnually
                  : t.billing.subscription.billedMonthly}
              </p>
            </div>
          )
        )}
        {hasPlan && !complimentary && renewal && (
          <p className={`text-muted-foreground ${compact ? "mt-1 text-xs" : "mt-4 text-sm"}`}>
            {interpolate(
              state.subscription?.cancelAtPeriodEnd
                ? t.billing.sidebar.accessUntil
                : t.billing.sidebar.renewsOn,
              { date: formatDate(renewal) },
            )}
          </p>
        )}
      </div>
      {hasPlan && plan && (
        <PlanCapacity plan={plan} workspaceScoped={Boolean(state.workspace)} compact={compact} />
      )}
      {notice && <div className={compact ? "basis-full" : undefined}>{notice}</div>}
      {showPlanAction && (
        <Button asChild variant="secondary" className="w-full">
          <Link href="/billing/plans">
            {!hasPlan
              ? t.billing.onboarding.choosePlan
              : complimentary
                ? t.billing.onboarding.compare
                : t.billing.workspaces.changePlan}
            <UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" aria-hidden="true" />
          </Link>
        </Button>
      )}
    </section>
  );
}

type PortalPanelProps = { portalAvailable?: boolean; hasHistory?: boolean };

export function BillingPaymentsPanel({
  portalAvailable = false,
  hasHistory = true,
}: PortalPanelProps) {
  const { t } = useI18n();
  const copy = t.billing.paymentPanel;
  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-card p-5">
        <PendingCheckoutsPanel />
      </section>
      {hasHistory ? (
        <section className="rounded-2xl bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
              <UiIcon name="credit-card" className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-medium text-foreground">{copy.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
            </div>
          </div>
          <div className="mt-5">
            <OpenStripePortalButton enabled={portalAvailable} label={copy.openStripe} />
          </div>
        </section>
      ) : <BillingEmptyState kind="payment" />}
    </div>
  );
}
