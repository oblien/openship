import type { AffiliatePlanSelection, AffiliateOverview } from "@repo/contracts";
import type { ApiPlan } from "@/components/billing/PricingCards";
import { PlanIcon } from "@/components/billing/PlanIcon";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { affiliateMoney } from "./affiliate-presentation";
import { referralPlanId, referralPlans } from "./referral-plans";

type Interval = "monthly" | "annual";
type Policy = AffiliateOverview["program"]["policies"][number];
export function affiliatePlanOptions(
  plans: ApiPlan[],
  policy: Policy | undefined,
  annual: boolean,
) {
  return (["monthly", ...(annual ? ["annual"] : [])] as Interval[]).flatMap((interval) =>
    referralPlans(plans, policy, interval).map((plan) => ({
      plan,
      interval,
      planId: referralPlanId(plan)!,
    })),
  );
}
export function selectionFromOptions(
  options: ReturnType<typeof affiliatePlanOptions>,
): AffiliatePlanSelection[] {
  const result = new Map<string, AffiliatePlanSelection>();
  for (const { planId, interval } of options) {
    if (!result.has(planId)) result.set(planId, { planId, intervals: [] });
    result.get(planId)!.intervals.push(interval);
  }
  return [...result.values()];
}

/** Illustrative earnings use the provider's per-invoice rounding; checkout remains authoritative. */
export function affiliateEstimate(subtotal: number, commissionBps: number, discountBps: number) {
  const discount = Math.round((subtotal * discountBps) / 10000);
  return {
    paid: subtotal - discount,
    commission: Math.round((subtotal * commissionBps) / 10000) - discount,
  };
}

export function AffiliatePlanPicker({
  options,
  selection,
  onChange,
  commissionBps,
  discountBps,
  durationMonths,
  disabled,
}: {
  options: ReturnType<typeof affiliatePlanOptions>;
  /** Null includes every eligible current and future plan; an array is an explicit allowlist. */
  selection: AffiliatePlanSelection[] | null;
  onChange: (value: AffiliatePlanSelection[] | null) => void;
  commissionBps: number;
  discountBps: number;
  durationMonths: number;
  disabled: boolean;
}) {
  const { t, locale } = useI18n(),
    copy = t.affiliates;
  const plans = [...new Map(options.map((option) => [option.planId, option.plan])).entries()];
  const selected = selection ?? selectionFromOptions(options);
  const toggle = (planId: string, interval: Interval) => {
    const entries = selected.map((entry) => ({ ...entry, intervals: [...entry.intervals] }));
    const entry = entries.find((item) => item.planId === planId);
    if (!entry) entries.push({ planId, intervals: [interval] });
    else if (entry.intervals.includes(interval))
      entry.intervals = entry.intervals.filter((item) => item !== interval);
    else entry.intervals.push(interval);
    onChange(entries.filter((item) => item.intervals.length));
  };
  const intervalName = (interval: Interval) =>
    interval === "annual" ? t.billing.pricing.annual : t.billing.pricing.monthly;
  return (
    <section className="@container/affiliate-plans space-y-4" aria-label={copy.planSelection}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 rounded-xl bg-muted/40 p-1">
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            aria-pressed={selection === null}
            variant={selection === null ? "secondary" : "ghost"}
            onClick={() => onChange(null)}
          >
            {copy.allPlans}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            aria-pressed={selection !== null}
            variant={selection !== null ? "secondary" : "ghost"}
            onClick={() => onChange(selected)}
          >
            {copy.selectedPlans}
          </Button>
        </div>
        {selection !== null && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange([])}
          >
            {copy.clearSelection}
          </Button>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {selection === null ? copy.allPlansHint : copy.selectedPlansHint}
      </p>
      <div className="grid gap-3 @min-[480px]/affiliate-plans:grid-cols-2 @min-[860px]/affiliate-plans:grid-cols-4">
        {plans.map(([planId, plan]) => (
          <article key={planId} aria-label={plan.name} className="min-w-0 rounded-2xl bg-card p-4">
            <div className="mb-5 flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60">
                <PlanIcon planId={plan.id} />
              </span>
              <h3 className="font-medium">{plan.name}</h3>
            </div>
            <div className="grid grid-cols-2 gap-2 @min-[480px]/affiliate-plans:grid-cols-1">
              {(["monthly", "annual"] as const).map((interval) => {
                const option = options.find(
                  (item) => item.planId === planId && item.interval === interval,
                );
                if (!option)
                  return (
                    <p key={interval} className="p-3 text-xs text-muted-foreground">
                      {intervalName(interval)} · —
                    </p>
                  );
                const amounts = affiliateEstimate(
                  option.plan.price[interval]!,
                  commissionBps,
                  discountBps,
                );
                const label = `${plan.name} · ${intervalName(interval)}`;
                const includesRenewals = durationMonths > (interval === "annual" ? 12 : 1);
                const checked = selected.some(
                  (item) => item.planId === planId && item.intervals.includes(interval),
                );
                return (
                  <button
                    key={interval}
                    type="button"
                    role="checkbox"
                    aria-label={label}
                    aria-checked={checked}
                    disabled={disabled}
                    onClick={() => toggle(planId, interval)}
                    className={`min-w-0 rounded-xl p-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-muted/60 hover:bg-muted" : "bg-background/40 hover:bg-muted/40"}`}
                  >
                    <span className="flex items-center justify-between gap-2 text-sm font-medium">
                      <span className={checked ? "text-foreground" : "text-muted-foreground"}>
                        {interval === "annual" ? copy.yearlyBilling : copy.monthlyBilling}
                      </span>
                      <Checkbox asButton={false} checked={checked} size="sm" />
                    </span>
                    <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
                      {(interval === "annual"
                        ? copy.customerYearlyPayment
                        : copy.customerMonthlyPayment
                      ).replace("{amount}", affiliateMoney(amounts.paid, locale))}
                    </span>
                    <span className="mt-4 block text-xs text-muted-foreground">{copy.youEarn}</span>
                    <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
                      <span className="text-2xl font-medium tracking-tight tabular-nums">
                        {affiliateMoney(amounts.commission, locale)}
                      </span>
                      <span className="text-xs text-muted-foreground">{copy.perPayment}</span>
                    </span>
                    <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
                      {includesRenewals ? copy.firstPaymentAndRenewals : copy.firstPaymentOnly}
                    </span>
                  </button>
                );
              })}
            </div>
          </article>
        ))}
      </div>
      {selection !== null && selection.length === 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {copy.selectAtLeastOne}
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">{copy.estimatesHint}</p>
    </section>
  );
}
