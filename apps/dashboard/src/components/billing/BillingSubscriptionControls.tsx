"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { billingApi, type BillingState } from "@/lib/api/billing";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { OpenStripePortalButton } from "@/app/(dashboard)/billing/_components/OpenStripePortalButton";

export function BillingSubscriptionControls({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [subscription, setSubscription] = useState(state.subscription);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSubscription(state.subscription);
  }, [state.subscription]);
  if (!subscription) return null;

  const copy = t.billing.subscription;
  const ended = subscription.status === "canceled";
  const ending = subscription.cancelAtPeriodEnd;
  const canManage =
    !ended &&
    (ending ? state.capabilities?.resumption === true : state.capabilities?.cancellation === true);
  const end = subscription.currentPeriod.end;
  const endDate = end
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(end))
    : null;
  const status = ended
    ? copy.ended
    : ending
      ? endDate
        ? interpolate(copy.endsOn, { date: endDate })
        : copy.endsAtPeriodEnd
      : endDate
        ? interpolate(copy.renewsOn, { date: endDate })
        : copy.renewalEnabled;

  async function updateRenewal(action: "cancel" | "resume") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        action === "cancel"
          ? await billingApi.cancelSubscription(state.workspace?.id)
          : await billingApi.resumeSubscription(state.workspace?.id);
      setSubscription(result.subscription);
      setConfirming(false);
      router.refresh();
    } catch (err) {
      setError(getApiErrorMessage(err, copy.error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl bg-card p-5">
      <h3 className="text-sm font-medium text-foreground">{copy.title}</h3>
      <p role="status" className="mt-1 text-xs text-muted-foreground">
        {status}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {confirming ? (
        <div className="mt-4 space-y-3 rounded-xl bg-muted/35 p-3">
          <p className="text-sm text-muted-foreground">{copy.cancelNotice}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void updateRenewal("cancel")}
            >
              {busy && <UiIcon name="spinner" aria-hidden className="size-4 animate-spin" />}
              {copy.confirmCancel}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {copy.keepPlan}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <OpenStripePortalButton enabled={state.capabilities?.portal === true} />
          {canManage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => (ending ? void updateRenewal("resume") : setConfirming(true))}
            >
              {busy && <UiIcon name="spinner" aria-hidden className="size-4 animate-spin" />}
              {ending ? copy.resume : copy.cancel}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
