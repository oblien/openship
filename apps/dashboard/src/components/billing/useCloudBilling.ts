"use client";

import { useBillingWorkspace } from "./BillingWorkspaceContext";
import { useEffect, useRef, useState } from "react";
import type { PlanTierId } from "@repo/core";
import type { BillingPlans, CustomSubscriptionSelection } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { api, ApiError, getApiErrorMessage } from "@/lib/api/client";
import { endpoints } from "@/lib/api/endpoints";
import { randomUUID } from "@/lib/random-uuid";
import { trackCloudEvent } from "@/lib/cloud-analytics";
import type { ApiPlan, ApiPricingUi } from "./PricingCards";

interface PlansPayload {
  custom: BillingPlans["custom"];
  locale: string;
  annual: { enabled: boolean; monthsFree: number };
  ui: ApiPricingUi;
  plans: ApiPlan[];
}

/** Both the recommendation and comparison use the same live checkout catalog. */
export function useCloudPlans() {
  const { t, locale } = useI18n();
  const [payload, setPayload] = useState<PlansPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get<{ data: PlansPayload }>(`${endpoints.billing.plans}?locale=${encodeURIComponent(locale)}`)
      .then((res) => { if (!cancelled) setPayload(res.data); })
      .catch(() => { if (!cancelled) setError(t.billing.plansRoute.loadError); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [locale, attempt, t.billing.plansRoute.loadError]);
  return { payload, loading, error, retry: () => setAttempt((value) => value + 1) };
}

/** Shared hosted checkout, including duplicate-click and uncertain-payment retries. */
export function useCloudCheckout({ enabled, preserveProject = false, onCheckoutStarted, workspaceId: selectedWorkspaceId }: {
  enabled: boolean;
  workspaceId?: string;
  preserveProject?: boolean;
  onCheckoutStarted?: () => void;
}) {
  const { t } = useI18n();
  const billingWorkspaceId = useBillingWorkspace();
  const workspaceId = selectedWorkspaceId ?? billingWorkspaceId;
  const [subscribing, setSubscribing] = useState<PlanTierId | "custom" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const attempts = useRef(new Map<string, string>());
  const busy = useRef(false);

  async function startCheckout(planTierId: PlanTierId, interval: "monthly" | "annual", custom?: CustomSubscriptionSelection) {
    if (!enabled || busy.current || planTierId === "free" || planTierId === "enterprise") return;
    busy.current = true;
    trackCloudEvent({ event: "cloud_checkout_clicked", properties: { kind: "subscription", surface: preserveProject ? "onboarding" : "billing" } });
    // Open within the user's click, preserving unfinished project configuration.
    const checkoutTab = preserveProject ? window.open("about:blank", "_blank") : null;
    if (checkoutTab) checkoutTab.opener = null;
    setSubscribing(custom ? "custom" : planTierId);
    setError(null);
    setCheckoutUrl(null);
    try {
      const attempt = `${workspaceId ?? "dedicated"}:${custom?.quoteReference ?? planTierId}:${interval}`;
      if (!attempts.current.has(attempt)) attempts.current.set(attempt, randomUUID());
      const res = await api.post<{ data: { checkoutUrl: string } }>(endpoints.billing.subscription, {
        planTierId, interval, workspaceId, custom, idempotencyKey: attempts.current.get(attempt),
      });
      const url = new URL(res.data.checkoutUrl);
      if (url.protocol !== "https:") throw new Error(t.billing.plansRoute.checkoutError);
      if (preserveProject) {
        if (checkoutTab && !checkoutTab.closed) checkoutTab.location.href = url.href;
        setCheckoutUrl(url.href);
        onCheckoutStarted?.();
      } else {
        window.location.href = url.href;
      }
    } catch (err) {
      checkoutTab?.close();
      setError(getApiErrorMessage(err, t.billing.plansRoute.checkoutError));
      if (err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === "BILLING_QUOTE_CHANGED") {
        setQuoteRevision(value => value + 1);
      }
    } finally {
      busy.current = false;
      setSubscribing(null);
    }
  }
  return { startCheckout, subscribing, error, checkoutUrl, quoteRevision };
}
