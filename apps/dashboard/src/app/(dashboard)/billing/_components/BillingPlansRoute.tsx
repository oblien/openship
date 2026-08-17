"use client";

import { useEffect, useState } from "react";
import {
  PricingCards,
  type ApiPlan,
  type ApiPricingUi,
} from "@/components/billing/PricingCards";
import { api } from "@/lib/api/client";
import { endpoints } from "@/lib/api/endpoints";
import type { PlanTierId } from "@repo/core";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

interface PlansPayload {
  locale: string;
  annual: { enabled: boolean; monthsFree: number };
  ui: ApiPricingUi;
  plans: ApiPlan[];
}

interface PlansResponse {
  data: PlansPayload;
}

interface CheckoutResponse {
  data: { checkoutUrl: string };
}

export function BillingPlansRoute({ currentPlan }: { currentPlan: PlanTierId }) {
  const { t, locale } = useI18n();
  const [payload, setPayload] = useState<PlansPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchPlans() {
      try {
        // Plan copy is localized SERVER-side from the pricing catalog, so the
        // reader's locale (a cookie the browser never sends as a language
        // header) has to travel on the query string.
        const res = await api.get<PlansResponse>(
          `${endpoints.billing.plans}?locale=${encodeURIComponent(locale)}`,
        );
        if (!cancelled) setPayload(res.data);
      } catch {
        if (!cancelled) setError(t.billing.plansRoute.loadError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPlans();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const handleSelectPlan = async (planTierId: PlanTierId) => {
    if (planTierId === "free" || planTierId === currentPlan) return;
    setSubscribing(planTierId);
    try {
      // Body key MUST be `planTierId` — the backend `createSubscriptionSchema`
      // validates that exact field (the old `planId` silently 400'd).
      const res = await api.post<CheckoutResponse>("billing/subscription", {
        planTierId,
        interval: "monthly",
      });
      window.location.href = res.data.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.billing.plansRoute.checkoutError);
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

  if (error || !payload) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">{error || t.billing.plansRoute.genericError}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 text-sm font-medium text-primary hover:underline"
        >
          {t.billing.plansRoute.tryAgain}
        </button>
      </div>
    );
  }

  return (
    <PricingCards
      plans={payload.plans}
      ui={payload.ui}
      currentPlan={currentPlan}
      onSelectPlan={handleSelectPlan}
      subscribingPlan={subscribing}
    />
  );
}
