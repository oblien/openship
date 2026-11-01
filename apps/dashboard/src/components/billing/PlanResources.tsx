"use client";

import { Icon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { formatBillingNumber } from "@/lib/billing-usage";
import type { ApiPlan } from "./PricingCards";
import { planCapacity } from "./plan-presentation";
import { CapacitySummary } from "@/components/shared/CapacitySummary";

/** Shared by plan comparisons and the compact subscription summary. */
export function PlanCapacity({ plan, workspaceScoped = false, compact = false }: { plan: ApiPlan; workspaceScoped?: boolean; compact?: boolean }) {
  const { t } = useI18n();
  const capacity = planCapacity(plan);
  if (!capacity) return null;
  return (
    <div className="space-y-2">
      {workspaceScoped && !compact && <p className="text-xs text-muted-foreground">{t.billing.workspaces.provisioned}</p>}
      <CapacitySummary inline={compact} resources={{ cpuCores: capacity.cpu, memoryMb: capacity.memoryGb * 1024, diskMb: capacity.diskGb * 1024 }} />
    </div>
  );
}

/** Compare concrete resources. Metering is explained once after the plans. */
export function PlanResources({ plan, compact = false, workspaceScoped = false }: { plan: ApiPlan; compact?: boolean; workspaceScoped?: boolean }) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourcesGuide;
  if (plan.id === "free")
    return <p className="text-xs leading-relaxed text-muted-foreground">{copy.setupHint}</p>;
  const buildMinutes = plan.limits.buildMinutesPerMonth;
  const facts = [
    ...(plan.limits.maxProjects != null ? [{ label: copy.projects, value: formatBillingNumber(plan.limits.maxProjects, locale) }] : []),
    ...(plan.limits.runningServices != null ? [{ label: t.billing.capacity.runningServices, value: formatBillingNumber(plan.limits.runningServices, locale) }] : []),
    ...(plan.limits.concurrentBuilds != null ? [{ label: copy.concurrentBuilds, value: formatBillingNumber(plan.limits.concurrentBuilds, locale) }] : []),
    ...(buildMinutes !== null ? [{
      label: copy.buildTime,
      value: buildMinutes === 0
        ? copy.notIncluded
        : interpolate(copy.buildMinutes, { amount: formatBillingNumber(buildMinutes, locale) }),
    }] : []),
    ...(plan.edge?.bandwidthGb != null ? [{
      label: t.billing.resourceOverview.bandwidth,
      value: interpolate(t.billing.resourceOverview.bandwidthPerMonth, {
        amount: formatBillingNumber(plan.edge.bandwidthGb, locale),
      }),
    }] : []),
  ];
  // Use the offer's localized support feature, not a guessed benefit for its tier name.
  const supportIndex = plan.featureKeys?.indexOf(`${plan.support}Support`) ?? -1;
  const support = supportIndex >= 0 ? plan.features[supportIndex] : undefined;

  if (compact) return <PlanCapacity plan={plan} />;

  return (
    <div className="space-y-4 py-4">
      <PlanCapacity plan={plan} workspaceScoped={workspaceScoped} />
      {facts.length > 0 && <dl className="space-y-2.5">
        {facts.map(({ label, value }) => (
          <div key={label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="max-w-40 text-end text-sm font-medium tabular-nums text-foreground">
              <bdi>{value}</bdi>
            </dd>
          </div>
        ))}
      </dl>}
      {support && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon name="check" className="size-3.5 shrink-0" aria-hidden="true" />
          {support}
        </p>
      )}
    </div>
  );
}
