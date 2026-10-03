"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { useEffect, useRef, useState } from "react";
import { needsCloudPlan } from "@/lib/billing-presentation";
import { randomUUID } from "@/lib/random-uuid";
import { BillingEmptyState } from "./BillingEmptyState";
import { OpenStripePortalButton } from "@/app/(dashboard)/billing/_components/OpenStripePortalButton";
import { Button } from "@/components/ui/button";
import { api, getApiErrorMessage } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";
import { formatMilliCredits } from "@/lib/billing-usage";

export type { BillingState };

interface TopupPack {
  id: string;
  name: string;
  credits_milli: number;
  price_cents: number;
  sortOrder: number;
}

export function BillingTopups({ state }: { state: BillingState }) {
  const { t } = useI18n();
  if (needsCloudPlan(state)) return <BillingEmptyState kind="topups" />;
  if (state.topups?.status === "unavailable")
    return (
      <section className="space-y-4 rounded-2xl bg-card p-5">
        <h2 className="text-base font-medium text-foreground">{t.billing.topups.title}</h2>
        <p className="text-sm text-muted-foreground">
          {state.complimentary
            ? t.billing.complimentary.topupsUnavailable
            : state.capabilities?.subscriptionChange
              ? t.billing.deployGate.paymentDescription
              : t.billing.plansRoute.changeViaSupport}
        </p>
        {state.complimentary && (
          <Button asChild variant="secondary">
            <a href="mailto:support@openship.io">{t.billing.portal.supportButton}</a>
          </Button>
        )}
      </section>
    );
  return <CreditPacks state={state} />;
}

function CreditPacks({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const allowance =
    state.subscription?.interval === "annual"
      ? state.plan?.annualCredits
      : state.plan?.monthlyCredits;
  const topupsAvailable = state.topups?.available === true;
  const [packs, setPacks] = useState<TopupPack[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [buyingPackId, setBuyingPackId] = useState<string | null>(null);
  const checkoutAttempts = useRef(new Map<string, string>());
  const checkoutBusy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<{ data: TopupPack[] }>("billing/topup-packs")
      .then((res) => {
        if (!cancelled) setPacks([...res.data].sort((a, b) => a.sortOrder - b.sortOrder));
      })
      .catch(() => {
        if (!cancelled) setError(t.billing.topups.loadError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, t.billing.topups.loadError]);

  async function handleBuy(packId: string) {
    if (!topupsAvailable || checkoutBusy.current) return;
    checkoutBusy.current = true;
    setBuyingPackId(packId);
    setError(null);
    try {
      // An uncertain response may have created checkout. Retain the same key
      // on retry; choosing another pack or workspace is a different purchase.
      const key = `${state.workspace?.id}:${packId}`;
      if (!checkoutAttempts.current.has(key)) checkoutAttempts.current.set(key, randomUUID());
      const res = await api.post<{ data: { checkoutUrl: string } }>("billing/topup", {
        workspaceId: state.workspace?.id,
        packId,
        idempotencyKey: checkoutAttempts.current.get(key),
      });
      window.location.href = res.data.checkoutUrl;
    } catch (err) {
      setError(getApiErrorMessage(err, t.billing.topups.checkoutError));
      setBuyingPackId(null);
      checkoutBusy.current = false;
    }
  }

  return (
    <div className="space-y-5">
      <section className="@container/packs rounded-2xl bg-card p-5" aria-busy={loading}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-medium text-foreground">{t.billing.topups.title}</h2>
          {!topupsAvailable && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t.billing.pricing.comingSoon}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {topupsAvailable ? t.billing.topups.description : t.billing.topupsComingSoon}
        </p>
        {error && (
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-danger"
          >
            <p>{error}</p>
            {!packs && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t.billing.topups.tryAgain}
              </Button>
            )}
          </div>
        )}
        {loading ? (
          <div
            role="status"
            aria-label={t.billing.usage.breakdown.loading}
            className="mt-5 grid gap-3 @min-[28rem]/packs:grid-cols-3"
          >
            {[1, 2, 3].map((item) => (
              <div key={item} className="h-52 animate-pulse rounded-xl bg-muted/40" />
            ))}
          </div>
        ) : packs?.length ? (
          <div className="mt-5 grid grid-cols-1 gap-3 @min-[28rem]/packs:grid-cols-2 @min-[44rem]/packs:grid-cols-3">
            {packs.map((pack) => {
              const percent =
                allowance != null && Number.isFinite(allowance) && allowance > 0
                  ? new Intl.NumberFormat(locale, {
                      style: "percent",
                      maximumFractionDigits: 1,
                    }).format(pack.credits_milli / allowance)
                  : null;
              const buying = buyingPackId === pack.id;
              return (
                <article key={pack.id} className="flex flex-col rounded-xl bg-muted/35 p-4">
                  <h3 className="text-sm font-medium text-foreground">{pack.name}</h3>
                  <p className="mt-3 text-2xl font-medium tabular-nums text-foreground">
                    {percent ? (
                      <bdi>+{percent}</bdi>
                    ) : (
                      <span className="text-base">{t.billing.topups.prepaidUsage}</span>
                    )}
                  </p>
                  {percent && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t.billing.topups.allowanceEquivalent}
                    </p>
                  )}
                  <p className="mt-4 text-xl font-medium tabular-nums text-foreground">
                    {new Intl.NumberFormat(locale, {
                      style: "currency",
                      currency: "USD",
                      minimumFractionDigits: pack.price_cents % 100 === 0 ? 0 : 2,
                    }).format(pack.price_cents / 100)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t.billing.topups.oneTime}</p>
                  <details className="group mt-3 text-xs text-muted-foreground">
                    <summary className="flex cursor-pointer list-none items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                      {t.billing.resourcesGuide.usageDetails}
                      <UiIcon
                        name="chevron-down"
                        className="size-3.5 transition-transform group-open:rotate-180"
                        aria-hidden="true"
                      />
                    </summary>
                    <p className="mt-2 tabular-nums">
                      {interpolate(t.billing.overview.creditsAmount, {
                        n: formatMilliCredits(pack.credits_milli, locale),
                      })}
                    </p>
                  </details>
                  <div className="mt-auto pt-4">
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full"
                      onClick={() => void handleBuy(pack.id)}
                      disabled={!topupsAvailable || buyingPackId !== null}
                    >
                      {buying && (
                        <UiIcon name="spinner" className="size-4 animate-spin" aria-hidden="true" />
                      )}
                      {buying
                        ? t.billing.topups.redirecting
                        : topupsAvailable
                          ? t.billing.topups.buy
                          : t.billing.pricing.comingSoon}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          !error && (
            <p className="mt-5 py-4 text-sm text-muted-foreground">{t.billing.topups.empty}</p>
          )
        )}
      </section>
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-card p-5">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t.billing.topups.receiptsTitle}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.billing.topups.receiptsDescription}
          </p>
        </div>
        <OpenStripePortalButton
          enabled={state.capabilities?.portal === true}
          label={t.billing.topups.openPortal}
        />
      </section>
    </div>
  );
}
