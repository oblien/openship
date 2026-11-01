"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BillingPlanChange, BillingPlanChangeQuote, CustomSubscriptionSelection } from "@repo/contracts";
import type { PlanTierId } from "@repo/core";
import { billingApi } from "@/lib/api/billing";
import { ApiError, getApiErrorMessage } from "@/lib/api/client";
import { randomUUID } from "@/lib/random-uuid";

function needsFreshQuote(error: unknown) {
  const body = error instanceof ApiError ? error.body as { code?: string; providerCode?: string; details?: { providerCode?: string } } | null : null;
  return [body?.code, body?.providerCode, body?.details?.providerCode].some(code =>
    code && ["BILLING_QUOTE_CHANGED", "BILLING_QUOTE_EXPIRED", "CLOUD_WORKSPACE_CHANGED", "billing_quote_changed", "billing_quote_expired"].includes(code));
}

export function useSubscriptionChange(workspaceId?: string, onAccepted?: () => void) {
  const router = useRouter();
  const [quote, setQuote] = useState<BillingPlanChangeQuote | null>(null);
  const [change, setChange] = useState<BillingPlanChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmationStarted, setConfirmationStarted] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const selection = useRef<{ planTierId: PlanTierId; custom?: CustomSubscriptionSelection; key: string } | null>(null);
  const acceptedRef = useRef(onAccepted);
  acceptedRef.current = onAccepted;
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setQuote(null); setChange(null); setError(null); setOpen(false); setBusy(false); setConfirmationStarted(false); setRefreshRequired(false);
    selection.current = null;
    return () => { generation.current++; };
  }, [workspaceId]);

  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    const version = generation.current;
    try { await work(); }
    catch (failure) { if (version === generation.current) setError(getApiErrorMessage(failure)); }
    finally { if (version === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  async function review(planTierId: PlanTierId, custom?: CustomSubscriptionSelection, fresh = false) {
    return run(async () => {
      const version = generation.current;
      const previous = selection.current;
      const key = !fresh && previous?.planTierId === planTierId && JSON.stringify(previous.custom) === JSON.stringify(custom)
        ? previous.key : randomUUID();
      selection.current = { planTierId, custom, key };
      let next: BillingPlanChangeQuote;
      try {
        next = await billingApi.previewSubscriptionChange({ workspaceId, planTierId, custom, idempotencyKey: key });
      } catch (error) {
        if (version === generation.current && needsFreshQuote(error)) selection.current = null;
        throw error;
      }
      if (version !== generation.current) return;
      setQuote(next); setChange(null); setConfirmationStarted(false); setRefreshRequired(false); setOpen(true);
    });
  }
  async function confirm() {
    if (!quote) return;
    return run(async () => {
      const version = generation.current;
      setConfirmationStarted(true);
      let result: BillingPlanChange;
      try {
        result = await billingApi.confirmSubscriptionChange({ workspaceId, quoteId: quote.id, confirmRestart: true });
      } catch (error) {
        if (version === generation.current && needsFreshQuote(error)) {
          setConfirmationStarted(false); setRefreshRequired(true);
        }
        throw error;
      }
      if (version !== generation.current) return;
      setChange(result);
      acceptedRef.current?.();
      router.refresh();
    });
  }
  return {
    quote, change, error, busy, open, confirmationStarted, refreshRequired, review, confirm,
    refreshQuote: () => selection.current ? review(selection.current.planTierId, selection.current.custom, true) : Promise.resolve(),
    close: () => { if (!inFlight.current) { setOpen(false); if (!confirmationStarted) selection.current = null; router.refresh(); } },
  };
}
