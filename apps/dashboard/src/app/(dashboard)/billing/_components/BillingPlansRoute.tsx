"use client";

import { useEffect, useState } from "react";
import { PricingCards, type ApiPlan } from "@/components/billing/PricingCards";
import { api } from "@/lib/api/client";
import type { PlanId } from "@repo/core";
import { Loader2 } from "lucide-react";

interface PlansResponse {
  data: {
    plans: ApiPlan[];
    annualDiscount: number;
  };
}

interface CheckoutResponse {
  data: { checkoutUrl: string };
}

export function BillingPlansRoute({ currentPlan }: { currentPlan: PlanId }) {
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [annualDiscount, setAnnualDiscount] = useState(0.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchPlans() {
      try {
        const res = await api.get<PlansResponse>("billing/plans");
        if (!cancelled) {
          setPlans(res.data.plans);
          setAnnualDiscount(res.data.annualDiscount);
        }
      } catch {
        if (!cancelled) setError("Failed to load plans");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPlans();
    return () => { cancelled = true; };
  }, []);

  const handleSelectPlan = async (planId: PlanId, interval: "monthly" | "annual") => {
    if (planId === "free" || planId === currentPlan) return;
    setSubscribing(planId);
    try {
      const res = await api.post<CheckoutResponse>("billing/subscription", {
        planId,
        interval,
      });
      window.location.href = res.data.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start checkout");
      setSubscribing(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !plans) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">{error || "Something went wrong"}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 text-sm font-medium text-primary hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <PricingCards
      plans={plans}
      annualDiscount={annualDiscount}
      currentPlan={currentPlan}
      onSelectPlan={handleSelectPlan}
      subscribingPlan={subscribing}
    />
  );
}