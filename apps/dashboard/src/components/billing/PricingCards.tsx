"use client";

import React from "react";
import {
  ArrowRight,
  Building2,
  Check,
  Crown,
  Loader2,
  Sparkles,
  Zap,
} from "lucide-react";
import type { PlanTierId } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";

/* ------------------------------------------------------------------ */
/*  Types — mirror the shape returned by GET /api/billing/plans       */
/* ------------------------------------------------------------------ */

export interface ApiPlan {
  id: PlanTierId;
  name: string;
  description: string;
  popular: boolean;
  /** Both fields are cents OR null. Null = "contact sales" / no Stripe price. */
  price: { monthly: number | null; annual: number | null };
  monthlyCredits: number | null;
  features: string[];
  support: string;
  contactSales?: string | null;
}

interface PricingCardsProps {
  plans: ApiPlan[];
  currentPlan?: PlanTierId;
  onSelectPlan?: (planId: PlanTierId) => void;
  subscribingPlan?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const PLAN_ICON: Record<string, React.ReactNode> = {
  free: <Zap className="size-5" />,
  pro: <Crown className="size-5" />,
  team: <Building2 className="size-5" />,
  enterprise: <Sparkles className="size-5" />,
};

function formatPrice(cents: number | null): { dollars: string | null; suffix: string | null } {
  // `dollars: null` signals the "contact sales" tier, so the component can
  // render the localized "Custom" label in place of a price.
  if (cents === null) return { dollars: null, suffix: null };
  if (cents === 0) return { dollars: "$0", suffix: null };
  const dollars = Math.round(cents / 100);
  return { dollars: `$${dollars}`, suffix: "/mo" };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const PricingCards: React.FC<PricingCardsProps> = ({
  plans,
  currentPlan = "free",
  onSelectPlan,
  subscribingPlan,
}) => {
  const { t } = useI18n();
  return (
    <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
      {plans.map((plan) => {
        const { dollars, suffix } = formatPrice(plan.price.monthly);
        const isCurrent = currentPlan === plan.id;
        const isPopular = plan.popular;
        const isEnterprise = plan.id === "enterprise";
        // Paid tier with no finalized price → "coming soon" (not enterprise,
        // which is genuinely "contact sales"). Free stays $0.
        const isComingSoon = plan.price.monthly === null && !isEnterprise;
        const isSubscribing = subscribingPlan === plan.id;
        const icon = PLAN_ICON[plan.id] ?? <Sparkles className="size-5" />;

        return (
          <div
            key={plan.id}
            className={`relative flex flex-col rounded-2xl border bg-card p-6 transition-colors ${
              isPopular
                ? "border-primary/50 shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
                : "border-border/50 hover:border-border"
            }`}
          >
            {isPopular && (
              <span className="absolute -top-2.5 start-6 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary-foreground">
                {t.billing.pricing.mostPopular}
              </span>
            )}

            {/* Header */}
            <div className="mb-5 flex items-center gap-2.5">
              <div
                className={`flex size-9 items-center justify-center rounded-lg ${
                  isPopular
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {icon}
              </div>
              <h3 className="text-base font-semibold text-foreground">{plan.name}</h3>
            </div>

            {/* Price */}
            <div className="mb-1 flex items-baseline gap-1">
              <span className={`font-bold tracking-tight tabular-nums text-foreground ${isComingSoon ? "text-2xl" : "text-4xl"}`}>
                {isComingSoon ? t.billing.pricing.comingSoon : (dollars ?? t.billing.pricing.custom)}
              </span>
              {suffix && !isComingSoon && (
                <span className="text-sm font-medium text-muted-foreground">
                  {suffix}
                </span>
              )}
            </div>
            <p className="mb-6 min-h-[2.5rem] text-[13px] leading-snug text-muted-foreground">
              {plan.description}
            </p>

            {/* CTA */}
            <div className="mb-5">
              {isCurrent ? (
                <div className="flex h-10 w-full items-center justify-center rounded-lg border border-border/50 bg-muted/40 text-sm font-medium text-muted-foreground">
                  {t.billing.pricing.currentPlan}
                </div>
              ) : isEnterprise ? (
                <a
                  href={plan.contactSales ?? "mailto:sales@openship.io"}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border/50 bg-card text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
                >
                  {t.billing.pricing.contactSales}
                  <ArrowRight className="size-3.5 rtl:rotate-180" />
                </a>
              ) : isComingSoon ? (
                <div className="flex h-10 w-full items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/20 text-sm font-medium text-muted-foreground">
                  {t.billing.pricing.comingSoon}
                </div>
              ) : plan.price.monthly === 0 ? (
                <div className="flex h-10 w-full items-center justify-center rounded-lg border border-border/50 bg-muted/40 text-sm font-medium text-muted-foreground">
                  {t.billing.pricing.freeForever}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelectPlan?.(plan.id)}
                  disabled={!!subscribingPlan}
                  className={`flex h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60 ${
                    isPopular
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "border border-border/50 bg-card text-foreground hover:bg-muted/60"
                  }`}
                >
                  {isSubscribing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      {t.billing.pricing.upgrade}
                      <ArrowRight className="size-3.5 rtl:rotate-180" />
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Features */}
            <ul className="space-y-2.5 border-t border-border/30 pt-5">
              {plan.features.map((feature) => (
                <li
                  key={feature}
                  className="flex items-start gap-2 text-[13px] text-foreground/80"
                >
                  <Check
                    className={`mt-0.5 size-3.5 shrink-0 ${
                      isPopular ? "text-primary" : "text-muted-foreground"
                    }`}
                    strokeWidth={2.5}
                  />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
};
