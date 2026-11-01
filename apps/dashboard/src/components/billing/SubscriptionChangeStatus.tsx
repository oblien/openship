"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BillingPlanChange } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { billingApi } from "@/lib/api/billing";
import { getApiErrorMessage } from "@/lib/api/client";
import { workspaceBillingHref } from "./BillingWorkspaceContext";

/** Shared by the confirmation dialog and the selected server's billing card. */
export function SubscriptionChangeStatus({ initial, workspaceId }: {
  initial: BillingPlanChange; workspaceId?: string;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.planChange;
  const router = useRouter();
  const [change, setChange] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(change);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const receive = useCallback((next: BillingPlanChange) => {
    if (!mounted.current) return;
    const changed = next.status !== current.current.status || next.serverUpdate !== current.current.serverUpdate;
    current.current = next;
    setChange(next);
    if (changed) router.refresh();
  }, [router]);
  const refresh = useCallback(async (cancel = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      receive(await (cancel ? billingApi.cancelSubscriptionChange(initial.id, workspaceId)
        : billingApi.getSubscriptionChange(initial.id, workspaceId)));
    } catch (failure) {
      if (mounted.current) setError(getApiErrorMessage(failure));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [initial.id, workspaceId, receive]);
  const pending = !["applied", "canceled", "failed", "expired"].includes(change.status) ||
    (change.status === "applied" && change.serverUpdate === "pending");
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const check = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const timer = setInterval(check, change.status === "scheduled" ? 60_000 : 5_000);
    window.addEventListener("focus", check);
    return () => { clearInterval(timer); window.removeEventListener("focus", check); };
  }, [pending, change.status, refresh]);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(change.effectiveAt));
  const message = change.status === "scheduled" ? interpolate(copy.scheduled, { name: change.next.name, date })
    : change.status === "payment_pending" ? copy.paymentPending
      : change.status === "applied" ? change.serverUpdate === "review_required" ? copy.resizeReview : copy.applied
        : change.status === "canceled" ? copy.canceled
          : change.status === "failed" || change.status === "expired" ? copy.failed
            : copy.processing;
  const validPayment = change.status === "payment_pending" && change.paymentUrl && (!change.paymentExpiresAt || Date.parse(change.paymentExpiresAt) > Date.now());
  return <div className="space-y-3 rounded-xl bg-muted/40 p-4">
    <p role="status" className="text-sm text-foreground">{message}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {validPayment && <Button asChild size="sm"><a href={change.paymentUrl!} target="_blank" rel="noopener noreferrer">{copy.completePayment}</a></Button>}
      {pending && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</Button>}
      {change.cancelable && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh(true)}>{copy.cancelChange}</Button>}
      {change.status === "applied" && change.serverUpdate === "review_required" && <Button asChild size="sm" variant="secondary">
        <a href={workspaceBillingHref("/billing/overview", workspaceId)} target="_blank" rel="noopener noreferrer">{t.billing.custom.reviewResize}</a>
      </Button>}
    </div>
  </div>;
}
