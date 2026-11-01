"use client";

import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Icon } from "@repo/ui/icons";
import type { BillingState } from "@/lib/api/billing";
import { formatMilliCredits } from "@/lib/billing-usage";
import { BillingLink } from "./BillingWorkspaceContext";

/** Billing overview only. Reuse the selected server's authoritative billing state. */
export function CloudCreditAlert({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const copy = t.billing.creditAlert;
  const alert = state.creditAlert;
  const funded = state.tier !== "free" || (alert?.limit ?? 0) > 0 || state.balance.quotaUsed > 0;
  const billingMode = state.compute?.billingMode ?? state.plan?.billingMode;
  if (
    billingMode === "monthly" || !funded || !alert ||
    !["low", "grace", "depleted"].includes(alert.state)
  ) return null;

  const depleted = alert.state === "depleted";
  const title = depleted ? copy.exhaustedTitle
    : alert.state === "grace" ? copy.graceTitle : copy.lowTitle;
  const description = depleted ? copy.exhaustedDescription
    : interpolate(alert.state === "grace" ? copy.graceDescription : copy.lowDescription, {
      percent: String(alert.percent ?? ""),
      credits: formatMilliCredits(Math.max(0, (alert.state === "grace" ? alert.balance : alert.remaining) ?? 0), locale),
    });
  const canTopUp = state.billing?.enabled && state.topups?.available;

  return (
    <section aria-label={copy.title} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-card p-5">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon name="alert-circle" className={`mt-0.5 size-5 shrink-0 ${depleted ? "text-danger" : "text-warning"}`} aria-hidden="true" />
        <div role="status">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <Button asChild variant="secondary" size="sm">
        <BillingLink href={canTopUp ? "/billing/topups" : "/billing/plans"}>
          {canTopUp ? copy.buyCredits : t.billing.tabs.plans}
        </BillingLink>
      </Button>
    </section>
  );
}
