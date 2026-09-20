"use client";

import Link from "next/link";
import { ArrowRight, BarChart3, Check, Coins, CreditCard, Crown, LayoutDashboard, Receipt } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PLANS } from "@repo/core";
import type { BillingState } from "@/lib/api/billing";
import { needsCloudPlan } from "@/lib/billing-presentation";
import { useI18n } from "@/components/i18n-provider";
import { CloudPlanOffer } from "@/components/billing/CloudPlanOffer";
import { PlanResources } from "@/components/billing/PlanResources";
import { BillingEmptyState } from "@/components/billing/BillingEmptyState";
import { OpenStripePortalButton } from "./OpenStripePortalButton";

export type { BillingState };
export type BillingTab = "overview" | "usage" | "plans" | "topups" | "payment" | "invoices";

export const BILLING_TABS: Array<{ key: BillingTab; label: string; href: string; icon: LucideIcon }> = [
  { key: "overview", label: "Overview", href: "/billing/overview", icon: LayoutDashboard },
  { key: "usage", label: "Usage", href: "/billing/usage", icon: BarChart3 },
  { key: "plans", label: "Plans", href: "/billing/plans", icon: Crown },
  { key: "topups", label: "Top-ups", href: "/billing/topups", icon: Coins },
  { key: "payment", label: "Payment Method", href: "/billing/payment", icon: CreditCard },
  { key: "invoices", label: "Invoices", href: "/billing/invoices", icon: Receipt },
];

/** A subscription offer before purchase; a single plan summary after purchase. */
export function BillingSidebar({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  if (needsCloudPlan(state)) return <CloudPlanOffer state={state} />;
  const plan = state.plan;
  const interval = state.subscription?.interval ?? "monthly";
  const price = plan?.price[interval];
  const status = (t.billing.sidebar.statuses as Record<string, string>)[state.status] ?? state.status.replace(/_/g, " ");
  const healthy = state.status === "active" || state.status === "trialing";

  return <section className="rounded-2xl bg-card p-5 sm:p-6">
    <div className="mb-3 flex items-center justify-between gap-3">
      <p className="text-xs font-medium text-muted-foreground">{t.billing.pricing.currentPlan}</p>
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${healthy ? "bg-success-bg text-success" : "bg-warning-bg text-warning"}`}>{status}</span>
    </div>
    <h2 className="text-xl font-semibold tracking-tight text-foreground">{plan?.name ?? PLANS[state.tier].name}</h2>
    {price != null && <div className="mb-5 mt-2">
      <p className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
        {new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: price % 100 === 0 ? 0 : 2 }).format(price / 100)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{interval === "annual" ? t.billing.pricing.billedAnnually : t.billing.subscription.billedMonthly}</p>
    </div>}
    {plan && <>
      <p className="mt-5 text-sm font-medium text-foreground">{t.billing.sidebar.includedTitle}</p>
      <PlanResources plan={plan} interval={interval} />
      {plan.inheritedFrom && <p className="mb-3 text-xs text-muted-foreground">{plan.inheritedFrom}</p>}
      {plan.features.length > 0 && <details className="mb-4 border-t border-border/40 pt-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t.billing.resourcesGuide.moreFeatures}</summary>
        <ul className="mt-3 space-y-2.5">
        {plan.features.map((feature) => <li key={feature} className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
          <Check className="mt-1 size-3.5 shrink-0 text-primary" aria-hidden="true" /><span>{feature}</span>
        </li>)}
        </ul>
      </details>}
    </>}
    <Link href="/billing/plans" className="mt-4 flex min-h-10 items-center justify-center gap-2 rounded-xl border border-border/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/40">
      {t.billing.onboarding.compare}<ArrowRight className="size-3.5 rtl:rotate-180" aria-hidden="true" />
    </Link>
  </section>;
}

export function PaymentMethodPanel({ portalAvailable = false, hasHistory = true }: { portalAvailable?: boolean; hasHistory?: boolean }) {
  const { t } = useI18n();
  if (!hasHistory) return <BillingEmptyState kind="payment" />;
  return <section className="rounded-2xl bg-card p-5 sm:p-6">
    <h2 className="text-base font-semibold text-foreground">{t.billing.paymentPanel.title}</h2>
    <p className="mb-5 mt-1 text-sm text-muted-foreground">{t.billing.paymentPanel.description}</p>
    <OpenStripePortalButton enabled={portalAvailable} />
  </section>;
}

export function InvoicesPanel({ portalAvailable = false, hasHistory = true }: { portalAvailable?: boolean; hasHistory?: boolean }) {
  const { t } = useI18n();
  if (!hasHistory) return <BillingEmptyState kind="invoices" />;
  return <section className="rounded-2xl bg-card p-5 sm:p-6">
    <h2 className="text-base font-semibold text-foreground">{t.billing.invoicesPanel.title}</h2>
    <p className="mb-5 mt-1 text-sm text-muted-foreground">{t.billing.invoicesPanel.description}</p>
    <OpenStripePortalButton enabled={portalAvailable} />
  </section>;
}
