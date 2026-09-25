"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { RESOURCE_TIER_SPECS, formatCpuCores, formatMemoryMb } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { formatBillingNumber, formatMilliCredits } from "@/lib/billing-usage";
import type { ApiPlan } from "./PricingCards";

/** Lead with enforced project and resource allowances; keep metering details available. */
export function PlanResources({ plan, interval = "monthly" }: { plan: ApiPlan; interval?: "monthly" | "annual" }) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourcesGuide;
  if (plan.id === "free") return <p className="text-xs leading-relaxed text-muted-foreground">{copy.setupHint}</p>;
  const count = (n: number | null) => n === null ? copy.unlimited : formatBillingNumber(n, locale);
  const spec = plan.limits.maxResourceTier ? RESOURCE_TIER_SPECS[plan.limits.maxResourceTier] : null;
  const credits = interval === "annual" ? plan.annualCredits : plan.monthlyCredits;
  const facts = [
    { Icon: "folder-open" as const, label: copy.projects, value: count(plan.limits.maxProjects) },
    { Icon: "layers" as const, label: copy.apps, value: count(plan.limits.runningServices) },
    { Icon: "clock" as const, label: copy.buildTime, value: plan.limits.buildMinutesPerMonth === null ? copy.unlimited : interpolate(copy.buildMinutes, { amount: count(plan.limits.buildMinutesPerMonth) }) },
    { Icon: "cpu" as const, label: copy.machine, value: spec ? `${formatCpuCores(spec.cpuCores)} · ${formatMemoryMb(spec.memoryMb)}` : copy.unlimited },
    ...(plan.edge ? [{ Icon: "globe" as const, label: t.billing.resourceOverview.bandwidth, value: plan.edge.bandwidthGb === null ? copy.unlimited : interpolate(t.billing.resourceOverview.bandwidthPerMonth, { amount: count(plan.edge.bandwidthGb) }) }] : []),
  ];
  return (
    <div className="border-t border-border/40 py-4">
      <dl className="space-y-4">
        {facts.map(({ Icon, label, value }) => <div key={label} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <dt className="flex items-center gap-2 text-xs text-muted-foreground"><UiIcon name={Icon} className="size-3.5 shrink-0" aria-hidden="true" />{label}</dt>
          <dd className="ms-auto text-end text-sm font-medium tabular-nums text-foreground"><bdi>{value}</bdi></dd>
        </div>)}
      </dl>
      <details className="group mt-5 rounded-lg bg-muted/35 p-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium text-foreground [&::-webkit-details-marker]:hidden">
          {copy.usageIncluded}<UiIcon name="chevron-down" className="size-3.5 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{copy.usageSummary}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{copy.balanceRule}</p>
        <p className="mt-3 border-t border-border/40 pt-2 text-xs tabular-nums text-muted-foreground">
          {credits == null ? plan.id === "enterprise" ? t.billing.pricing.custom : "—" : interpolate(copy.creditsPerCycle, { amount: formatMilliCredits(credits, locale) })}
        </p>
      </details>
    </div>
  );
}
