"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { billingApi, type BillingState } from "@/lib/api/billing";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { OpenStripePortalButton } from "@/app/(dashboard)/billing/_components/OpenStripePortalButton";

export function BillingSubscriptionControls({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [subscription, setSubscription] = useState(state.subscription);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setSubscription(state.subscription); }, [state.subscription]);
  if (!subscription) return null;

  const copy = t.billing.subscription;
  const ended = subscription.status === "canceled";
  const ending = subscription.cancelAtPeriodEnd;
  const canManage = !ended && (ending
    ? state.capabilities?.resumption === true
    : state.capabilities?.cancellation === true);
  const end = subscription.currentPeriod.end;
  const endDate = end ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(end)) : null;
  const status = ended ? copy.ended : ending
    ? endDate ? interpolate(copy.endsOn, { date: endDate }) : copy.endsAtPeriodEnd
    : endDate ? interpolate(copy.renewsOn, { date: endDate }) : copy.renewalEnabled;

  async function updateRenewal(action: "cancel" | "resume") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = action === "cancel" ? await billingApi.cancelSubscription() : await billingApi.resumeSubscription();
      setSubscription(result.subscription);
      setConfirming(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.error);
    } finally {
      setBusy(false);
    }
  }

  return <div className="rounded-2xl border border-border/50 bg-card p-6">
    <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
    <p role="status" className="mt-1 text-sm text-muted-foreground">{status}</p>
    <p className="mt-1 text-xs text-muted-foreground">
      {subscription.interval === "annual" ? t.billing.pricing.billedAnnually : copy.billedMonthly}
    </p>
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    {confirming ? <div className="mt-4 space-y-3">
      <p className="text-sm text-muted-foreground">{copy.cancelNotice}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy} onClick={() => void updateRenewal("cancel")}
          className="inline-flex items-center gap-2 rounded-lg border border-danger/30 px-3 py-2 text-sm text-danger disabled:opacity-50">
          {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}{copy.confirmCancel}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="px-3 py-2 text-sm text-muted-foreground">
          {copy.keepPlan}
        </button>
      </div>
    </div> : <div className="mt-4 flex flex-wrap items-center gap-4">
      <OpenStripePortalButton enabled={state.capabilities?.portal === true} />
      {canManage && <button type="button" disabled={busy}
        onClick={() => ending ? void updateRenewal("resume") : setConfirming(true)}
        className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50">
        {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}{ending ? copy.resume : copy.cancel}
      </button>}
    </div>}
  </div>;
}
