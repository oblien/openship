"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useBillingScope } from "./BillingWorkspaceContext";
import { useEffect, useRef, useState } from "react";
import type { PlanTierId } from "@repo/core";
import type { BillingPlans, CustomSubscriptionSelection } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { api, ApiError, getApiErrorCode, getApiErrorMessage } from "@/lib/api/client";
import { beginCheckoutNavigation } from "@/lib/checkout-navigation";
import { endpoints } from "@/lib/api/endpoints";
import { randomUUID } from "@/lib/random-uuid";
import { trackCloudEvent } from "@/lib/cloud-analytics";
import { checkoutFailureKind, type CheckoutFailure } from "@/lib/checkout-failure";
import { useSession } from "@/lib/auth-client";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import type { ApiPlan, ApiPricingUi } from "./PricingCards";

interface PlansPayload extends Omit<BillingPlans, "ui" | "plans"> {
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
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/billing/useCloudBilling"); if (!cancelled) setError(t.billing.plansRoute.loadError); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [locale, attempt, t.billing.plansRoute.loadError]);
  return { payload, loading, error, retry: () => setAttempt((value) => value + 1) };
}

/** Shared hosted checkout, including duplicate-click and uncertain-payment retries. */
export function useCloudCheckout({ enabled, preserveProject = false, onCheckoutStarted, workspaceId: selectedWorkspaceId, prepareWorkspace, onWorkspaceRemoved, idempotencyKey, onCheckoutSettled, affiliateCode }: {
  enabled: boolean;
  workspaceId?: string;
  preserveProject?: boolean;
  onCheckoutStarted?: (checkoutUrl: string) => void;
  prepareWorkspace?: () => Promise<string>;
  onWorkspaceRemoved?: (workspaceId: string) => void;
  idempotencyKey?: string;
  affiliateCode?: string;
  onCheckoutSettled?: () => void;
}) {
  const { t } = useI18n();
  const { workspaceId: billingWorkspaceId, organizationId } = useBillingScope();
  const { data: session } = useSession();
  const cloudKey = useCloudResourceKey();
  const ownerKey = `${cloudKey}:${session?.user.id}:${organizationId ?? session?.session?.activeOrganizationId}`;
  const workspaceId = selectedWorkspaceId ?? billingWorkspaceId ?? undefined;
  const [subscribing, setSubscribing] = useState<PlanTierId | "custom" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<CheckoutFailure | null>(null);
  const [pending, setPending] = useState<{ workspaceId?: string } | null>(null);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const attempts = useRef(new Map<string, string>());
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    attempts.current.clear();
    setSubscribing(null); setCheckoutUrl(null); setError(null); setUnavailable(null); setPending(null);
    return () => { generation.current++; };
  }, [workspaceId, ownerKey]);
  useEffect(() => { attempts.current.clear(); }, [idempotencyKey]);

  async function startCheckout(planTierId: PlanTierId, interval: "monthly" | "annual", custom?: CustomSubscriptionSelection) {
    if (!enabled || busy.current || planTierId === "free" || planTierId === "enterprise") return;
    busy.current = true;
    const version = generation.current;
    trackCloudEvent({ event: "cloud_checkout_clicked", properties: { kind: "subscription", surface: preserveProject ? "onboarding" : "billing" } });
    // Open within the user's click, preserving unfinished project configuration.
    const navigation = beginCheckoutNavigation(preserveProject);
    setSubscribing(custom ? "custom" : planTierId);
    setError(null);
    setCheckoutUrl(null);
    setUnavailable(null);
    setPending(null);
    let targetWorkspaceId = workspaceId;
    let requestId: string | undefined;
    try {
      targetWorkspaceId = prepareWorkspace ? await prepareWorkspace() : workspaceId;
      if (version !== generation.current) { navigation.close(); return; }
      if (prepareWorkspace && !targetWorkspaceId) throw new Error(t.billing.plansRoute.checkoutError);
      const attempt = `${targetWorkspaceId ?? "initial"}:${custom?.quoteReference ?? planTierId}:${interval}:${affiliateCode ?? ""}`;
      if (!attempts.current.has(attempt)) attempts.current.set(attempt,
        idempotencyKey && !custom && !affiliateCode ? `${idempotencyKey}-${planTierId}-${interval}` : randomUUID());
      requestId = attempts.current.get(attempt)!;
      const res = await api.post<{ data: { checkoutUrl: string } }>(endpoints.billing.subscription, {
        planTierId, interval, workspaceId: targetWorkspaceId, custom, idempotencyKey: requestId,
        ...(affiliateCode ? { affiliateCode } : {}),
      });
      if (version !== generation.current) { navigation.close(); return; }
      const url = navigation.navigate(res.data.checkoutUrl);
      if (preserveProject) {
        setCheckoutUrl(url);
        onCheckoutStarted?.(url);
      }
    } catch (err) {
      navigation.close();
      if (version !== generation.current) return;
      const kind = checkoutFailureKind(err);
      if (getApiErrorCode(err) === "CLOUD_WORKSPACE_CHECKOUT_PENDING") setPending({ workspaceId: targetWorkspaceId });
      else if (kind) setUnavailable({ kind, requestId: requestId ?? randomUUID(), planTierId, interval, workspaceId: targetWorkspaceId, custom });
      else setError(getApiErrorMessage(err, t.billing.plansRoute.checkoutError));
      if (err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === "BILLING_QUOTE_CHANGED") {
        setQuoteRevision(value => value + 1);
      }
    } finally {
      if (version === generation.current) {
        busy.current = false;
        setSubscribing(null);
      }
    }
  }
  return { startCheckout, subscribing, error, checkoutUrl, quoteRevision, unavailable, dismissUnavailable: () => setUnavailable(null),
    recovery: {
      isOpen: pending !== null, workspaceId: pending?.workspaceId, preserveProject,
      onClose: () => setPending(null),
      onCleared: () => { attempts.current.clear(); setError(null); onCheckoutSettled?.(); },
      onCheckoutStarted: (url: string) => { setCheckoutUrl(url); onCheckoutStarted?.(url); },
      onServerRemoved: (id: string) => {
        attempts.current.clear(); setCheckoutUrl(null); onWorkspaceRemoved?.(id);
      },
    },
  };
}
