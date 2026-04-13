"use client";

import React, { useState } from "react";
import {
  Check,
  Sparkles,
  ArrowRight,
  Zap,
  Building2,
  Loader2,
  Crown,
} from "lucide-react";
import type { PlanId } from "@repo/core";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface ApiPlan {
  id: PlanId;
  name: string;
  description: string;
  popular: boolean;
  monthlyPrice: number;
  annualPrice: number;
  limits: {
    projects: number;
    deploymentsPerMonth: number;
    customDomains: number;
    teamMembers: number;
    buildMinutes: number;
    bandwidth: number;
  };
  support: string;
  features: string[];
}

interface PricingCardsProps {
  plans: ApiPlan[];
  annualDiscount: number;
  currentPlan?: PlanId;
  onSelectPlan?: (planId: PlanId, interval: "monthly" | "annual") => void;
  subscribingPlan?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Plan visual config                                                */
/* ------------------------------------------------------------------ */

const PLAN_ICON: Record<string, React.ReactNode> = {
  free: <Zap className="size-5" />,
  pro: <Crown className="size-5" />,
  team: <Building2 className="size-5" />,
};

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export const PricingCards: React.FC<PricingCardsProps> = ({
  plans,
  annualDiscount,
  currentPlan = "free",
  onSelectPlan,
  subscribingPlan,
}) => {
  const [interval, setInterval] = useState<"monthly" | "annual">("annual");

  const getPrice = (plan: ApiPlan) => {
    return interval === "annual" ? plan.annualPrice : plan.monthlyPrice;
  };

  const savePercent = Math.round(annualDiscount * 100);

  return (
    <div className="space-y-10">
      {/* ── Interval toggle ────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-3">
        <div className="relative inline-flex items-center rounded-full border border-border/40 bg-muted/30 p-1">
          <button
            onClick={() => setInterval("monthly")}
            className={`relative z-10 rounded-full px-5 py-2 text-sm font-medium transition-all duration-200 ${
              interval === "monthly"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground/80"
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setInterval("annual")}
            className={`relative z-10 rounded-full px-5 py-2 text-sm font-medium transition-all duration-200 ${
              interval === "annual"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground/80"
            }`}
          >
            Annual
          </button>
        </div>
        <p
          className={`text-sm text-muted-foreground transition-all duration-200 ${
            interval === "annual"
              ? "translate-y-0 opacity-100"
              : "pointer-events-none -translate-y-1 opacity-0"
          }`}
        >
          Save {savePercent}% with annual billing
        </p>
      </div>

      {/* ── Cards grid ─────────────────────────────────────────── */}
      <div className="grid gap-5 md:grid-cols-3">
        {plans.map((plan) => {
          const price = getPrice(plan);
          const isCurrent = currentPlan === plan.id;
          const isPopular = plan.popular;
          const isSubscribing = subscribingPlan === plan.id;
          const icon = PLAN_ICON[plan.id] ?? <Sparkles className="size-5" />;

          return (
            <div
              key={plan.id}
              className={`group relative flex flex-col rounded-2xl transition-all duration-200 ${
                isPopular ? "md:-mt-3 md:mb-[-12px]" : ""
              }`}
            >
              {/* Subtle highlight border for popular plan */}
              {isPopular && (
                <div className="pointer-events-none absolute -inset-[1px] rounded-2xl bg-primary/20" />
              )}

              {/* Card body */}
              <div
                className={`relative flex h-full flex-col rounded-2xl border bg-card ${
                  isPopular
                    ? "border-primary/30 shadow-sm"
                    : "border-border/50 hover:border-border hover:shadow-sm"
                } transition-all duration-200`}
              >
                {/* Popular badge */}
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                      Most Popular
                    </span>
                  </div>
                )}

                <div className="flex flex-1 flex-col p-7">
                  {/* Header */}
                  <div className={isPopular ? "mt-2" : ""}>
                    <div className="mb-3 flex items-center gap-3">
                      <div
                        className={`flex size-10 items-center justify-center rounded-xl ${
                          isPopular
                            ? "bg-primary/10 text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {icon}
                      </div>
                      <h3 className="text-base font-semibold text-foreground">
                        {plan.name}
                      </h3>
                    </div>
                    <p className="text-[13px] leading-relaxed text-muted-foreground">
                      {plan.description}
                    </p>
                  </div>

                  {/* Price */}
                  <div className="mt-6 mb-6">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-4xl font-bold tracking-tight text-foreground">
                        ${price}
                      </span>
                      {plan.monthlyPrice > 0 && (
                        <span className="text-sm text-muted-foreground">
                          /mo
                        </span>
                      )}
                    </div>
                    {plan.monthlyPrice > 0 && interval === "annual" ? (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-muted-foreground line-through">
                          ${plan.monthlyPrice}/mo
                        </span>
                        <span className="text-xs font-medium text-foreground">
                          -{savePercent}%
                        </span>
                      </div>
                    ) : plan.monthlyPrice === 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Free forever
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Billed monthly
                      </p>
                    )}
                  </div>

                  {/* CTA */}
                  <div className="mb-7">
                    {isCurrent ? (
                      <div className="flex w-full items-center justify-center rounded-xl border border-border/50 bg-muted/40 px-4 py-2.5 text-sm font-medium text-muted-foreground">
                        Current Plan
                      </div>
                    ) : isPopular ? (
                      <button
                        onClick={() => onSelectPlan?.(plan.id, interval)}
                        disabled={!!subscribingPlan}
                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                      >
                        {isSubscribing ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <>
                            Upgrade to {plan.name}
                            <ArrowRight className="size-3.5" />
                          </>
                        )}
                      </button>
                    ) : plan.monthlyPrice === 0 ? (
                      <div className="flex w-full items-center justify-center rounded-xl border border-border/50 bg-muted/40 px-4 py-2.5 text-sm font-medium text-muted-foreground">
                        Free Tier
                      </div>
                    ) : (
                      <button
                        onClick={() => onSelectPlan?.(plan.id, interval)}
                        disabled={!!subscribingPlan}
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-border/50 bg-card px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60 disabled:opacity-60"
                      >
                        {isSubscribing ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <>
                            Upgrade to {plan.name}
                            <ArrowRight className="size-3.5" />
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Divider */}
                  <div className="mb-5 border-t border-border/30" />

                  {/* Features */}
                  <div className="flex-1">
                    <p className="mb-4 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                      What&apos;s included
                    </p>
                    <ul className="space-y-3">
                      {plan.features.map((feature) => (
                        <li
                          key={feature}
                          className="flex items-start gap-3 text-[13px] text-foreground/80"
                        >
                          <Check
                            className={`mt-0.5 size-3.5 shrink-0 ${
                              isPopular ? "text-primary" : "text-muted-foreground"
                            }`}
                            strokeWidth={2.5}
                          />
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
