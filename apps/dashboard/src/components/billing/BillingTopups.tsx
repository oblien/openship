"use client";

import React, { useEffect, useState } from "react";
import { Loader2, Plus, ExternalLink, Receipt } from "lucide-react";
import { api } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";

export type { BillingState };

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface TopupPack {
  id: string;
  name: string;
  credits_milli: number;
  price_cents: number;
  stripePriceId: string;
  sortOrder: number;
}

interface TopupPacksResponse {
  data: TopupPack[];
}

interface CheckoutResponse {
  data: { checkoutUrl: string };
}

interface PortalResponse {
  data: { portalUrl: string };
}

interface BillingTopupsProps {
  state: BillingState;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatCredits(milliCredits: number): string {
  // milli-credits → credits
  const credits = Math.round(milliCredits / 1000);
  return credits.toLocaleString();
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export const BillingTopups: React.FC<BillingTopupsProps> = ({ state }) => {
  const { t } = useI18n();
  // Availability is decided by Openship Cloud (billing state), NOT hardcoded —
  // so top-ups can launch by flipping the cloud flag with no dashboard release.
  // Absent flag → treated as not-available (coming soon).
  const topupsAvailable = state.topups?.available === true;

  const [packs, setPacks] = useState<TopupPack[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buyingPackId, setBuyingPackId] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchPacks() {
      try {
        const res = await api.get<TopupPacksResponse>("billing/topup-packs");
        if (!cancelled) {
          const sorted = [...res.data].sort((a, b) => a.sortOrder - b.sortOrder);
          setPacks(sorted);
        }
      } catch {
        if (!cancelled) setError(t.billing.topups.loadError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPacks();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBuy = async (packId: string) => {
    setBuyingPackId(packId);
    setError(null);
    try {
      const res = await api.post<CheckoutResponse>("billing/topup", { packId });
      window.location.href = res.data.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.billing.topups.checkoutError);
      setBuyingPackId(null);
    }
  };

  const handleOpenPortal = async () => {
    setOpeningPortal(true);
    setError(null);
    try {
      const res = await api.post<PortalResponse>("billing/portal");
      window.location.href = res.data.portalUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.billing.topups.portalError);
      setOpeningPortal(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Catalog ───────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border/50 bg-card p-6">
        <div className="mb-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">{t.billing.topups.title}</h2>
            {!topupsAvailable && (
              <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {t.billing.pricing.comingSoon}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {topupsAvailable ? t.billing.topups.description : t.billing.topupsComingSoon}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : error && !packs ? (
          <div className="rounded-xl border border-border/50 bg-muted/30 px-4 py-6 text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-3 text-sm font-medium text-primary hover:underline"
            >
              {t.billing.topups.tryAgain}
            </button>
          </div>
        ) : packs && packs.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {packs.map((pack) => {
              const isBuying = buyingPackId === pack.id;
              return (
                <div
                  key={pack.id}
                  className={`flex flex-col rounded-xl border border-border/50 bg-background p-5 transition-colors ${
                    topupsAvailable ? "hover:border-border" : "opacity-70"
                  }`}
                >
                  <p className="text-sm font-medium text-muted-foreground">{pack.name}</p>

                  <div className="mt-3 flex items-baseline gap-1">
                    <Plus className="size-5 text-primary" />
                    <span className="text-3xl font-semibold tabular-nums text-foreground">
                      {formatCredits(pack.credits_milli)}
                    </span>
                    <span className="text-sm text-muted-foreground">{t.billing.topups.credits}</span>
                  </div>

                  <p className="mt-3 text-2xl font-medium tabular-nums text-foreground">
                    {formatPrice(pack.price_cents)}
                  </p>

                  {topupsAvailable ? (
                    <button
                      onClick={() => handleBuy(pack.id)}
                      disabled={isBuying || buyingPackId !== null}
                      className="mt-5 inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isBuying ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          {t.billing.topups.redirecting}
                        </>
                      ) : (
                        <>{t.billing.topups.buy}</>
                      )}
                    </button>
                  ) : (
                    <span
                      className="mt-5 inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-xl border border-border bg-muted px-4 py-2 text-sm font-medium text-muted-foreground"
                      aria-disabled
                    >
                      {t.billing.pricing.comingSoon}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-border/50 bg-muted/30 px-4 py-6 text-center">
            <p className="text-sm text-muted-foreground">{t.billing.topups.empty}</p>
          </div>
        )}

        {error && packs && (
          <div className="mt-4 rounded-xl border border-danger-border bg-danger-bg px-4 py-3">
            <p className="text-sm text-danger">{error}</p>
          </div>
        )}
      </div>

      {/* ── Receipts / portal ─────────────────────────────────── */}
      <div className="rounded-2xl border border-border/50 bg-card p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-xl border border-border/50 bg-muted/30 p-2">
              <Receipt className="size-5 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">{t.billing.topups.receiptsTitle}</h3>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {t.billing.topups.receiptsDescription}
              </p>
            </div>
          </div>

          <button
            onClick={handleOpenPortal}
            disabled={openingPortal}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {openingPortal ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t.billing.topups.opening}
              </>
            ) : (
              <>
                {t.billing.topups.openPortal}
                <ExternalLink className="size-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
