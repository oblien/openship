"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { BillingLink as Link } from "@/components/billing/BillingWorkspaceContext";
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
  const { t, locale } = useI18n();
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
  const hasPlan = !needsCloudPlan(state);
  const plan = state.plan;
  const interval = state.subscription?.interval ?? "monthly";
  const price = plan?.price[interval];
  const status =
    (t.billing.sidebar.statuses as Record<string, string>)[state.status] ??
    state.status.replace(/_/g, " ");
  const healthy = state.status === "active" || state.status === "trialing";
  const complimentary = state.complimentary;
  const renewal = state.subscription?.currentPeriod.end ?? state.currentPeriod?.end;
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));

  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-2xl bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
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
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-foreground/80">
              <PlanIcon planId={state.subscription?.tier ?? state.tier} />
            </span>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {hasPlan ? plan?.name ?? PLANS[state.subscription?.tier ?? state.tier].name : t.billing.sidebar.noActivePlan}
            </h2>
          </div>
          {!hasPlan ? (
            <p className="mt-2 text-sm text-muted-foreground">{t.billing.sidebar.inactiveServer}</p>
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
              <div className="mt-2">
                <p className="text-2xl font-medium tracking-tight tabular-nums text-foreground">
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
        </div>
        {hasPlan && !complimentary && renewal && (
          <p className="text-sm text-muted-foreground">
            {interpolate(state.subscription?.cancelAtPeriodEnd ? t.billing.sidebar.accessUntil : t.billing.sidebar.renewsOn, { date: formatDate(renewal) })}
          </p>
        )}
        {hasPlan && plan && <PlanCapacity plan={plan} workspaceScoped={Boolean(state.workspace)} />}
        {showPlanAction && <Button asChild variant="secondary" className="w-full">
          <Link href="/billing/plans">
            {!hasPlan ? t.billing.onboarding.choosePlan : complimentary ? t.billing.onboarding.compare : t.billing.workspaces.changePlan}
            <UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" aria-hidden="true" />
          </Link>
        </Button>}
      </section>
      {controls}
    </div>
  );
}

type PortalPanelProps = { portalAvailable?: boolean; hasHistory?: boolean };

function BillingPortalPanel({
  kind,
  portalAvailable = false,
  hasHistory = true,
}: PortalPanelProps & { kind: "payment" | "invoices" }) {
  const { t } = useI18n();
  if (!hasHistory) return <BillingEmptyState kind={kind} />;
  const copy = kind === "payment" ? t.billing.paymentPanel : t.billing.invoicesPanel;
  return (
    <section className="rounded-2xl bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
          <UiIcon
            name={kind === "payment" ? "credit-card" : "receipt"}
            className="size-5"
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-medium text-foreground">{copy.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
        </div>
      </div>
      <div className="mt-5">
        <OpenStripePortalButton enabled={portalAvailable} />
      </div>
    </section>
  );
}

export function PaymentMethodPanel(props: PortalPanelProps) {
  return <BillingPortalPanel kind="payment" {...props} />;
}

export function InvoicesPanel(props: PortalPanelProps) {
  return <BillingPortalPanel kind="invoices" {...props} />;
}
